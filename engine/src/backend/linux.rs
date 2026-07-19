use std::collections::{BTreeSet, HashMap, VecDeque};
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::{
    ChangeBatch, Coverage, PartialReason, RuntimeStats, SharedStats, SubscriptionOptions,
    UncertainReason,
};

const WATCH_MASK: u32 = libc::IN_ATTRIB
    | libc::IN_CLOSE_WRITE
    | libc::IN_CREATE
    | libc::IN_DELETE
    | libc::IN_DELETE_SELF
    | libc::IN_MODIFY
    | libc::IN_MOVE_SELF
    | libc::IN_MOVED_FROM
    | libc::IN_MOVED_TO
    | libc::IN_DONT_FOLLOW
    | libc::IN_ONLYDIR;
const READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_POLL_INTERVAL: Duration = Duration::from_millis(5);
const ROOT_IDENTITY_CHECK_INTERVAL: Duration = Duration::from_millis(250);
const MAX_COMMANDS_PER_TURN: usize = 16;
const MAX_NATIVE_READS_PER_TURN: usize = 2;
const MAX_NATIVE_EVENTS_PER_TURN: usize = 64;
const MAX_TOPOLOGY_DIRECTORIES_PER_TURN: usize = 64;
const MAX_TOPOLOGY_ENTRIES_PER_TURN: usize = 256;

type SubscriptionId = u64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RootIdentity {
    device: u64,
    inode: u64,
}

impl RootIdentity {
    fn capture(path: &Path) -> io::Result<Self> {
        let canonical = fs::canonicalize(path)?;
        if canonical != path {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "watch root path resolved through a symbolic link: {}",
                    path.display()
                ),
            ));
        }
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "watch root is no longer a real directory: {}",
                    path.display()
                ),
            ));
        }
        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

#[derive(Default)]
struct RuntimeCounters {
    inotify_instances: AtomicUsize,
    worker_threads: AtomicUsize,
    native_watches: AtomicUsize,
    subscriptions: AtomicUsize,
}

impl RuntimeCounters {
    fn snapshot(&self) -> RuntimeStats {
        RuntimeStats {
            inotify_instances: self.inotify_instances.load(Ordering::Acquire),
            worker_threads: self.worker_threads.load(Ordering::Acquire),
            native_watches: self.native_watches.load(Ordering::Acquire),
            subscriptions: self.subscriptions.load(Ordering::Acquire),
        }
    }
}

pub(crate) struct EstablishedSubscription {
    pub(crate) id: SubscriptionId,
    pub(crate) initial_coverage: Coverage,
    pub(crate) receiver: Receiver<ChangeBatch>,
}

pub(crate) struct Runtime {
    commands: mpsc::Sender<CommandEnvelope>,
    wakeup: Arc<OwnedFd>,
    worker: Mutex<Option<JoinHandle<()>>>,
    counters: Arc<RuntimeCounters>,
    leases: AtomicUsize,
    shutting_down: AtomicBool,
}

impl Runtime {
    pub(crate) fn start() -> io::Result<Arc<Self>> {
        let inotify = create_inotify()?;
        let wakeup = Arc::new(create_eventfd()?);
        let (commands, command_receiver) = mpsc::channel();
        let counters = Arc::new(RuntimeCounters::default());
        let worker_wakeup = Arc::clone(&wakeup);
        let worker_counters = Arc::clone(&counters);
        let worker = std::thread::Builder::new()
            .name("watchbound-linux-runtime".to_owned())
            .spawn(move || {
                Worker::new(inotify, worker_wakeup, command_receiver, worker_counters).run();
            })?;
        counters.inotify_instances.store(1, Ordering::Release);
        counters.worker_threads.store(1, Ordering::Release);
        Ok(Arc::new(Self {
            commands,
            wakeup,
            worker: Mutex::new(Some(worker)),
            counters,
            leases: AtomicUsize::new(0),
            shutting_down: AtomicBool::new(false),
        }))
    }

    pub(crate) fn try_acquire(&self) -> bool {
        if self.shutting_down.load(Ordering::Acquire) {
            return false;
        }
        self.leases.fetch_add(1, Ordering::AcqRel);
        if self.shutting_down.load(Ordering::Acquire) {
            self.leases.fetch_sub(1, Ordering::AcqRel);
            return false;
        }
        true
    }

