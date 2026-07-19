//! Watchbound's reusable, Linux-first watcher engine.
//!
//! The public surface deliberately describes coverage and invalidation without
//! exposing inotify watch descriptors, masks, or Linux resource error codes.

#[cfg(not(target_os = "linux"))]
compile_error!("watchbound-engine currently supports Linux only");

mod backend;

use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::thread::JoinHandle;
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

/// Factory for independent subscriptions.
///
/// A future multi-root scheduler can live behind this type without exposing
/// Linux descriptors or changing the subscription result model.
#[derive(Clone, Copy, Debug, Default)]
pub struct Engine;

impl Engine {
    pub fn new() -> Self {
        Self
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
        let initialized =
            backend::linux::InitializedWatcher::new(root, options.clone(), Arc::clone(&stats))?;
        let initial_coverage = initialized.coverage().clone();
        let stop = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = mpsc::sync_channel(options.output_queue_capacity);
        let worker_stop = Arc::clone(&stop);
        let worker_stats = Arc::clone(&stats);
        let worker = std::thread::Builder::new()
            .name("watchbound-inotify".to_owned())
            .spawn(move || initialized.run(sender, worker_stop, worker_stats))?;

        Ok(Subscription {
            initial_coverage,
            receiver,
            stop,
            stats,
            worker: Some(worker),
        })
    }
}

pub struct Subscription {
    initial_coverage: Coverage,
    receiver: Receiver<ChangeBatch>,
    stop: Arc<AtomicBool>,
    stats: Arc<SharedStats>,
    worker: Option<JoinHandle<()>>,
}

impl Subscription {
    pub fn initial_coverage(&self) -> &Coverage {
        &self.initial_coverage
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<ChangeBatch, RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }

    pub fn try_recv(&self) -> Result<ChangeBatch, TryRecvError> {
        self.receiver.try_recv()
    }

    pub fn stats(&self) -> Stats {
        self.stats.snapshot()
    }

    pub fn stats_handle(&self) -> StatsHandle {
        StatsHandle {
            shared: Arc::clone(&self.stats),
        }
    }

    /// Joins the native worker. Once this returns, the engine can no longer
    /// enqueue a batch for this subscription.
    pub fn dispose(&mut self) -> io::Result<()> {
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        self.stop.store(true, Ordering::Release);
        worker
            .join()
            .map_err(|_| io::Error::other("watch worker panicked"))?;
        while self.receiver.try_recv().is_ok() {}
        self.stats.disposed.store(true, Ordering::Release);
        Ok(())
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let _ = self.dispose();
    }
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
