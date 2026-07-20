use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::ffi::CString;
use std::fs;
use std::io;
use std::ops::Bound::{Excluded, Unbounded};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::{
    ChangeBatch, Coverage, PartialReason, ReconciliationResult, RootAttachment, RootIdentity,
    RootIdentityPolicy, RootLossEvidence, RootRecoveryAttachment, RootRecoveryFailureReason,
    RootRecoveryResult, RootState, RuntimeStats, SharedStats, SubscriptionOptions, UncertainReason,
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
const MAX_ALLOCATOR_SUBSCRIPTIONS_PER_TURN: usize = 16;
const MAX_DEFERRED_CANDIDATES_PER_TURN: usize = 64;

type SubscriptionId = u64;

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
    deferred_interests: AtomicUsize,
    subscriptions: AtomicUsize,
}

impl RuntimeCounters {
    fn snapshot(&self) -> RuntimeStats {
        RuntimeStats {
            inotify_instances: self.inotify_instances.load(Ordering::Acquire),
            worker_threads: self.worker_threads.load(Ordering::Acquire),
            native_watches: self.native_watches.load(Ordering::Acquire),
            native_watch_budget: None,
            deferred_interests: self.deferred_interests.load(Ordering::Acquire),
            subscriptions: self.subscriptions.load(Ordering::Acquire),
        }
    }
}

pub(crate) struct EstablishedSubscription {
    pub(crate) id: SubscriptionId,
    pub(crate) initial_coverage: Coverage,
    pub(crate) receiver: Receiver<ChangeBatch>,
    pub(crate) root_state: Arc<Mutex<RootState>>,
}

pub(crate) struct Runtime {
    commands: mpsc::Sender<CommandEnvelope>,
    wakeup: Arc<OwnedFd>,
    worker: Mutex<Option<JoinHandle<()>>>,
    counters: Arc<RuntimeCounters>,
    native_watch_budget: Option<usize>,
    leases: AtomicUsize,
    shutting_down: AtomicBool,
}

