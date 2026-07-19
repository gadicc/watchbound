//! Watchbound's reusable, Linux-first watcher engine.
//!
//! The public surface deliberately describes coverage and invalidation without
//! exposing inotify watch descriptors, masks, or Linux resource error codes.

#[cfg(not(target_os = "linux"))]
compile_error!("watchbound-engine currently supports Linux only");

mod backend;

use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::Duration;

/// Whether a subscription can currently account for its recursive tree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Coverage {
    Complete,
    Partial {
        reason: PartialReason,
        watched_directories: usize,
        deferred_directories: usize,
    },
    Uncertain {
        reason: UncertainReason,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PartialReason {
    ResourceLimit,
    Permission,
    TransientError,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UncertainReason {
    EventOverflow,
    RootReplaced,
    TopologyRace,
    ConsumerBackpressure,
}

/// A conservative set of paths that a consumer should re-evaluate together.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeBatch {
    pub sequence: u64,
    pub invalidated_paths: Vec<PathBuf>,
    pub coverage: Coverage,
}

/// Per-subscription tuning. No application-specific watch limit is implied.
#[derive(Clone, Debug)]
pub struct SubscriptionOptions {
    pub watch_limit: Option<usize>,
    pub batch_window: Duration,
    pub max_batch_paths: usize,
    pub output_queue_capacity: usize,
}

impl Default for SubscriptionOptions {
    fn default() -> Self {
        Self {
            watch_limit: None,
            batch_window: Duration::from_millis(10),
            max_batch_paths: 1_024,
            output_queue_capacity: 64,
        }
    }
}

impl SubscriptionOptions {
    fn validate(&self) -> io::Result<()> {
        if self.watch_limit == Some(0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "watch_limit must be positive when set",
            ));
        }
        if self.batch_window.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "batch_window must be non-zero",
            ));
        }
        if self.max_batch_paths == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "max_batch_paths must be positive",
            ));
        }
        if self.output_queue_capacity == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "output_queue_capacity must be positive",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Capabilities {
    pub recursive: bool,
    pub moved_in_tree_discovery: bool,
    pub explicit_watch_limits: bool,
    pub overflow_reporting: bool,
    pub dynamic_exclusions: bool,
    pub root_replacement_recovery: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub watched_directories: usize,
    pub deferred_directories: usize,
    pub raw_events: u64,
    pub batches_delivered: u64,
    pub batches_dropped: u64,
    pub topology_scans: u64,
    pub overflow_events: u64,
    pub disposed: bool,
}

/// Live process-wide Linux runtime resource gauges.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RuntimeStats {
    pub inotify_instances: usize,
    pub worker_threads: usize,
    pub native_watches: usize,
    pub native_watch_budget: Option<usize>,
    pub deferred_interests: usize,
    pub subscriptions: usize,
}

/// A cheap, thread-safe view of one subscription's live counters.
#[derive(Clone)]
pub struct StatsHandle {
    shared: Arc<SharedStats>,
}

impl StatsHandle {
    pub fn stats(&self) -> Stats {
        self.shared.snapshot()
    }
}

pub(crate) struct SharedStats {
    pub watched_directories: AtomicUsize,
    pub deferred_directories: AtomicUsize,
    pub raw_events: AtomicU64,
    pub batches_delivered: AtomicU64,
    pub batches_dropped: AtomicU64,
    pub topology_scans: AtomicU64,
    pub overflow_events: AtomicU64,
    pub disposed: AtomicBool,
}

impl SharedStats {
    fn new() -> Self {
        Self {
            watched_directories: AtomicUsize::new(0),
            deferred_directories: AtomicUsize::new(0),
            raw_events: AtomicU64::new(0),
            batches_delivered: AtomicU64::new(0),
            batches_dropped: AtomicU64::new(0),
            topology_scans: AtomicU64::new(0),
            overflow_events: AtomicU64::new(0),
            disposed: AtomicBool::new(false),
        }
    }