    pub(crate) fn release(&self) -> bool {
        let previous = self.leases.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0);
        if previous == 1 {
            self.shutting_down.store(true, Ordering::Release);
            true
        } else {
            false
        }
    }

    pub(crate) fn subscribe(
        &self,
        root: PathBuf,
        options: SubscriptionOptions,
        stats: Arc<SharedStats>,
    ) -> io::Result<EstablishedSubscription> {
        let (output, receiver) = mpsc::sync_channel(options.output_queue_capacity);
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        self.send(CommandEnvelope {
            generation: 0,
            command: Command::Subscribe {
                root,
                options,
                stats,
                output,
                acknowledgement,
            },
        })?;
        let established = acknowledged
            .recv()
            .map_err(|_| io::Error::other("shared runtime stopped during subscription"))?;
        if established.generation != 0 {
            return Err(io::Error::other(
                "shared runtime acknowledged the wrong generation",
            ));
        }
        let established = established.value?;
        Ok(EstablishedSubscription {
            id: established.id,
            initial_coverage: established.coverage,
            receiver,
        })
    }

    pub(crate) fn dispose(&self, id: SubscriptionId) -> io::Result<()> {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        self.send(CommandEnvelope {
            generation: 0,
            command: Command::Dispose {
                subscription_id: id,
                acknowledgement,
            },
        })?;
        let acknowledged = acknowledged
            .recv()
            .map_err(|_| io::Error::other("shared runtime stopped during disposal"))?;
        if acknowledged.generation != 0 {
            return Err(io::Error::other(
                "shared runtime acknowledged the wrong generation",
            ));
        }
        Ok(())
    }

    pub(crate) fn shutdown_and_join(&self) -> io::Result<()> {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        let mut result = self.send(CommandEnvelope {
            generation: 0,
            command: Command::Shutdown { acknowledgement },
        });
        if result.is_ok() {
            result = acknowledged
                .recv()
                .map_err(|_| {
                    io::Error::other("shared runtime stopped before shutdown acknowledgement")
                })
                .and_then(|acknowledged| {
                    if acknowledged.generation == 0 {
                        Ok(())
                    } else {
                        Err(io::Error::other(
                            "shared runtime acknowledged the wrong generation",
                        ))
                    }
                });
        }
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(worker) = worker
            && worker.join().is_err()
            && result.is_ok()
        {
            result = Err(io::Error::other("shared runtime worker panicked"));
        }
        result
    }

    pub(crate) fn stats(&self) -> RuntimeStats {
        self.counters.snapshot()
    }

    fn send(&self, command: CommandEnvelope) -> io::Result<()> {
        self.commands
            .send(command)
            .map_err(|_| io::Error::other("shared runtime command channel is closed"))?;
        let value = 1_u64.to_ne_bytes();
        // SAFETY: wakeup is a live eventfd and value points to exactly eight
        // initialized bytes, as required by eventfd writes.
        let written =
            unsafe { libc::write(self.wakeup.as_raw_fd(), value.as_ptr().cast(), value.len()) };
        // The worker polls the command channel at a bounded interval even if
        // this best-effort latency wakeup is interrupted or saturated.
        let _ = written;
        Ok(())
    }
}