impl Runtime {
    pub(crate) fn start(native_watch_budget: Option<usize>) -> io::Result<Arc<Self>> {
        let inotify = create_inotify()?;
        let wakeup = Arc::new(create_eventfd()?);
        let (commands, command_receiver) = mpsc::channel();
        let counters = Arc::new(RuntimeCounters::default());
        let worker_wakeup = Arc::clone(&wakeup);
        let worker_counters = Arc::clone(&counters);
        let worker = std::thread::Builder::new()
            .name("watchbound-linux-runtime".to_owned())
            .spawn(move || {
                Worker::new(
                    inotify,
                    worker_wakeup,
                    command_receiver,
                    worker_counters,
                    native_watch_budget,
                )
                .run();
            })?;
        counters.inotify_instances.store(1, Ordering::Release);
        counters.worker_threads.store(1, Ordering::Release);
        Ok(Arc::new(Self {
            commands,
            wakeup,
            worker: Mutex::new(Some(worker)),
            counters,
            native_watch_budget,
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

    pub(crate) const fn native_watch_budget(&self) -> Option<usize> {
        self.native_watch_budget
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
            root_state: established.root_state,
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

    pub(crate) fn queue_replace_exclusions(
        &self,
        id: SubscriptionId,
        generation: u64,
        prefixes: Vec<PathBuf>,
    ) -> io::Result<PendingExclusionAcknowledgement> {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        self.send(CommandEnvelope {
            generation,
            command: Command::ReplaceExclusions {
                subscription_id: id,
                prefixes,
                acknowledgement,
            },
        })?;
        Ok(PendingExclusionAcknowledgement {
            generation,
            acknowledged,
        })
    }

    pub(crate) fn queue_reconciliation(
        &self,
        id: SubscriptionId,
    ) -> io::Result<PendingReconciliationAcknowledgement> {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        self.send(CommandEnvelope {
            generation: 0,
            command: Command::Reconcile {
                subscription_id: id,
                acknowledgement,
            },
        })?;
        Ok(PendingReconciliationAcknowledgement { acknowledged })
    }

    pub(crate) fn queue_root_recovery(
        &self,
        id: SubscriptionId,
        identity_policy: RootIdentityPolicy,
    ) -> io::Result<PendingRootRecoveryAcknowledgement> {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        self.send(CommandEnvelope {
            generation: 0,
            command: Command::RecoverRoot {
                subscription_id: id,
                identity_policy,
                acknowledgement,
            },
        })?;
        Ok(PendingRootRecoveryAcknowledgement { acknowledged })
    }

    pub(crate) fn stats(&self) -> RuntimeStats {
        RuntimeStats {
            native_watch_budget: self.native_watch_budget,
            ..self.counters.snapshot()
        }
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

pub(crate) struct PendingExclusionAcknowledgement {
    generation: u64,
    acknowledged: Receiver<CommandAcknowledgement<io::Result<Coverage>>>,
}

impl PendingExclusionAcknowledgement {
    pub(crate) fn wait(self) -> io::Result<Coverage> {
        let acknowledged = self
            .acknowledged
            .recv()
            .map_err(|_| io::Error::other("shared runtime stopped during exclusion update"))?;
        if acknowledged.generation != self.generation {
            return Err(io::Error::other(
                "shared runtime acknowledged the wrong exclusion generation",
            ));
        }
        acknowledged.value
    }
}

pub(crate) struct PendingReconciliationAcknowledgement {
    acknowledged: Receiver<CommandAcknowledgement<io::Result<ReconciliationResult>>>,
}

pub(crate) struct PendingRootRecoveryAcknowledgement {
    acknowledged: Receiver<CommandAcknowledgement<io::Result<RootRecoveryResult>>>,
}

impl PendingRootRecoveryAcknowledgement {
    pub(crate) fn wait(self) -> io::Result<RootRecoveryResult> {
        let acknowledged = self
            .acknowledged
            .recv()
            .map_err(|_| io::Error::other("shared runtime stopped during root recovery"))?;
        if acknowledged.generation != 0 {
            return Err(io::Error::other(
                "shared runtime acknowledged the wrong root recovery generation",
            ));
        }
        acknowledged.value
    }
}

impl PendingReconciliationAcknowledgement {
    pub(crate) fn wait(self) -> io::Result<ReconciliationResult> {
        let acknowledged = self
            .acknowledged
            .recv()
            .map_err(|_| io::Error::other("shared runtime stopped during reconciliation"))?;
        if acknowledged.generation != 0 {
            return Err(io::Error::other(
                "shared runtime acknowledged the wrong reconciliation generation",
            ));
        }
        acknowledged.value
    }
}

impl Runtime {
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
    ReplaceExclusions {
        subscription_id: SubscriptionId,
        prefixes: Vec<PathBuf>,
        acknowledgement: SyncSender<CommandAcknowledgement<io::Result<Coverage>>>,
    },
    Reconcile {
        subscription_id: SubscriptionId,
        acknowledgement: SyncSender<CommandAcknowledgement<io::Result<ReconciliationResult>>>,
    },
    RecoverRoot {
        subscription_id: SubscriptionId,
        identity_policy: RootIdentityPolicy,
        acknowledgement: SyncSender<CommandAcknowledgement<io::Result<RootRecoveryResult>>>,
    },
    Shutdown {
        acknowledgement: SyncSender<CommandAcknowledgement<()>>,
    },
}

struct Established {
    id: SubscriptionId,
    coverage: Coverage,
    root_state: Arc<Mutex<RootState>>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Interest {
    subscription_id: SubscriptionId,
    path: PathBuf,
}

#[derive(Default)]
struct NativeWatch {
    identity: Option<RootIdentity>,
    interests: BTreeSet<Interest>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DeferredCause {
    SubscriptionLimit,
    RuntimeBudget,
    NativeResource,
    Permission,
    TransientError,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DeferredInterest {
    reason: PartialReason,
    cause: DeferredCause,
}

struct SubscriptionState {
    id: SubscriptionId,
    root: PathBuf,
    root_identity: RootIdentity,
    root_generation: u64,
    root_lost: bool,
    root_loss_evidence: Option<RootLossEvidence>,
    published_root_state: Arc<Mutex<RootState>>,
    next_root_identity_check: Option<Instant>,
    options: SubscriptionOptions,
    stats: Arc<SharedStats>,
    output: SyncSender<ChangeBatch>,
    watched_paths: BTreeMap<PathBuf, i32>,
    deferred_directories: BTreeMap<PathBuf, DeferredInterest>,
    deferred_order: VecDeque<PathBuf>,
    pending_promotions: BTreeSet<PathBuf>,
    uncertain_reason: Option<UncertainReason>,
    pending_paths: BTreeSet<PathBuf>,
    pending_started: Option<Instant>,
    pending_generation: Option<u64>,
    next_sequence: u64,
    exclusion_generation: u64,
    selection_generation: u64,
    exclusions: BTreeSet<PathBuf>,
    exclusion_update: Option<PendingExclusionUpdate>,
    reconciliation: Option<PendingReconciliation>,
    root_recovery: Option<PendingRootRecovery>,
    topology_jobs: VecDeque<TopologyJob>,
    topology_barriers: usize,
    establishment: Option<PendingEstablishment>,
    uncertainty_epoch: u64,
}

struct PendingEstablishment {
    generation: u64,
    acknowledgement: SyncSender<CommandAcknowledgement<io::Result<Established>>>,
}

struct PendingExclusionUpdate {
    generation: u64,
    exclusions: BTreeSet<PathBuf>,
    previous_exclusions: BTreeSet<PathBuf>,
    newly_excluded: VecDeque<PathBuf>,
    newly_included: Vec<PathBuf>,
    acknowledgement: SyncSender<CommandAcknowledgement<io::Result<Coverage>>>,
    phase: ExclusionUpdatePhase,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExclusionUpdatePhase {
    WaitingForTopology,
    RemovingExcluded,
    ScanningIncluded,
}

struct PendingReconciliation {
    acknowledgement: SyncSender<CommandAcknowledgement<io::Result<ReconciliationResult>>>,
    phase: ReconciliationPhase,
    encountered: BTreeSet<PathBuf>,
    sweep_after: Option<PathBuf>,
    rebuilt_deferred_order: VecDeque<PathBuf>,
    starting_uncertainty: Option<UncertainReason>,
    starting_uncertainty_epoch: u64,
}

struct PendingRootRecovery {
    acknowledgement: SyncSender<CommandAcknowledgement<io::Result<RootRecoveryResult>>>,
    phase: RootRecoveryPhase,
    previous_root_state: RootState,
    candidate_identity: RootIdentity,
    starting_uncertainty: Option<UncertainReason>,
    starting_uncertainty_epoch: u64,
    candidate_unstable: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RootRecoveryPhase {
    RemovingOld,
    Scanning,
    CleaningFailure(RootRecoveryFailureReason),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReconciliationPhase {
    WaitingForTopology,
    Scanning,
    SweepingWatched,
    SweepingDeferred,
    SweepingDeferredOrder,
    SweepingPromotions,
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
        let initial_root_state = RootState {
            generation: 0,
            identity: root_identity,
            attachment: RootAttachment::Attached,
            loss_evidence: None,
        };
        Self {
            id,
            root: root.clone(),
            root_identity,
            root_generation: 0,
            root_lost: false,
            root_loss_evidence: None,
            published_root_state: Arc::new(Mutex::new(initial_root_state)),
            next_root_identity_check: None,
            options,
            stats,
            output,
            watched_paths: BTreeMap::new(),
            deferred_directories: BTreeMap::new(),
            deferred_order: VecDeque::new(),
            pending_promotions: BTreeSet::new(),
            uncertain_reason: None,
            pending_paths: BTreeSet::new(),
            pending_started: None,
            pending_generation: None,
            next_sequence: 1,
            exclusion_generation: 0,
            selection_generation: 0,
            exclusions: BTreeSet::new(),
            exclusion_update: None,
            reconciliation: None,
            root_recovery: None,
            topology_jobs: VecDeque::from([TopologyJob::new(root, true)]),
            topology_barriers: 1,
            establishment: Some(establishment),
            uncertainty_epoch: 0,
        }
    }

    fn coverage(&self) -> Coverage {
        if let Some(reason) = self.uncertain_reason {
            Coverage::Uncertain { reason }
        } else {
            self.coverage_without_uncertainty()
        }
    }

    fn root_state(&self) -> RootState {
        RootState {
            generation: self.root_generation,
            identity: self.root_identity,
            attachment: if self.root_lost {
                RootAttachment::Lost
            } else {
                RootAttachment::Attached
            },
            loss_evidence: self.root_loss_evidence,
        }
    }

    fn publish_root_state(&self) {
        *self
            .published_root_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = self.root_state();
    }

    fn not_attached_result(
        &self,
        previous_root_state: RootState,
        candidate_identity: Option<RootIdentity>,
        reason: RootRecoveryFailureReason,
    ) -> RootRecoveryResult {
        RootRecoveryResult {
            attachment: RootRecoveryAttachment::NotAttached,
            reason: Some(reason),
            previous_root_state,
            candidate_identity,
            current_root_state: self.root_state(),
            exclusion_generation: self.exclusion_generation,
            coverage: self.coverage(),
            boundary_sequence: None,
        }
    }

    fn mark_root_lost(&mut self, evidence: RootLossEvidence) {
        self.root_loss_evidence = Some(match self.root_loss_evidence {
            None => evidence,
            Some(current) if current == evidence => current,
            Some(_) => RootLossEvidence::Multiple,
        });
        self.root_lost = true;
        if let Some(recovery) = self.root_recovery.as_mut() {
            recovery.candidate_unstable = true;
        } else {
            self.topology_barriers = 0;
            if let Some(update) = self.exclusion_update.take() {
                self.exclusions = update.previous_exclusions;
                self.selection_generation = self.exclusion_generation;
                let _ = update.acknowledgement.send(CommandAcknowledgement {
                    generation: update.generation,
                    value: Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "root identity was lost during exclusion update",
                    )),
                });
            }
            if let Some(reconciliation) = self.reconciliation.take() {
                let _ = reconciliation.acknowledgement.send(CommandAcknowledgement {
                    generation: 0,
                    value: Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "root identity was lost during reconciliation",
                    )),
                });
            }
        }
        self.mark_uncertain(UncertainReason::RootReplaced, self.root.clone());
        self.publish_resource_counts();
        self.publish_root_state();
    }

    fn coverage_without_uncertainty(&self) -> Coverage {
        if let Some(reason) = self.current_partial_reason() {
            Coverage::Partial {
                reason,
                watched_directories: self.watched_paths.len(),
                deferred_directories: self.deferred_count(),
            }
        } else {
            Coverage::Complete
        }
    }

    fn queue_path(&mut self, path: PathBuf) {
        match self.pending_generation {
            Some(generation) if generation != self.selection_generation => {
                self.pending_paths.clear();
                self.pending_paths.insert(self.root.clone());
                self.pending_generation = Some(self.selection_generation);
                self.uncertain_reason = Some(UncertainReason::TopologyRace);
            }
            Some(_) => {}
            None => self.pending_generation = Some(self.selection_generation),
        }
        if path == self.root {
            self.pending_paths.clear();
            self.pending_paths.insert(path);
        } else if !self.pending_paths.contains(&self.root) {
            self.pending_paths.insert(path);
        }
        self.pending_started.get_or_insert_with(Instant::now);
    }

    fn mark_uncertain(&mut self, reason: UncertainReason, invalidated_path: PathBuf) {
        self.uncertainty_epoch = self.uncertainty_epoch.saturating_add(1);
        self.uncertain_reason = Some(match self.uncertain_reason {
            Some(current) if uncertainty_priority(current) >= uncertainty_priority(reason) => {
                current
            }
            _ => reason,
        });
        self.queue_path(invalidated_path);
    }

    fn defer(&mut self, path: PathBuf, reason: PartialReason, cause: DeferredCause) {
        if !self.deferred_directories.contains_key(&path) {
            self.deferred_order.push_back(path.clone());
        }
        self.deferred_directories
            .entry(path)
            .and_modify(|current| {
                if partial_priority(reason) > partial_priority(current.reason) {
                    *current = DeferredInterest { reason, cause };
                }
            })
            .or_insert(DeferredInterest { reason, cause });
    }

    fn defer_error(&mut self, path: PathBuf, error: &io::Error) {
        let reason = partial_reason_for_error(error);
        let cause = match reason {
            PartialReason::Permission => DeferredCause::Permission,
            PartialReason::ResourceLimit => DeferredCause::NativeResource,
            PartialReason::TransientError => DeferredCause::TransientError,
        };
        self.defer(path, reason, cause);
    }

    fn remove_deferred_subtree(&mut self, path: &Path) {
        self.deferred_directories
            .retain(|candidate, _| !candidate.starts_with(path));
        self.deferred_order
            .retain(|candidate| !candidate.starts_with(path));
    }

    fn current_partial_reason(&self) -> Option<PartialReason> {
        self.deferred_directories
            .values()
            .map(|deferred| deferred.reason)
            .chain((!self.pending_promotions.is_empty()).then_some(PartialReason::ResourceLimit))
            .max_by_key(|reason| partial_priority(*reason))
    }

    fn deferred_count(&self) -> usize {
        self.deferred_directories.len()
            + self
                .pending_promotions
                .iter()
                .filter(|path| !self.deferred_directories.contains_key(*path))
                .count()
    }

    fn publish_resource_counts(&self) {
        self.stats
            .watched_directories
            .store(self.watched_paths.len(), Ordering::Release);
        self.stats
            .deferred_directories
            .store(self.deferred_count(), Ordering::Release);
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
            exclusion_generation: self
                .pending_generation
                .take()
                .unwrap_or(self.selection_generation),
            root_state: self.root_state(),
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

    fn is_excluded(&self, path: &Path) -> bool {
        self.exclusions
            .iter()
            .any(|prefix| path.starts_with(prefix))
    }
}

struct TopologyJob {
    directories: VecDeque<PathBuf>,
    active: Option<ActiveDirectory>,
    establishment: bool,
    promotion_root: Option<PathBuf>,
    yield_after_promoted_watch: bool,
    require_watch_before_read: bool,
    reconciliation: bool,
}

impl TopologyJob {
    fn new(start: PathBuf, establishment: bool) -> Self {
        Self {
            directories: VecDeque::from([start]),
            active: None,
            establishment,
            promotion_root: None,
            yield_after_promoted_watch: false,
            require_watch_before_read: !establishment,
            reconciliation: false,
        }
    }

    fn inclusion(start: PathBuf) -> Self {
        Self {
            directories: VecDeque::from([start]),
            active: None,
            establishment: false,
            promotion_root: None,
            yield_after_promoted_watch: false,
            require_watch_before_read: true,
            reconciliation: false,
        }
    }

    fn promotion(path: PathBuf, active: ActiveDirectory) -> Self {
        Self {
            directories: VecDeque::new(),
            active: Some(active),
            establishment: false,
            promotion_root: Some(path),
            yield_after_promoted_watch: true,
            require_watch_before_read: true,
            reconciliation: false,
        }
    }

    fn reconciliation(start: PathBuf) -> Self {
        Self {
            directories: VecDeque::from([start]),
            active: None,
            establishment: false,
            promotion_root: None,
            yield_after_promoted_watch: false,
            require_watch_before_read: true,
            reconciliation: true,
        }
    }

    fn root_recovery(active: ActiveDirectory) -> Self {
        Self {
            directories: VecDeque::new(),
            active: Some(active),
            establishment: false,
            promotion_root: None,
            yield_after_promoted_watch: true,
            require_watch_before_read: true,
            reconciliation: false,
        }
    }
}

struct ActiveDirectory {
    path: PathBuf,
    entries: fs::ReadDir,
    deferred_at_limit: bool,
}

struct OpenedDirectory {
    active: ActiveDirectory,
    created_native_watch: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InterestAllocation {
    Added { created_native_watch: bool },
    RuntimeBudgetExhausted,
}

struct Worker {
    inotify: OwnedFd,
    wakeup: Arc<OwnedFd>,
    commands: mpsc::Receiver<CommandEnvelope>,
    counters: Arc<RuntimeCounters>,
    native_watch_budget: Option<usize>,
    subscriptions: HashMap<SubscriptionId, SubscriptionState>,
    watches: HashMap<i32, NativeWatch>,
    watch_identities: HashMap<RootIdentity, i32>,
    expected_ignored: BTreeSet<i32>,
    topology_runnable: VecDeque<SubscriptionId>,
    topology_scheduled: BTreeSet<SubscriptionId>,
    allocator_order: VecDeque<SubscriptionId>,
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
        native_watch_budget: Option<usize>,
    ) -> Self {
        Self {
            inotify,
            wakeup,
            commands,
            counters,
            native_watch_budget,
            subscriptions: HashMap::new(),
            watches: HashMap::new(),
            watch_identities: HashMap::new(),
            expected_ignored: BTreeSet::new(),
            topology_runnable: VecDeque::new(),
            topology_scheduled: BTreeSet::new(),
            allocator_order: VecDeque::new(),
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
            let promotion = self.process_promotion_turn();
            let topology = self.process_topology_turn();
            self.run_maintenance();
            if self.shutting_down {
                break;
            }
            let immediate = commands == MAX_COMMANDS_PER_TURN
                || native
                || promotion
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
        self.watch_identities.clear();
        self.allocator_order.clear();
        self.counters.native_watches.store(0, Ordering::Release);
        self.counters.deferred_interests.store(0, Ordering::Release);
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
                    self.allocator_order.push_back(id);
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
                Command::ReplaceExclusions {
                    subscription_id,
                    prefixes,
                    acknowledgement,
                } => {
                    let Some(mut state) = self.subscriptions.remove(&subscription_id) else {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(io::Error::new(
                                io::ErrorKind::NotConnected,
                                "subscription is no longer active",
                            )),
                        });
                        continue;
                    };
                    let validation = if generation <= state.exclusion_generation {
                        Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            format!(
                                "exclusion generation {generation} is not newer than committed generation {}",
                                state.exclusion_generation
                            ),
                        ))
                    } else if state.root_lost {
                        Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "root identity is lost; recover the root before replacing exclusions",
                        ))
                    } else if state.exclusion_update.is_some()
                        || state.reconciliation.is_some()
                        || state.root_recovery.is_some()
                    {
                        Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            "a topology transaction is already in progress for this subscription",
                        ))
                    } else {
                        validate_exclusion_prefixes(&state.root, prefixes)
                    };
                    match validation {
                        Err(error) => {
                            let _ = acknowledgement.send(CommandAcknowledgement {
                                generation,
                                value: Err(error),
                            });
                        }
                        Ok(exclusions) => {
                            let newly_excluded = exclusions
                                .iter()
                                .filter(|new| {
                                    !state.exclusions.iter().any(|old| new.starts_with(old))
                                })
                                .cloned()
                                .collect();
                            let newly_included = state
                                .exclusions
                                .iter()
                                .filter(|old| !exclusions.iter().any(|new| old.starts_with(new)))
                                .cloned()
                                .collect();
                            state.exclusion_update = Some(PendingExclusionUpdate {
                                generation,
                                exclusions,
                                previous_exclusions: state.exclusions.clone(),
                                newly_excluded,
                                newly_included,
                                acknowledgement,
                                phase: ExclusionUpdatePhase::WaitingForTopology,
                            });
                            self.progress_exclusion_update(&mut state);
                        }
                    }
                    let runnable = !state.topology_jobs.is_empty()
                        || state.exclusion_update.as_ref().is_some_and(|update| {
                            update.phase != ExclusionUpdatePhase::WaitingForTopology
                        });
                    self.subscriptions.insert(subscription_id, state);
                    self.publish_deferred_interest_count();
                    if runnable {
                        self.schedule_topology(subscription_id);
                    }
                }
                Command::Reconcile {
                    subscription_id,
                    acknowledgement,
                } => {
                    let Some(mut state) = self.subscriptions.remove(&subscription_id) else {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(io::Error::new(
                                io::ErrorKind::NotConnected,
                                "subscription is no longer active",
                            )),
                        });
                        continue;
                    };
                    if state.exclusion_update.is_some()
                        || state.reconciliation.is_some()
                        || state.root_recovery.is_some()
                    {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(io::Error::new(
                                io::ErrorKind::WouldBlock,
                                "a topology transaction is already in progress for this subscription",
                            )),
                        });
                    } else if state.root_lost {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "root-replaced uncertainty is not recoverable by reconciliation",
                            )),
                        });
                    } else {
                        state.reconciliation = Some(PendingReconciliation {
                            acknowledgement,
                            phase: ReconciliationPhase::WaitingForTopology,
                            encountered: BTreeSet::new(),
                            sweep_after: None,
                            rebuilt_deferred_order: VecDeque::new(),
                            starting_uncertainty: None,
                            starting_uncertainty_epoch: 0,
                        });
                        self.progress_reconciliation(&mut state);
                    }
                    let runnable =
                        !state.topology_jobs.is_empty() || reconciliation_runnable(&state);
                    self.subscriptions.insert(subscription_id, state);
                    if runnable {
                        self.schedule_topology(subscription_id);
                    }
                }
                Command::RecoverRoot {
                    subscription_id,
                    identity_policy,
                    acknowledgement,
                } => {
                    let Some(mut state) = self.subscriptions.remove(&subscription_id) else {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(io::Error::new(
                                io::ErrorKind::NotConnected,
                                "subscription is no longer active",
                            )),
                        });
                        continue;
                    };
                    if state.exclusion_update.is_some()
                        || state.reconciliation.is_some()
                        || state.root_recovery.is_some()
                    {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(io::Error::new(
                                io::ErrorKind::WouldBlock,
                                "a topology transaction is already in progress for this subscription",
                            )),
                        });
                    } else if !state.root_lost {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(io::Error::new(
                                io::ErrorKind::InvalidInput,
                                "root identity is still attached",
                            )),
                        });
                    } else {
                        let previous_root_state = state.root_state();
                        match capture_root_candidate(&state.root) {
                            Err(reason) => {
                                let result =
                                    state.not_attached_result(previous_root_state, None, reason);
                                let _ = acknowledgement.send(CommandAcknowledgement {
                                    generation,
                                    value: Ok(result),
                                });
                            }
                            Ok(candidate_identity)
                                if identity_policy == RootIdentityPolicy::OriginalOnly
                                    && candidate_identity != state.root_identity =>
                            {
                                let result = state.not_attached_result(
                                    previous_root_state,
                                    Some(candidate_identity),
                                    RootRecoveryFailureReason::ReplacementNotAccepted,
                                );
                                let _ = acknowledgement.send(CommandAcknowledgement {
                                    generation,
                                    value: Ok(result),
                                });
                            }
                            Ok(candidate_identity) => {
                                state.flush();
                                state.pending_paths.clear();
                                state.pending_started = None;
                                state.pending_generation = None;
                                state.topology_barriers = 1;
                                state.root_recovery = Some(PendingRootRecovery {
                                    acknowledgement,
                                    phase: RootRecoveryPhase::RemovingOld,
                                    previous_root_state,
                                    candidate_identity,
                                    starting_uncertainty: state.uncertain_reason,
                                    starting_uncertainty_epoch: state.uncertainty_epoch,
                                    candidate_unstable: false,
                                });
                                self.progress_root_recovery(&mut state);
                            }
                        }
                    }
                    let runnable =
                        !state.topology_jobs.is_empty() || root_recovery_runnable(&state);
                    self.subscriptions.insert(subscription_id, state);
                    self.publish_deferred_interest_count();
                    if runnable {
                        self.schedule_topology(subscription_id);
                    }
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
        if self.has_blocking_topology_pressure() {
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
                if self.has_blocking_topology_pressure() {
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

    fn has_blocking_topology_pressure(&self) -> bool {
        self.subscriptions.values().any(|state| {
            state.exclusion_update.is_none()
                && state.reconciliation.is_none()
                && state.root_recovery.is_none()
                && state.topology_barriers > 0
                && state.pending_paths.len() >= state.options.max_batch_paths
        })
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
        if state.is_excluded(&event_path) {
            return;
        }
        if mask & libc::IN_UNMOUNT != 0 {
            state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
            return;
        }
        if mask & libc::IN_DELETE_SELF != 0 {
            if directory == state.root {
                state.mark_root_lost(RootLossEvidence::RootSelfEvent);
            } else {
                self.expected_ignored.insert(descriptor);
            }
        } else if mask & libc::IN_MOVE_SELF != 0 && directory == state.root {
            state.mark_root_lost(RootLossEvidence::RootSelfEvent);
        }
        if (state.exclusion_update.is_some()
            || state.reconciliation.is_some()
            || state.root_recovery.is_some())
            && state.topology_barriers > 0
            && state.pending_paths.len() >= state.options.max_batch_paths
            && !state.pending_paths.contains(&event_path)
            && !state.pending_paths.contains(&state.root)
        {
            state.mark_uncertain(UncertainReason::ConsumerBackpressure, state.root.clone());
        } else {
            if state.reconciliation.is_some() || state.root_recovery.is_some() || state.root_lost {
                state.queue_path(state.root.clone());
            } else {
                state.queue_path(event_path.clone());
            }
        }
        if state.root_lost && state.root_recovery.is_none() {
            return;
        }
        if mask & libc::IN_ISDIR != 0 {
            if mask & (libc::IN_MOVED_FROM | libc::IN_DELETE) != 0 {
                self.remove_subscription_subtree(state, &event_path);
            }
            if mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0 {
                if let Some(reconciliation) = state.reconciliation.as_mut()
                    && reconciliation.phase != ReconciliationPhase::WaitingForTopology
                {
                    reconciliation.phase = ReconciliationPhase::Scanning;
                    reconciliation.sweep_after = None;
                }
                state.stats.topology_scans.fetch_add(1, Ordering::Relaxed);
                state.topology_jobs.push_back(
                    if state.reconciliation.is_some() || state.root_recovery.is_some() {
                        TopologyJob::reconciliation(event_path)
                    } else {
                        TopologyJob::new(event_path, false)
                    },
                );
                state.topology_barriers += 1;
                self.schedule_topology(state.id);
            }
        }
        if state.pending_paths.len() >= state.options.max_batch_paths
            && state.topology_barriers == 0
        {
            state.flush();
        }
        if state
            .root_recovery
            .as_ref()
            .is_some_and(|recovery| recovery.candidate_unstable)
        {
            self.schedule_topology(state.id);
        }
    }

    fn handle_ignored(&mut self, descriptor: i32) {
        let expected = self.expected_ignored.remove(&descriptor);
        let Some(watch) = self.watches.remove(&descriptor) else {
            return;
        };
        self.watch_identities
            .retain(|_, candidate| *candidate != descriptor);
        let mut schedule = Vec::new();
        for interest in watch.interests {
            if let Some(state) = self.subscriptions.get_mut(&interest.subscription_id) {
                state.watched_paths.remove(&interest.path);
                if interest.path == state.root {
                    state.mark_root_lost(RootLossEvidence::RootWatchLoss);
                } else if !expected {
                    state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
                }
                if state.exclusion_update.is_none()
                    && state.reconciliation.is_none()
                    && state.root_recovery.is_none()
                {
                    state.publish_resource_counts();
                }
                if state
                    .root_recovery
                    .as_ref()
                    .is_some_and(|recovery| recovery.candidate_unstable)
                {
                    schedule.push(state.id);
                }
            }
        }
        for id in schedule {
            self.schedule_topology(id);
        }
        self.publish_native_watch_count();
        self.publish_deferred_interest_count();
    }

    fn process_promotion_turn(&mut self) -> bool {
        let candidates = self
            .allocator_order
            .len()
            .min(MAX_ALLOCATOR_SUBSCRIPTIONS_PER_TURN);
        for _ in 0..candidates {
            let Some(id) = self.allocator_order.pop_front() else {
                return false;
            };
            self.allocator_order.push_back(id);
            let Some(mut state) = self.subscriptions.remove(&id) else {
                continue;
            };
            if state.root_lost
                || state.exclusion_update.is_some()
                || state.reconciliation.is_some()
                || state.root_recovery.is_some()
            {
                self.subscriptions.insert(id, state);
                continue;
            }
            let candidate = self.next_promotable_path(&mut state);
            let Some(path) = candidate else {
                self.subscriptions.insert(id, state);
                continue;
            };
            let opened = self.open_topology_directory(&mut state, path.clone(), true, false, false);
            let mut scheduled = false;
            if let Some(opened) = opened
                && state.watched_paths.contains_key(&path)
            {
                state.pending_promotions.insert(path.clone());
                state.queue_path(path.clone());
                state.stats.topology_scans.fetch_add(1, Ordering::Relaxed);
                state.topology_barriers += 1;
                state
                    .topology_jobs
                    .push_back(TopologyJob::promotion(path, opened.active));
                scheduled = true;
            }
            state.publish_resource_counts();
            self.subscriptions.insert(id, state);
            self.publish_deferred_interest_count();
            if scheduled {
                self.schedule_topology(id);
            }
            return true;
        }
        false
    }

    fn next_promotable_path(&self, state: &mut SubscriptionState) -> Option<PathBuf> {
        if state
            .options
            .watch_limit
            .is_some_and(|limit| state.watched_paths.len() >= limit)
        {
            return None;
        }
        let candidates = state
            .deferred_order
            .len()
            .min(MAX_DEFERRED_CANDIDATES_PER_TURN);
        for _ in 0..candidates {
            let Some(path) = state.deferred_order.pop_front() else {
                break;
            };
            if state.is_excluded(&path) {
                state.deferred_directories.remove(&path);
                continue;
            }
            let Some(deferred) = state.deferred_directories.get(&path) else {
                continue;
            };
            let promotable = matches!(
                deferred.cause,
                DeferredCause::SubscriptionLimit | DeferredCause::RuntimeBudget
            ) && !state
                .pending_promotions
                .iter()
                .any(|promoted| path.starts_with(promoted))
                && self.runtime_token_available_for(&path);
            state.deferred_order.push_back(path.clone());
            if promotable {
                return Some(path);
            }
        }
        None
    }

    fn runtime_token_available_for(&self, path: &Path) -> bool {
        if self
            .native_watch_budget
            .is_none_or(|budget| self.watches.len() < budget)
        {
            return true;
        }
        directory_identity(path)
            .ok()
            .is_some_and(|identity| self.watch_identities.contains_key(&identity))
    }

    fn process_topology_turn(&mut self) -> bool {
        let Some(id) = self.topology_runnable.pop_front() else {
            return false;
        };
        self.topology_scheduled.remove(&id);
        let Some(mut state) = self.subscriptions.remove(&id) else {
            return true;
        };
        if state
            .root_recovery
            .as_ref()
            .is_some_and(|recovery| recovery.candidate_unstable)
        {
            state.topology_barriers = 1;
            state
                .root_recovery
                .as_mut()
                .expect("root recovery must exist")
                .phase =
                RootRecoveryPhase::CleaningFailure(RootRecoveryFailureReason::IdentityUnstable);
            self.progress_root_recovery(&mut state);
            self.subscriptions.insert(id, state);
            self.publish_deferred_interest_count();
            return true;
        }
        if state.root_lost && state.root_recovery.is_none() {
            self.subscriptions.insert(id, state);
            return true;
        }
        let mut directories = 0;
        let mut entries = 0;
        let mut native_allocations = 0;
        let mut establishment_failed = false;
        while directories < MAX_TOPOLOGY_DIRECTORIES_PER_TURN
            && entries < MAX_TOPOLOGY_ENTRIES_PER_TURN
            && (self.native_watch_budget.is_none() || native_allocations == 0)
        {
            let Some(mut job) = state.topology_jobs.pop_front() else {
                break;
            };
            if job.active.is_none() {
                let Some(directory) = job.directories.pop_front() else {
                    establishment_failed = self.finish_topology_job(
                        &mut state,
                        job.establishment,
                        job.promotion_root.as_deref(),
                    );
                    if establishment_failed {
                        break;
                    }
                    continue;
                };
                directories += 1;
                let allow_new_native_watch = job.promotion_root.is_none();
                match self.open_topology_directory(
                    &mut state,
                    directory,
                    allow_new_native_watch,
                    !job.require_watch_before_read,
                    job.reconciliation,
                ) {
                    Some(opened) => {
                        native_allocations += usize::from(opened.created_native_watch);
                        job.active = Some(opened.active);
                    }
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
                                if !state.is_excluded(&entry.path()) {
                                    job.directories.push_back(entry.path());
                                }
                            }
                            Ok(_) => {}
                            Err(error) => state.defer_error(active.path.clone(), &error),
                        }
                    }
                    Some(Err(error)) => {
                        entries += 1;
                        state.defer_error(active.path.clone(), &error);
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
                    establishment_failed = self.finish_topology_job(
                        &mut state,
                        job.establishment,
                        job.promotion_root.as_deref(),
                    );
                    if establishment_failed {
                        break;
                    }
                    if self.native_watch_budget.is_some() && native_allocations > 0 {
                        break;
                    }
                    continue;
                }
            }
            let yielded_promoted_watch = job.yield_after_promoted_watch;
            job.yield_after_promoted_watch = false;
            state.topology_jobs.push_front(job);
            if yielded_promoted_watch {
                break;
            }
        }
        if establishment_failed {
            self.discard_unestablished(state);
            return true;
        }
        self.progress_exclusion_update(&mut state);
        self.progress_reconciliation(&mut state);
        self.progress_root_recovery(&mut state);
        if state.exclusion_update.is_none()
            && state.reconciliation.is_none()
            && state.root_recovery.is_none()
        {
            state.publish_resource_counts();
        }
        let runnable = !state.topology_jobs.is_empty()
            || state
                .exclusion_update
                .as_ref()
                .is_some_and(|update| update.phase != ExclusionUpdatePhase::WaitingForTopology)
            || reconciliation_runnable(&state);
        let runnable = runnable || root_recovery_runnable(&state);
        self.subscriptions.insert(id, state);
        self.publish_deferred_interest_count();
        if runnable {
            self.schedule_topology(id);
        }
        true
    }

    fn open_topology_directory(
        &mut self,
        state: &mut SubscriptionState,
        directory: PathBuf,
        allow_new_native_watch: bool,
        read_without_watch: bool,
        reconciliation: bool,
    ) -> Option<OpenedDirectory> {
        if state.is_excluded(&directory) {
            state.remove_deferred_subtree(&directory);
            return None;
        }
        let mut deferred_at_limit = false;
        let mut created_native_watch = false;
        if reconciliation && state.watched_paths.contains_key(&directory) {
            let current_identity = directory_identity(&directory);
            let descriptor = state.watched_paths.get(&directory).copied();
            let watched_identity = descriptor
                .and_then(|descriptor| self.watches.get(&descriptor))
                .and_then(|watch| watch.identity);
            if current_identity.ok() != watched_identity
                && let Some(descriptor) = descriptor
            {
                state.watched_paths.remove(&directory);
                self.remove_interest(state.id, &directory, descriptor);
            }
        }
        if !state.watched_paths.contains_key(&directory) {
            let at_limit = state
                .options
                .watch_limit
                .is_some_and(|limit| state.watched_paths.len() >= limit);
            if at_limit {
                match fs::symlink_metadata(&directory) {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                        deferred_at_limit = true;
                        state.defer(
                            directory.clone(),
                            PartialReason::ResourceLimit,
                            DeferredCause::SubscriptionLimit,
                        );
                        mark_reconciliation_encounter(state, &directory, reconciliation);
                        if !read_without_watch {
                            return None;
                        }
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
                        state.defer_error(directory, &error);
                        return None;
                    }
                }
            } else {
                match self.add_interest(state, &directory, allow_new_native_watch) {
                    Ok(InterestAllocation::Added {
                        created_native_watch: created,
                    }) => created_native_watch = created,
                    Ok(InterestAllocation::RuntimeBudgetExhausted) => {
                        deferred_at_limit = true;
                        state.defer(
                            directory.clone(),
                            PartialReason::ResourceLimit,
                            DeferredCause::RuntimeBudget,
                        );
                        mark_reconciliation_encounter(state, &directory, reconciliation);
                        if !read_without_watch {
                            return None;
                        }
                    }
                    Err(error) => {
                        if path_is_stale_or_not_directory(&error) {
                            state.remove_deferred_subtree(&directory);
                        } else {
                            state.defer_error(directory.clone(), &error);
                        }
                        mark_reconciliation_encounter(state, &directory, reconciliation);
                        return None;
                    }
                }
            }
        }
        mark_reconciliation_encounter(state, &directory, reconciliation);
        match fs::read_dir(&directory) {
            Ok(entries) => Some(OpenedDirectory {
                active: ActiveDirectory {
                    path: directory,
                    entries,
                    deferred_at_limit,
                },
                created_native_watch,
            }),
            Err(error) if path_is_stale_or_not_directory(&error) => {
                self.remove_subscription_subtree(state, &directory);
                None
            }
            Err(error) => {
                state.defer_error(directory, &error);
                None
            }
        }
    }

    fn progress_exclusion_update(&mut self, state: &mut SubscriptionState) {
        let ready_to_start = state.exclusion_update.as_ref().is_some_and(|update| {
            update.phase == ExclusionUpdatePhase::WaitingForTopology
                && state.topology_jobs.is_empty()
                && state.topology_barriers == 0
        });
        if ready_to_start {
            state.flush();
            let boundary_dropped = !state.pending_paths.is_empty();
            if boundary_dropped {
                state.pending_paths.clear();
                state.pending_started = None;
                state.pending_generation = None;
            }

            let (generation, exclusions) = {
                let update = state
                    .exclusion_update
                    .as_mut()
                    .expect("ready exclusion update must exist");
                update.phase = ExclusionUpdatePhase::RemovingExcluded;
                (update.generation, update.exclusions.clone())
            };
            state.exclusions = exclusions;
            state.selection_generation = generation;
            state.topology_barriers = 1;
            if boundary_dropped {
                state.mark_uncertain(UncertainReason::ConsumerBackpressure, state.root.clone());
            }
        }

        let removing = state
            .exclusion_update
            .as_ref()
            .is_some_and(|update| update.phase == ExclusionUpdatePhase::RemovingExcluded);
        if removing {
            let mut work = 0;
            while work < MAX_TOPOLOGY_DIRECTORIES_PER_TURN {
                let Some(prefix) = state
                    .exclusion_update
                    .as_ref()
                    .and_then(|update| update.newly_excluded.front())
                    .cloned()
                else {
                    break;
                };
                let watched = state
                    .watched_paths
                    .range(prefix.clone()..)
                    .next()
                    .filter(|(path, _)| path.starts_with(&prefix))
                    .map(|(path, descriptor)| (path.clone(), *descriptor));
                if let Some((path, descriptor)) = watched {
                    state.watched_paths.remove(&path);
                    self.remove_interest(state.id, &path, descriptor);
                    work += 1;
                    continue;
                }
                let deferred = state
                    .deferred_directories
                    .range(prefix.clone()..)
                    .next()
                    .filter(|(path, _)| path.starts_with(&prefix))
                    .map(|(path, _)| path.clone());
                if let Some(path) = deferred {
                    state.deferred_directories.remove(&path);
                    work += 1;
                    continue;
                }
                let promotion = state
                    .pending_promotions
                    .range(prefix.clone()..)
                    .next()
                    .filter(|path| path.starts_with(&prefix))
                    .cloned();
                if let Some(path) = promotion {
                    state.pending_promotions.remove(&path);
                    work += 1;
                    continue;
                }
                state
                    .exclusion_update
                    .as_mut()
                    .expect("removing exclusion update must exist")
                    .newly_excluded
                    .pop_front();
                work += 1;
            }
            let removal_complete = state
                .exclusion_update
                .as_ref()
                .is_some_and(|update| update.newly_excluded.is_empty());
            if removal_complete {
                let newly_included = {
                    let update = state
                        .exclusion_update
                        .as_mut()
                        .expect("removing exclusion update must exist");
                    update.phase = ExclusionUpdatePhase::ScanningIncluded;
                    update.newly_included.clone()
                };
                for path in newly_included {
                    state.stats.topology_scans.fetch_add(1, Ordering::Relaxed);
                    state.topology_jobs.push_back(TopologyJob::inclusion(path));
                    state.topology_barriers += 1;
                }
            }
        }

        let ready_to_commit = state.exclusion_update.as_ref().is_some_and(|update| {
            update.phase == ExclusionUpdatePhase::ScanningIncluded
                && state.topology_jobs.is_empty()
                && state.topology_barriers == 1
        });
        if ready_to_commit {
            let update = state
                .exclusion_update
                .take()
                .expect("committing exclusion update must exist");
            state.topology_barriers = state.topology_barriers.saturating_sub(1);
            state.exclusion_generation = update.generation;
            for path in update.newly_included {
                state.queue_path(path);
            }
            state.publish_resource_counts();
            self.publish_deferred_interest_count_with(state);
            let coverage = state.coverage();
            let _ = update.acknowledgement.send(CommandAcknowledgement {
                generation: update.generation,
                value: Ok(coverage),
            });
        }
    }

    fn progress_reconciliation(&mut self, state: &mut SubscriptionState) {
        let ready_to_start = state.reconciliation.as_ref().is_some_and(|reconciliation| {
            reconciliation.phase == ReconciliationPhase::WaitingForTopology
                && state.topology_jobs.is_empty()
                && state.topology_barriers == 0
        });
        if ready_to_start {
            state.flush();
            state.pending_paths.clear();
            state.pending_started = None;
            state.pending_generation = None;

            match RootIdentity::capture(&state.root) {
                Ok(identity) if identity == state.root_identity => {
                    let reconciliation = state
                        .reconciliation
                        .as_mut()
                        .expect("ready reconciliation must exist");
                    reconciliation.phase = ReconciliationPhase::Scanning;
                    reconciliation.starting_uncertainty = state.uncertain_reason;
                    reconciliation.starting_uncertainty_epoch = state.uncertainty_epoch;
                    state.topology_barriers = 2;
                    state.stats.topology_scans.fetch_add(1, Ordering::Relaxed);
                    state
                        .topology_jobs
                        .push_back(TopologyJob::reconciliation(state.root.clone()));
                }
                Ok(_) | Err(_) => {
                    state.mark_root_lost(RootLossEvidence::PathIdentityMismatch);
                    if let Some(reconciliation) = state.reconciliation.take() {
                        let _ = reconciliation.acknowledgement.send(CommandAcknowledgement {
                            generation: 0,
                            value: Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "watch root identity changed before reconciliation",
                            )),
                        });
                    }
                }
            }
        }

        let scan_complete = state.reconciliation.as_ref().is_some_and(|reconciliation| {
            reconciliation.phase == ReconciliationPhase::Scanning
                && state.topology_jobs.is_empty()
                && state.topology_barriers == 1
        });
        if scan_complete {
            let reconciliation = state
                .reconciliation
                .as_mut()
                .expect("scanned reconciliation must exist");
            reconciliation.phase = ReconciliationPhase::SweepingWatched;
            reconciliation.sweep_after = None;
        }

        let mut work = 0;
        while work < MAX_TOPOLOGY_DIRECTORIES_PER_TURN {
            let Some(phase) = state
                .reconciliation
                .as_ref()
                .map(|reconciliation| reconciliation.phase)
            else {
                return;
            };
            match phase {
                ReconciliationPhase::WaitingForTopology | ReconciliationPhase::Scanning => break,
                ReconciliationPhase::SweepingWatched => {
                    let after = state
                        .reconciliation
                        .as_ref()
                        .and_then(|reconciliation| reconciliation.sweep_after.clone());
                    let candidate = match after {
                        Some(after) => state
                            .watched_paths
                            .range((Excluded(after), Unbounded))
                            .next()
                            .map(|(path, descriptor)| (path.clone(), *descriptor)),
                        None => state
                            .watched_paths
                            .iter()
                            .next()
                            .map(|(path, descriptor)| (path.clone(), *descriptor)),
                    };
                    if let Some((path, descriptor)) = candidate {
                        let encountered =
                            state.reconciliation.as_ref().is_some_and(|reconciliation| {
                                reconciliation.encountered.contains(&path)
                            });
                        state
                            .reconciliation
                            .as_mut()
                            .expect("sweeping reconciliation must exist")
                            .sweep_after = Some(path.clone());
                        if !encountered {
                            state.watched_paths.remove(&path);
                            self.remove_interest(state.id, &path, descriptor);
                        }
                        work += 1;
                    } else {
                        let reconciliation = state
                            .reconciliation
                            .as_mut()
                            .expect("sweeping reconciliation must exist");
                        reconciliation.phase = ReconciliationPhase::SweepingDeferred;
                        reconciliation.sweep_after = None;
                    }
                }
                ReconciliationPhase::SweepingDeferred => {
                    let after = state
                        .reconciliation
                        .as_ref()
                        .and_then(|reconciliation| reconciliation.sweep_after.clone());
                    let candidate = match after {
                        Some(after) => state
                            .deferred_directories
                            .range((Excluded(after), Unbounded))
                            .next()
                            .map(|(path, _)| path.clone()),
                        None => state.deferred_directories.keys().next().cloned(),
                    };
                    if let Some(path) = candidate {
                        let encountered =
                            state.reconciliation.as_ref().is_some_and(|reconciliation| {
                                reconciliation.encountered.contains(&path)
                            });
                        state
                            .reconciliation
                            .as_mut()
                            .expect("sweeping reconciliation must exist")
                            .sweep_after = Some(path.clone());
                        if !encountered {
                            state.deferred_directories.remove(&path);
                        }
                        work += 1;
                    } else {
                        let reconciliation = state
                            .reconciliation
                            .as_mut()
                            .expect("sweeping reconciliation must exist");
                        reconciliation.phase = ReconciliationPhase::SweepingDeferredOrder;
                        reconciliation.sweep_after = None;
                    }
                }
                ReconciliationPhase::SweepingDeferredOrder => {
                    if let Some(path) = state.deferred_order.pop_front() {
                        if state.deferred_directories.contains_key(&path) {
                            state
                                .reconciliation
                                .as_mut()
                                .expect("rebuilding reconciliation must exist")
                                .rebuilt_deferred_order
                                .push_back(path);
                        }
                        work += 1;
                    } else {
                        let reconciliation = state
                            .reconciliation
                            .as_mut()
                            .expect("rebuilding reconciliation must exist");
                        state.deferred_order =
                            std::mem::take(&mut reconciliation.rebuilt_deferred_order);
                        reconciliation.phase = ReconciliationPhase::SweepingPromotions;
                    }
                }
                ReconciliationPhase::SweepingPromotions => {
                    let after = state
                        .reconciliation
                        .as_ref()
                        .and_then(|reconciliation| reconciliation.sweep_after.clone());
                    let candidate = match after {
                        Some(after) => state
                            .pending_promotions
                            .range((Excluded(after), Unbounded))
                            .next()
                            .cloned(),
                        None => state.pending_promotions.iter().next().cloned(),
                    };
                    if let Some(path) = candidate {
                        let encountered =
                            state.reconciliation.as_ref().is_some_and(|reconciliation| {
                                reconciliation.encountered.contains(&path)
                            });
                        state
                            .reconciliation
                            .as_mut()
                            .expect("sweeping reconciliation must exist")
                            .sweep_after = Some(path.clone());
                        if !encountered {
                            state.pending_promotions.remove(&path);
                        }
                        work += 1;
                    } else {
                        self.commit_reconciliation(state);
                        break;
                    }
                }
            }
        }
    }

    fn commit_reconciliation(&mut self, state: &mut SubscriptionState) {
        let root_stable = RootIdentity::capture(&state.root)
            .is_ok_and(|identity| identity == state.root_identity);
        if !root_stable {
            state.topology_barriers = state.topology_barriers.saturating_sub(1);
            state.mark_root_lost(RootLossEvidence::PathIdentityMismatch);
            if let Some(reconciliation) = state.reconciliation.take() {
                let _ = reconciliation.acknowledgement.send(CommandAcknowledgement {
                    generation: 0,
                    value: Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "watch root identity changed during reconciliation",
                    )),
                });
            }
            return;
        }

        let reconciliation = state
            .reconciliation
            .take()
            .expect("committing reconciliation must exist");
        state.topology_barriers = state.topology_barriers.saturating_sub(1);
        let clears_recoverable_uncertainty = state.uncertainty_epoch
            == reconciliation.starting_uncertainty_epoch
            && state.uncertain_reason == reconciliation.starting_uncertainty
            && state.uncertain_reason.is_none_or(recoverable_uncertainty);
        state.pending_paths.clear();
        state.pending_started = None;
        state.pending_generation = None;
        let result = ReconciliationResult {
            exclusion_generation: state.exclusion_generation,
            coverage: if clears_recoverable_uncertainty {
                state.coverage_without_uncertainty()
            } else {
                state.coverage()
            },
        };
        let batch = ChangeBatch {
            sequence: state.next_sequence,
            exclusion_generation: state.exclusion_generation,
            root_state: state.root_state(),
            invalidated_paths: vec![state.root.clone()],
            coverage: result.coverage.clone(),
        };
        match state.output.try_send(batch) {
            Ok(()) => {
                if clears_recoverable_uncertainty {
                    state.uncertain_reason = None;
                }
                state.next_sequence = state.next_sequence.saturating_add(1);
                state
                    .stats
                    .batches_delivered
                    .fetch_add(1, Ordering::Relaxed);
                state.publish_resource_counts();
                self.publish_deferred_interest_count_with(state);
                let _ = reconciliation.acknowledgement.send(CommandAcknowledgement {
                    generation: 0,
                    value: Ok(result),
                });
            }
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                state.stats.batches_dropped.fetch_add(1, Ordering::Relaxed);
                if state.uncertainty_epoch == reconciliation.starting_uncertainty_epoch {
                    state.uncertain_reason = Some(UncertainReason::ConsumerBackpressure);
                } else {
                    state.mark_uncertain(UncertainReason::ConsumerBackpressure, state.root.clone());
                }
                state.queue_path(state.root.clone());
                state.publish_resource_counts();
                self.publish_deferred_interest_count_with(state);
                let _ = reconciliation.acknowledgement.send(CommandAcknowledgement {
                    generation: 0,
                    value: Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "reconciliation root invalidation could not enter the output queue",
                    )),
                });
            }
        }
    }

    fn progress_root_recovery(&mut self, state: &mut SubscriptionState) {
        let Some(phase) = state.root_recovery.as_ref().map(|recovery| recovery.phase) else {
            return;
        };

        if matches!(
            phase,
            RootRecoveryPhase::RemovingOld | RootRecoveryPhase::CleaningFailure(_)
        ) {
            let removal_complete = self.drain_root_recovery_state(state);
            if !removal_complete {
                return;
            }

            if let RootRecoveryPhase::CleaningFailure(reason) = phase {
                self.finish_root_recovery_failure(state, reason);
                return;
            }

            let candidate = state
                .root_recovery
                .as_ref()
                .expect("root recovery must exist")
                .candidate_identity;
            if state
                .root_recovery
                .as_ref()
                .is_some_and(|recovery| recovery.candidate_unstable)
                || capture_root_candidate(&state.root).ok() != Some(candidate)
            {
                state
                    .root_recovery
                    .as_mut()
                    .expect("root recovery must exist")
                    .phase =
                    RootRecoveryPhase::CleaningFailure(RootRecoveryFailureReason::IdentityUnstable);
                self.progress_root_recovery(state);
                return;
            }

            if state.is_excluded(&state.root) {
                self.commit_root_recovery(state);
                return;
            }

            let root = state.root.clone();
            let opened = self.open_topology_directory(state, root.clone(), true, false, false);
            let Some(opened) = opened.filter(|_| state.watched_paths.contains_key(&root)) else {
                state.remove_deferred_subtree(&root);
                self.finish_root_recovery_failure(
                    state,
                    RootRecoveryFailureReason::RootWatchUnavailable,
                );
                return;
            };
            state.stats.topology_scans.fetch_add(1, Ordering::Relaxed);
            state.topology_barriers = 2;
            state
                .topology_jobs
                .push_back(TopologyJob::root_recovery(opened.active));
            state
                .root_recovery
                .as_mut()
                .expect("root recovery must exist")
                .phase = RootRecoveryPhase::Scanning;
            return;
        }

        let scan_complete = state.root_recovery.as_ref().is_some_and(|recovery| {
            recovery.phase == RootRecoveryPhase::Scanning
                && state.topology_jobs.is_empty()
                && state.topology_barriers == 1
        });
        if scan_complete {
            let candidate = state
                .root_recovery
                .as_ref()
                .expect("root recovery must exist")
                .candidate_identity;
            if state
                .root_recovery
                .as_ref()
                .is_some_and(|recovery| recovery.candidate_unstable)
                || capture_root_candidate(&state.root).ok() != Some(candidate)
            {
                state.topology_barriers = 1;
                state
                    .root_recovery
                    .as_mut()
                    .expect("root recovery must exist")
                    .phase =
                    RootRecoveryPhase::CleaningFailure(RootRecoveryFailureReason::IdentityUnstable);
            } else {
                self.commit_root_recovery(state);
            }
        }
    }

    fn drain_root_recovery_state(&mut self, state: &mut SubscriptionState) -> bool {
        let mut work = 0;
        while work < MAX_TOPOLOGY_DIRECTORIES_PER_TURN {
            if let Some((path, descriptor)) = state
                .watched_paths
                .iter()
                .next()
                .map(|(path, descriptor)| (path.clone(), *descriptor))
            {
                state.watched_paths.remove(&path);
                self.remove_interest(state.id, &path, descriptor);
                work += 1;
                continue;
            }
            if let Some(path) = state.deferred_directories.keys().next().cloned() {
                state.deferred_directories.remove(&path);
                work += 1;
                continue;
            }
            if state.deferred_order.pop_front().is_some() {
                work += 1;
                continue;
            }
            if let Some(path) = state.pending_promotions.iter().next().cloned() {
                state.pending_promotions.remove(&path);
                work += 1;
                continue;
            }
            if state.topology_jobs.pop_front().is_some() {
                work += 1;
                continue;
            }
            break;
        }
        state.watched_paths.is_empty()
            && state.deferred_directories.is_empty()
            && state.deferred_order.is_empty()
            && state.pending_promotions.is_empty()
            && state.topology_jobs.is_empty()
    }

    fn finish_root_recovery_failure(
        &mut self,
        state: &mut SubscriptionState,
        reason: RootRecoveryFailureReason,
    ) {
        let Some(recovery) = state.root_recovery.take() else {
            return;
        };
        state.topology_barriers = 0;
        state.publish_resource_counts();
        self.publish_deferred_interest_count_with(state);
        let result = state.not_attached_result(
            recovery.previous_root_state,
            Some(recovery.candidate_identity),
            reason,
        );
        let _ = recovery.acknowledgement.send(CommandAcknowledgement {
            generation: 0,
            value: Ok(result),
        });
    }

    fn commit_root_recovery(&mut self, state: &mut SubscriptionState) {
        let Some(recovery) = state.root_recovery.take() else {
            return;
        };
        state.topology_barriers = 0;
        state.root_identity = recovery.candidate_identity;
        state.root_generation = state.root_generation.saturating_add(1);
        state.root_lost = false;
        state.root_loss_evidence = None;
        state.next_root_identity_check = Some(Instant::now() + ROOT_IDENTITY_CHECK_INTERVAL);
        let clears_root_uncertainty = state.uncertainty_epoch
            == recovery.starting_uncertainty_epoch
            && state.uncertain_reason == recovery.starting_uncertainty
            && state.uncertain_reason == Some(UncertainReason::RootReplaced);
        if clears_root_uncertainty {
            state.uncertain_reason = None;
        }
        state.pending_paths.clear();
        state.pending_started = None;
        state.pending_generation = None;
        state.publish_resource_counts();
        state.publish_root_state();
        self.publish_deferred_interest_count_with(state);

        let sequence = state.next_sequence;
        let root_state = state.root_state();
        let coverage = state.coverage();
        let batch = ChangeBatch {
            sequence,
            exclusion_generation: state.exclusion_generation,
            root_state,
            invalidated_paths: vec![state.root.clone()],
            coverage: coverage.clone(),
        };
        let attachment = if recovery.candidate_identity == recovery.previous_root_state.identity {
            RootRecoveryAttachment::OriginalRestored
        } else {
            RootRecoveryAttachment::ReplacementAdopted
        };
        let (coverage, boundary_sequence) = match state.output.try_send(batch) {
            Ok(()) => {
                state.next_sequence = state.next_sequence.saturating_add(1);
                state
                    .stats
                    .batches_delivered
                    .fetch_add(1, Ordering::Relaxed);
                (coverage, Some(sequence))
            }
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                state.stats.batches_dropped.fetch_add(1, Ordering::Relaxed);
                state.mark_uncertain(UncertainReason::ConsumerBackpressure, state.root.clone());
                (state.coverage(), None)
            }
        };
        let result = RootRecoveryResult {
            attachment,
            reason: None,
            previous_root_state: recovery.previous_root_state,
            candidate_identity: Some(recovery.candidate_identity),
            current_root_state: state.root_state(),
            exclusion_generation: state.exclusion_generation,
            coverage,
            boundary_sequence,
        };
        let _ = recovery.acknowledgement.send(CommandAcknowledgement {
            generation: 0,
            value: Ok(result),
        });
    }

    fn finish_topology_job(
        &mut self,
        state: &mut SubscriptionState,
        establishment: bool,
        promotion_root: Option<&Path>,
    ) -> bool {
        state.topology_barriers = state.topology_barriers.saturating_sub(1);
        if let Some(path) = promotion_root {
            state.pending_promotions.remove(path);
        }
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
                    root_state: Arc::clone(&state.published_root_state),
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
        // The establishment acknowledgement is the public visibility boundary:
        // publish both subscription-local and runtime allocator gauges before
        // the subscribing thread can observe the returned handle.
        state.publish_resource_counts();
        self.publish_deferred_interest_count_with(state);
        if let Some(establishment) = state.establishment.take() {
            let _ = establishment.acknowledgement.send(CommandAcknowledgement {
                generation: establishment.generation,
                value: result,
            });
        }
        failed
    }

    fn add_interest(
        &mut self,
        state: &mut SubscriptionState,
        path: &Path,
        allow_new_native_watch: bool,
    ) -> io::Result<InterestAllocation> {
        let identity = directory_identity(path)?;
        if let Some(descriptor) = self.watch_identities.get(&identity).copied()
            && self.watches.contains_key(&descriptor)
        {
            if directory_identity(path).ok() != Some(identity) {
                state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
                return Err(io::Error::from_raw_os_error(libc::ESTALE));
            }
            self.insert_interest(state, path, descriptor);
            return Ok(InterestAllocation::Added {
                created_native_watch: false,
            });
        }
        if !allow_new_native_watch {
            return Ok(InterestAllocation::RuntimeBudgetExhausted);
        }
        if self
            .native_watch_budget
            .is_some_and(|budget| self.watches.len() >= budget)
        {
            return Ok(InterestAllocation::RuntimeBudgetExhausted);
        }
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
        let created_native_watch = !self.watches.contains_key(&descriptor);
        let identity_after = directory_identity(path);
        if identity_after.as_ref().ok() != Some(&identity)
            || self
                .watches
                .get(&descriptor)
                .and_then(|watch| watch.identity)
                .is_some_and(|watched| watched != identity)
        {
            if created_native_watch {
                self.expected_ignored.insert(descriptor);
                // SAFETY: inotify is live and this call only removes the watch
                // created by the mismatched add above.
                unsafe {
                    libc::inotify_rm_watch(self.inotify.as_raw_fd(), descriptor);
                }
            }
            state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
            return Err(io::Error::from_raw_os_error(libc::ESTALE));
        }
        if self.expected_ignored.contains(&descriptor) {
            // Linux may recycle a removed watch descriptor before its queued
            // IN_IGNORED record is consumed. The later record cannot be
            // attributed safely to the old or new lifetime, so preserve the
            // new interest but make its coverage explicitly uncertain.
            state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
        }
        let watch = self.watches.entry(descriptor).or_default();
        watch.identity.get_or_insert(identity);
        self.watch_identities.insert(identity, descriptor);
        self.insert_interest(state, path, descriptor);
        self.publish_native_watch_count();
        Ok(InterestAllocation::Added {
            created_native_watch,
        })
    }

    fn insert_interest(&mut self, state: &mut SubscriptionState, path: &Path, descriptor: i32) {
        self.watches
            .get_mut(&descriptor)
            .expect("shared native watch must exist")
            .interests
            .insert(Interest {
                subscription_id: state.id,
                path: path.to_path_buf(),
            });
        state.watched_paths.insert(path.to_path_buf(), descriptor);
        state.deferred_directories.remove(path);
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
        if state.exclusion_update.is_none() && state.reconciliation.is_none() {
            state.publish_resource_counts();
        }
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
            self.watch_identities
                .retain(|_, candidate| *candidate != descriptor);
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
        self.allocator_order.retain(|candidate| *candidate != id);
        let Some(mut state) = self.subscriptions.remove(&id) else {
            return;
        };
        let interests: Vec<_> = std::mem::take(&mut state.watched_paths)
            .into_iter()
            .collect();
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
        if let Some(update) = state.exclusion_update.take() {
            let _ = update.acknowledgement.send(CommandAcknowledgement {
                generation: update.generation,
                value: Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "subscription disposed during exclusion update",
                )),
            });
        }
        if let Some(reconciliation) = state.reconciliation.take() {
            let _ = reconciliation.acknowledgement.send(CommandAcknowledgement {
                generation: 0,
                value: Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "subscription disposed during reconciliation",
                )),
            });
        }
        if let Some(recovery) = state.root_recovery.take() {
            let _ = recovery.acknowledgement.send(CommandAcknowledgement {
                generation: 0,
                value: Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "subscription disposed during root recovery",
                )),
            });
        }
        self.counters
            .subscriptions
            .store(self.subscriptions.len(), Ordering::Release);
        self.publish_deferred_interest_count();
    }

    fn discard_unestablished(&mut self, mut state: SubscriptionState) {
        self.topology_scheduled.remove(&state.id);
        self.topology_runnable
            .retain(|candidate| *candidate != state.id);
        self.allocator_order
            .retain(|candidate| *candidate != state.id);
        let interests: Vec<_> = std::mem::take(&mut state.watched_paths)
            .into_iter()
            .collect();
        for (path, descriptor) in interests {
            self.remove_interest(state.id, &path, descriptor);
        }
        state.stats.watched_directories.store(0, Ordering::Release);
        state.stats.deferred_directories.store(0, Ordering::Release);
        self.counters
            .subscriptions
            .store(self.subscriptions.len(), Ordering::Release);
        self.publish_deferred_interest_count();
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
        let mut schedule = Vec::new();
        for state in self.subscriptions.values_mut() {
            if state.next_root_identity_check.is_some_and(|due| now >= due) {
                match RootIdentity::capture(&state.root) {
                    Ok(identity) if identity == state.root_identity => {
                        state.next_root_identity_check = Some(now + ROOT_IDENTITY_CHECK_INTERVAL);
                    }
                    Ok(_) | Err(_) => {
                        state.next_root_identity_check = None;
                        state.mark_root_lost(RootLossEvidence::PathIdentityMismatch);
                    }
                }
            }
            state.flush_if_due();
            if state
                .root_recovery
                .as_ref()
                .is_some_and(|recovery| recovery.candidate_unstable)
            {
                schedule.push(state.id);
            }
        }
        for id in schedule {
            self.schedule_topology(id);
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

    fn publish_deferred_interest_count(&self) {
        self.counters.deferred_interests.store(
            self.subscriptions
                .values()
                .map(|state| state.stats.deferred_directories.load(Ordering::Acquire))
                .sum(),
            Ordering::Release,
        );
    }

    fn publish_deferred_interest_count_with(&self, detached: &SubscriptionState) {
        self.counters.deferred_interests.store(
            self.subscriptions
                .values()
                .map(|state| state.stats.deferred_directories.load(Ordering::Acquire))
                .sum::<usize>()
                + detached.stats.deferred_directories.load(Ordering::Acquire),
            Ordering::Release,
        );
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

fn reconciliation_runnable(state: &SubscriptionState) -> bool {
    state.reconciliation.as_ref().is_some_and(|reconciliation| {
        matches!(
            reconciliation.phase,
            ReconciliationPhase::SweepingWatched
                | ReconciliationPhase::SweepingDeferred
                | ReconciliationPhase::SweepingDeferredOrder
                | ReconciliationPhase::SweepingPromotions
        )
    })
}

fn root_recovery_runnable(state: &SubscriptionState) -> bool {
    state.root_recovery.as_ref().is_some_and(|recovery| {
        matches!(
            recovery.phase,
            RootRecoveryPhase::RemovingOld | RootRecoveryPhase::CleaningFailure(_)
        ) || recovery.candidate_unstable
            || (recovery.phase == RootRecoveryPhase::Scanning
                && state.topology_jobs.is_empty()
                && state.topology_barriers == 1)
    })
}

fn mark_reconciliation_encounter(state: &mut SubscriptionState, path: &Path, reconciliation: bool) {
    if reconciliation && let Some(transaction) = state.reconciliation.as_mut() {
        transaction.encountered.insert(path.to_path_buf());
    }
}

fn recoverable_uncertainty(reason: UncertainReason) -> bool {
    matches!(
        reason,
        UncertainReason::EventOverflow
            | UncertainReason::TopologyRace
            | UncertainReason::ConsumerBackpressure
    )
}

fn validate_exclusion_prefixes(
    root: &Path,
    prefixes: Vec<PathBuf>,
) -> io::Result<BTreeSet<PathBuf>> {
    let mut absolute = BTreeSet::new();
    for prefix in prefixes {
        if prefix.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "exclusion prefix must be root-relative: {}",
                    prefix.display()
                ),
            ));
        }
        if prefix.as_os_str().as_bytes().contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "exclusion prefix contains NUL",
            ));
        }
        let mut normalized = PathBuf::new();
        for component in prefix.components() {
            match component {
                Component::Normal(value) => normalized.push(value),
                Component::CurDir
                | Component::ParentDir
                | Component::RootDir
                | Component::Prefix(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!(
                            "exclusion prefix is not a normalized root-relative path: {}",
                            prefix.display()
                        ),
                    ));
                }
            }
        }
        if normalized.as_os_str().as_bytes() != prefix.as_os_str().as_bytes() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("exclusion prefix is not normalized: {}", prefix.display()),
            ));
        }
        absolute.insert(root.join(normalized));
    }
    let candidates: Vec<_> = absolute.into_iter().collect();
    Ok(candidates
        .iter()
        .filter(|candidate| {
            !candidates
                .iter()
                .any(|ancestor| *candidate != ancestor && candidate.starts_with(ancestor))
        })
        .cloned()
        .collect())
}