    fn snapshot(&self) -> Stats {
        Stats {
            watched_directories: self.watched_directories.load(Ordering::Acquire),
            deferred_directories: self.deferred_directories.load(Ordering::Acquire),
            raw_events: self.raw_events.load(Ordering::Relaxed),
            batches_delivered: self.batches_delivered.load(Ordering::Relaxed),
            batches_dropped: self.batches_dropped.load(Ordering::Relaxed),
            topology_scans: self.topology_scans.load(Ordering::Relaxed),
            overflow_events: self.overflow_events.load(Ordering::Relaxed),
            disposed: self.disposed.load(Ordering::Acquire),
        }
    }
}

/// Factory for subscriptions on the shared process-wide Linux runtime.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Engine {
    runtime_watch_budget: Option<usize>,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates an engine that requires the shared runtime to enforce the given
    /// unique native-watch budget. The budget is fixed until that runtime's
    /// final subscription is disposed.
    pub fn with_runtime_watch_budget(native_watches: usize) -> io::Result<Self> {
        if native_watches == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "runtime native-watch budget must be positive",
            ));
        }
        Ok(Self {
            runtime_watch_budget: Some(native_watches),
        })
    }

    pub const fn capabilities(&self) -> Capabilities {
        Capabilities {
            recursive: true,
            moved_in_tree_discovery: true,
            explicit_watch_limits: true,
            overflow_reporting: true,
            dynamic_exclusions: false,
            root_replacement_recovery: false,
        }
    }

    /// Returns live gauges for the shared Linux runtime, or zeroes while no
    /// subscriptions exist.
    pub fn runtime_stats(&self) -> RuntimeStats {
        let registry = runtime_registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        registry
            .as_ref()
            .and_then(Weak::upgrade)
            .map_or_else(RuntimeStats::default, |runtime| runtime.stats())
    }

    /// Returns only after the initial traversal has either established complete
    /// coverage or produced an explicit partial-coverage result.
    pub fn subscribe(
        &self,
        root: impl AsRef<Path>,
        options: SubscriptionOptions,
    ) -> io::Result<Subscription> {
        options.validate()?;
        let root = reject_symlink_ancestry(&absolute_path(root.as_ref())?)?;
        let metadata = std::fs::symlink_metadata(&root)?;
        if !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("watch root is not a directory: {}", root.display()),
            ));
        }

        let stats = Arc::new(SharedStats::new());
        let runtime = acquire_runtime(self.runtime_watch_budget)?;
        let established = match runtime.subscribe(root, options, Arc::clone(&stats)) {
            Ok(established) => established,
            Err(error) => {
                let _ = release_runtime(&runtime);
                return Err(error);
            }
        };

        Ok(Subscription {
            initial_coverage: established.initial_coverage,
            receiver: Mutex::new(established.receiver),
            stats,
            lifecycle: Mutex::new(Lifecycle::Active {
                runtime,
                subscription_id: established.id,
            }),
            disposed: Condvar::new(),
        })
    }
}

pub struct Subscription {
    initial_coverage: Coverage,
    receiver: Mutex<Receiver<ChangeBatch>>,
    stats: Arc<SharedStats>,
    lifecycle: Mutex<Lifecycle>,
    disposed: Condvar,
}

enum Lifecycle {
    Active {
        runtime: Arc<backend::linux::Runtime>,
        subscription_id: u64,
    },
    Disposing,
    Disposed(Option<(io::ErrorKind, String)>),
}