fn create_inotify() -> io::Result<OwnedFd> {
    // SAFETY: inotify_init1 has no pointer arguments and returns a new owned
    // descriptor on success.
    let raw = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: raw was returned uniquely by inotify_init1.
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

fn create_eventfd() -> io::Result<OwnedFd> {
    // SAFETY: eventfd has no pointer arguments and returns a new owned
    // descriptor on success.
    let raw = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: raw was returned uniquely by eventfd.
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

struct CommandEnvelope {
    // Reserved now so future exclusion transactions can share the same ordered
    // command and acknowledgement boundary without changing lifecycle shape.
    generation: u64,
    command: Command,
}

struct CommandAcknowledgement<T> {
    generation: u64,
    value: T,
}

enum Command {
    Subscribe {
        root: PathBuf,
        options: SubscriptionOptions,
        stats: Arc<SharedStats>,
        output: SyncSender<ChangeBatch>,
        acknowledgement: SyncSender<CommandAcknowledgement<io::Result<Established>>>,
    },
    Dispose {
        subscription_id: SubscriptionId,
        acknowledgement: SyncSender<CommandAcknowledgement<()>>,
    },
    Shutdown {
        acknowledgement: SyncSender<CommandAcknowledgement<()>>,
    },
}

struct Established {
    id: SubscriptionId,
    coverage: Coverage,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Interest {
    subscription_id: SubscriptionId,
    path: PathBuf,
}

#[derive(Default)]
struct NativeWatch {
    interests: BTreeSet<Interest>,
}

struct SubscriptionState {
    id: SubscriptionId,
    root: PathBuf,
    root_identity: RootIdentity,
    next_root_identity_check: Option<Instant>,
    options: SubscriptionOptions,
    stats: Arc<SharedStats>,
    output: SyncSender<ChangeBatch>,
    watched_paths: HashMap<PathBuf, i32>,
    deferred_directories: HashMap<PathBuf, PartialReason>,
    uncertain_reason: Option<UncertainReason>,
    pending_paths: BTreeSet<PathBuf>,
    pending_started: Option<Instant>,
    next_sequence: u64,
    topology_jobs: VecDeque<TopologyJob>,
    topology_barriers: usize,
    establishment: Option<PendingEstablishment>,
}

struct PendingEstablishment {
    generation: u64,
    acknowledgement: SyncSender<CommandAcknowledgement<io::Result<Established>>>,
}

impl SubscriptionState {
    fn new(
        id: SubscriptionId,
        root: PathBuf,
        root_identity: RootIdentity,
        options: SubscriptionOptions,
        stats: Arc<SharedStats>,
        output: SyncSender<ChangeBatch>,
        establishment: PendingEstablishment,
    ) -> Self {
        stats.topology_scans.fetch_add(1, Ordering::Relaxed);
        Self {
            id,
            root: root.clone(),
            root_identity,
            next_root_identity_check: None,
            options,
            stats,
            output,
            watched_paths: HashMap::new(),
            deferred_directories: HashMap::new(),
            uncertain_reason: None,
            pending_paths: BTreeSet::new(),
            pending_started: None,
            next_sequence: 1,
            topology_jobs: VecDeque::from([TopologyJob::new(root, true)]),
            topology_barriers: 1,
            establishment: Some(establishment),
        }
    }

    fn coverage(&self) -> Coverage {
        if let Some(reason) = self.uncertain_reason {
            Coverage::Uncertain { reason }
        } else if let Some(reason) = self.current_partial_reason() {
            Coverage::Partial {
                reason,
                watched_directories: self.watched_paths.len(),
                deferred_directories: self.deferred_directories.len(),
            }
        } else {
            Coverage::Complete
        }
    }

    fn queue_path(&mut self, path: PathBuf) {
        if path == self.root {
            self.pending_paths.clear();
            self.pending_paths.insert(path);
        } else if !self.pending_paths.contains(&self.root) {
            self.pending_paths.insert(path);
        }
        self.pending_started.get_or_insert_with(Instant::now);
    }

    fn mark_uncertain(&mut self, reason: UncertainReason, invalidated_path: PathBuf) {
        self.uncertain_reason = Some(match self.uncertain_reason {
            Some(current) if uncertainty_priority(current) >= uncertainty_priority(reason) => {
                current
            }
            _ => reason,
        });
        self.queue_path(invalidated_path);
    }

    fn defer(&mut self, path: PathBuf, reason: PartialReason) {
        self.deferred_directories
            .entry(path)
            .and_modify(|current| {
                if partial_priority(reason) > partial_priority(*current) {
                    *current = reason;
                }
            })
            .or_insert(reason);
    }

    fn remove_deferred_subtree(&mut self, path: &Path) {
        self.deferred_directories
            .retain(|candidate, _| !candidate.starts_with(path));
    }

    fn current_partial_reason(&self) -> Option<PartialReason> {
        self.deferred_directories
            .values()
            .copied()
            .max_by_key(|reason| partial_priority(*reason))
    }

    fn publish_resource_counts(&self) {
        self.stats
            .watched_directories
            .store(self.watched_paths.len(), Ordering::Release);
        self.stats
            .deferred_directories
            .store(self.deferred_directories.len(), Ordering::Release);
    }

    fn flush_if_due(&mut self) {
        if self.topology_barriers == 0
            && (self.pending_paths.len() >= self.options.max_batch_paths
                || self
                    .pending_started
                    .is_some_and(|started| started.elapsed() >= self.options.batch_window))
        {
            self.flush();
        }
    }

    fn flush(&mut self) {
        if self.pending_paths.is_empty() {
            self.pending_started = None;
            return;
        }
        if self.pending_paths.len() > self.options.max_batch_paths {
            self.mark_uncertain(UncertainReason::ConsumerBackpressure, self.root.clone());
        }
        let batch = ChangeBatch {
            sequence: self.next_sequence,
            invalidated_paths: std::mem::take(&mut self.pending_paths)
                .into_iter()
                .collect(),
            coverage: self.coverage(),
        };
        self.pending_started = None;
        match self.output.try_send(batch) {
            Ok(()) => {
                self.next_sequence += 1;
                self.stats.batches_delivered.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Full(_)) => {
                self.stats.batches_dropped.fetch_add(1, Ordering::Relaxed);
                self.mark_uncertain(UncertainReason::ConsumerBackpressure, self.root.clone());
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

struct TopologyJob {
    directories: VecDeque<PathBuf>,
    active: Option<ActiveDirectory>,
    establishment: bool,
}

impl TopologyJob {
    fn new(start: PathBuf, establishment: bool) -> Self {
        Self {
            directories: VecDeque::from([start]),
            active: None,
            establishment,
        }
    }
}

struct ActiveDirectory {
    path: PathBuf,
    entries: fs::ReadDir,
    deferred_at_limit: bool,
}

struct Worker {
    inotify: OwnedFd,
    wakeup: Arc<OwnedFd>,
    commands: mpsc::Receiver<CommandEnvelope>,
    counters: Arc<RuntimeCounters>,
    subscriptions: HashMap<SubscriptionId, SubscriptionState>,
    watches: HashMap<i32, NativeWatch>,
    expected_ignored: BTreeSet<i32>,
    topology_runnable: VecDeque<SubscriptionId>,
    topology_scheduled: BTreeSet<SubscriptionId>,
    next_subscription_id: SubscriptionId,
    read_buffer: Vec<u8>,
    pending_native: Vec<u8>,
    pending_native_offset: usize,
    shutting_down: bool,
}

impl Worker {
    fn new(
        inotify: OwnedFd,
        wakeup: Arc<OwnedFd>,
        commands: mpsc::Receiver<CommandEnvelope>,
        counters: Arc<RuntimeCounters>,
    ) -> Self {
        Self {
            inotify,
            wakeup,
            commands,
            counters,
            subscriptions: HashMap::new(),
            watches: HashMap::new(),
            expected_ignored: BTreeSet::new(),
            topology_runnable: VecDeque::new(),
            topology_scheduled: BTreeSet::new(),
            next_subscription_id: 1,
            read_buffer: vec![0; READ_BUFFER_BYTES],
            pending_native: Vec::new(),
            pending_native_offset: 0,
            shutting_down: false,
        }
    }

    fn run(mut self) {
        while !self.shutting_down {
            let commands = self.process_command_turn();
            let native = self.process_native_turn();
            let topology = self.process_topology_turn();
            self.run_maintenance();
            if self.shutting_down {
                break;
            }
            let immediate = commands == MAX_COMMANDS_PER_TURN
                || native
                || topology
                || !self.topology_runnable.is_empty()
                || self.pending_native_offset < self.pending_native.len();
            self.poll(if immediate {
                Duration::ZERO
            } else {
                self.poll_timeout()
            });
        }
        self.shutdown_all_subscriptions();
        self.watches.clear();
        self.counters.native_watches.store(0, Ordering::Release);
        self.counters.inotify_instances.store(0, Ordering::Release);
        self.counters.worker_threads.store(0, Ordering::Release);
    }

    fn process_command_turn(&mut self) -> usize {
        let mut processed = 0;
        while processed < MAX_COMMANDS_PER_TURN {
            let envelope = match self.commands.try_recv() {
                Ok(command) => command,
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
            };
            processed += 1;
            let generation = envelope.generation;
            match envelope.command {
                Command::Subscribe {
                    root,
                    options,
                    stats,
                    output,
                    acknowledgement,
                } => {
                    let root_identity = match RootIdentity::capture(&root) {
                        Ok(identity) => identity,
                        Err(error) => {
                            let _ = acknowledgement.send(CommandAcknowledgement {
                                generation,
                                value: Err(error),
                            });
                            continue;
                        }
                    };
                    let id = self.next_subscription_id;
                    self.next_subscription_id = self.next_subscription_id.saturating_add(1);
                    let state = SubscriptionState::new(
                        id,
                        root,
                        root_identity,
                        options,
                        stats,
                        output,
                        PendingEstablishment {
                            generation,
                            acknowledgement,
                        },
                    );
                    self.subscriptions.insert(id, state);
                    self.counters
                        .subscriptions
                        .store(self.subscriptions.len(), Ordering::Release);
                    self.schedule_topology(id);
                }
                Command::Dispose {
                    subscription_id,
                    acknowledgement,
                } => {
                    self.remove_subscription(subscription_id);
                    let _ = acknowledgement.send(CommandAcknowledgement {
                        generation,
                        value: (),
                    });
                }
                Command::Shutdown { acknowledgement } => {
                    self.shutting_down = true;
                    self.shutdown_all_subscriptions();
                    let _ = acknowledgement.send(CommandAcknowledgement {
                        generation,
                        value: (),
                    });
                    break;
                }
            }
        }
        processed
    }

    fn process_native_turn(&mut self) -> bool {
        if self.subscriptions.values().any(|state| {
            state.topology_barriers > 0
                && state.pending_paths.len() >= state.options.max_batch_paths
        }) {
            return false;
        }
        let mut did_work = false;
        let mut events = 0;
        let mut reads = 0;
        while events < MAX_NATIVE_EVENTS_PER_TURN {
            if let Some(event) = self.next_native_event() {
                did_work = true;
                events += 1;
                self.handle_native_event(event);
                if self.subscriptions.values().any(|state| {
                    state.topology_barriers > 0
                        && state.pending_paths.len() >= state.options.max_batch_paths
                }) {
                    break;
                }
                continue;
            }
            if reads >= MAX_NATIVE_READS_PER_TURN {
                break;
            }
            reads += 1;
            // SAFETY: read_buffer is valid for writes and inotify is a live
            // nonblocking descriptor owned by this worker.
            let read = unsafe {
                libc::read(
                    self.inotify.as_raw_fd(),
                    self.read_buffer.as_mut_ptr().cast(),
                    self.read_buffer.len(),
                )
            };
            if read < 0 {
                let error = io::Error::last_os_error();
                if !matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) {
                    self.mark_all_uncertain(UncertainReason::TopologyRace);
                }
                break;
            }
            if read == 0 {
                break;
            }
            self.pending_native.clear();
            self.pending_native
                .extend_from_slice(&self.read_buffer[..read as usize]);
            self.pending_native_offset = 0;
        }
        did_work
    }

    fn next_native_event(&mut self) -> Option<ParsedEvent> {
        if self.pending_native_offset >= self.pending_native.len() {
            self.pending_native.clear();
            self.pending_native_offset = 0;
            return None;
        }
        let header_size = std::mem::size_of::<libc::inotify_event>();
        let offset = self.pending_native_offset;
        if offset + header_size > self.pending_native.len() {
            self.mark_all_uncertain(UncertainReason::TopologyRace);
            self.pending_native.clear();
            self.pending_native_offset = 0;
            return None;
        }
        // SAFETY: the bounds check provides header_size readable bytes and
        // unaligned access is required for a byte buffer.
        let event = unsafe {
            std::ptr::read_unaligned(
                self.pending_native
                    .as_ptr()
                    .add(offset)
                    .cast::<libc::inotify_event>(),
            )
        };
        let event_size = header_size.saturating_add(event.len as usize);
        if event_size < header_size || offset + event_size > self.pending_native.len() {
            self.mark_all_uncertain(UncertainReason::TopologyRace);
            self.pending_native.clear();
            self.pending_native_offset = 0;
            return None;
        }
        let name = if event.len == 0 {
            None
        } else {
            let bytes = &self.pending_native[offset + header_size..offset + event_size];
            let length = bytes
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(bytes.len());
            Some(std::ffi::OsString::from_vec(bytes[..length].to_vec()))
        };
        self.pending_native_offset += event_size;
        Some(ParsedEvent {
            descriptor: event.wd,
            mask: event.mask,
            name,
        })
    }

    fn handle_native_event(&mut self, event: ParsedEvent) {
        if event.mask & libc::IN_Q_OVERFLOW != 0 {
            for state in self.subscriptions.values_mut() {
                state.stats.raw_events.fetch_add(1, Ordering::Relaxed);
                state.stats.overflow_events.fetch_add(1, Ordering::Relaxed);
                state.mark_uncertain(UncertainReason::EventOverflow, state.root.clone());
            }
            return;
        }
        if event.mask & libc::IN_IGNORED != 0 {
            self.handle_ignored(event.descriptor);
            return;
        }
        let interests: Vec<_> = self
            .watches
            .get(&event.descriptor)
            .map(|watch| watch.interests.iter().cloned().collect())
            .unwrap_or_default();
        for interest in interests {
            let Some(mut state) = self.subscriptions.remove(&interest.subscription_id) else {
                continue;
            };
            state.stats.raw_events.fetch_add(1, Ordering::Relaxed);
            self.handle_interest_event(
                &mut state,
                event.descriptor,
                event.mask,
                &interest.path,
                event.name.as_deref(),
            );
            let id = state.id;
            self.subscriptions.insert(id, state);
        }
    }

    fn handle_interest_event(
        &mut self,
        state: &mut SubscriptionState,
        descriptor: i32,
        mask: u32,
        directory: &Path,
        name: Option<&std::ffi::OsStr>,
    ) {
        let event_path = name.map_or_else(|| directory.to_path_buf(), |name| directory.join(name));
        if mask & libc::IN_UNMOUNT != 0 {
            state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
            return;
        }
        if mask & libc::IN_DELETE_SELF != 0 {
            if directory == state.root {
                state.mark_uncertain(UncertainReason::RootReplaced, state.root.clone());
            } else {
                self.expected_ignored.insert(descriptor);
            }
        } else if mask & libc::IN_MOVE_SELF != 0 && directory == state.root {
            state.mark_uncertain(UncertainReason::RootReplaced, state.root.clone());
        }
        state.queue_path(event_path.clone());
        if mask & libc::IN_ISDIR != 0 {
            if mask & (libc::IN_MOVED_FROM | libc::IN_DELETE) != 0 {
                self.remove_subscription_subtree(state, &event_path);
            }
            if mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0 {
                state.stats.topology_scans.fetch_add(1, Ordering::Relaxed);
                state
                    .topology_jobs
                    .push_back(TopologyJob::new(event_path, false));
                state.topology_barriers += 1;
                self.schedule_topology(state.id);
            }
        }
        if state.pending_paths.len() >= state.options.max_batch_paths
            && state.topology_barriers == 0
        {
            state.flush();
        }
    }

    fn handle_ignored(&mut self, descriptor: i32) {
        let expected = self.expected_ignored.remove(&descriptor);
        let Some(watch) = self.watches.remove(&descriptor) else {
            return;
        };
        for interest in watch.interests {
            if let Some(state) = self.subscriptions.get_mut(&interest.subscription_id) {
                state.watched_paths.remove(&interest.path);
                if interest.path == state.root {
                    state.mark_uncertain(UncertainReason::RootReplaced, state.root.clone());
                } else if !expected {
                    state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
                }
                state.publish_resource_counts();
            }
        }
        self.publish_native_watch_count();
    }

    fn process_topology_turn(&mut self) -> bool {
        let Some(id) = self.topology_runnable.pop_front() else {
            return false;
        };
        self.topology_scheduled.remove(&id);
        let Some(mut state) = self.subscriptions.remove(&id) else {
            return true;
        };
        let mut directories = 0;
        let mut entries = 0;
        let mut establishment_failed = false;
        while directories < MAX_TOPOLOGY_DIRECTORIES_PER_TURN
            && entries < MAX_TOPOLOGY_ENTRIES_PER_TURN
        {
            let Some(mut job) = state.topology_jobs.pop_front() else {
                break;
            };
            if job.active.is_none() {
                let Some(directory) = job.directories.pop_front() else {
                    establishment_failed = self.finish_topology_job(&mut state, job.establishment);
                    if establishment_failed {
                        break;
                    }
                    continue;
                };
                directories += 1;
                match self.open_topology_directory(&mut state, directory) {
                    Some(active) => job.active = Some(active),
                    None => {
                        state.topology_jobs.push_front(job);
                        continue;
                    }
                }
            }
            let active = job.active.as_mut().expect("active topology directory");
            let mut finished = false;
            while entries < MAX_TOPOLOGY_ENTRIES_PER_TURN {
                match active.entries.next() {
                    Some(Ok(entry)) => {
                        entries += 1;
                        match entry.file_type() {
                            Ok(file_type) if file_type.is_dir() && !file_type.is_symlink() => {
                                job.directories.push_back(entry.path());
                            }
                            Ok(_) => {}
                            Err(error) => {
                                state.defer(active.path.clone(), partial_reason_for_error(&error))
                            }
                        }
                    }
                    Some(Err(error)) => {
                        entries += 1;
                        state.defer(active.path.clone(), partial_reason_for_error(&error));
                    }
                    None => {
                        if !active.deferred_at_limit {
                            state.deferred_directories.remove(&active.path);
                        }
                        finished = true;
                        break;
                    }
                }
            }
            if finished {
                job.active = None;
                if job.directories.is_empty() {
                    establishment_failed = self.finish_topology_job(&mut state, job.establishment);
                    if establishment_failed {
                        break;
                    }
                    continue;
                }
            }
            state.topology_jobs.push_front(job);
        }
        if establishment_failed {
            self.discard_unestablished(state);
            return true;
        }
        state.publish_resource_counts();
        let runnable = !state.topology_jobs.is_empty();
        self.subscriptions.insert(id, state);
        if runnable {
            self.schedule_topology(id);
        }
        true
    }

    fn open_topology_directory(
        &mut self,
        state: &mut SubscriptionState,
        directory: PathBuf,
    ) -> Option<ActiveDirectory> {
        let mut deferred_at_limit = false;
        if !state.watched_paths.contains_key(&directory) {
            let at_limit = state
                .options
                .watch_limit
                .is_some_and(|limit| state.watched_paths.len() >= limit);
            if at_limit {
                match fs::symlink_metadata(&directory) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                        deferred_at_limit = true;
                        state.defer(directory.clone(), PartialReason::ResourceLimit);
                    }
                    Ok(_) => {
                        state.remove_deferred_subtree(&directory);
                        return None;
                    }
                    Err(error) if path_is_stale_or_not_directory(&error) => {
                        state.remove_deferred_subtree(&directory);
                        return None;
                    }
                    Err(error) => {
                        state.defer(directory, partial_reason_for_error(&error));
                        return None;
                    }
                }
            } else if let Err(error) = self.add_interest(state, &directory) {
                if path_is_stale_or_not_directory(&error) {
                    state.remove_deferred_subtree(&directory);
                } else {
                    state.defer(directory, partial_reason_for_error(&error));
                }
                return None;
            }
        }
        match fs::read_dir(&directory) {
            Ok(entries) => Some(ActiveDirectory {
                path: directory,
                entries,
                deferred_at_limit,
            }),
            Err(error) if path_is_stale_or_not_directory(&error) => {
                self.remove_subscription_subtree(state, &directory);
                None
            }
            Err(error) => {
                state.defer(directory, partial_reason_for_error(&error));
                None
            }
        }
    }

    fn finish_topology_job(&mut self, state: &mut SubscriptionState, establishment: bool) -> bool {
        state.topology_barriers = state.topology_barriers.saturating_sub(1);
        if !establishment {
            return false;
        }
        let result = if !state.watched_paths.contains_key(&state.root)
            && !state.deferred_directories.contains_key(&state.root)
        {
            Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "watch root disappeared during establishment: {}",
                    state.root.display()
                ),
            ))
        } else {
            match RootIdentity::capture(&state.root) {
                Ok(identity) if identity == state.root_identity => Ok(Established {
                    id: state.id,
                    coverage: state.coverage(),
                }),
                Ok(_) | Err(_) => Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!(
                        "watch root changed during establishment: {}",
                        state.root.display()
                    ),
                )),
            }
        };
        let failed = result.is_err();
        if !failed {
            state.next_root_identity_check = Some(Instant::now() + ROOT_IDENTITY_CHECK_INTERVAL);
        }
        if let Some(establishment) = state.establishment.take() {
            let _ = establishment.acknowledgement.send(CommandAcknowledgement {
                generation: establishment.generation,
                value: result,
            });
        }
        failed
    }

    fn add_interest(&mut self, state: &mut SubscriptionState, path: &Path) -> io::Result<()> {
        let bytes = path.as_os_str().as_bytes();
        let c_path = CString::new(bytes).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("watch path contains NUL: {}", path.display()),
            )
        })?;
        // SAFETY: c_path is NUL-terminated and inotify is a live descriptor.
        let descriptor = unsafe {
            libc::inotify_add_watch(self.inotify.as_raw_fd(), c_path.as_ptr(), WATCH_MASK)
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        if self.expected_ignored.contains(&descriptor) {
            // Linux may recycle a removed watch descriptor before its queued
            // IN_IGNORED record is consumed. The later record cannot be
            // attributed safely to the old or new lifetime, so preserve the
            // new interest but make its coverage explicitly uncertain.
            state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
        }
        self.watches
            .entry(descriptor)
            .or_default()
            .interests
            .insert(Interest {
                subscription_id: state.id,
                path: path.to_path_buf(),
            });
        state.watched_paths.insert(path.to_path_buf(), descriptor);
        state.deferred_directories.remove(path);
        self.publish_native_watch_count();
        Ok(())
    }

    fn remove_subscription_subtree(&mut self, state: &mut SubscriptionState, path: &Path) {
        let interests: Vec<_> = state
            .watched_paths
            .iter()
            .filter(|(candidate, _)| candidate.starts_with(path))
            .map(|(candidate, descriptor)| (candidate.clone(), *descriptor))
            .collect();
        for (watched_path, descriptor) in interests {
            state.watched_paths.remove(&watched_path);
            self.remove_interest(state.id, &watched_path, descriptor);
        }
        state.remove_deferred_subtree(path);
        state.publish_resource_counts();
    }

    fn remove_interest(&mut self, id: SubscriptionId, path: &Path, descriptor: i32) {
        let remove_native = if let Some(watch) = self.watches.get_mut(&descriptor) {
            watch.interests.remove(&Interest {
                subscription_id: id,
                path: path.to_path_buf(),
            });
            watch.interests.is_empty()
        } else {
            false
        };
        if remove_native {
            self.watches.remove(&descriptor);
            self.expected_ignored.insert(descriptor);
            // SAFETY: inotify is live. Failure is benign when the kernel has
            // already removed the watch for a deleted inode.
            unsafe {
                libc::inotify_rm_watch(self.inotify.as_raw_fd(), descriptor);
            }
            self.publish_native_watch_count();
        }
    }

    fn remove_subscription(&mut self, id: SubscriptionId) {
        self.topology_scheduled.remove(&id);
        self.topology_runnable.retain(|candidate| *candidate != id);
        let Some(mut state) = self.subscriptions.remove(&id) else {
            return;
        };
        let interests: Vec<_> = state.watched_paths.drain().collect();
        for (path, descriptor) in interests {
            self.remove_interest(id, &path, descriptor);
        }
        state.pending_paths.clear();
        state.pending_started = None;
        state.stats.watched_directories.store(0, Ordering::Release);
        state.stats.deferred_directories.store(0, Ordering::Release);
        state.stats.disposed.store(true, Ordering::Release);
        if let Some(establishment) = state.establishment.take() {
            let _ = establishment.acknowledgement.send(CommandAcknowledgement {
                generation: establishment.generation,
                value: Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "subscription disposed during establishment",
                )),
            });
        }
        self.counters
            .subscriptions
            .store(self.subscriptions.len(), Ordering::Release);
    }

    fn discard_unestablished(&mut self, mut state: SubscriptionState) {
        self.topology_scheduled.remove(&state.id);
        self.topology_runnable
            .retain(|candidate| *candidate != state.id);
        let interests: Vec<_> = state.watched_paths.drain().collect();
        for (path, descriptor) in interests {
            self.remove_interest(state.id, &path, descriptor);
        }
        state.stats.watched_directories.store(0, Ordering::Release);
        state.stats.deferred_directories.store(0, Ordering::Release);
        self.counters
            .subscriptions
            .store(self.subscriptions.len(), Ordering::Release);
    }

    fn shutdown_all_subscriptions(&mut self) {
        let ids: Vec<_> = self.subscriptions.keys().copied().collect();
        for id in ids {
            self.remove_subscription(id);
        }
    }

    fn schedule_topology(&mut self, id: SubscriptionId) {
        if self.topology_scheduled.insert(id) {
            self.topology_runnable.push_back(id);
        }
    }

    fn run_maintenance(&mut self) {
        let now = Instant::now();
        for state in self.subscriptions.values_mut() {
            if state.next_root_identity_check.is_some_and(|due| now >= due) {
                match RootIdentity::capture(&state.root) {
                    Ok(identity) if identity == state.root_identity => {
                        state.next_root_identity_check = Some(now + ROOT_IDENTITY_CHECK_INTERVAL);
                    }
                    Ok(_) | Err(_) => {
                        state.next_root_identity_check = None;
                        state.mark_uncertain(UncertainReason::RootReplaced, state.root.clone());
                    }
                }
            }
            state.flush_if_due();
        }
    }

    fn poll_timeout(&self) -> Duration {
        let now = Instant::now();
        self.subscriptions
            .values()
            .fold(MAX_POLL_INTERVAL, |timeout, state| {
                let batch = state.pending_started.map_or(MAX_POLL_INTERVAL, |started| {
                    state.options.batch_window.saturating_sub(started.elapsed())
                });
                let identity = state
                    .next_root_identity_check
                    .map_or(MAX_POLL_INTERVAL, |due| due.saturating_duration_since(now));
                timeout.min(batch).min(identity)
            })
    }

    fn poll(&mut self, timeout: Duration) {
        let mut descriptors = [
            libc::pollfd {
                fd: self.inotify.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: self.wakeup.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let timeout_ms = timeout.as_millis().min(i32::MAX as u128) as i32;
        // SAFETY: descriptors contains two initialized pollfd values for the
        // duration of the call.
        let result = unsafe { libc::poll(descriptors.as_mut_ptr(), 2, timeout_ms) };
        if result < 0 {
            if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                self.mark_all_uncertain(UncertainReason::TopologyRace);
            }
            return;
        }
        if descriptors[1].revents & libc::POLLIN != 0 {
            self.drain_wakeup();
        }
        if descriptors.iter().any(|descriptor| {
            descriptor.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0
        }) {
            self.mark_all_uncertain(UncertainReason::TopologyRace);
        }
    }

    fn drain_wakeup(&self) {
        let mut value = 0_u64;
        // SAFETY: wakeup is a live eventfd and value is valid for eight bytes.
        let read = unsafe {
            libc::read(
                self.wakeup.as_raw_fd(),
                (&mut value as *mut u64).cast(),
                std::mem::size_of::<u64>(),
            )
        };
        if read < 0 && io::Error::last_os_error().kind() != io::ErrorKind::WouldBlock {
            // A failed command wakeup cannot invalidate filesystem coverage;
            // bounded polling still observes the command channel.
        }
    }

    fn mark_all_uncertain(&mut self, reason: UncertainReason) {
        for state in self.subscriptions.values_mut() {
            state.mark_uncertain(reason, state.root.clone());
        }
    }

    fn publish_native_watch_count(&self) {
        self.counters
            .native_watches
            .store(self.watches.len(), Ordering::Release);
    }
}

