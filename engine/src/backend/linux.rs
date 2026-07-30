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

#[cfg(test)]
use crate::EstablishmentCancellation;
use crate::{
    ChangeBatch, Coverage, ErrorCode, EstablishmentCancellationState, Operation, PartialReason,
    ReconciliationResult, Result as WatchboundResult, RootAttachment, RootIdentity,
    RootIdentityPolicy, RootLossEvidence, RootRecoveryAttachment, RootRecoveryFailureReason,
    RootRecoveryResult, RootState, RuntimeStats, SharedStats, SubscriptionOptions, UncertainReason,
    WatchboundError, operation_cancelled_error,
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
const CONTROL_COMMAND_QUEUE_CAPACITY: usize = 64;
const WORK_COMMAND_QUEUE_CAPACITY: usize = 64;
const MAX_CONTROL_COMMANDS_PER_TURN: usize = 16;
const MAX_WORK_COMMANDS_PER_TURN: usize = 16;
const COMMAND_ADMISSION_POLL: Duration = Duration::from_millis(5);
const MAX_NATIVE_READS_PER_TURN: usize = 2;
const MAX_NATIVE_EVENTS_PER_TURN: usize = 64;
const MAX_TOPOLOGY_DIRECTORIES_PER_TURN: usize = 64;
const MAX_TOPOLOGY_ENTRIES_PER_TURN: usize = 256;
const MAX_ESTABLISHMENT_TEARDOWN_ITEMS_PER_TURN: usize = 64;
const MAX_DISPOSAL_ITEMS_PER_TURN: usize = 64;
const MAX_ALLOCATOR_SUBSCRIPTIONS_PER_TURN: usize = 16;
const MAX_DEFERRED_CANDIDATES_PER_TURN: usize = 64;

type SubscriptionId = u64;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RootRecoveryBarrier {
    CandidateCaptured,
    OldInterestsDrained,
    SharingExistingWatch,
    BeforeAddWatch,
    AfterAddWatch,
    DuringTraversal,
    BeforeFinalValidation,
}

#[cfg(test)]
type RootRecoveryBarrierHook = Arc<dyn Fn(RootRecoveryBarrier, &Path) + Send + Sync>;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EstablishmentBarrier {
    SharingExistingWatch,
    AfterAddWatch,
    DuringTraversal,
    BeforeFinalValidation,
    BeforeFinalCommit,
    TeardownQuantumCompleted,
}

#[cfg(test)]
type EstablishmentBarrierHook = Arc<dyn Fn(EstablishmentBarrier, &Path) + Send + Sync>;

#[derive(Debug)]
enum RootCaptureError {
    Missing(io::Error),
    NotDirectory,
    SymlinkAncestry,
    Unavailable(io::Error),
}

impl RootCaptureError {
    fn from_io(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::NotFound {
            Self::Missing(error)
        } else {
            match error.raw_os_error() {
                Some(libc::ENOTDIR) => Self::NotDirectory,
                Some(libc::ELOOP) => Self::SymlinkAncestry,
                _ => Self::Unavailable(error),
            }
        }
    }

    fn into_watchbound(self, operation: Operation, message: impl Into<String>) -> WatchboundError {
        let message = message.into();
        match self {
            Self::Missing(cause) | Self::Unavailable(cause) => {
                WatchboundError::from_io(ErrorCode::RootUnavailable, operation, message, &cause)
            }
            Self::NotDirectory | Self::SymlinkAncestry => {
                WatchboundError::new(ErrorCode::RootUnavailable, operation, message)
            }
        }
    }
}

impl RootIdentity {
    fn capture(path: &Path) -> std::result::Result<Self, RootCaptureError> {
        let canonical = fs::canonicalize(path).map_err(RootCaptureError::from_io)?;
        if canonical != path {
            return Err(RootCaptureError::SymlinkAncestry);
        }
        let metadata = fs::symlink_metadata(path).map_err(RootCaptureError::from_io)?;
        if metadata.file_type().is_symlink() {
            return Err(RootCaptureError::SymlinkAncestry);
        }
        if !metadata.is_dir() {
            return Err(RootCaptureError::NotDirectory);
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
    pub(crate) initial_root_state: RootState,
    pub(crate) receiver: Receiver<ChangeBatch>,
    pub(crate) root_state: Arc<Mutex<RootState>>,
}

pub(crate) struct PendingEstablishedSubscription {
    acknowledged: Receiver<CommandAcknowledgement<WatchboundResult<Established>>>,
    receiver: Option<Receiver<ChangeBatch>>,
}

impl PendingEstablishedSubscription {
    pub(crate) fn wait(mut self) -> WatchboundResult<EstablishedSubscription> {
        let acknowledged = self.acknowledged.recv().map_err(|_| {
            internal_error(
                Operation::Subscribe,
                "shared runtime stopped during subscription",
            )
        })?;
        if acknowledged.generation != 0 {
            return Err(internal_error(
                Operation::Subscribe,
                "shared runtime acknowledged the wrong generation",
            ));
        }
        let established = acknowledged.value?;
        Ok(EstablishedSubscription {
            id: established.id,
            initial_coverage: established.coverage,
            initial_root_state: established.initial_root_state,
            receiver: self
                .receiver
                .take()
                .expect("pending subscription receiver may only be consumed once"),
            root_state: established.root_state,
        })
    }
}

pub(crate) struct Runtime {
    control_commands: SyncSender<CommandEnvelope>,
    work_commands: SyncSender<CommandEnvelope>,
    wakeup: Arc<OwnedFd>,
    worker: Mutex<Option<JoinHandle<()>>>,
    counters: Arc<RuntimeCounters>,
    native_watch_budget: Option<usize>,
    leases: AtomicUsize,
    shutting_down: AtomicBool,
}

impl Runtime {
    pub(crate) fn start(native_watch_budget: Option<usize>) -> WatchboundResult<Arc<Self>> {
        Self::start_inner(native_watch_budget, None, None)
    }

    #[cfg(test)]
    fn start_with_root_recovery_barrier_hook(
        native_watch_budget: Option<usize>,
        hook: RootRecoveryBarrierHook,
    ) -> WatchboundResult<Arc<Self>> {
        Self::start_inner(native_watch_budget, Some(hook), None)
    }

    #[cfg(test)]
    fn start_with_establishment_barrier_hook(
        native_watch_budget: Option<usize>,
        hook: EstablishmentBarrierHook,
    ) -> WatchboundResult<Arc<Self>> {
        Self::start_inner(native_watch_budget, None, Some(hook))
    }

    fn start_inner(
        native_watch_budget: Option<usize>,
        #[cfg(test)] root_recovery_barrier_hook: Option<RootRecoveryBarrierHook>,
        #[cfg(test)] establishment_barrier_hook: Option<EstablishmentBarrierHook>,
        #[cfg(not(test))] _root_recovery_barrier_hook: Option<()>,
        #[cfg(not(test))] _establishment_barrier_hook: Option<()>,
    ) -> WatchboundResult<Arc<Self>> {
        let inotify = create_inotify().map_err(|error| {
            WatchboundError::from_io(
                ErrorCode::ResourceUnavailable,
                Operation::Subscribe,
                "failed to create the shared inotify runtime",
                &error,
            )
        })?;
        let wakeup = Arc::new(create_eventfd().map_err(|error| {
            WatchboundError::from_io(
                ErrorCode::ResourceUnavailable,
                Operation::Subscribe,
                "failed to create the shared runtime wakeup descriptor",
                &error,
            )
        })?);
        let (control_commands, control_command_receiver) =
            mpsc::sync_channel(CONTROL_COMMAND_QUEUE_CAPACITY);
        let (work_commands, work_command_receiver) =
            mpsc::sync_channel(WORK_COMMAND_QUEUE_CAPACITY);
        let counters = Arc::new(RuntimeCounters::default());
        let worker_wakeup = Arc::clone(&wakeup);
        let worker_counters = Arc::clone(&counters);
        let worker = std::thread::Builder::new()
            .name("watchbound-linux-runtime".to_owned())
            .spawn(move || {
                let worker = Worker::new(
                    inotify,
                    worker_wakeup,
                    control_command_receiver,
                    work_command_receiver,
                    worker_counters,
                    native_watch_budget,
                );
                #[cfg(test)]
                let worker = {
                    let mut worker = worker;
                    worker.root_recovery_barrier_hook = root_recovery_barrier_hook;
                    worker.establishment_barrier_hook = establishment_barrier_hook;
                    worker
                };
                worker.run();
            })
            .map_err(|error| {
                WatchboundError::from_io(
                    ErrorCode::ResourceUnavailable,
                    Operation::Subscribe,
                    "failed to start the shared runtime worker",
                    &error,
                )
            })?;
        counters.inotify_instances.store(1, Ordering::Release);
        counters.worker_threads.store(1, Ordering::Release);
        Ok(Arc::new(Self {
            control_commands,
            work_commands,
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

    #[cfg(test)]
    fn subscribe(
        &self,
        root: PathBuf,
        options: SubscriptionOptions,
        stats: Arc<SharedStats>,
    ) -> WatchboundResult<EstablishedSubscription> {
        let cancellation = EstablishmentCancellation::new()?;
        cancellation.shared.bind()?;
        self.begin_subscribe(root, options, stats, cancellation.shared())?
            .wait()
    }

    pub(crate) fn begin_subscribe(
        &self,
        root: PathBuf,
        options: SubscriptionOptions,
        stats: Arc<SharedStats>,
        cancellation: Arc<EstablishmentCancellationState>,
    ) -> WatchboundResult<PendingEstablishedSubscription> {
        let (output, receiver) = mpsc::sync_channel(options.output_queue_capacity);
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        let mut envelope = CommandEnvelope {
            generation: 0,
            command: Command::Subscribe {
                root,
                options,
                stats,
                output,
                acknowledgement,
                cancellation: Arc::clone(&cancellation),
            },
        };
        loop {
            if cancellation.cancellation_requested() {
                cancellation.finish_cancelled();
                return Err(operation_cancelled_error());
            }
            match self.work_commands.try_send(envelope) {
                Ok(()) => {
                    self.wake();
                    break;
                }
                Err(TrySendError::Full(returned)) => {
                    envelope = returned;
                    #[cfg(test)]
                    cancellation.observe_command_admission_full();
                    std::thread::park_timeout(COMMAND_ADMISSION_POLL);
                }
                Err(TrySendError::Disconnected(_)) => {
                    let error = internal_error(
                        Operation::Subscribe,
                        "shared runtime work command channel is closed",
                    );
                    return Err(if cancellation.try_commit_failure() {
                        error
                    } else {
                        cancellation.finish_cancelled();
                        operation_cancelled_error()
                    });
                }
            }
        }
        Ok(PendingEstablishedSubscription {
            acknowledged,
            receiver: Some(receiver),
        })
    }

    pub(crate) fn wake(&self) {
        let value = 1_u64.to_ne_bytes();
        // SAFETY: wakeup is a live eventfd and value points to exactly eight
        // initialized bytes, as required by eventfd writes.
        let written =
            unsafe { libc::write(self.wakeup.as_raw_fd(), value.as_ptr().cast(), value.len()) };
        // The worker polls both bounded command channels at a bounded interval
        // even if this best-effort latency wakeup is interrupted or saturated.
        let _ = written;
    }

    pub(crate) fn dispose(&self, id: SubscriptionId) -> WatchboundResult<()> {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        self.send_control(
            CommandEnvelope {
                generation: 0,
                command: Command::Dispose {
                    subscription_id: id,
                    acknowledgement,
                },
            },
            Operation::Dispose,
        )?;
        let established = acknowledged.recv().map_err(|_| {
            internal_error(Operation::Dispose, "shared runtime stopped during disposal")
        })?;
        if established.generation != 0 {
            return Err(internal_error(
                Operation::Dispose,
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
    ) -> WatchboundResult<PendingExclusionAcknowledgement> {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        self.send_control(
            CommandEnvelope {
                generation,
                command: Command::ReplaceExclusions {
                    subscription_id: id,
                    prefixes,
                    acknowledgement,
                },
            },
            Operation::ReplaceExclusions,
        )?;
        Ok(PendingExclusionAcknowledgement {
            generation,
            acknowledged,
        })
    }

    pub(crate) fn queue_reconciliation(
        &self,
        id: SubscriptionId,
    ) -> WatchboundResult<PendingReconciliationAcknowledgement> {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        self.send_control(
            CommandEnvelope {
                generation: 0,
                command: Command::Reconcile {
                    subscription_id: id,
                    acknowledgement,
                },
            },
            Operation::Reconcile,
        )?;
        Ok(PendingReconciliationAcknowledgement { acknowledged })
    }

    pub(crate) fn queue_root_recovery(
        &self,
        id: SubscriptionId,
        identity_policy: RootIdentityPolicy,
    ) -> WatchboundResult<PendingRootRecoveryAcknowledgement> {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        self.send_control(
            CommandEnvelope {
                generation: 0,
                command: Command::RecoverRoot {
                    subscription_id: id,
                    identity_policy,
                    acknowledgement,
                },
            },
            Operation::RecoverRoot,
        )?;
        Ok(PendingRootRecoveryAcknowledgement { acknowledged })
    }

    pub(crate) fn stats(&self) -> RuntimeStats {
        RuntimeStats {
            native_watch_budget: self.native_watch_budget,
            ..self.counters.snapshot()
        }
    }

    fn send_control(&self, command: CommandEnvelope, operation: Operation) -> WatchboundResult<()> {
        self.control_commands.send(command).map_err(|_| {
            internal_error(
                operation,
                "shared runtime control command channel is closed",
            )
        })?;
        self.wake();
        Ok(())
    }
}

pub(crate) struct PendingExclusionAcknowledgement {
    generation: u64,
    acknowledged: Receiver<CommandAcknowledgement<WatchboundResult<Coverage>>>,
}

impl PendingExclusionAcknowledgement {
    pub(crate) fn wait(self) -> WatchboundResult<Coverage> {
        let acknowledged = self.acknowledged.recv().map_err(|_| {
            internal_error(
                Operation::ReplaceExclusions,
                "shared runtime stopped during exclusion update",
            )
        })?;
        if acknowledged.generation != self.generation {
            return Err(internal_error(
                Operation::ReplaceExclusions,
                "shared runtime acknowledged the wrong exclusion generation",
            ));
        }
        acknowledged.value
    }
}

pub(crate) struct PendingReconciliationAcknowledgement {
    acknowledged: Receiver<CommandAcknowledgement<WatchboundResult<ReconciliationResult>>>,
}

pub(crate) struct PendingRootRecoveryAcknowledgement {
    acknowledged: Receiver<CommandAcknowledgement<WatchboundResult<RootRecoveryResult>>>,
}

impl PendingRootRecoveryAcknowledgement {
    pub(crate) fn wait(self) -> WatchboundResult<RootRecoveryResult> {
        let acknowledged = self.acknowledged.recv().map_err(|_| {
            internal_error(
                Operation::RecoverRoot,
                "shared runtime stopped during root recovery",
            )
        })?;
        if acknowledged.generation != 0 {
            return Err(internal_error(
                Operation::RecoverRoot,
                "shared runtime acknowledged the wrong root recovery generation",
            ));
        }
        acknowledged.value
    }
}

impl PendingReconciliationAcknowledgement {
    pub(crate) fn wait(self) -> WatchboundResult<ReconciliationResult> {
        let acknowledged = self.acknowledged.recv().map_err(|_| {
            internal_error(
                Operation::Reconcile,
                "shared runtime stopped during reconciliation",
            )
        })?;
        if acknowledged.generation != 0 {
            return Err(internal_error(
                Operation::Reconcile,
                "shared runtime acknowledged the wrong reconciliation generation",
            ));
        }
        acknowledged.value
    }
}

impl Runtime {
    pub(crate) fn shutdown_and_join(&self) -> WatchboundResult<()> {
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        let mut result = self.send_control(
            CommandEnvelope {
                generation: 0,
                command: Command::Shutdown { acknowledgement },
            },
            Operation::Dispose,
        );
        if result.is_ok() {
            result = acknowledged
                .recv()
                .map_err(|_| {
                    internal_error(
                        Operation::Dispose,
                        "shared runtime stopped before shutdown acknowledgement",
                    )
                })
                .and_then(|acknowledged| {
                    if acknowledged.generation == 0 {
                        Ok(())
                    } else {
                        Err(internal_error(
                            Operation::Dispose,
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
        if let Some(worker) = worker {
            let panicked = worker.join().is_err();
            self.counters.inotify_instances.store(0, Ordering::Release);
            self.counters.worker_threads.store(0, Ordering::Release);
            if panicked && result.is_ok() {
                result = Err(internal_error(
                    Operation::Dispose,
                    "shared runtime worker panicked",
                ));
            }
        }
        result
    }
}

fn internal_error(operation: Operation, message: impl Into<String>) -> WatchboundError {
    WatchboundError::new(ErrorCode::Internal, operation, message)
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

#[derive(Clone, Copy)]
enum CommandLane {
    Control,
    Work,
}

struct CommandAcknowledgement<T> {
    generation: u64,
    value: T,
}

fn commit_establishment_failure(
    cancellation: &EstablishmentCancellationState,
    error: WatchboundError,
) -> WatchboundError {
    if cancellation.try_commit_failure() {
        error
    } else {
        cancellation.finish_cancelled();
        operation_cancelled_error()
    }
}

enum Command {
    Subscribe {
        root: PathBuf,
        options: SubscriptionOptions,
        stats: Arc<SharedStats>,
        output: SyncSender<ChangeBatch>,
        acknowledgement: SyncSender<CommandAcknowledgement<WatchboundResult<Established>>>,
        cancellation: Arc<EstablishmentCancellationState>,
    },
    Dispose {
        subscription_id: SubscriptionId,
        acknowledgement: SyncSender<CommandAcknowledgement<()>>,
    },
    ReplaceExclusions {
        subscription_id: SubscriptionId,
        prefixes: Vec<PathBuf>,
        acknowledgement: SyncSender<CommandAcknowledgement<WatchboundResult<Coverage>>>,
    },
    Reconcile {
        subscription_id: SubscriptionId,
        acknowledgement: SyncSender<CommandAcknowledgement<WatchboundResult<ReconciliationResult>>>,
    },
    RecoverRoot {
        subscription_id: SubscriptionId,
        identity_policy: RootIdentityPolicy,
        acknowledgement: SyncSender<CommandAcknowledgement<WatchboundResult<RootRecoveryResult>>>,
    },
    Shutdown {
        acknowledgement: SyncSender<CommandAcknowledgement<()>>,
    },
}

struct Established {
    id: SubscriptionId,
    coverage: Coverage,
    initial_root_state: RootState,
    root_state: Arc<Mutex<RootState>>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct Interest {
    subscription_id: SubscriptionId,
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct WatchLifetime(u64);

struct NativeWatch {
    lifetime: WatchLifetime,
    identity: Option<RootIdentity>,
    interests: BTreeSet<Interest>,
    expects_ignored: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ExpectedIgnoredLifetimes {
    // A descriptor's generations remain contiguous while ignored records are
    // outstanding. The closed range therefore represents any number of
    // retired lifetimes without a per-event allocation.
    first: WatchLifetime,
    last: WatchLifetime,
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
    establishment_teardown: Option<PendingEstablishmentTeardown>,
    disposal: Option<PendingDisposal>,
    published_deferred_directories: usize,
    uncertainty_epoch: u64,
}

struct PendingEstablishment {
    generation: u64,
    acknowledgement: SyncSender<CommandAcknowledgement<WatchboundResult<Established>>>,
    cancellation: Arc<EstablishmentCancellationState>,
}

struct PendingEstablishmentTeardown {
    generation: u64,
    acknowledgement: Option<SyncSender<CommandAcknowledgement<WatchboundResult<Established>>>>,
    cancellation: Arc<EstablishmentCancellationState>,
    terminal_error: Option<WatchboundError>,
    phase: EstablishmentTeardownPhase,
}

struct CompletedEstablishmentTeardown {
    generation: u64,
    acknowledgement: Option<SyncSender<CommandAcknowledgement<WatchboundResult<Established>>>>,
    cancellation: Arc<EstablishmentCancellationState>,
    terminal_error: Option<WatchboundError>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EstablishmentTeardownPhase {
    PendingPaths,
    WatchedInterests,
    DeferredMap,
    DeferredOrder,
    Promotions,
    TopologyJobs,
    Complete,
}

struct PendingDisposal {
    acknowledgement: Option<DisposalAcknowledgement>,
    interrupted_establishment: Option<CompletedEstablishmentTeardown>,
    cleanup_path_sets: VecDeque<BTreeSet<PathBuf>>,
    cleanup_path_queues: VecDeque<VecDeque<PathBuf>>,
    cleanup_path_vectors: VecDeque<Vec<PathBuf>>,
    phase: DisposalPhase,
}

struct CompletedDisposal {
    acknowledgement: Option<DisposalAcknowledgement>,
    interrupted_establishment: Option<CompletedEstablishmentTeardown>,
}

struct DisposalAcknowledgement {
    generation: u64,
    sender: SyncSender<CommandAcknowledgement<()>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DisposalPhase {
    PendingPaths,
    WatchedInterests,
    DeferredMap,
    DeferredOrder,
    Promotions,
    TopologyJobs,
    Exclusions,
    CleanupPathSets,
    CleanupPathQueues,
    CleanupPathVectors,
    Complete,
}

struct PendingExclusionUpdate {
    generation: u64,
    exclusions: BTreeSet<PathBuf>,
    previous_exclusions: BTreeSet<PathBuf>,
    newly_excluded: VecDeque<PathBuf>,
    newly_included: Vec<PathBuf>,
    acknowledgement: SyncSender<CommandAcknowledgement<WatchboundResult<Coverage>>>,
    phase: ExclusionUpdatePhase,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExclusionUpdatePhase {
    WaitingForTopology,
    RemovingExcluded,
    ScanningIncluded,
}

struct PendingReconciliation {
    acknowledgement: SyncSender<CommandAcknowledgement<WatchboundResult<ReconciliationResult>>>,
    phase: ReconciliationPhase,
    encountered: BTreeSet<PathBuf>,
    sweep_after: Option<PathBuf>,
    rebuilt_deferred_order: VecDeque<PathBuf>,
    starting_uncertainty: Option<UncertainReason>,
    starting_uncertainty_epoch: u64,
}

struct PendingRootRecovery {
    acknowledgement: SyncSender<CommandAcknowledgement<WatchboundResult<RootRecoveryResult>>>,
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
        let exclusions = options
            .initial_exclusions
            .iter()
            .map(|prefix| root.join(prefix))
            .collect();
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
            exclusions,
            exclusion_update: None,
            reconciliation: None,
            root_recovery: None,
            topology_jobs: VecDeque::from([TopologyJob::new(root, true)]),
            topology_barriers: 1,
            establishment: Some(establishment),
            establishment_teardown: None,
            disposal: None,
            published_deferred_directories: 0,
            uncertainty_epoch: 0,
        }
    }

    fn establishment_cancel_requested(&self) -> bool {
        self.establishment
            .as_ref()
            .is_some_and(|establishment| establishment.cancellation.cancellation_requested())
    }

    fn disposal_in_progress(&self) -> bool {
        self.disposal.is_some()
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
                    value: Err(WatchboundError::new(
                        ErrorCode::RootStateConflict,
                        Operation::ReplaceExclusions,
                        "root identity was lost during exclusion update",
                    )),
                });
            }
            if let Some(reconciliation) = self.reconciliation.take() {
                let _ = reconciliation.acknowledgement.send(CommandAcknowledgement {
                    generation: 0,
                    value: Err(WatchboundError::new(
                        ErrorCode::RootStateConflict,
                        Operation::Reconcile,
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

#[derive(Default)]
struct FairIdQueue {
    current_round: BTreeSet<SubscriptionId>,
    next_round: BTreeSet<SubscriptionId>,
}

impl FairIdQueue {
    fn schedule(&mut self, id: SubscriptionId) -> bool {
        if self.current_round.contains(&id) || self.next_round.contains(&id) {
            return false;
        }
        self.next_round.insert(id)
    }

    fn pop_next(&mut self) -> Option<SubscriptionId> {
        if self.current_round.is_empty() {
            std::mem::swap(&mut self.current_round, &mut self.next_round);
        }
        self.current_round.pop_first()
    }

    fn remove(&mut self, id: &SubscriptionId) -> bool {
        self.current_round.remove(id) | self.next_round.remove(id)
    }

    #[cfg(test)]
    fn contains(&self, id: &SubscriptionId) -> bool {
        self.current_round.contains(id) || self.next_round.contains(id)
    }

    fn ready_len(&mut self) -> usize {
        if self.current_round.is_empty() {
            std::mem::swap(&mut self.current_round, &mut self.next_round);
        }
        self.current_round.len()
    }

    fn is_empty(&self) -> bool {
        self.current_round.is_empty() && self.next_round.is_empty()
    }
}

struct Worker {
    inotify: OwnedFd,
    wakeup: Arc<OwnedFd>,
    control_commands: Receiver<CommandEnvelope>,
    work_commands: Receiver<CommandEnvelope>,
    counters: Arc<RuntimeCounters>,
    native_watch_budget: Option<usize>,
    subscriptions: HashMap<SubscriptionId, SubscriptionState>,
    watches: HashMap<i32, NativeWatch>,
    watch_identities: HashMap<RootIdentity, i32>,
    retired_ignored_lifetimes: BTreeMap<i32, ExpectedIgnoredLifetimes>,
    exhausted_watch_descriptors: BTreeSet<i32>,
    topology_runnable: FairIdQueue,
    allocator_order: FairIdQueue,
    next_subscription_id: SubscriptionId,
    read_buffer: Vec<u8>,
    pending_native: Vec<u8>,
    pending_native_offset: usize,
    shutting_down: bool,
    shutdown_acknowledgement: Option<DisposalAcknowledgement>,
    #[cfg(test)]
    root_recovery_barrier_hook: Option<RootRecoveryBarrierHook>,
    #[cfg(test)]
    establishment_barrier_hook: Option<EstablishmentBarrierHook>,
}

impl Worker {
    fn new(
        inotify: OwnedFd,
        wakeup: Arc<OwnedFd>,
        control_commands: Receiver<CommandEnvelope>,
        work_commands: Receiver<CommandEnvelope>,
        counters: Arc<RuntimeCounters>,
        native_watch_budget: Option<usize>,
    ) -> Self {
        Self {
            inotify,
            wakeup,
            control_commands,
            work_commands,
            counters,
            native_watch_budget,
            subscriptions: HashMap::new(),
            watches: HashMap::new(),
            watch_identities: HashMap::new(),
            retired_ignored_lifetimes: BTreeMap::new(),
            exhausted_watch_descriptors: BTreeSet::new(),
            topology_runnable: FairIdQueue::default(),
            allocator_order: FairIdQueue::default(),
            next_subscription_id: 1,
            read_buffer: vec![0; READ_BUFFER_BYTES],
            pending_native: Vec::new(),
            pending_native_offset: 0,
            shutting_down: false,
            shutdown_acknowledgement: None,
            #[cfg(test)]
            root_recovery_barrier_hook: None,
            #[cfg(test)]
            establishment_barrier_hook: None,
        }
    }

    #[cfg(test)]
    fn inject_root_recovery_barrier(&self, barrier: RootRecoveryBarrier, path: &Path) {
        if let Some(hook) = &self.root_recovery_barrier_hook {
            hook(barrier, path);
        }
    }

    #[cfg(test)]
    fn inject_establishment_barrier(&self, barrier: EstablishmentBarrier, path: &Path) {
        if let Some(hook) = &self.establishment_barrier_hook {
            hook(barrier, path);
        }
    }

    fn run(mut self) {
        loop {
            if self.shutting_down {
                if self.process_shutdown_turn() {
                    continue;
                }
                break;
            }
            let control_commands =
                self.process_command_turn(CommandLane::Control, MAX_CONTROL_COMMANDS_PER_TURN);
            if self.shutting_down {
                continue;
            }
            let work_commands =
                self.process_command_turn(CommandLane::Work, MAX_WORK_COMMANDS_PER_TURN);
            let native = self.process_native_turn();
            let promotion = self.process_promotion_turn();
            let topology = self.process_topology_turn();
            self.run_maintenance();
            let immediate = control_commands == MAX_CONTROL_COMMANDS_PER_TURN
                || work_commands == MAX_WORK_COMMANDS_PER_TURN
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
        assert!(self.subscriptions.is_empty());
        assert!(self.watches.is_empty());
        assert!(self.watch_identities.is_empty());
        assert!(self.retired_ignored_lifetimes.is_empty());
        assert!(self.exhausted_watch_descriptors.is_empty());
        assert!(self.topology_runnable.is_empty());
        assert!(self.allocator_order.is_empty());
    }

    fn process_command_turn(&mut self, lane: CommandLane, limit: usize) -> usize {
        let mut processed = 0;
        while processed < limit {
            let received = match lane {
                CommandLane::Control => self.control_commands.try_recv(),
                CommandLane::Work => self.work_commands.try_recv(),
            };
            let envelope = match received {
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
                    cancellation,
                } => {
                    if cancellation.cancellation_requested() {
                        cancellation.finish_cancelled();
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(operation_cancelled_error()),
                        });
                        continue;
                    }
                    let root_identity = match RootIdentity::capture(&root) {
                        Ok(identity) => identity,
                        Err(error) => {
                            let error = error.into_watchbound(
                                Operation::Subscribe,
                                "watch root changed while establishing the subscription",
                            );
                            let _ = acknowledgement.send(CommandAcknowledgement {
                                generation,
                                value: Err(commit_establishment_failure(&cancellation, error)),
                            });
                            continue;
                        }
                    };
                    if cancellation.cancellation_requested() {
                        cancellation.finish_cancelled();
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(operation_cancelled_error()),
                        });
                        continue;
                    }
                    let id = self.next_subscription_id;
                    let Some(next_subscription_id) = self.next_subscription_id.checked_add(1)
                    else {
                        let error = WatchboundError::new(
                            ErrorCode::Internal,
                            Operation::Subscribe,
                            "subscription IDs are exhausted",
                        );
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(commit_establishment_failure(&cancellation, error)),
                        });
                        continue;
                    };
                    self.next_subscription_id = next_subscription_id;
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
                            cancellation,
                        },
                    );
                    let replaced = self.subscriptions.insert(id, state);
                    debug_assert!(replaced.is_none(), "subscription IDs must be unique");
                    self.allocator_order.schedule(id);
                    self.counters
                        .subscriptions
                        .store(self.subscriptions.len(), Ordering::Release);
                    self.schedule_topology(id);
                }
                Command::Dispose {
                    subscription_id,
                    acknowledgement,
                } => {
                    let Some(mut state) = self.subscriptions.remove(&subscription_id) else {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: (),
                        });
                        continue;
                    };
                    self.begin_subscription_disposal(&mut state, generation, Some(acknowledgement));
                    self.subscriptions.insert(subscription_id, state);
                    self.schedule_topology(subscription_id);
                }
                Command::ReplaceExclusions {
                    subscription_id,
                    prefixes,
                    acknowledgement,
                } => {
                    let Some(mut state) = self.subscriptions.remove(&subscription_id) else {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(WatchboundError::new(
                                ErrorCode::SubscriptionClosed,
                                Operation::ReplaceExclusions,
                                "subscription is no longer active",
                            )),
                        });
                        continue;
                    };
                    let validation = if state.disposal_in_progress() {
                        Err(WatchboundError::new(
                            ErrorCode::SubscriptionClosed,
                            Operation::ReplaceExclusions,
                            "subscription is disposing",
                        ))
                    } else if generation <= state.exclusion_generation {
                        Err(WatchboundError::new(
                            ErrorCode::InvalidArgument,
                            Operation::ReplaceExclusions,
                            format!(
                                "exclusion generation {generation} is not newer than committed generation {}",
                                state.exclusion_generation
                            ),
                        ))
                    } else if state.root_lost {
                        Err(WatchboundError::new(
                            ErrorCode::RootStateConflict,
                            Operation::ReplaceExclusions,
                            "root identity is lost; recover the root before replacing exclusions",
                        ))
                    } else if state.exclusion_update.is_some()
                        || state.reconciliation.is_some()
                        || state.root_recovery.is_some()
                    {
                        Err(WatchboundError::new(
                            ErrorCode::TopologyTransactionConflict,
                            Operation::ReplaceExclusions,
                            "a topology transaction is already in progress for this subscription",
                        ))
                    } else {
                        validate_exclusion_prefixes(
                            &state.root,
                            prefixes,
                            Operation::ReplaceExclusions,
                        )
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
                            value: Err(WatchboundError::new(
                                ErrorCode::SubscriptionClosed,
                                Operation::Reconcile,
                                "subscription is no longer active",
                            )),
                        });
                        continue;
                    };
                    if state.disposal_in_progress() {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(WatchboundError::new(
                                ErrorCode::SubscriptionClosed,
                                Operation::Reconcile,
                                "subscription is disposing",
                            )),
                        });
                    } else if state.exclusion_update.is_some()
                        || state.reconciliation.is_some()
                        || state.root_recovery.is_some()
                    {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(WatchboundError::new(
                                ErrorCode::TopologyTransactionConflict,
                                Operation::Reconcile,
                                "a topology transaction is already in progress for this subscription",
                            )),
                        });
                    } else if state.root_lost {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(WatchboundError::new(
                                ErrorCode::RootStateConflict,
                                Operation::Reconcile,
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
                            value: Err(WatchboundError::new(
                                ErrorCode::SubscriptionClosed,
                                Operation::RecoverRoot,
                                "subscription is no longer active",
                            )),
                        });
                        continue;
                    };
                    if state.disposal_in_progress() {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(WatchboundError::new(
                                ErrorCode::SubscriptionClosed,
                                Operation::RecoverRoot,
                                "subscription is disposing",
                            )),
                        });
                    } else if state.exclusion_update.is_some()
                        || state.reconciliation.is_some()
                        || state.root_recovery.is_some()
                    {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(WatchboundError::new(
                                ErrorCode::TopologyTransactionConflict,
                                Operation::RecoverRoot,
                                "a topology transaction is already in progress for this subscription",
                            )),
                        });
                    } else if !state.root_lost {
                        let _ = acknowledgement.send(CommandAcknowledgement {
                            generation,
                            value: Err(WatchboundError::new(
                                ErrorCode::RootStateConflict,
                                Operation::RecoverRoot,
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
                                #[cfg(test)]
                                self.inject_root_recovery_barrier(
                                    RootRecoveryBarrier::CandidateCaptured,
                                    &state.root,
                                );
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
                    debug_assert!(
                        !self.shutting_down && self.shutdown_acknowledgement.is_none(),
                        "the runtime must issue exactly one shutdown command"
                    );
                    self.shutting_down = true;
                    self.shutdown_acknowledgement = Some(DisposalAcknowledgement {
                        generation,
                        sender: acknowledgement,
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
                if state.disposal_in_progress() {
                    continue;
                }
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
            if state.disposal_in_progress() {
                self.subscriptions.insert(state.id, state);
                continue;
            }
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
        if state.disposal_in_progress()
            || state.establishment_teardown.is_some()
            || state.establishment_cancel_requested()
        {
            return;
        }
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
            } else if let Some(watch) = self.watches.get_mut(&descriptor) {
                // IN_DELETE_SELF is followed by one IN_IGNORED for this
                // specific kernel-watch lifetime. Keep that expectation on
                // the live watch so an older queued record for a recycled
                // numeric descriptor cannot consume it.
                watch.expects_ignored = true;
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
        } else if state.reconciliation.is_some() || state.root_recovery.is_some() || state.root_lost
        {
            state.queue_path(state.root.clone());
        } else {
            state.queue_path(event_path.clone());
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

    fn next_watch_lifetime(&self, descriptor: i32) -> io::Result<WatchLifetime> {
        let latest = self
            .retired_ignored_lifetimes
            .get(&descriptor)
            .map(|lifetimes| lifetimes.last)
            .into_iter()
            .chain(self.watches.get(&descriptor).map(|watch| watch.lifetime))
            .max();
        match latest {
            Some(WatchLifetime(lifetime)) => lifetime
                .checked_add(1)
                .map(WatchLifetime)
                .ok_or_else(|| io::Error::from_raw_os_error(libc::EOVERFLOW)),
            None => Ok(WatchLifetime(1)),
        }
    }

    fn claim_new_watch_lifetime(&mut self, descriptor: i32) -> io::Result<WatchLifetime> {
        if self.exhausted_watch_descriptors.contains(&descriptor) {
            // SAFETY: this is called only after inotify_add_watch returned a
            // descriptor that has no live registry entry. Quarantined numeric
            // descriptors are never admitted again.
            unsafe {
                libc::inotify_rm_watch(self.inotify.as_raw_fd(), descriptor);
            }
            return Err(io::Error::from_raw_os_error(libc::EOVERFLOW));
        }
        match self.next_watch_lifetime(descriptor) {
            Ok(lifetime) => Ok(lifetime),
            Err(error) => {
                self.exhausted_watch_descriptors.insert(descriptor);
                // SAFETY: as above, the successful add is not represented by
                // a live registry entry. Remove it before reporting failure.
                unsafe {
                    libc::inotify_rm_watch(self.inotify.as_raw_fd(), descriptor);
                }
                Err(error)
            }
        }
    }

    fn mark_reused_descriptor_uncertain(&self, state: &mut SubscriptionState, descriptor: i32) {
        if self.retired_ignored_lifetimes.contains_key(&descriptor) {
            // The expected IN_IGNORED record is lifetime-ordered, but any
            // other queued record with the reused numeric descriptor remains
            // ambiguous. Every sharing subscription therefore inherits the
            // same conservative coverage state.
            state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
        }
    }

    fn expect_ignored(&mut self, descriptor: i32, lifetime: WatchLifetime) {
        let ordered = match self.retired_ignored_lifetimes.get_mut(&descriptor) {
            Some(lifetimes) => {
                if lifetime == lifetimes.last {
                    true
                } else if lifetimes.last.0.checked_add(1) == Some(lifetime.0) {
                    lifetimes.last = lifetime;
                    true
                } else {
                    false
                }
            }
            None => {
                self.retired_ignored_lifetimes.insert(
                    descriptor,
                    ExpectedIgnoredLifetimes {
                        first: lifetime,
                        last: lifetime,
                    },
                );
                true
            }
        };
        if !ordered {
            // A gap would make a compact range consume an ignored event for a
            // lifetime that was never retired. Permanently quarantine the
            // numeric descriptor instead of weakening attribution.
            self.exhausted_watch_descriptors.insert(descriptor);
        }
    }

    fn remove_native_watch_lifetime(&mut self, descriptor: i32, lifetime: WatchLifetime) {
        self.expect_ignored(descriptor, lifetime);
        // SAFETY: inotify is live. Failure is benign when the kernel already
        // removed this exact lifetime and queued its IN_IGNORED record.
        unsafe {
            libc::inotify_rm_watch(self.inotify.as_raw_fd(), descriptor);
        }
    }

    fn consume_expected_ignored(&mut self, descriptor: i32) -> Option<WatchLifetime> {
        let (lifetime, exhausted) = {
            let lifetimes = self.retired_ignored_lifetimes.get_mut(&descriptor)?;
            let lifetime = lifetimes.first;
            if lifetimes.first == lifetimes.last {
                (lifetime, true)
            } else {
                lifetimes.first = WatchLifetime(lifetimes.first.0 + 1);
                (lifetime, false)
            }
        };
        if exhausted {
            self.retired_ignored_lifetimes.remove(&descriptor);
        }
        Some(lifetime)
    }

    fn handle_ignored(&mut self, descriptor: i32) {
        if let Some(retired_lifetime) = self.consume_expected_ignored(descriptor) {
            debug_assert!(
                self.watches
                    .get(&descriptor)
                    .is_none_or(|watch| watch.lifetime > retired_lifetime),
                "an expected ignored record must precede a reused live lifetime"
            );
            return;
        }
        let Some(watch) = self.watches.remove(&descriptor) else {
            return;
        };
        let expected = watch.expects_ignored;
        self.watch_identities
            .retain(|_, candidate| *candidate != descriptor);
        let mut schedule = Vec::new();
        for interest in watch.interests {
            if let Some(state) = self.subscriptions.get_mut(&interest.subscription_id) {
                if state.disposal_in_progress() {
                    continue;
                }
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
            .ready_len()
            .min(MAX_ALLOCATOR_SUBSCRIPTIONS_PER_TURN);
        for _ in 0..candidates {
            let Some(id) = self.allocator_order.pop_next() else {
                return false;
            };
            let Some(mut state) = self.subscriptions.remove(&id) else {
                debug_assert!(false, "allocator membership must name a live subscription");
                continue;
            };
            self.allocator_order.schedule(id);
            if state.root_lost
                || state.exclusion_update.is_some()
                || state.reconciliation.is_some()
                || state.root_recovery.is_some()
                || state.disposal_in_progress()
                || state.establishment_teardown.is_some()
                || state.establishment_cancel_requested()
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
        let Some(id) = self.topology_runnable.pop_next() else {
            return false;
        };
        let Some(mut state) = self.subscriptions.remove(&id) else {
            return true;
        };
        if self.shutting_down && !state.disposal_in_progress() {
            self.begin_subscription_disposal(&mut state, 0, None);
        }
        if state.disposal_in_progress() {
            self.process_subscription_disposal_turn(state);
            return true;
        }
        if state.establishment_teardown.is_some() {
            self.process_establishment_teardown_turn(state);
            return true;
        }
        if state.establishment_cancel_requested() {
            self.begin_cancelled_establishment_teardown(&mut state);
            self.process_establishment_teardown_turn(state);
            return true;
        }
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
            if let Some(establishment) = state.establishment.take() {
                let error = WatchboundError::new(
                    ErrorCode::RootUnavailable,
                    Operation::Subscribe,
                    format!(
                        "watch root was lost during establishment: {}",
                        state.root.display()
                    ),
                );
                self.begin_failed_establishment_teardown(&mut state, establishment, error);
                self.process_establishment_teardown_turn(state);
            } else {
                self.subscriptions.insert(id, state);
            }
            return true;
        }
        let mut directories = 0;
        let mut entries = 0;
        let mut native_allocations = 0;
        let mut establishment_teardown_started = false;
        'topology: while directories < MAX_TOPOLOGY_DIRECTORIES_PER_TURN
            && entries < MAX_TOPOLOGY_ENTRIES_PER_TURN
            && (self.native_watch_budget.is_none() || native_allocations == 0)
        {
            if state.establishment_cancel_requested() {
                self.begin_cancelled_establishment_teardown(&mut state);
                establishment_teardown_started = true;
                break;
            }
            let Some(mut job) = state.topology_jobs.pop_front() else {
                break;
            };
            if job.active.is_none() {
                let Some(directory) = job.directories.pop_front() else {
                    establishment_teardown_started = self.finish_topology_job(
                        &mut state,
                        job.establishment,
                        job.promotion_root.as_deref(),
                    );
                    if establishment_teardown_started {
                        break;
                    }
                    continue;
                };
                directories += 1;
                if state.is_excluded(&directory) {
                    state.remove_deferred_subtree(&directory);
                    state.topology_jobs.push_front(job);
                    continue;
                }
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
            if state.establishment_cancel_requested() {
                state.topology_jobs.push_front(job);
                self.begin_cancelled_establishment_teardown(&mut state);
                establishment_teardown_started = true;
                break;
            }
            #[cfg(test)]
            let root_recovery_traversal = state
                .root_recovery
                .as_ref()
                .is_some_and(|recovery| recovery.phase == RootRecoveryPhase::Scanning)
                .then(|| state.root.clone());
            let active = job.active.as_mut().expect("active topology directory");
            let mut finished = false;
            let mut cancellation_observed = false;
            while entries < MAX_TOPOLOGY_ENTRIES_PER_TURN {
                if state.establishment_cancel_requested() {
                    cancellation_observed = true;
                    break;
                }
                #[cfg(test)]
                if let Some(root) = &root_recovery_traversal {
                    self.inject_root_recovery_barrier(RootRecoveryBarrier::DuringTraversal, root);
                }
                #[cfg(test)]
                if state.establishment.is_some() {
                    self.inject_establishment_barrier(
                        EstablishmentBarrier::DuringTraversal,
                        &active.path,
                    );
                }
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
            if cancellation_observed {
                state.topology_jobs.push_front(job);
                self.begin_cancelled_establishment_teardown(&mut state);
                establishment_teardown_started = true;
                break 'topology;
            }
            if finished {
                job.active = None;
                if job.directories.is_empty() {
                    establishment_teardown_started = self.finish_topology_job(
                        &mut state,
                        job.establishment,
                        job.promotion_root.as_deref(),
                    );
                    if establishment_teardown_started {
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
        if establishment_teardown_started || state.establishment_teardown.is_some() {
            self.process_establishment_teardown_turn(state);
            return true;
        }
        if state.establishment_cancel_requested() {
            self.begin_cancelled_establishment_teardown(&mut state);
            self.process_establishment_teardown_turn(state);
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
            let root_stable = RootIdentity::capture(&state.root)
                .is_ok_and(|identity| identity == state.root_identity);
            if !root_stable {
                state.mark_root_lost(RootLossEvidence::PathIdentityMismatch);
                return;
            }
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
            let root_stable = RootIdentity::capture(&state.root)
                .is_ok_and(|identity| identity == state.root_identity);
            if !root_stable {
                state.mark_root_lost(RootLossEvidence::PathIdentityMismatch);
                return;
            }
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
                            value: Err(WatchboundError::new(
                                ErrorCode::RootStateConflict,
                                Operation::Reconcile,
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
                    value: Err(WatchboundError::new(
                        ErrorCode::RootStateConflict,
                        Operation::Reconcile,
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
            Err(error) => {
                state.stats.batches_dropped.fetch_add(1, Ordering::Relaxed);
                if state.uncertainty_epoch == reconciliation.starting_uncertainty_epoch {
                    state.uncertain_reason = Some(UncertainReason::ConsumerBackpressure);
                } else {
                    state.mark_uncertain(UncertainReason::ConsumerBackpressure, state.root.clone());
                }
                state.queue_path(state.root.clone());
                state.publish_resource_counts();
                self.publish_deferred_interest_count_with(state);
                let (code, message) = match error {
                    TrySendError::Full(_) => (
                        ErrorCode::ConsumerBackpressure,
                        "reconciliation root invalidation could not enter the output queue",
                    ),
                    TrySendError::Disconnected(_) => (
                        ErrorCode::SubscriptionClosed,
                        "subscription output closed during reconciliation",
                    ),
                };
                let _ = reconciliation.acknowledgement.send(CommandAcknowledgement {
                    generation: 0,
                    value: Err(WatchboundError::new(code, Operation::Reconcile, message)),
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

            #[cfg(test)]
            self.inject_root_recovery_barrier(
                RootRecoveryBarrier::OldInterestsDrained,
                &state.root,
            );

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
            if state
                .root_recovery
                .as_ref()
                .is_some_and(|recovery| recovery.candidate_unstable)
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
            #[cfg(test)]
            self.inject_root_recovery_barrier(
                RootRecoveryBarrier::BeforeFinalValidation,
                &state.root,
            );
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
        if state.establishment_cancel_requested() {
            self.begin_cancelled_establishment_teardown(state);
            return true;
        }
        #[cfg(test)]
        self.inject_establishment_barrier(EstablishmentBarrier::BeforeFinalValidation, &state.root);
        if state.establishment_cancel_requested() {
            self.begin_cancelled_establishment_teardown(state);
            return true;
        }
        let establishment = state
            .establishment
            .take()
            .expect("an establishment topology job must own its acknowledgement");
        let result = if !state.watched_paths.contains_key(&state.root)
            && !state.deferred_directories.contains_key(&state.root)
            && !state.is_excluded(&state.root)
        {
            Err(WatchboundError::new(
                ErrorCode::RootUnavailable,
                Operation::Subscribe,
                format!(
                    "watch root disappeared during establishment: {}",
                    state.root.display()
                ),
            ))
        } else {
            match RootIdentity::capture(&state.root) {
                Ok(identity) if identity == state.root_identity => {
                    let initial_root_state = state.root_state();
                    Ok(Established {
                        id: state.id,
                        coverage: state.coverage(),
                        initial_root_state,
                        root_state: Arc::clone(&state.published_root_state),
                    })
                }
                Ok(_) | Err(_) => Err(WatchboundError::new(
                    ErrorCode::RootUnavailable,
                    Operation::Subscribe,
                    format!(
                        "watch root changed during establishment: {}",
                        state.root.display()
                    ),
                )),
            }
        };
        #[cfg(test)]
        self.inject_establishment_barrier(EstablishmentBarrier::BeforeFinalCommit, &state.root);
        match result {
            Ok(established) => {
                if !establishment.cancellation.try_commit_success() {
                    self.begin_establishment_teardown(
                        state,
                        establishment,
                        Some(operation_cancelled_error()),
                    );
                    return true;
                }
                state.next_root_identity_check =
                    Some(Instant::now() + ROOT_IDENTITY_CHECK_INTERVAL);
                // The establishment acknowledgement is the public visibility
                // boundary: publish both subscription-local and runtime
                // allocator gauges before the subscribing thread can observe
                // the returned handle.
                state.publish_resource_counts();
                self.publish_deferred_interest_count_with(state);
                if establishment
                    .acknowledgement
                    .send(CommandAcknowledgement {
                        generation: establishment.generation,
                        value: Ok(established),
                    })
                    .is_err()
                {
                    self.begin_orphaned_establishment_teardown(state, establishment);
                    return true;
                }
                false
            }
            Err(error) => {
                self.begin_failed_establishment_teardown(state, establishment, error);
                true
            }
        }
    }

    fn begin_failed_establishment_teardown(
        &mut self,
        state: &mut SubscriptionState,
        establishment: PendingEstablishment,
        error: WatchboundError,
    ) {
        let terminal_error = if establishment.cancellation.try_commit_failure() {
            error
        } else {
            operation_cancelled_error()
        };
        self.begin_establishment_teardown(state, establishment, Some(terminal_error));
    }

    fn begin_cancelled_establishment_teardown(&mut self, state: &mut SubscriptionState) {
        let establishment = state
            .establishment
            .take()
            .expect("a cancellable establishment must own its acknowledgement");
        self.begin_establishment_teardown(state, establishment, Some(operation_cancelled_error()));
    }

    fn begin_establishment_teardown(
        &mut self,
        state: &mut SubscriptionState,
        establishment: PendingEstablishment,
        terminal_error: Option<WatchboundError>,
    ) {
        debug_assert!(state.establishment_teardown.is_none());
        state.topology_barriers = 0;
        state.pending_started = None;
        state.pending_generation = None;
        state.establishment_teardown = Some(PendingEstablishmentTeardown {
            generation: establishment.generation,
            acknowledgement: Some(establishment.acknowledgement),
            cancellation: establishment.cancellation,
            terminal_error,
            phase: EstablishmentTeardownPhase::PendingPaths,
        });
    }

    fn begin_orphaned_establishment_teardown(
        &mut self,
        state: &mut SubscriptionState,
        establishment: PendingEstablishment,
    ) {
        debug_assert!(state.establishment_teardown.is_none());
        state.topology_barriers = 0;
        state.pending_started = None;
        state.pending_generation = None;
        state.establishment_teardown = Some(PendingEstablishmentTeardown {
            generation: establishment.generation,
            acknowledgement: None,
            cancellation: establishment.cancellation,
            terminal_error: None,
            phase: EstablishmentTeardownPhase::PendingPaths,
        });
    }

    fn process_establishment_teardown_turn(&mut self, mut state: SubscriptionState) {
        let id = state.id;
        if let Some(completed) = self.progress_establishment_teardown(&mut state) {
            debug_assert!(
                !self.topology_runnable.remove(&id),
                "the running teardown must be the subscription's only topology turn"
            );
            debug_assert!(
                self.allocator_order.remove(&id),
                "an admitted subscription must own allocator membership"
            );
            state.stats.watched_directories.store(0, Ordering::Release);
            let published_deferred = state.published_deferred_directories;
            state.published_deferred_directories = 0;
            state.stats.deferred_directories.store(0, Ordering::Release);
            state.stats.disposed.store(true, Ordering::Release);
            self.counters
                .subscriptions
                .store(self.subscriptions.len(), Ordering::Release);
            self.remove_published_deferred_interest_count(published_deferred);
            drop(state);
            self.finish_establishment_teardown(completed);
            return;
        }
        #[cfg(test)]
        self.inject_establishment_barrier(
            EstablishmentBarrier::TeardownQuantumCompleted,
            &state.root,
        );
        self.subscriptions.insert(id, state);
        self.schedule_topology(id);
    }

    fn progress_establishment_teardown(
        &mut self,
        state: &mut SubscriptionState,
    ) -> Option<CompletedEstablishmentTeardown> {
        let mut removed = 0;
        while removed < MAX_ESTABLISHMENT_TEARDOWN_ITEMS_PER_TURN {
            let phase = state
                .establishment_teardown
                .as_ref()
                .expect("establishment teardown must exist")
                .phase;
            match phase {
                EstablishmentTeardownPhase::PendingPaths => {
                    if state.pending_paths.pop_first().is_some() {
                        removed += 1;
                    } else {
                        state
                            .establishment_teardown
                            .as_mut()
                            .expect("establishment teardown must exist")
                            .phase = EstablishmentTeardownPhase::WatchedInterests;
                    }
                }
                EstablishmentTeardownPhase::WatchedInterests => {
                    if let Some((path, descriptor)) = state.watched_paths.pop_first() {
                        self.remove_interest(state.id, &path, descriptor);
                        removed += 1;
                    } else {
                        state
                            .establishment_teardown
                            .as_mut()
                            .expect("establishment teardown must exist")
                            .phase = EstablishmentTeardownPhase::DeferredMap;
                    }
                }
                EstablishmentTeardownPhase::DeferredMap => {
                    if state.deferred_directories.pop_first().is_some() {
                        removed += 1;
                    } else {
                        state
                            .establishment_teardown
                            .as_mut()
                            .expect("establishment teardown must exist")
                            .phase = EstablishmentTeardownPhase::DeferredOrder;
                    }
                }
                EstablishmentTeardownPhase::DeferredOrder => {
                    if state.deferred_order.pop_front().is_some() {
                        removed += 1;
                    } else {
                        state
                            .establishment_teardown
                            .as_mut()
                            .expect("establishment teardown must exist")
                            .phase = EstablishmentTeardownPhase::Promotions;
                    }
                }
                EstablishmentTeardownPhase::Promotions => {
                    if state.pending_promotions.pop_first().is_some() {
                        removed += 1;
                    } else {
                        state
                            .establishment_teardown
                            .as_mut()
                            .expect("establishment teardown must exist")
                            .phase = EstablishmentTeardownPhase::TopologyJobs;
                    }
                }
                EstablishmentTeardownPhase::TopologyJobs => {
                    let Some(job) = state.topology_jobs.front_mut() else {
                        state
                            .establishment_teardown
                            .as_mut()
                            .expect("establishment teardown must exist")
                            .phase = EstablishmentTeardownPhase::Complete;
                        continue;
                    };
                    if job.active.take().is_some() || job.directories.pop_front().is_some() {
                        removed += 1;
                    } else {
                        state.topology_jobs.pop_front();
                        removed += 1;
                    }
                }
                EstablishmentTeardownPhase::Complete => {
                    let teardown = state
                        .establishment_teardown
                        .take()
                        .expect("completed establishment teardown must exist");
                    return Some(CompletedEstablishmentTeardown {
                        generation: teardown.generation,
                        acknowledgement: teardown.acknowledgement,
                        cancellation: teardown.cancellation,
                        terminal_error: teardown.terminal_error,
                    });
                }
            }
        }
        None
    }

    fn finish_establishment_teardown(&mut self, completed: CompletedEstablishmentTeardown) {
        // This also detaches failure/success tokens from their best-effort
        // runtime wake handle; the state transition itself is a no-op unless
        // cancellation won.
        completed.cancellation.finish_cancelled();
        if let (Some(acknowledgement), Some(error)) =
            (completed.acknowledgement, completed.terminal_error)
        {
            let _ = acknowledgement.send(CommandAcknowledgement {
                generation: completed.generation,
                value: Err(error),
            });
        }
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
            #[cfg(test)]
            if state.root_recovery.is_some() {
                self.inject_root_recovery_barrier(RootRecoveryBarrier::SharingExistingWatch, path);
            }
            if directory_identity(path).ok() != Some(identity) {
                if path == state.root
                    && let Some(recovery) = state.root_recovery.as_mut()
                {
                    recovery.candidate_unstable = true;
                }
                state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
                return Err(io::Error::from_raw_os_error(libc::ESTALE));
            }
            self.mark_reused_descriptor_uncertain(state, descriptor);
            self.insert_interest(state, path, descriptor);
            #[cfg(test)]
            if state.establishment.is_some() {
                self.inject_establishment_barrier(EstablishmentBarrier::SharingExistingWatch, path);
            }
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
        #[cfg(test)]
        if state.root_recovery.is_some() {
            self.inject_root_recovery_barrier(RootRecoveryBarrier::BeforeAddWatch, path);
        }
        // SAFETY: c_path is NUL-terminated and inotify is a live descriptor.
        let descriptor = unsafe {
            libc::inotify_add_watch(self.inotify.as_raw_fd(), c_path.as_ptr(), WATCH_MASK)
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        #[cfg(test)]
        if state.root_recovery.is_some() {
            self.inject_root_recovery_barrier(RootRecoveryBarrier::AfterAddWatch, path);
        }
        let created_native_watch = !self.watches.contains_key(&descriptor);
        let created_lifetime = if created_native_watch {
            match self.claim_new_watch_lifetime(descriptor) {
                Ok(lifetime) => Some(lifetime),
                Err(error) => {
                    state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
                    return Err(error);
                }
            }
        } else {
            None
        };
        let identity_after = directory_identity(path);
        if identity_after.as_ref().ok() != Some(&identity)
            || self
                .watches
                .get(&descriptor)
                .and_then(|watch| watch.identity)
                .is_some_and(|watched| watched != identity)
        {
            if path == state.root
                && let Some(recovery) = state.root_recovery.as_mut()
            {
                recovery.candidate_unstable = true;
            }
            if created_native_watch {
                self.remove_native_watch_lifetime(
                    descriptor,
                    created_lifetime.expect("a newly created watch must have a lifetime"),
                );
            }
            state.mark_uncertain(UncertainReason::TopologyRace, state.root.clone());
            return Err(io::Error::from_raw_os_error(libc::ESTALE));
        }
        self.mark_reused_descriptor_uncertain(state, descriptor);
        if created_native_watch {
            self.watches.insert(
                descriptor,
                NativeWatch {
                    lifetime: created_lifetime.expect("a newly created watch must have a lifetime"),
                    identity: None,
                    interests: BTreeSet::new(),
                    expects_ignored: false,
                },
            );
        }
        let watch = self
            .watches
            .get_mut(&descriptor)
            .expect("a successful native watch must be registered");
        watch.identity.get_or_insert(identity);
        self.watch_identities.insert(identity, descriptor);
        self.insert_interest(state, path, descriptor);
        #[cfg(test)]
        if state.establishment.is_some() {
            self.inject_establishment_barrier(EstablishmentBarrier::AfterAddWatch, path);
        }
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
            let watch = self
                .watches
                .remove(&descriptor)
                .expect("the final logical interest must own a native watch");
            if let Some(identity) = watch.identity {
                self.watch_identities.remove(&identity);
            }
            self.remove_native_watch_lifetime(descriptor, watch.lifetime);
            self.publish_native_watch_count();
        }
    }

    fn begin_subscription_disposal(
        &mut self,
        state: &mut SubscriptionState,
        generation: u64,
        acknowledgement: Option<SyncSender<CommandAcknowledgement<()>>>,
    ) {
        if state.disposal.is_some() {
            assert!(
                acknowledgement.is_none(),
                "the public lifecycle must coalesce duplicate disposal commands"
            );
            return;
        }

        self.topology_runnable.remove(&state.id);
        self.allocator_order.remove(&state.id);
        state.topology_barriers = 0;
        state.pending_started = None;
        state.pending_generation = None;
        state.next_root_identity_check = None;

        let interrupted_establishment = if let Some(establishment) = state.establishment.take() {
            let terminal_error = if establishment.cancellation.try_commit_failure() {
                WatchboundError::new(
                    ErrorCode::OperationInterrupted,
                    Operation::Subscribe,
                    "subscription disposed during establishment",
                )
            } else {
                operation_cancelled_error()
            };
            Some(CompletedEstablishmentTeardown {
                generation: establishment.generation,
                acknowledgement: Some(establishment.acknowledgement),
                cancellation: establishment.cancellation,
                terminal_error: Some(terminal_error),
            })
        } else {
            state
                .establishment_teardown
                .take()
                .map(|teardown| CompletedEstablishmentTeardown {
                    generation: teardown.generation,
                    acknowledgement: teardown.acknowledgement,
                    cancellation: teardown.cancellation,
                    terminal_error: teardown.terminal_error,
                })
        };

        let mut cleanup_path_sets = VecDeque::new();
        let mut cleanup_path_queues = VecDeque::new();
        let mut cleanup_path_vectors = VecDeque::new();
        if let Some(update) = state.exclusion_update.take() {
            let PendingExclusionUpdate {
                generation,
                exclusions,
                previous_exclusions,
                newly_excluded,
                newly_included,
                acknowledgement,
                ..
            } = update;
            let _ = acknowledgement.send(CommandAcknowledgement {
                generation,
                value: Err(WatchboundError::new(
                    ErrorCode::OperationInterrupted,
                    Operation::ReplaceExclusions,
                    "subscription disposed during exclusion update",
                )),
            });
            cleanup_path_sets.push_back(exclusions);
            cleanup_path_sets.push_back(previous_exclusions);
            cleanup_path_queues.push_back(newly_excluded);
            cleanup_path_vectors.push_back(newly_included);
        }
        if let Some(reconciliation) = state.reconciliation.take() {
            let PendingReconciliation {
                acknowledgement,
                encountered,
                rebuilt_deferred_order,
                ..
            } = reconciliation;
            let _ = acknowledgement.send(CommandAcknowledgement {
                generation: 0,
                value: Err(WatchboundError::new(
                    ErrorCode::OperationInterrupted,
                    Operation::Reconcile,
                    "subscription disposed during reconciliation",
                )),
            });
            cleanup_path_sets.push_back(encountered);
            cleanup_path_queues.push_back(rebuilt_deferred_order);
        }
        if let Some(recovery) = state.root_recovery.take() {
            let _ = recovery.acknowledgement.send(CommandAcknowledgement {
                generation: 0,
                value: Err(WatchboundError::new(
                    ErrorCode::OperationInterrupted,
                    Operation::RecoverRoot,
                    "subscription disposed during root recovery",
                )),
            });
        }

        state.disposal = Some(PendingDisposal {
            acknowledgement: acknowledgement
                .map(|sender| DisposalAcknowledgement { generation, sender }),
            interrupted_establishment,
            cleanup_path_sets,
            cleanup_path_queues,
            cleanup_path_vectors,
            phase: DisposalPhase::PendingPaths,
        });
    }

    fn process_subscription_disposal_turn(&mut self, mut state: SubscriptionState) {
        let id = state.id;
        if let Some(completed) = self.progress_subscription_disposal(&mut state) {
            self.complete_subscription_disposal(state, completed);
            return;
        }
        self.subscriptions.insert(id, state);
        self.schedule_topology(id);
    }

    fn progress_subscription_disposal(
        &mut self,
        state: &mut SubscriptionState,
    ) -> Option<CompletedDisposal> {
        let mut removed = 0;
        while removed < MAX_DISPOSAL_ITEMS_PER_TURN {
            let phase = state
                .disposal
                .as_ref()
                .expect("disposing subscription must own disposal state")
                .phase;
            match phase {
                DisposalPhase::PendingPaths => {
                    if state.pending_paths.pop_first().is_some() {
                        removed += 1;
                    } else {
                        state.disposal.as_mut().unwrap().phase = DisposalPhase::WatchedInterests;
                    }
                }
                DisposalPhase::WatchedInterests => {
                    if let Some((path, descriptor)) = state.watched_paths.pop_first() {
                        self.remove_interest(state.id, &path, descriptor);
                        removed += 1;
                    } else {
                        state.disposal.as_mut().unwrap().phase = DisposalPhase::DeferredMap;
                    }
                }
                DisposalPhase::DeferredMap => {
                    if state.deferred_directories.pop_first().is_some() {
                        removed += 1;
                    } else {
                        state.disposal.as_mut().unwrap().phase = DisposalPhase::DeferredOrder;
                    }
                }
                DisposalPhase::DeferredOrder => {
                    if state.deferred_order.pop_front().is_some() {
                        removed += 1;
                    } else {
                        state.disposal.as_mut().unwrap().phase = DisposalPhase::Promotions;
                    }
                }
                DisposalPhase::Promotions => {
                    if state.pending_promotions.pop_first().is_some() {
                        removed += 1;
                    } else {
                        state.disposal.as_mut().unwrap().phase = DisposalPhase::TopologyJobs;
                    }
                }
                DisposalPhase::TopologyJobs => {
                    let Some(job) = state.topology_jobs.front_mut() else {
                        state.disposal.as_mut().unwrap().phase = DisposalPhase::Exclusions;
                        continue;
                    };
                    if job.active.take().is_some() || job.directories.pop_front().is_some() {
                        removed += 1;
                    } else {
                        state.topology_jobs.pop_front();
                        removed += 1;
                    }
                }
                DisposalPhase::Exclusions => {
                    if state.exclusions.pop_first().is_some() {
                        removed += 1;
                    } else {
                        state.disposal.as_mut().unwrap().phase = DisposalPhase::CleanupPathSets;
                    }
                }
                DisposalPhase::CleanupPathSets => {
                    let disposal = state.disposal.as_mut().unwrap();
                    let Some(paths) = disposal.cleanup_path_sets.front_mut() else {
                        disposal.phase = DisposalPhase::CleanupPathQueues;
                        continue;
                    };
                    if paths.pop_first().is_some() {
                        removed += 1;
                    } else {
                        disposal.cleanup_path_sets.pop_front();
                        removed += 1;
                    }
                }
                DisposalPhase::CleanupPathQueues => {
                    let disposal = state.disposal.as_mut().unwrap();
                    let Some(paths) = disposal.cleanup_path_queues.front_mut() else {
                        disposal.phase = DisposalPhase::CleanupPathVectors;
                        continue;
                    };
                    if paths.pop_front().is_some() {
                        removed += 1;
                    } else {
                        disposal.cleanup_path_queues.pop_front();
                        removed += 1;
                    }
                }
                DisposalPhase::CleanupPathVectors => {
                    let disposal = state.disposal.as_mut().unwrap();
                    let Some(paths) = disposal.cleanup_path_vectors.front_mut() else {
                        disposal.phase = DisposalPhase::Complete;
                        continue;
                    };
                    if paths.pop().is_some() {
                        removed += 1;
                    } else {
                        disposal.cleanup_path_vectors.pop_front();
                        removed += 1;
                    }
                }
                DisposalPhase::Complete => {
                    let disposal = state
                        .disposal
                        .take()
                        .expect("completed subscription disposal must exist");
                    return Some(CompletedDisposal {
                        acknowledgement: disposal.acknowledgement,
                        interrupted_establishment: disposal.interrupted_establishment,
                    });
                }
            }
        }
        None
    }

    fn complete_subscription_disposal(
        &mut self,
        state: SubscriptionState,
        completed: CompletedDisposal,
    ) {
        let id = state.id;
        self.topology_runnable.remove(&id);
        self.allocator_order.remove(&id);
        let published_deferred = state.published_deferred_directories;
        let stats = Arc::clone(&state.stats);
        let publish_disposed = completed.acknowledgement.is_none();
        drop(state);
        stats.watched_directories.store(0, Ordering::Release);
        stats.deferred_directories.store(0, Ordering::Release);
        if publish_disposed {
            stats.disposed.store(true, Ordering::Release);
        }
        self.counters
            .subscriptions
            .store(self.subscriptions.len(), Ordering::Release);
        self.remove_published_deferred_interest_count(published_deferred);
        if let Some(establishment) = completed.interrupted_establishment {
            self.finish_establishment_teardown(establishment);
        }
        if let Some(acknowledgement) = completed.acknowledgement {
            let _ = acknowledgement.sender.send(CommandAcknowledgement {
                generation: acknowledgement.generation,
                value: (),
            });
        }
    }

    #[cfg(test)]
    fn remove_subscription(&mut self, id: SubscriptionId) {
        let Some(mut state) = self.subscriptions.remove(&id) else {
            return;
        };
        if state.disposal.is_none() {
            self.begin_subscription_disposal(&mut state, 0, None);
        }
        loop {
            if let Some(completed) = self.progress_subscription_disposal(&mut state) {
                self.complete_subscription_disposal(state, completed);
                break;
            }
        }
    }

    fn process_shutdown_turn(&mut self) -> bool {
        if let Some(id) = self.allocator_order.pop_next() {
            let mut state = self
                .subscriptions
                .remove(&id)
                .expect("allocator membership must name a live subscription");
            self.begin_subscription_disposal(&mut state, 0, None);
            self.subscriptions.insert(id, state);
            self.schedule_topology(id);
        }

        if self.process_topology_turn() {
            return true;
        }
        if !self.subscriptions.is_empty() {
            panic!(
                "every live subscription must own allocator or topology membership during shutdown"
            );
        }

        let mut removed = 0;
        while removed < MAX_DISPOSAL_ITEMS_PER_TURN {
            if self.retired_ignored_lifetimes.pop_first().is_some() {
                removed += 1;
                continue;
            }
            if self.exhausted_watch_descriptors.pop_first().is_some() {
                removed += 1;
                continue;
            }
            break;
        }
        if !self.retired_ignored_lifetimes.is_empty()
            || !self.exhausted_watch_descriptors.is_empty()
        {
            return true;
        }

        assert!(
            self.watches.is_empty() && self.watch_identities.is_empty(),
            "joined subscription disposal must remove every live native watch"
        );
        self.counters.native_watches.store(0, Ordering::Release);
        self.counters.deferred_interests.store(0, Ordering::Release);
        if let Some(acknowledgement) = self.shutdown_acknowledgement.take() {
            let _ = acknowledgement.sender.send(CommandAcknowledgement {
                generation: acknowledgement.generation,
                value: (),
            });
        }
        false
    }

    fn schedule_topology(&mut self, id: SubscriptionId) {
        self.topology_runnable.schedule(id);
    }

    fn run_maintenance(&mut self) {
        let now = Instant::now();
        let mut schedule = Vec::new();
        for state in self.subscriptions.values_mut() {
            if state.disposal_in_progress()
                || state.establishment_teardown.is_some()
                || state.establishment_cancel_requested()
            {
                continue;
            }
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
            if state.disposal_in_progress() || state.establishment_teardown.is_some() {
                continue;
            }
            state.mark_uncertain(reason, state.root.clone());
        }
    }

    fn publish_native_watch_count(&self) {
        self.counters
            .native_watches
            .store(self.watches.len(), Ordering::Release);
    }

    fn publish_deferred_interest_count(&mut self) {
        let mut total = 0;
        for state in self.subscriptions.values_mut() {
            let contribution = state.stats.deferred_directories.load(Ordering::Acquire);
            state.published_deferred_directories = contribution;
            total += contribution;
        }
        self.counters
            .deferred_interests
            .store(total, Ordering::Release);
    }

    fn remove_published_deferred_interest_count(&mut self, removed: usize) {
        if removed == 0 {
            return;
        }
        let updated = self.counters.deferred_interests.fetch_update(
            Ordering::AcqRel,
            Ordering::Acquire,
            |current| current.checked_sub(removed),
        );
        if updated.is_err() {
            debug_assert!(false, "deferred-interest counter contribution must exist");
            self.publish_deferred_interest_count();
        }
    }

    fn publish_deferred_interest_count_with(&mut self, detached: &mut SubscriptionState) {
        let mut total = 0;
        for state in self.subscriptions.values_mut() {
            let contribution = state.stats.deferred_directories.load(Ordering::Acquire);
            state.published_deferred_directories = contribution;
            total += contribution;
        }
        let detached_contribution = detached.stats.deferred_directories.load(Ordering::Acquire);
        detached.published_deferred_directories = detached_contribution;
        self.counters
            .deferred_interests
            .store(total + detached_contribution, Ordering::Release);
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

pub(crate) fn validate_exclusion_prefixes(
    root: &Path,
    prefixes: Vec<PathBuf>,
    operation: Operation,
) -> WatchboundResult<BTreeSet<PathBuf>> {
    let mut absolute = BTreeSet::new();
    for prefix in prefixes {
        if prefix.is_absolute() {
            return Err(WatchboundError::new(
                ErrorCode::InvalidArgument,
                operation,
                format!(
                    "exclusion prefix must be root-relative: {}",
                    prefix.display()
                ),
            ));
        }
        if prefix.as_os_str().as_bytes().contains(&0) {
            return Err(WatchboundError::new(
                ErrorCode::InvalidArgument,
                operation,
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
                    return Err(WatchboundError::new(
                        ErrorCode::InvalidArgument,
                        operation,
                        format!(
                            "exclusion prefix is not a normalized root-relative path: {}",
                            prefix.display()
                        ),
                    ));
                }
            }
        }
        if normalized.as_os_str().as_bytes() != prefix.as_os_str().as_bytes() {
            return Err(WatchboundError::new(
                ErrorCode::InvalidArgument,
                operation,
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
    RootIdentity::capture(path).map_err(|error| match error {
        RootCaptureError::Missing(_) => RootRecoveryFailureReason::CandidateMissing,
        RootCaptureError::NotDirectory => RootRecoveryFailureReason::CandidateNotDirectory,
        RootCaptureError::SymlinkAncestry => RootRecoveryFailureReason::SymlinkAncestry,
        RootCaptureError::Unavailable(_) => RootRecoveryFailureReason::RootWatchUnavailable,
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
    use std::sync::atomic::{AtomicBool, AtomicU64};
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
        let cancellation = EstablishmentCancellation::new().unwrap();
        cancellation.shared.bind().unwrap();
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
                cancellation: cancellation.shared(),
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
        let (_control_commands, control_command_receiver) = mpsc::channel();
        let (_work_commands, work_command_receiver) = mpsc::channel();
        let mut worker = Worker::new(
            create_inotify().unwrap(),
            Arc::new(create_eventfd().unwrap()),
            control_command_receiver,
            work_command_receiver,
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

    #[test]
    fn exclusion_update_rejects_a_changed_root_before_scanning() {
        let parent = TestRoot::new("exclusion-root-change-before-scan");
        let root = parent.0.join("root");
        let original = parent.0.join("original");
        fs::create_dir(&root).unwrap();
        let previous_exclusion = root.join("previously-hidden");
        let previous_exclusions = BTreeSet::from([previous_exclusion.clone()]);
        let (mut state, _batches) = state(&root, SubscriptionOptions::default());
        state.exclusions = previous_exclusions.clone();
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        state.exclusion_update = Some(PendingExclusionUpdate {
            generation: 1,
            exclusions: BTreeSet::new(),
            previous_exclusions: previous_exclusions.clone(),
            newly_excluded: VecDeque::new(),
            newly_included: vec![previous_exclusion],
            acknowledgement,
            phase: ExclusionUpdatePhase::WaitingForTopology,
        });

        fs::rename(&root, &original).unwrap();
        fs::create_dir(&root).unwrap();
        worker().progress_exclusion_update(&mut state);

        let error = acknowledged
            .recv_timeout(Duration::from_millis(100))
            .expect("changed root must reject the exclusion update before scanning")
            .value
            .expect_err("changed root must not commit an exclusion update");
        assert_eq!(error.code(), ErrorCode::RootStateConflict);
        assert!(state.root_lost);
        assert_eq!(state.exclusion_generation, 0);
        assert_eq!(state.selection_generation, 0);
        assert_eq!(state.exclusions, previous_exclusions);
        assert!(state.topology_jobs.is_empty());
    }

    #[test]
    fn exclusion_update_revalidates_root_before_commit() {
        let parent = TestRoot::new("exclusion-root-change-before-commit");
        let root = parent.0.join("root");
        let original = parent.0.join("original");
        fs::create_dir(&root).unwrap();
        let previous_exclusions = BTreeSet::from([root.join("previously-hidden")]);
        let replacement_exclusions = BTreeSet::from([root.join("newly-hidden")]);
        let (mut state, _batches) = state(&root, SubscriptionOptions::default());
        state.exclusions = replacement_exclusions.clone();
        state.selection_generation = 1;
        state.topology_barriers = 1;
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        state.exclusion_update = Some(PendingExclusionUpdate {
            generation: 1,
            exclusions: replacement_exclusions,
            previous_exclusions: previous_exclusions.clone(),
            newly_excluded: VecDeque::new(),
            newly_included: Vec::new(),
            acknowledgement,
            phase: ExclusionUpdatePhase::ScanningIncluded,
        });

        fs::rename(&root, &original).unwrap();
        fs::create_dir(&root).unwrap();
        worker().progress_exclusion_update(&mut state);

        let error = acknowledged
            .recv_timeout(Duration::from_millis(100))
            .expect("changed root must reject the exclusion update before commit")
            .value
            .expect_err("changed root must not commit an exclusion update");
        assert_eq!(error.code(), ErrorCode::RootStateConflict);
        assert!(state.root_lost);
        assert_eq!(state.exclusion_generation, 0);
        assert_eq!(state.selection_generation, 0);
        assert_eq!(state.exclusions, previous_exclusions);
    }

    fn prepare_reconciliation(
        state: &mut SubscriptionState,
        reason: UncertainReason,
    ) -> Receiver<CommandAcknowledgement<WatchboundResult<ReconciliationResult>>> {
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
        let (_control_commands, control_command_receiver) = mpsc::channel();
        let (_work_commands, work_command_receiver) = mpsc::channel();
        Worker::new(
            create_inotify().unwrap(),
            Arc::new(create_eventfd().unwrap()),
            control_command_receiver,
            work_command_receiver,
            Arc::new(RuntimeCounters::default()),
            None,
        )
    }

    fn bound_cancellation() -> EstablishmentCancellation {
        let cancellation = EstablishmentCancellation::new().unwrap();
        cancellation.shared.bind().unwrap();
        cancellation
    }

    fn cancellation_at_establishment_barrier(barrier: EstablishmentBarrier, shared_peer: bool) {
        let root = TestRoot::new("establishment-cancellation-barrier");
        let cancellation = bound_cancellation();
        let armed = Arc::new(AtomicBool::new(!shared_peer));
        let fired = Arc::new(AtomicBool::new(false));
        let hook_cancellation = cancellation.clone();
        let hook_armed = Arc::clone(&armed);
        let hook_fired = Arc::clone(&fired);
        let hook: EstablishmentBarrierHook = Arc::new(move |observed, _path| {
            if observed == barrier
                && hook_armed.load(Ordering::Acquire)
                && !hook_fired.swap(true, Ordering::AcqRel)
            {
                hook_cancellation.cancel();
            }
        });
        let runtime = Runtime::start_with_establishment_barrier_hook(None, hook).unwrap();

        let peer = shared_peer.then(|| {
            runtime
                .subscribe(
                    root.0.clone(),
                    SubscriptionOptions::default(),
                    Arc::new(SharedStats::new()),
                )
                .unwrap()
        });
        armed.store(true, Ordering::Release);

        let pending = runtime
            .begin_subscribe(
                root.0.clone(),
                SubscriptionOptions::default(),
                Arc::new(SharedStats::new()),
                cancellation.shared(),
            )
            .unwrap();
        let error = match pending.wait() {
            Ok(_) => panic!("barrier cancellation unexpectedly established a subscription"),
            Err(error) => error,
        };
        assert_eq!(error.code(), ErrorCode::OperationCancelled);
        assert!(
            fired.load(Ordering::Acquire),
            "establishment barrier hook was not reached"
        );

        if let Some(peer) = peer {
            assert_eq!(runtime.stats().subscriptions, 1);
            assert_eq!(runtime.stats().native_watches, 1);
            let sentinel = root.0.join("peer-remains-live");
            fs::write(&sentinel, b"peer").unwrap();
            wait_for_batch_path(&peer.receiver, &sentinel);
            runtime.dispose(peer.id).unwrap();
        } else {
            assert_eq!(runtime.stats().subscriptions, 0);
            assert_eq!(runtime.stats().native_watches, 0);
        }
        runtime.shutdown_and_join().unwrap();
        assert_eq!(runtime.stats(), RuntimeStats::default());
    }

    #[test]
    fn cancellation_after_unique_watch_allocation_rolls_back_before_acknowledgement() {
        cancellation_at_establishment_barrier(EstablishmentBarrier::AfterAddWatch, false);
    }

    #[test]
    fn cancellation_after_shared_interest_preserves_the_established_peer() {
        cancellation_at_establishment_barrier(EstablishmentBarrier::SharingExistingWatch, true);
    }

    #[test]
    fn cancellation_at_the_final_commit_boundary_rolls_back_before_acknowledgement() {
        cancellation_at_establishment_barrier(EstablishmentBarrier::BeforeFinalCommit, false);
    }

    #[test]
    fn cancellation_during_a_traversal_entry_rolls_back_before_acknowledgement() {
        cancellation_at_establishment_barrier(EstablishmentBarrier::DuringTraversal, false);
    }

    #[test]
    fn cancellation_after_several_traversed_directories_rolls_back_incrementally() {
        let root = TestRoot::new("later-traversal-cancellation");
        for index in 0..4 {
            fs::create_dir(root.0.join(format!("child-{index}"))).unwrap();
        }
        let cancellation = bound_cancellation();
        let added_watches = Arc::new(AtomicUsize::new(0));
        let traversed_directories = Arc::new(Mutex::new(BTreeSet::new()));
        let fired = Arc::new(AtomicBool::new(false));
        let hook_cancellation = cancellation.clone();
        let hook_added_watches = Arc::clone(&added_watches);
        let hook_traversed_directories = Arc::clone(&traversed_directories);
        let hook_fired = Arc::clone(&fired);
        let hook: EstablishmentBarrierHook = Arc::new(move |observed, path| {
            if observed == EstablishmentBarrier::AfterAddWatch {
                hook_added_watches.fetch_add(1, Ordering::AcqRel);
                return;
            }
            if observed != EstablishmentBarrier::DuringTraversal {
                return;
            }
            let distinct = {
                let mut traversed = hook_traversed_directories
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                traversed.insert(path.to_path_buf());
                traversed.len()
            };
            if distinct >= 3 && !hook_fired.swap(true, Ordering::AcqRel) {
                assert!(
                    hook_added_watches.load(Ordering::Acquire) >= 3,
                    "later traversal cancellation fired before several watches were allocated"
                );
                hook_cancellation.cancel();
            }
        });
        let runtime = Runtime::start_with_establishment_barrier_hook(None, hook).unwrap();
        let pending = runtime
            .begin_subscribe(
                root.0.clone(),
                SubscriptionOptions::default(),
                Arc::new(SharedStats::new()),
                cancellation.shared(),
            )
            .unwrap();

        let error = match pending.wait() {
            Ok(_) => panic!("later traversal cancellation unexpectedly established"),
            Err(error) => error,
        };
        assert_eq!(error.code(), ErrorCode::OperationCancelled);
        assert!(fired.load(Ordering::Acquire));
        assert!(
            traversed_directories
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len()
                >= 3
        );
        assert_eq!(runtime.stats().subscriptions, 0);
        assert_eq!(runtime.stats().native_watches, 0);
        assert_eq!(runtime.stats().deferred_interests, 0);
        runtime.shutdown_and_join().unwrap();
        assert_eq!(runtime.stats(), RuntimeStats::default());
    }

    fn cancellation_at_partial_final_commit(
        native_watch_budget: Option<usize>,
        options: SubscriptionOptions,
    ) {
        let root = TestRoot::new("partial-final-cancellation");
        fs::create_dir(root.0.join("deferred-child")).unwrap();
        let cancellation = bound_cancellation();
        let hook_cancellation = cancellation.clone();
        let fired = Arc::new(AtomicBool::new(false));
        let hook_fired = Arc::clone(&fired);
        let hook: EstablishmentBarrierHook = Arc::new(move |observed, _path| {
            if observed == EstablishmentBarrier::BeforeFinalCommit
                && !hook_fired.swap(true, Ordering::AcqRel)
            {
                hook_cancellation.cancel();
            }
        });
        let runtime =
            Runtime::start_with_establishment_barrier_hook(native_watch_budget, hook).unwrap();
        let pending = runtime
            .begin_subscribe(
                root.0.clone(),
                options,
                Arc::new(SharedStats::new()),
                cancellation.shared(),
            )
            .unwrap();

        let error = match pending.wait() {
            Ok(_) => panic!("partial establishment unexpectedly committed after cancellation"),
            Err(error) => error,
        };
        assert_eq!(error.code(), ErrorCode::OperationCancelled);
        assert!(fired.load(Ordering::Acquire));
        assert_eq!(runtime.stats().subscriptions, 0);
        assert_eq!(runtime.stats().native_watches, 0);
        assert_eq!(runtime.stats().deferred_interests, 0);
        runtime.shutdown_and_join().unwrap();
    }

    #[test]
    fn cancellation_rolls_back_watch_limit_partial_state() {
        cancellation_at_partial_final_commit(
            None,
            SubscriptionOptions {
                watch_limit: Some(1),
                ..SubscriptionOptions::default()
            },
        );
    }

    #[test]
    fn cancellation_rolls_back_runtime_budget_partial_state() {
        cancellation_at_partial_final_commit(Some(1), SubscriptionOptions::default());
    }

    fn root_change_terminal_race(cancel_before_failure_commit: bool) -> WatchboundError {
        let parent = TestRoot::new("root-change-terminal-race");
        let root = parent.0.join("root");
        let moved = parent.0.join("moved");
        fs::create_dir(&root).unwrap();
        let cancellation = bound_cancellation();
        let hook_cancellation = cancellation.clone();
        let hook_root = root.clone();
        let hook_moved = moved.clone();
        let renamed = Arc::new(AtomicBool::new(false));
        let hook_renamed = Arc::clone(&renamed);
        let hook: EstablishmentBarrierHook = Arc::new(move |observed, path| {
            if observed == EstablishmentBarrier::BeforeFinalValidation
                && path == hook_root
                && !hook_renamed.swap(true, Ordering::AcqRel)
            {
                fs::rename(&hook_root, &hook_moved).unwrap();
            }
            if cancel_before_failure_commit && observed == EstablishmentBarrier::BeforeFinalCommit {
                hook_cancellation.cancel();
            }
        });
        let runtime = Runtime::start_with_establishment_barrier_hook(None, hook).unwrap();
        let pending = runtime
            .begin_subscribe(
                root,
                SubscriptionOptions::default(),
                Arc::new(SharedStats::new()),
                cancellation.shared(),
            )
            .unwrap();
        let error = match pending.wait() {
            Ok(_) => panic!("changed root unexpectedly established"),
            Err(error) => error,
        };
        assert!(renamed.load(Ordering::Acquire));
        if !cancel_before_failure_commit {
            cancellation.cancel();
            assert!(!cancellation.is_cancelled());
        }
        assert_eq!(runtime.stats().subscriptions, 0);
        assert_eq!(runtime.stats().native_watches, 0);
        runtime.shutdown_and_join().unwrap();
        error
    }

    #[test]
    fn native_root_loss_during_establishment_rolls_back_before_acknowledgement() {
        let parent = TestRoot::new("root-loss-during-establishment");
        let root = parent.0.join("root");
        let moved = parent.0.join("moved");
        fs::create_dir(&root).unwrap();
        for index in 0..(MAX_TOPOLOGY_ENTRIES_PER_TURN + 32) {
            fs::write(root.join(format!("entry-{index}")), b"watched").unwrap();
        }

        let hook_root = root.clone();
        let hook_moved = moved.clone();
        let renamed = Arc::new(AtomicBool::new(false));
        let hook_renamed = Arc::clone(&renamed);
        let hook: EstablishmentBarrierHook = Arc::new(move |observed, path| {
            if observed == EstablishmentBarrier::DuringTraversal
                && path == hook_root
                && !hook_renamed.swap(true, Ordering::AcqRel)
            {
                fs::rename(&hook_root, &hook_moved).unwrap();
            }
        });
        let runtime = Runtime::start_with_establishment_barrier_hook(None, hook).unwrap();
        let cancellation = bound_cancellation();
        let pending = runtime
            .begin_subscribe(
                root,
                SubscriptionOptions::default(),
                Arc::new(SharedStats::new()),
                cancellation.shared(),
            )
            .unwrap();
        let (completed, completion) = mpsc::sync_channel(1);
        let waiter = std::thread::spawn(move || {
            completed.send(pending.wait()).unwrap();
        });

        let result = match completion.recv_timeout(Duration::from_secs(2)) {
            Ok(result) => result,
            Err(error) => {
                runtime.shutdown_and_join().unwrap();
                waiter.join().unwrap();
                panic!("root-loss establishment did not settle: {error}");
            }
        };
        let error = match result {
            Ok(_) => panic!("renamed root unexpectedly established"),
            Err(error) => error,
        };
        assert_eq!(error.code(), ErrorCode::RootUnavailable);
        assert!(renamed.load(Ordering::Acquire));
        assert_eq!(runtime.stats().subscriptions, 0);
        assert_eq!(runtime.stats().native_watches, 0);
        assert_eq!(runtime.stats().deferred_interests, 0);
        waiter.join().unwrap();
        runtime.shutdown_and_join().unwrap();
        assert_eq!(runtime.stats(), RuntimeStats::default());
    }

    #[test]
    fn cancellation_wins_before_a_root_change_failure_commits() {
        assert_eq!(
            root_change_terminal_race(true).code(),
            ErrorCode::OperationCancelled
        );
    }

    #[test]
    fn root_change_failure_wins_before_late_cancellation() {
        assert_eq!(
            root_change_terminal_race(false).code(),
            ErrorCode::RootUnavailable
        );
    }

    #[test]
    fn cancellation_escapes_a_full_work_admission_lane() {
        let root = TestRoot::new("full-work-admission");
        let first_cancellation = bound_cancellation();
        let (reached, barrier_reached) = mpsc::sync_channel(1);
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let hook_gate = Arc::clone(&gate);
        let fired = Arc::new(AtomicBool::new(false));
        let hook_fired = Arc::clone(&fired);
        let hook: EstablishmentBarrierHook = Arc::new(move |observed, _path| {
            if observed != EstablishmentBarrier::AfterAddWatch
                || hook_fired.swap(true, Ordering::AcqRel)
            {
                return;
            }
            reached.send(()).unwrap();
            let (released, wake) = &*hook_gate;
            let released = released
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let (released, _) = wake
                .wait_timeout_while(released, Duration::from_secs(5), |released| !*released)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(*released, "timed out waiting to release add-watch hook");
        });
        let runtime = Runtime::start_with_establishment_barrier_hook(None, hook).unwrap();
        let first = runtime
            .begin_subscribe(
                root.0.clone(),
                SubscriptionOptions::default(),
                Arc::new(SharedStats::new()),
                first_cancellation.shared(),
            )
            .unwrap();
        barrier_reached
            .recv_timeout(Duration::from_secs(5))
            .expect("worker did not reach add-watch barrier");

        let mut queued = Vec::with_capacity(WORK_COMMAND_QUEUE_CAPACITY);
        for _ in 0..WORK_COMMAND_QUEUE_CAPACITY {
            let cancellation = bound_cancellation();
            let pending = runtime
                .begin_subscribe(
                    root.0.clone(),
                    SubscriptionOptions::default(),
                    Arc::new(SharedStats::new()),
                    cancellation.shared(),
                )
                .unwrap();
            queued.push((cancellation, pending));
        }

        let waiting_cancellation = bound_cancellation();
        let waiting_control = waiting_cancellation.clone();
        let waiting_runtime = Arc::clone(&runtime);
        let waiting_root = root.0.clone();
        let (completed, completion) = mpsc::sync_channel(1);
        let waiter = std::thread::spawn(move || {
            let result = waiting_runtime.begin_subscribe(
                waiting_root,
                SubscriptionOptions::default(),
                Arc::new(SharedStats::new()),
                waiting_control.shared(),
            );
            completed.send(result).unwrap();
        });

        let deadline = Instant::now() + Duration::from_secs(5);
        while waiting_cancellation
            .shared
            .command_admission_full_observations()
            == 0
        {
            assert!(
                Instant::now() < deadline,
                "subscribe did not observe the full work lane"
            );
            std::thread::yield_now();
        }
        waiting_cancellation.cancel();
        let waiting_result = completion
            .recv_timeout(Duration::from_secs(1))
            .expect("full-lane cancellation did not release the caller");
        let waiting_error = match waiting_result {
            Ok(_) => panic!("a cancelled full-lane attempt must not be admitted"),
            Err(error) => error,
        };
        assert_eq!(waiting_error.code(), ErrorCode::OperationCancelled);
        waiter.join().unwrap();

        first_cancellation.cancel();
        for (cancellation, _) in &queued {
            cancellation.cancel();
        }
        let (released, wake) = &*gate;
        *released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        wake.notify_all();

        let first_error = match first.wait() {
            Ok(_) => panic!("blocked first establishment unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(first_error.code(), ErrorCode::OperationCancelled);
        for (_, pending) in queued {
            let error = match pending.wait() {
                Ok(_) => panic!("cancelled queued establishment unexpectedly succeeded"),
                Err(error) => error,
            };
            assert_eq!(error.code(), ErrorCode::OperationCancelled);
        }
        assert_eq!(runtime.stats().subscriptions, 0);
        assert_eq!(runtime.stats().native_watches, 0);
        runtime.shutdown_and_join().unwrap();
    }

    #[test]
    fn dropped_establishment_acknowledgement_rolls_back_committed_resources() {
        let root = TestRoot::new("dropped-establishment-ack");
        let cancellation = bound_cancellation();
        let (reached, barrier_reached) = mpsc::sync_channel(1);
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let hook_gate = Arc::clone(&gate);
        let fired = Arc::new(AtomicBool::new(false));
        let hook_fired = Arc::clone(&fired);
        let hook: EstablishmentBarrierHook = Arc::new(move |observed, _path| {
            if observed != EstablishmentBarrier::BeforeFinalCommit
                || hook_fired.swap(true, Ordering::AcqRel)
            {
                return;
            }
            reached.send(()).unwrap();
            let (released, wake) = &*hook_gate;
            let released = released
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let (released, timeout) = wake
                .wait_timeout_while(released, Duration::from_secs(5), |released| !*released)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            assert!(*released, "timed out waiting to release final-commit hook");
            assert!(!timeout.timed_out());
        });
        let runtime = Runtime::start_with_establishment_barrier_hook(None, hook).unwrap();
        let pending = runtime
            .begin_subscribe(
                root.0.clone(),
                SubscriptionOptions::default(),
                Arc::new(SharedStats::new()),
                cancellation.shared(),
            )
            .unwrap();

        barrier_reached
            .recv_timeout(Duration::from_secs(5))
            .expect("worker did not reach final establishment commit");
        drop(pending);
        let (released, wake) = &*gate;
        *released
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        wake.notify_all();

        let deadline = Instant::now() + Duration::from_secs(5);
        while runtime.stats().subscriptions != 0 || runtime.stats().native_watches != 0 {
            assert!(
                Instant::now() < deadline,
                "orphaned establishment resources were not rolled back"
            );
            std::thread::yield_now();
        }
        runtime.shutdown_and_join().unwrap();
        assert_eq!(runtime.stats(), RuntimeStats::default());
    }

    #[test]
    fn frozen_scheduler_rounds_do_not_starve_requeued_low_ids_under_churn() {
        let mut runnable = FairIdQueue::default();
        runnable.schedule(1);
        assert_eq!(runnable.pop_next(), Some(1));
        runnable.schedule(1);

        for higher_id in 2..=1_024 {
            runnable.schedule(higher_id);
        }

        assert_eq!(
            runnable.pop_next(),
            Some(1),
            "newer higher IDs must not extend the round ahead of requeued work"
        );
    }

    #[test]
    fn terminal_teardown_removes_the_last_published_deferred_contribution() {
        let cancelled_root = TestRoot::new("published-counter-cancelled");
        let peer_root = TestRoot::new("published-counter-peer");
        let cancellation = bound_cancellation();
        cancellation.cancel();
        let (mut cancelled, _cancelled_batches) =
            state(&cancelled_root.0, SubscriptionOptions::default());
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        cancelled.establishment = Some(PendingEstablishment {
            generation: 0,
            acknowledgement,
            cancellation: cancellation.shared(),
        });
        cancelled
            .stats
            .deferred_directories
            .store(5, Ordering::Release);
        cancelled.published_deferred_directories = 10;

        let (mut peer, _peer_batches) = state(&peer_root.0, SubscriptionOptions::default());
        peer.id = 2;
        peer.stats.deferred_directories.store(4, Ordering::Release);
        peer.published_deferred_directories = 4;

        let mut worker = worker();
        worker.begin_cancelled_establishment_teardown(&mut cancelled);
        cancelled.establishment_teardown.as_mut().unwrap().phase =
            EstablishmentTeardownPhase::Complete;
        worker.subscriptions.insert(peer.id, peer);
        worker.allocator_order.schedule(cancelled.id);
        worker
            .counters
            .deferred_interests
            .store(14, Ordering::Release);

        worker.process_establishment_teardown_turn(cancelled);

        let result = acknowledged
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .value;
        let error = match result {
            Ok(_) => panic!("cancelled teardown unexpectedly established"),
            Err(error) => error,
        };
        assert_eq!(error.code(), ErrorCode::OperationCancelled);
        assert_eq!(
            worker.counters.deferred_interests.load(Ordering::Acquire),
            4
        );
        worker.remove_subscription(2);
    }

    #[test]
    fn bounded_teardown_yields_to_a_peer_and_clears_scheduler_membership() {
        let cancelled_root = TestRoot::new("bounded-teardown-cancelled");
        let peer_root = TestRoot::new("bounded-teardown-peer");
        let cancellation = bound_cancellation();
        cancellation.cancel();
        let (mut cancelled, _cancelled_batches) =
            state(&cancelled_root.0, SubscriptionOptions::default());
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        cancelled.establishment = Some(PendingEstablishment {
            generation: 0,
            acknowledgement,
            cancellation: cancellation.shared(),
        });
        cancelled.pending_paths = (0..(MAX_ESTABLISHMENT_TEARDOWN_ITEMS_PER_TURN * 2 + 1))
            .map(|index| cancelled_root.0.join(format!("pending-{index}")))
            .collect();
        cancelled
            .stats
            .deferred_directories
            .store(7, Ordering::Release);
        cancelled.published_deferred_directories = 7;

        let (mut peer, peer_batches) = state(
            &peer_root.0,
            SubscriptionOptions {
                batch_window: Duration::from_nanos(1),
                ..SubscriptionOptions::default()
            },
        );
        peer.id = 2;
        peer.topology_jobs
            .push_back(TopologyJob::new(peer_root.0.clone(), false));
        peer.topology_barriers = 1;

        let mut worker = worker();
        worker
            .counters
            .deferred_interests
            .store(7, Ordering::Release);
        worker.begin_cancelled_establishment_teardown(&mut cancelled);
        worker.subscriptions.insert(cancelled.id, cancelled);
        worker.subscriptions.insert(peer.id, peer);
        worker.allocator_order.schedule(1);
        worker.allocator_order.schedule(2);
        worker.topology_runnable.schedule(1);
        worker.topology_runnable.schedule(2);

        assert!(worker.process_topology_turn());
        assert_eq!(
            worker.subscriptions[&1].pending_paths.len(),
            MAX_ESTABLISHMENT_TEARDOWN_ITEMS_PER_TURN + 1
        );
        assert!(worker.topology_runnable.contains(&1));
        assert!(worker.allocator_order.contains(&1));

        assert!(worker.process_topology_turn());
        assert!(
            worker.subscriptions[&2]
                .watched_paths
                .contains_key(&peer_root.0),
            "peer topology did not progress between teardown quanta"
        );

        let peer_sentinel = peer_root.0.join("delivered-between-quanta");
        let delivery_fired = Arc::new(AtomicBool::new(false));
        let hook_delivery_fired = Arc::clone(&delivery_fired);
        let hook_peer_sentinel = peer_sentinel.clone();
        worker.establishment_barrier_hook = Some(Arc::new(move |observed, _path| {
            if observed == EstablishmentBarrier::TeardownQuantumCompleted
                && !hook_delivery_fired.swap(true, Ordering::AcqRel)
            {
                fs::write(&hook_peer_sentinel, b"peer").unwrap();
            }
        }));
        assert!(worker.process_topology_turn());
        assert!(delivery_fired.load(Ordering::Acquire));
        assert!(worker.subscriptions.contains_key(&1));
        assert!(matches!(acknowledged.try_recv(), Err(TryRecvError::Empty)));
        assert!(worker.process_native_turn());
        worker.run_maintenance();
        wait_for_batch_path(&peer_batches, &peer_sentinel);

        let pending_before_churn = worker.subscriptions[&1].pending_paths.len();
        for higher_id in 3..=8 {
            worker.topology_runnable.schedule(higher_id);
            assert!(worker.process_topology_turn());
        }
        assert!(
            worker
                .subscriptions
                .get(&1)
                .is_none_or(|state| state.pending_paths.len() < pending_before_churn),
            "continuous higher-ID admissions starved the requeued teardown"
        );

        for _ in 0..16 {
            if !worker.subscriptions.contains_key(&1) {
                break;
            }
            assert!(worker.process_topology_turn());
        }
        let result = acknowledged
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .value;
        let error = match result {
            Ok(_) => panic!("cancelled teardown unexpectedly established a subscription"),
            Err(error) => error,
        };
        assert_eq!(error.code(), ErrorCode::OperationCancelled);
        assert!(!worker.subscriptions.contains_key(&1));
        assert!(!worker.topology_runnable.contains(&1));
        assert!(!worker.allocator_order.contains(&1));
        assert_eq!(
            worker.counters.deferred_interests.load(Ordering::Acquire),
            0
        );
        for higher_id in 3..=8 {
            worker.topology_runnable.remove(&higher_id);
        }
        worker.remove_subscription(2);
        assert!(worker.topology_runnable.is_empty());
        assert!(worker.allocator_order.is_empty());
    }

    #[test]
    fn exhausted_subscription_ids_reject_without_aliasing_live_state() {
        let root = TestRoot::new("subscription-id-exhaustion");
        let cancellation = bound_cancellation();
        let stats = Arc::new(SharedStats::new());
        let (output, _batches) =
            mpsc::sync_channel(SubscriptionOptions::default().output_queue_capacity);
        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        let (_control_commands, control_command_receiver) = mpsc::channel();
        let (work_commands, work_command_receiver) = mpsc::channel();
        let mut worker = Worker::new(
            create_inotify().unwrap(),
            Arc::new(create_eventfd().unwrap()),
            control_command_receiver,
            work_command_receiver,
            Arc::new(RuntimeCounters::default()),
            None,
        );
        worker.next_subscription_id = SubscriptionId::MAX;
        work_commands
            .send(CommandEnvelope {
                generation: 0,
                command: Command::Subscribe {
                    root: root.0.clone(),
                    options: SubscriptionOptions::default(),
                    stats,
                    output,
                    acknowledgement,
                    cancellation: cancellation.shared(),
                },
            })
            .unwrap();

        assert_eq!(
            worker.process_command_turn(CommandLane::Work, MAX_WORK_COMMANDS_PER_TURN),
            1
        );
        let result = acknowledged
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .value;
        let error = match result {
            Ok(_) => panic!("exhausted subscription IDs must not establish"),
            Err(error) => error,
        };
        assert_eq!(error.code(), ErrorCode::Internal);
        assert!(worker.subscriptions.is_empty());
        assert!(worker.topology_runnable.is_empty());
        assert!(worker.allocator_order.is_empty());
        assert_eq!(worker.next_subscription_id, SubscriptionId::MAX);
    }

    #[test]
    fn established_disposal_is_quantized_and_yields_to_peer_delivery() {
        let disposing_root = TestRoot::new("quantized-established-disposal");
        let directory_count = MAX_DISPOSAL_ITEMS_PER_TURN * 2 + 1;
        let mut directories = Vec::with_capacity(directory_count);
        for index in 0..directory_count {
            let path = disposing_root.0.join(format!("watched-{index}"));
            fs::create_dir(&path).unwrap();
            directories.push(path);
        }
        let shared_directory = directories
            .iter()
            .max()
            .expect("the disposal test must create watched directories")
            .clone();

        let (mut disposing, _disposing_batches) =
            state(&disposing_root.0, SubscriptionOptions::default());
        let disposing_stats = Arc::clone(&disposing.stats);
        let (mut peer, peer_batches) = state(
            &shared_directory,
            SubscriptionOptions {
                batch_window: Duration::from_nanos(1),
                ..SubscriptionOptions::default()
            },
        );
        peer.id = 2;

        let (control_commands, control_command_receiver) = mpsc::channel();
        let (_work_commands, work_command_receiver) = mpsc::channel();
        let mut worker = Worker::new(
            create_inotify().unwrap(),
            Arc::new(create_eventfd().unwrap()),
            control_command_receiver,
            work_command_receiver,
            Arc::new(RuntimeCounters::default()),
            None,
        );
        for directory in &directories {
            assert_eq!(
                worker
                    .add_interest(&mut disposing, directory, true)
                    .unwrap(),
                InterestAllocation::Added {
                    created_native_watch: true,
                }
            );
        }
        assert_eq!(
            worker
                .add_interest(&mut peer, &shared_directory, true)
                .unwrap(),
            InterestAllocation::Added {
                created_native_watch: false,
            }
        );
        let peer_descriptor = peer.watched_paths[&shared_directory];
        for index in 0..3 {
            disposing.defer(
                disposing_root.0.join(format!("deferred-{index}")),
                PartialReason::ResourceLimit,
                DeferredCause::SubscriptionLimit,
            );
        }
        disposing.publish_resource_counts();
        peer.publish_resource_counts();
        worker.subscriptions.insert(disposing.id, disposing);
        worker.subscriptions.insert(peer.id, peer);
        worker.allocator_order.schedule(1);
        worker.allocator_order.schedule(2);
        worker.counters.subscriptions.store(2, Ordering::Release);
        worker.publish_deferred_interest_count();
        assert_eq!(
            worker.counters.deferred_interests.load(Ordering::Acquire),
            3
        );

        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        control_commands
            .send(CommandEnvelope {
                generation: 0,
                command: Command::Dispose {
                    subscription_id: 1,
                    acknowledgement,
                },
            })
            .unwrap();
        assert_eq!(
            worker.process_command_turn(CommandLane::Control, MAX_CONTROL_COMMANDS_PER_TURN),
            1
        );
        assert!(worker.subscriptions.contains_key(&1));
        assert!(matches!(acknowledged.try_recv(), Err(TryRecvError::Empty)));

        assert!(worker.process_topology_turn());
        assert!(worker.subscriptions.contains_key(&1));
        assert!(
            worker.subscriptions[&1].watched_paths.len()
                <= directory_count - MAX_DISPOSAL_ITEMS_PER_TURN
        );
        assert!(matches!(acknowledged.try_recv(), Err(TryRecvError::Empty)));

        let sentinel = shared_directory.join("delivered-during-disposal");
        worker.handle_native_event(ParsedEvent {
            descriptor: peer_descriptor,
            mask: libc::IN_CREATE,
            name: sentinel.file_name().map(std::ffi::OsStr::to_os_string),
        });
        worker.run_maintenance();
        wait_for_batch_path(&peer_batches, &sentinel);
        assert!(worker.subscriptions.contains_key(&1));
        assert_eq!(disposing_stats.raw_events.load(Ordering::Acquire), 0);

        for _ in 0..16 {
            if !worker.subscriptions.contains_key(&1) {
                break;
            }
            assert!(worker.process_topology_turn());
        }
        acknowledged
            .recv_timeout(Duration::from_secs(1))
            .expect("dispose acknowledgement did not follow joined cleanup");
        assert!(!worker.subscriptions.contains_key(&1));
        assert!(!worker.topology_runnable.contains(&1));
        assert!(!worker.allocator_order.contains(&1));
        assert_eq!(worker.counters.subscriptions.load(Ordering::Acquire), 1);
        assert_eq!(worker.counters.native_watches.load(Ordering::Acquire), 1);
        assert_eq!(
            worker.counters.deferred_interests.load(Ordering::Acquire),
            0
        );
        assert_eq!(
            disposing_stats.watched_directories.load(Ordering::Acquire),
            0
        );
        assert_eq!(
            disposing_stats.deferred_directories.load(Ordering::Acquire),
            0
        );
        assert!(!disposing_stats.disposed.load(Ordering::Acquire));
        assert!(
            worker.subscriptions[&2]
                .watched_paths
                .contains_key(&shared_directory)
        );

        worker.remove_subscription(2);
        assert_eq!(worker.counters.native_watches.load(Ordering::Acquire), 0);
    }

    #[test]
    fn shutdown_joins_established_disposal_through_bounded_turns() {
        let root = TestRoot::new("quantized-shutdown-disposal");
        let directory_count = MAX_DISPOSAL_ITEMS_PER_TURN * 2 + 1;
        let mut directories = Vec::with_capacity(directory_count);
        for index in 0..directory_count {
            let path = root.0.join(format!("watched-{index}"));
            fs::create_dir(&path).unwrap();
            directories.push(path);
        }

        let (mut state, _batches) = state(&root.0, SubscriptionOptions::default());
        let stats = Arc::clone(&state.stats);
        let (control_commands, control_command_receiver) = mpsc::channel();
        let (_work_commands, work_command_receiver) = mpsc::channel();
        let mut worker = Worker::new(
            create_inotify().unwrap(),
            Arc::new(create_eventfd().unwrap()),
            control_command_receiver,
            work_command_receiver,
            Arc::new(RuntimeCounters::default()),
            None,
        );
        for directory in &directories {
            assert_eq!(
                worker.add_interest(&mut state, directory, true).unwrap(),
                InterestAllocation::Added {
                    created_native_watch: true,
                }
            );
        }
        state.publish_resource_counts();
        worker.subscriptions.insert(state.id, state);
        worker.allocator_order.schedule(1);
        worker.counters.subscriptions.store(1, Ordering::Release);

        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        control_commands
            .send(CommandEnvelope {
                generation: 7,
                command: Command::Shutdown { acknowledgement },
            })
            .unwrap();
        assert_eq!(
            worker.process_command_turn(CommandLane::Control, MAX_CONTROL_COMMANDS_PER_TURN),
            1
        );
        assert!(worker.shutting_down);
        assert!(worker.subscriptions.contains_key(&1));
        assert!(matches!(acknowledged.try_recv(), Err(TryRecvError::Empty)));

        assert!(worker.process_shutdown_turn());
        assert!(worker.subscriptions.contains_key(&1));
        assert!(
            worker.subscriptions[&1].watched_paths.len()
                <= directory_count - MAX_DISPOSAL_ITEMS_PER_TURN
        );
        assert!(matches!(acknowledged.try_recv(), Err(TryRecvError::Empty)));

        let mut turns = 1;
        while !worker.subscriptions.is_empty() {
            assert!(worker.process_shutdown_turn());
            turns += 1;
            assert!(
                turns < 16,
                "shutdown subscription disposal did not converge"
            );
            assert!(matches!(acknowledged.try_recv(), Err(TryRecvError::Empty)));
        }
        assert!(turns >= 3);
        let retired_before = worker.retired_ignored_lifetimes.len();
        assert!(retired_before > MAX_DISPOSAL_ITEMS_PER_TURN);
        assert!(worker.process_shutdown_turn());
        assert_eq!(
            worker.retired_ignored_lifetimes.len(),
            retired_before - MAX_DISPOSAL_ITEMS_PER_TURN
        );
        assert!(matches!(acknowledged.try_recv(), Err(TryRecvError::Empty)));
        while worker.process_shutdown_turn() {}
        let acknowledged = acknowledged
            .recv_timeout(Duration::from_secs(1))
            .expect("shutdown acknowledgement did not follow joined cleanup");
        assert_eq!(acknowledged.generation, 7);
        assert!(worker.subscriptions.is_empty());
        assert!(worker.topology_runnable.is_empty());
        assert!(worker.allocator_order.is_empty());
        assert_eq!(worker.counters.subscriptions.load(Ordering::Acquire), 0);
        assert_eq!(worker.counters.native_watches.load(Ordering::Acquire), 0);
        assert_eq!(stats.watched_directories.load(Ordering::Acquire), 0);
        assert!(stats.disposed.load(Ordering::Acquire));
    }

    #[test]
    fn disposal_interrupts_transactions_before_bounded_scratch_cleanup() {
        let root = TestRoot::new("quantized-transaction-disposal");
        let (mut state, _batches) = state(&root.0, SubscriptionOptions::default());
        let stats = Arc::clone(&state.stats);
        let path_count = MAX_DISPOSAL_ITEMS_PER_TURN * 2 + 1;
        let paths = (0..path_count)
            .map(|index| root.0.join(format!("candidate-{index}")))
            .collect::<Vec<_>>();
        let (transaction_acknowledgement, transaction_acknowledged) = mpsc::sync_channel(1);
        state.exclusion_update = Some(PendingExclusionUpdate {
            generation: 1,
            exclusions: paths.iter().cloned().collect(),
            previous_exclusions: paths.iter().map(|path| path.join("previous")).collect(),
            newly_excluded: paths.iter().cloned().collect(),
            newly_included: paths.iter().map(|path| path.join("included")).collect(),
            acknowledgement: transaction_acknowledgement,
            phase: ExclusionUpdatePhase::WaitingForTopology,
        });

        let (control_commands, control_command_receiver) = mpsc::channel();
        let (_work_commands, work_command_receiver) = mpsc::channel();
        let mut worker = Worker::new(
            create_inotify().unwrap(),
            Arc::new(create_eventfd().unwrap()),
            control_command_receiver,
            work_command_receiver,
            Arc::new(RuntimeCounters::default()),
            None,
        );
        worker.subscriptions.insert(state.id, state);
        worker.allocator_order.schedule(1);
        worker.counters.subscriptions.store(1, Ordering::Release);

        let (acknowledgement, acknowledged) = mpsc::sync_channel(1);
        control_commands
            .send(CommandEnvelope {
                generation: 0,
                command: Command::Dispose {
                    subscription_id: 1,
                    acknowledgement,
                },
            })
            .unwrap();
        assert_eq!(
            worker.process_command_turn(CommandLane::Control, MAX_CONTROL_COMMANDS_PER_TURN),
            1
        );
        let interrupted = transaction_acknowledged
            .recv_timeout(Duration::from_secs(1))
            .expect("disposal must promptly interrupt the active transaction")
            .value
            .expect_err("the active transaction must not commit during disposal");
        assert_eq!(interrupted.code(), ErrorCode::OperationInterrupted);
        assert!(matches!(acknowledged.try_recv(), Err(TryRecvError::Empty)));

        assert!(worker.process_topology_turn());
        let disposal = worker.subscriptions[&1]
            .disposal
            .as_ref()
            .expect("scratch cleanup must remain pending after one quantum");
        assert_eq!(
            disposal.cleanup_path_sets.front().unwrap().len(),
            path_count - MAX_DISPOSAL_ITEMS_PER_TURN
        );
        assert!(matches!(acknowledged.try_recv(), Err(TryRecvError::Empty)));

        drop(acknowledged);
        for _ in 0..16 {
            if !worker.subscriptions.contains_key(&1) {
                break;
            }
            assert!(worker.process_topology_turn());
        }
        assert!(!worker.subscriptions.contains_key(&1));
        assert!(!worker.topology_runnable.contains(&1));
        assert!(!worker.allocator_order.contains(&1));
        assert_eq!(worker.counters.subscriptions.load(Ordering::Acquire), 0);
        assert!(!stats.disposed.load(Ordering::Acquire));
    }

    fn wait_for_root_attachment(state: &Arc<Mutex<RootState>>, attachment: RootAttachment) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .attachment
            != attachment
        {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for root attachment {attachment:?}"
            );
            std::thread::yield_now();
        }
    }

    fn wait_for_batch_path(receiver: &Receiver<ChangeBatch>, path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for {}",
                path.display()
            );
            let batch = receiver.recv_timeout(remaining).unwrap();
            if batch.invalidated_paths.contains(&path.to_path_buf()) {
                return;
            }
        }
    }

    fn assert_only_root_invalidations(receiver: &Receiver<ChangeBatch>, root: &Path) {
        while let Ok(batch) = receiver.try_recv() {
            assert_eq!(batch.invalidated_paths, vec![root.to_path_buf()]);
            assert_eq!(batch.root_state.attachment, RootAttachment::Lost);
        }
    }

    fn root_recovery_barrier_rejects_replacement(
        barrier: RootRecoveryBarrier,
        share_candidate_watch: bool,
    ) {
        let parent = TestRoot::new("root-recovery-barrier");
        let root = parent.0.join("root");
        let original = parent.0.join("original");
        let replaced_candidate = parent.0.join("replaced-candidate");
        let peer_root = parent.0.join("peer");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&peer_root).unwrap();

        let fired = Arc::new(AtomicBool::new(false));
        let hook_fired = Arc::clone(&fired);
        let hook_root = root.clone();
        let hook_replaced_candidate = replaced_candidate.clone();
        let hook: RootRecoveryBarrierHook = Arc::new(move |observed, path| {
            if observed == barrier && path == hook_root && !hook_fired.swap(true, Ordering::AcqRel)
            {
                fs::rename(&hook_root, &hook_replaced_candidate).unwrap();
                fs::create_dir(&hook_root).unwrap();
            }
        });
        let runtime = Runtime::start_with_root_recovery_barrier_hook(None, hook).unwrap();

        let primary_stats = Arc::new(SharedStats::new());
        let primary = runtime
            .subscribe(
                root.clone(),
                SubscriptionOptions::default(),
                Arc::clone(&primary_stats),
            )
            .unwrap();
        let peer_stats = Arc::new(SharedStats::new());
        let peer = runtime
            .subscribe(
                peer_root.clone(),
                SubscriptionOptions::default(),
                peer_stats,
            )
            .unwrap();

        fs::rename(&root, &original).unwrap();
        fs::create_dir(&root).unwrap();
        if barrier == RootRecoveryBarrier::DuringTraversal {
            fs::create_dir(root.join("scan-child")).unwrap();
        }
        wait_for_root_attachment(&primary.root_state, RootAttachment::Lost);

        let candidate_peer = share_candidate_watch.then(|| {
            runtime
                .subscribe(
                    root.clone(),
                    SubscriptionOptions::default(),
                    Arc::new(SharedStats::new()),
                )
                .unwrap()
        });

        let result = runtime
            .queue_root_recovery(primary.id, RootIdentityPolicy::AcceptReplacement)
            .unwrap()
            .wait()
            .unwrap();

        assert!(
            fired.load(Ordering::Acquire),
            "barrier hook was not reached"
        );
        assert_eq!(result.attachment, RootRecoveryAttachment::NotAttached);
        assert_eq!(
            result.reason,
            Some(RootRecoveryFailureReason::IdentityUnstable)
        );
        assert_eq!(result.boundary_sequence, None);
        assert_eq!(result.current_root_state.attachment, RootAttachment::Lost);
        assert_eq!(
            primary
                .root_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .attachment,
            RootAttachment::Lost
        );
        assert_eq!(primary_stats.snapshot().watched_directories, 0);
        assert_eq!(primary_stats.snapshot().deferred_directories, 0);
        assert_only_root_invalidations(&primary.receiver, &root);

        if let Some(candidate_peer) = &candidate_peer {
            wait_for_root_attachment(&candidate_peer.root_state, RootAttachment::Lost);
            assert_eq!(runtime.stats().native_watches, 2);
        } else {
            assert_eq!(runtime.stats().native_watches, 1);
        }

        let later_occupant = root.join("must-not-be-followed");
        fs::write(&later_occupant, b"later").unwrap();
        let peer_sentinel = peer_root.join("peer-still-live");
        fs::write(&peer_sentinel, b"peer").unwrap();
        wait_for_batch_path(&peer.receiver, &peer_sentinel);
        assert_only_root_invalidations(&primary.receiver, &root);

        runtime.dispose(primary.id).unwrap();
        runtime.dispose(primary.id).unwrap();
        if let Some(candidate_peer) = candidate_peer {
            runtime.dispose(candidate_peer.id).unwrap();
            runtime.dispose(candidate_peer.id).unwrap();
        }
        runtime.dispose(peer.id).unwrap();
        runtime.dispose(peer.id).unwrap();
        runtime.shutdown_and_join().unwrap();
        assert_eq!(runtime.stats(), RuntimeStats::default());
    }

    #[test]
    fn replacement_after_candidate_capture_is_rejected() {
        root_recovery_barrier_rejects_replacement(RootRecoveryBarrier::CandidateCaptured, false);
    }

    #[test]
    fn replacement_after_old_interests_drain_is_rejected() {
        root_recovery_barrier_rejects_replacement(RootRecoveryBarrier::OldInterestsDrained, false);
    }

    #[test]
    fn replacement_while_sharing_candidate_watch_is_rejected() {
        root_recovery_barrier_rejects_replacement(RootRecoveryBarrier::SharingExistingWatch, true);
    }

    #[test]
    fn replacement_before_add_watch_is_rejected() {
        root_recovery_barrier_rejects_replacement(RootRecoveryBarrier::BeforeAddWatch, false);
    }

    #[test]
    fn replacement_after_add_watch_is_rejected() {
        root_recovery_barrier_rejects_replacement(RootRecoveryBarrier::AfterAddWatch, false);
    }

    #[test]
    fn replacement_during_traversal_is_rejected() {
        root_recovery_barrier_rejects_replacement(RootRecoveryBarrier::DuringTraversal, false);
    }

    #[test]
    fn replacement_before_final_validation_is_rejected() {
        root_recovery_barrier_rejects_replacement(
            RootRecoveryBarrier::BeforeFinalValidation,
            false,
        );
    }

    fn install_synthetic_watch(
        worker: &mut Worker,
        state: &mut SubscriptionState,
        descriptor: i32,
        lifetime: WatchLifetime,
        path: &Path,
        expects_ignored: bool,
    ) {
        let identity = directory_identity(path).unwrap();
        let interest = Interest {
            subscription_id: state.id,
            path: path.to_path_buf(),
        };
        state.watched_paths.insert(path.to_path_buf(), descriptor);
        worker.watches.insert(
            descriptor,
            NativeWatch {
                lifetime,
                identity: Some(identity),
                interests: BTreeSet::from([interest]),
                expects_ignored,
            },
        );
        worker.watch_identities.insert(identity, descriptor);
        worker.publish_native_watch_count();
    }

    #[test]
    fn ignored_for_retired_lifetime_does_not_remove_reused_descriptor() {
        let root = TestRoot::new("retired-ignored-reuse");
        let child = root.0.join("child");
        fs::create_dir(&child).unwrap();
        let (mut state, _batches) = state(&root.0, SubscriptionOptions::default());
        let mut worker = worker();
        let descriptor = 41;

        install_synthetic_watch(
            &mut worker,
            &mut state,
            descriptor,
            WatchLifetime(1),
            &child,
            false,
        );
        state.watched_paths.remove(&child);
        worker.remove_interest(state.id, &child, descriptor);
        assert_eq!(
            worker.next_watch_lifetime(descriptor).unwrap(),
            WatchLifetime(2)
        );
        install_synthetic_watch(
            &mut worker,
            &mut state,
            descriptor,
            WatchLifetime(2),
            &child,
            false,
        );
        state.mark_uncertain(UncertainReason::TopologyRace, root.0.clone());
        worker.subscriptions.insert(state.id, state);

        worker.handle_ignored(descriptor);

        let state = worker.subscriptions.get(&1).unwrap();
        assert_eq!(state.watched_paths.get(&child), Some(&descriptor));
        assert!(worker.watches.contains_key(&descriptor));
        assert!(!worker.retired_ignored_lifetimes.contains_key(&descriptor));
        assert_eq!(worker.watch_identities.len(), 1);
        assert_eq!(worker.counters.native_watches.load(Ordering::Acquire), 1);

        worker.handle_ignored(descriptor);

        let state = worker.subscriptions.get(&1).unwrap();
        assert!(!state.watched_paths.contains_key(&child));
        assert!(!worker.watches.contains_key(&descriptor));
        assert!(worker.watch_identities.is_empty());
        assert_eq!(worker.counters.native_watches.load(Ordering::Acquire), 0);
        assert_eq!(
            state.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::TopologyRace,
            }
        );
    }

    #[test]
    fn reused_root_is_lost_only_when_current_lifetime_is_ignored() {
        let root = TestRoot::new("retired-ignored-root-reuse");
        let (mut state, _batches) = state(&root.0, SubscriptionOptions::default());
        let mut worker = worker();
        let descriptor = 43;

        // Model the identity-mismatch rollback path: the newly created old
        // lifetime was removed before it was ever entered in `watches`.
        worker.remove_native_watch_lifetime(descriptor, WatchLifetime(1));
        assert_eq!(
            worker.next_watch_lifetime(descriptor).unwrap(),
            WatchLifetime(2)
        );
        install_synthetic_watch(
            &mut worker,
            &mut state,
            descriptor,
            WatchLifetime(2),
            &root.0,
            false,
        );
        state.mark_uncertain(UncertainReason::TopologyRace, root.0.clone());
        worker.subscriptions.insert(state.id, state);

        worker.handle_ignored(descriptor);

        let state = worker.subscriptions.get(&1).unwrap();
        assert_eq!(state.root_state().attachment, RootAttachment::Attached);
        assert_eq!(state.root_state().loss_evidence, None);
        assert_eq!(state.watched_paths.get(&root.0), Some(&descriptor));

        worker.handle_ignored(descriptor);

        let state = worker.subscriptions.get(&1).unwrap();
        assert_eq!(state.root_state().attachment, RootAttachment::Lost);
        assert_eq!(
            state.root_state().loss_evidence,
            Some(RootLossEvidence::RootWatchLoss)
        );
        assert_eq!(
            state.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::RootReplaced,
            }
        );
        assert!(!worker.watches.contains_key(&descriptor));
        assert_eq!(worker.counters.native_watches.load(Ordering::Acquire), 0);
    }

    #[test]
    fn delete_self_expectation_is_scoped_to_the_live_watch_lifetime() {
        let root = TestRoot::new("delete-self-lifetime");
        let child = root.0.join("child");
        fs::create_dir(&child).unwrap();
        let (mut state, _batches) = state(&root.0, SubscriptionOptions::default());
        let mut worker = worker();
        let descriptor = 47;

        install_synthetic_watch(
            &mut worker,
            &mut state,
            descriptor,
            WatchLifetime(1),
            &child,
            false,
        );
        worker.subscriptions.insert(state.id, state);

        worker.handle_native_event(ParsedEvent {
            descriptor,
            mask: libc::IN_DELETE_SELF | libc::IN_ISDIR,
            name: None,
        });
        assert!(worker.watches[&descriptor].expects_ignored);

        worker.handle_native_event(ParsedEvent {
            descriptor,
            mask: libc::IN_IGNORED,
            name: None,
        });

        let state = worker.subscriptions.get(&1).unwrap();
        assert!(!state.watched_paths.contains_key(&child));
        assert_eq!(state.coverage(), Coverage::Complete);
        assert!(!worker.watches.contains_key(&descriptor));
        assert_eq!(worker.counters.native_watches.load(Ordering::Acquire), 0);
    }

    #[test]
    fn sharing_a_reused_descriptor_preserves_peer_coverage_truth() {
        let root = TestRoot::new("shared-retired-ignored-reuse");
        let child = root.0.join("child");
        fs::create_dir(&child).unwrap();
        let (mut owner, _owner_batches) = state(&root.0, SubscriptionOptions::default());
        let (mut peer, _peer_batches) = state(&root.0, SubscriptionOptions::default());
        peer.id = 2;
        let mut worker = worker();
        let descriptor = 53;

        worker.remove_native_watch_lifetime(descriptor, WatchLifetime(1));
        install_synthetic_watch(
            &mut worker,
            &mut owner,
            descriptor,
            WatchLifetime(2),
            &child,
            false,
        );

        assert_eq!(
            worker.add_interest(&mut peer, &child, true).unwrap(),
            InterestAllocation::Added {
                created_native_watch: false,
            }
        );

        assert_eq!(worker.watches[&descriptor].interests.len(), 2);
        assert_eq!(
            peer.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::TopologyRace,
            }
        );
    }

    #[test]
    fn exhausted_watch_lifetime_is_removed_and_permanently_quarantined() {
        let mut worker = worker();
        let descriptor = 59;

        worker.expect_ignored(descriptor, WatchLifetime(u64::MAX));

        let error = worker.claim_new_watch_lifetime(descriptor).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EOVERFLOW));
        assert!(worker.exhausted_watch_descriptors.contains(&descriptor));
        assert!(!worker.watches.contains_key(&descriptor));
        assert_eq!(worker.counters.native_watches.load(Ordering::Acquire), 0);

        // Even after the old expected record is gone, this numeric descriptor
        // cannot reset to lifetime 1 and alias the unrepresentable removal.
        worker.retired_ignored_lifetimes.remove(&descriptor);
        let error = worker.claim_new_watch_lifetime(descriptor).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EOVERFLOW));
        assert!(!worker.watches.contains_key(&descriptor));
    }

    #[test]
    fn compact_retired_range_rejects_a_lifetime_gap() {
        let mut worker = worker();
        let descriptor = 61;

        worker.expect_ignored(descriptor, WatchLifetime(1));
        worker.remove_native_watch_lifetime(descriptor, WatchLifetime(3));

        assert_eq!(
            worker.retired_ignored_lifetimes.get(&descriptor),
            Some(&ExpectedIgnoredLifetimes {
                first: WatchLifetime(1),
                last: WatchLifetime(1),
            })
        );
        assert!(worker.exhausted_watch_descriptors.contains(&descriptor));
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
        assert_eq!(error.code(), crate::ErrorCode::ConsumerBackpressure);
        assert_eq!(error.operation(), crate::Operation::Reconcile);
        assert!(error.retryable());
        assert_eq!(error.retry_after(), Some(crate::RetryAfter::DeliveryDrains));
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