impl Subscription {
    pub fn initial_coverage(&self) -> &Coverage {
        &self.initial_coverage
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<ChangeBatch, RecvTimeoutError> {
        self.receiver
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .recv_timeout(timeout)
    }

    pub fn try_recv(&self) -> Result<ChangeBatch, TryRecvError> {
        self.receiver
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .try_recv()
    }

    pub fn stats(&self) -> Stats {
        self.stats.snapshot()
    }

    pub fn stats_handle(&self) -> StatsHandle {
        StatsHandle {
            shared: Arc::clone(&self.stats),
        }
    }

    /// Joins removal of this subscription from the shared worker. Once this
    /// returns, the engine can no longer enqueue a batch for this subscription.
    /// Disposing the final subscription also joins the worker thread.
    pub fn dispose(&self) -> io::Result<()> {
        let (runtime, subscription_id) = {
            let mut lifecycle = self
                .lifecycle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            loop {
                match &*lifecycle {
                    Lifecycle::Active { .. } => {
                        let Lifecycle::Active {
                            runtime,
                            subscription_id,
                        } = std::mem::replace(&mut *lifecycle, Lifecycle::Disposing)
                        else {
                            unreachable!();
                        };
                        break (runtime, subscription_id);
                    }
                    Lifecycle::Disposing => {
                        lifecycle = self
                            .disposed
                            .wait(lifecycle)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                    Lifecycle::Disposed(error) => return stored_result(error),
                }
            }
        };

        let mut result = runtime.dispose(subscription_id);
        if let Err(error) = release_runtime(&runtime)
            && result.is_ok()
        {
            result = Err(error);
        }
        while self
            .receiver
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .try_recv()
            .is_ok()
        {}
        self.stats.disposed.store(true, Ordering::Release);

        let stored_error = result
            .as_ref()
            .err()
            .map(|error| (error.kind(), error.to_string()));
        let mut lifecycle = self
            .lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *lifecycle = Lifecycle::Disposed(stored_error);
        self.disposed.notify_all();
        result
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let _ = self.dispose();
    }
}

fn stored_result(error: &Option<(io::ErrorKind, String)>) -> io::Result<()> {
    match error {
        Some((kind, message)) => Err(io::Error::new(*kind, message.clone())),
        None => Ok(()),
    }
}

static RUNTIME: OnceLock<Mutex<Option<Weak<backend::linux::Runtime>>>> = OnceLock::new();

fn runtime_registry() -> &'static Mutex<Option<Weak<backend::linux::Runtime>>> {
    RUNTIME.get_or_init(|| Mutex::new(None))
}

fn acquire_runtime(native_watch_budget: Option<usize>) -> io::Result<Arc<backend::linux::Runtime>> {
    let mut registry = runtime_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(runtime) = registry.as_ref().and_then(Weak::upgrade) {
        if runtime.native_watch_budget() != native_watch_budget {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "engine runtime native-watch budget conflicts with the active shared runtime",
            ));
        }
        if runtime.try_acquire() {
            return Ok(runtime);
        }
    }
    let runtime = backend::linux::Runtime::start(native_watch_budget)?;
    assert!(runtime.try_acquire());
    *registry = Some(Arc::downgrade(&runtime));
    Ok(runtime)
}

fn release_runtime(runtime: &Arc<backend::linux::Runtime>) -> io::Result<()> {
    let mut registry = runtime_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !runtime.release() {
        return Ok(());
    }
    if registry
        .as_ref()
        .and_then(Weak::upgrade)
        .is_some_and(|current| Arc::ptr_eq(&current, runtime))
    {
        *registry = None;
    }
    runtime.shutdown_and_join()
}

fn absolute_path(path: &Path) -> io::Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn reject_symlink_ancestry(path: &Path) -> io::Result<PathBuf> {
    let mut current = PathBuf::new();
    let mut current_is_directory = true;
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => {
                current.push(Path::new("/"));
                current_is_directory = true;
            }
            Component::CurDir => continue,
            Component::ParentDir => {
                if !current_is_directory {
                    return Err(io::Error::from_raw_os_error(libc::ENOTDIR));
                }
                current.pop();
                current_is_directory = true;
                continue;
            }
            Component::Normal(component) => {
                if !current_is_directory {
                    return Err(io::Error::from_raw_os_error(libc::ENOTDIR));
                }
                current.push(component);
            }
        }
        if current == Path::new("/") {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&current)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "watch root path must not contain a symbolic link: {}",
                    current.display()
                ),
            ));
        }
        current_is_directory = metadata.is_dir();
    }
    Ok(current)
}