struct ParsedEvent {
    descriptor: i32,
    mask: u32,
    name: Option<std::ffi::OsString>,
}

fn path_is_stale_or_not_directory(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP)
    )
}

fn partial_priority(reason: PartialReason) -> u8 {
    match reason {
        PartialReason::TransientError => 1,
        PartialReason::ResourceLimit => 2,
        PartialReason::Permission => 3,
    }
}

fn uncertainty_priority(reason: UncertainReason) -> u8 {
    match reason {
        UncertainReason::ConsumerBackpressure => 1,
        UncertainReason::TopologyRace => 2,
        UncertainReason::RootReplaced => 3,
        UncertainReason::EventOverflow => 4,
    }
}

fn partial_reason_for_error(error: &io::Error) -> PartialReason {
    if error.kind() == io::ErrorKind::PermissionDenied {
        return PartialReason::Permission;
    }
    match error.raw_os_error() {
        Some(libc::ENOSPC | libc::EMFILE | libc::ENFILE | libc::ENOMEM) => {
            PartialReason::ResourceLimit
        }
        _ => PartialReason::TransientError,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let serial = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "watchbound-runtime-unit-{label}-{}-{nonce}-{serial}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn state(
        root: &Path,
        options: SubscriptionOptions,
    ) -> (SubscriptionState, Receiver<ChangeBatch>) {
        let stats = Arc::new(SharedStats::new());
        let (output, receiver) = mpsc::sync_channel(options.output_queue_capacity);
        let (acknowledgement, _acknowledged) = mpsc::sync_channel(1);
        let mut state = SubscriptionState::new(
            1,
            root.to_path_buf(),
            RootIdentity::capture(root).unwrap(),
            options,
            stats,
            output,
            PendingEstablishment {
                generation: 0,
                acknowledgement,
            },
        );
        state.topology_jobs.clear();
        state.topology_barriers = 0;
        state.establishment = None;
        (state, receiver)
    }

    #[test]
    fn native_overflow_marks_every_subscription_uncertain() {
        let root = TestRoot::new("overflow");
        let (state, _receiver) = state(&root.0, SubscriptionOptions::default());
        let (_commands, command_receiver) = mpsc::channel();
        let mut worker = Worker::new(
            create_inotify().unwrap(),
            Arc::new(create_eventfd().unwrap()),
            command_receiver,
            Arc::new(RuntimeCounters::default()),
        );
        worker.subscriptions.insert(state.id, state);

        worker.handle_native_event(ParsedEvent {
            descriptor: -1,
            mask: libc::IN_Q_OVERFLOW,
            name: None,
        });

        let state = worker.subscriptions.get(&1).unwrap();
        assert_eq!(
            state.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::EventOverflow
            }
        );
        assert!(state.pending_paths.contains(&root.0));
        assert_eq!(state.stats.overflow_events.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn full_output_queue_collapses_only_that_subscription_to_its_root() {
        let root = TestRoot::new("backpressure");
        let options = SubscriptionOptions {
            output_queue_capacity: 1,
            ..SubscriptionOptions::default()
        };
        let (mut state, receiver) = state(&root.0, options);

        state.queue_path(root.0.join("first"));
        state.flush();
        state.queue_path(root.0.join("second"));
        state.flush();

        assert!(receiver.try_recv().is_ok());
        assert_eq!(
            state.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::ConsumerBackpressure
            }
        );
        assert_eq!(state.pending_paths, BTreeSet::from([root.0.clone()]));
        assert_eq!(state.stats.batches_dropped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn stronger_uncertainty_is_not_replaced_by_backpressure() {
        let root = TestRoot::new("uncertainty-priority");
        let (mut state, _receiver) = state(&root.0, SubscriptionOptions::default());
        state.mark_uncertain(UncertainReason::EventOverflow, root.0.clone());
        state.mark_uncertain(UncertainReason::ConsumerBackpressure, root.0.clone());
        assert_eq!(
            state.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::EventOverflow
            }
        );
    }
}