fn directory_identity(path: &Path) -> io::Result<RootIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(io::Error::from_raw_os_error(libc::ENOTDIR));
    }
    Ok(RootIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

fn capture_root_candidate(path: &Path) -> Result<RootIdentity, RootRecoveryFailureReason> {
    RootIdentity::capture(path).map_err(|error| {
        if error.to_string().contains("symbolic link") {
            RootRecoveryFailureReason::SymlinkAncestry
        } else if error.kind() == io::ErrorKind::NotFound {
            RootRecoveryFailureReason::CandidateMissing
        } else if error.kind() == io::ErrorKind::InvalidInput
            || matches!(error.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP))
        {
            RootRecoveryFailureReason::CandidateNotDirectory
        } else {
            RootRecoveryFailureReason::RootWatchUnavailable
        }
    })
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
            None,
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
    fn root_loss_latch_survives_stronger_overflow_coverage() {
        let root = TestRoot::new("overflow-root-loss");
        let (mut state, _receiver) = state(&root.0, SubscriptionOptions::default());
        state.mark_uncertain(UncertainReason::EventOverflow, root.0.clone());
        state.mark_root_lost(RootLossEvidence::PathIdentityMismatch);

        assert_eq!(
            state.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::EventOverflow,
            }
        );
        assert_eq!(state.root_state().attachment, RootAttachment::Lost);
        assert_eq!(
            state.root_state().loss_evidence,
            Some(RootLossEvidence::PathIdentityMismatch)
        );
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

    fn prepare_reconciliation(
        state: &mut SubscriptionState,
        reason: UncertainReason,
    ) -> Receiver<CommandAcknowledgement<io::Result<ReconciliationResult>>> {
        state.mark_uncertain(reason, state.root.clone());
        state.pending_paths.clear();
        state.pending_started = None;
        state.pending_generation = None;
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        state.reconciliation = Some(PendingReconciliation {
            acknowledgement,
            phase: ReconciliationPhase::SweepingPromotions,
            encountered: BTreeSet::from([state.root.clone()]),
            sweep_after: None,
            rebuilt_deferred_order: VecDeque::new(),
            starting_uncertainty: state.uncertain_reason,
            starting_uncertainty_epoch: state.uncertainty_epoch,
        });
        state.topology_barriers = 1;
        acknowledged
    }

    fn worker() -> Worker {
        let (_commands, command_receiver) = mpsc::channel();
        Worker::new(
            create_inotify().unwrap(),
            Arc::new(create_eventfd().unwrap()),
            command_receiver,
            Arc::new(RuntimeCounters::default()),
            None,
        )
    }

    #[test]
    fn event_overflow_reconciliation_queues_root_before_clearing_uncertainty() {
        let root = TestRoot::new("reconcile-overflow");
        let (mut state, batches) = state(&root.0, SubscriptionOptions::default());
        let acknowledged = prepare_reconciliation(&mut state, UncertainReason::EventOverflow);
        let mut worker = worker();

        worker.commit_reconciliation(&mut state);

        let result = acknowledged.recv().unwrap().value.unwrap();
        assert_eq!(result.coverage, Coverage::Complete);
        let batch = batches.recv().unwrap();
        assert_eq!(batch.invalidated_paths, vec![root.0.clone()]);
        assert_eq!(batch.coverage, Coverage::Complete);
        assert_eq!(state.uncertain_reason, None);
    }

    #[test]
    fn topology_race_reconciliation_can_return_to_complete_coverage() {
        let root = TestRoot::new("reconcile-topology-race");
        let (mut state, batches) = state(&root.0, SubscriptionOptions::default());
        let acknowledged = prepare_reconciliation(&mut state, UncertainReason::TopologyRace);
        let mut worker = worker();

        worker.commit_reconciliation(&mut state);

        assert_eq!(
            acknowledged.recv().unwrap().value.unwrap().coverage,
            Coverage::Complete
        );
        assert_eq!(batches.recv().unwrap().coverage, Coverage::Complete);
    }

    #[test]
    fn root_replaced_uncertainty_is_not_cleared_by_a_topology_commit() {
        let root = TestRoot::new("reconcile-root-replaced");
        let (mut state, batches) = state(&root.0, SubscriptionOptions::default());
        let acknowledged = prepare_reconciliation(&mut state, UncertainReason::RootReplaced);
        let mut worker = worker();

        worker.commit_reconciliation(&mut state);

        let expected = Coverage::Uncertain {
            reason: UncertainReason::RootReplaced,
        };
        assert_eq!(
            acknowledged.recv().unwrap().value.unwrap().coverage,
            expected
        );
        assert_eq!(batches.recv().unwrap().coverage, expected);
    }

    #[test]
    fn new_overflow_during_reconciliation_preserves_overflow_uncertainty() {
        let root = TestRoot::new("reconcile-new-overflow");
        let (mut state, batches) = state(&root.0, SubscriptionOptions::default());
        let acknowledged = prepare_reconciliation(&mut state, UncertainReason::EventOverflow);
        state.mark_uncertain(UncertainReason::EventOverflow, root.0.clone());
        let mut worker = worker();

        worker.commit_reconciliation(&mut state);

        let expected = Coverage::Uncertain {
            reason: UncertainReason::EventOverflow,
        };
        assert_eq!(
            acknowledged.recv().unwrap().value.unwrap().coverage,
            expected
        );
        assert_eq!(batches.recv().unwrap().coverage, expected);
    }

    #[test]
    fn full_output_queue_rejects_reconciliation_and_retains_backpressure() {
        let root = TestRoot::new("reconcile-backpressure");
        let options = SubscriptionOptions {
            output_queue_capacity: 1,
            ..SubscriptionOptions::default()
        };
        let (mut state, batches) = state(&root.0, options);
        state.queue_path(root.0.join("already-queued"));
        state.flush();
        let acknowledged =
            prepare_reconciliation(&mut state, UncertainReason::ConsumerBackpressure);
        let mut worker = worker();

        worker.commit_reconciliation(&mut state);

        let error = acknowledged.recv().unwrap().value.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        assert_eq!(
            state.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::ConsumerBackpressure,
            }
        );
        assert!(state.pending_paths.contains(&root.0));
        assert!(batches.try_recv().is_ok());
    }
}
