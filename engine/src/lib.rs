//! Watchbound's reusable, Linux-first watcher engine.
//!
//! The public surface deliberately describes coverage and invalidation without
//! exposing inotify watch descriptors, masks, or Linux resource error codes.

#[cfg(not(target_os = "linux"))]
compile_error!("watchbound-engine currently supports Linux only");

mod backend;
mod error;

pub use error::{
    ErrorCode, MAX_ERROR_MESSAGE_BYTES, Operation, Result, RetryAfter, SystemCause, WatchboundError,
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::Duration;

const ATTEMPT_CREATED: u8 = 0;
const ATTEMPT_BOUND: u8 = 1;
const ATTEMPT_CANCEL_REQUESTED_UNBOUND: u8 = 2;
const ATTEMPT_CANCEL_REQUESTED_BOUND: u8 = 3;
const ATTEMPT_SUCCEEDED: u8 = 4;
const ATTEMPT_FAILED: u8 = 5;
const ATTEMPT_CANCELLED: u8 = 6;
const MAX_OUTPUT_DISPOSAL_ITEMS_PER_TURN: usize = 64;

static NEXT_ESTABLISHMENT_ATTEMPT_ID: AtomicU64 = AtomicU64::new(1);

/// One attempt-scoped, cooperatively observed establishment cancellation.
///
/// A token may be bound to exactly one call to
/// [`Engine::begin_subscribe_with_cancellation`]. Cancellation is idempotent
/// and has no effect after the engine has committed establishment success.
#[derive(Clone)]
pub struct EstablishmentCancellation {
    shared: Arc<EstablishmentCancellationState>,
}

pub(crate) struct EstablishmentCancellationState {
    id: u64,
    state: AtomicU8,
    runtime: Mutex<Option<Weak<backend::linux::Runtime>>>,
    #[cfg(test)]
    command_admission_full_observations: AtomicUsize,
}

impl EstablishmentCancellation {
    pub fn new() -> Result<Self> {
        let id = allocate_establishment_attempt_id(&NEXT_ESTABLISHMENT_ATTEMPT_ID)?;
        Ok(Self {
            shared: Arc::new(EstablishmentCancellationState {
                id,
                state: AtomicU8::new(ATTEMPT_CREATED),
                runtime: Mutex::new(None),
                #[cfg(test)]
                command_admission_full_observations: AtomicUsize::new(0),
            }),
        })
    }

    /// Requests cancellation without waiting for rollback.
    pub fn cancel(&self) {
        if self.shared.request_cancel() {
            let runtime = self
                .shared
                .runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .and_then(Weak::upgrade);
            if let Some(runtime) = runtime {
                runtime.wake();
            }
        }
    }

    /// Whether cancellation won or is awaiting joined rollback.
    pub fn is_cancelled(&self) -> bool {
        self.shared.cancellation_requested()
    }

    pub(crate) fn shared(&self) -> Arc<EstablishmentCancellationState> {
        Arc::clone(&self.shared)
    }
}

fn allocate_establishment_attempt_id(next: &AtomicU64) -> Result<u64> {
    next.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
        current.checked_add(1)
    })
    .map_err(|_| {
        WatchboundError::new(
            ErrorCode::Internal,
            Operation::Subscribe,
            "subscription establishment attempt IDs are exhausted",
        )
    })
}

impl std::fmt::Debug for EstablishmentCancellation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EstablishmentCancellation")
            .field("id", &self.shared.id)
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl EstablishmentCancellationState {
    pub(crate) fn bind(&self) -> Result<()> {
        loop {
            let state = self.state.load(Ordering::Acquire);
            let next = match state {
                ATTEMPT_CREATED => ATTEMPT_BOUND,
                ATTEMPT_CANCEL_REQUESTED_UNBOUND => ATTEMPT_CANCEL_REQUESTED_BOUND,
                _ => {
                    return Err(WatchboundError::new(
                        ErrorCode::InvalidArgument,
                        Operation::Subscribe,
                        "establishment cancellation token is already bound",
                    ));
                }
            };
            if self
                .state
                .compare_exchange(state, next, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return Ok(());
            }
        }
    }

    fn attach_runtime(&self, runtime: &Arc<backend::linux::Runtime>) {
        *self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::downgrade(runtime));
    }

    fn detach_runtime(&self) {
        self.runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
    }

    fn request_cancel(&self) -> bool {
        loop {
            let state = self.state.load(Ordering::Acquire);
            let next = match state {
                ATTEMPT_CREATED => ATTEMPT_CANCEL_REQUESTED_UNBOUND,
                ATTEMPT_BOUND => ATTEMPT_CANCEL_REQUESTED_BOUND,
                ATTEMPT_CANCEL_REQUESTED_UNBOUND
                | ATTEMPT_CANCEL_REQUESTED_BOUND
                | ATTEMPT_CANCELLED
                | ATTEMPT_SUCCEEDED
                | ATTEMPT_FAILED => return false,
                _ => unreachable!("unknown establishment attempt state"),
            };
            if self
                .state
                .compare_exchange(state, next, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return true;
            }
        }
    }

    pub(crate) fn cancellation_requested(&self) -> bool {
        matches!(
            self.state.load(Ordering::Acquire),
            ATTEMPT_CANCEL_REQUESTED_UNBOUND | ATTEMPT_CANCEL_REQUESTED_BOUND | ATTEMPT_CANCELLED
        )
    }

    pub(crate) fn try_commit_success(&self) -> bool {
        self.state
            .compare_exchange(
                ATTEMPT_BOUND,
                ATTEMPT_SUCCEEDED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub(crate) fn try_commit_failure(&self) -> bool {
        self.state
            .compare_exchange(
                ATTEMPT_BOUND,
                ATTEMPT_FAILED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub(crate) fn finish_cancelled(&self) {
        let _ = self.state.compare_exchange(
            ATTEMPT_CANCEL_REQUESTED_BOUND,
            ATTEMPT_CANCELLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        self.detach_runtime();
    }

    #[cfg(test)]
    pub(crate) fn observe_command_admission_full(&self) {
        self.command_admission_full_observations
            .fetch_add(1, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn command_admission_full_observations(&self) -> usize {
        self.command_admission_full_observations
            .load(Ordering::Acquire)
    }
}

pub(crate) fn operation_cancelled_error() -> WatchboundError {
    WatchboundError::new(
        ErrorCode::OperationCancelled,
        Operation::Subscribe,
        "subscription establishment was cancelled",
    )
}

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

/// The accepted Linux filesystem identity for a subscription root.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct RootIdentity {
    pub device: u64,
    pub inode: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RootAttachment {
    Attached,
    Lost,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RootLossEvidence {
    RootSelfEvent,
    RootWatchLoss,
    PathIdentityMismatch,
    Multiple,
}

/// Fixed-size root identity evidence attached to every batch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RootState {
    pub generation: u64,
    pub identity: RootIdentity,
    pub attachment: RootAttachment,
    pub loss_evidence: Option<RootLossEvidence>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RootIdentityPolicy {
    OriginalOnly,
    AcceptReplacement,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RootRecoveryAttachment {
    OriginalRestored,
    ReplacementAdopted,
    NotAttached,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RootRecoveryFailureReason {
    ReplacementNotAccepted,
    CandidateMissing,
    CandidateNotDirectory,
    SymlinkAncestry,
    IdentityUnstable,
    RootWatchUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RootRecoveryResult {
    pub attachment: RootRecoveryAttachment,
    pub reason: Option<RootRecoveryFailureReason>,
    pub previous_root_state: RootState,
    pub candidate_identity: Option<RootIdentity>,
    pub current_root_state: RootState,
    pub exclusion_generation: u64,
    pub coverage: Coverage,
    pub boundary_sequence: Option<u64>,
}

/// A conservative set of paths that a consumer should re-evaluate together.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeBatch {
    pub sequence: u64,
    /// Exclusion-set generation under which every path in this batch was selected.
    pub exclusion_generation: u64,
    pub root_state: RootState,
    pub invalidated_paths: Vec<PathBuf>,
    pub coverage: Coverage,
}

/// The committed result of one subscription-local reconciliation barrier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReconciliationResult {
    pub exclusion_generation: u64,
    pub coverage: Coverage,
}

/// Per-subscription tuning. No application-specific watch limit is implied.
#[derive(Clone, Debug)]
pub struct SubscriptionOptions {
    /// Exact normalized root-relative directory prefixes excluded during
    /// initial establishment at exclusion generation zero.
    pub initial_exclusions: Vec<PathBuf>,
    pub watch_limit: Option<usize>,
    pub batch_window: Duration,
    pub max_batch_paths: usize,
    pub output_queue_capacity: usize,
}

impl Default for SubscriptionOptions {
    fn default() -> Self {
        Self {
            initial_exclusions: Vec::new(),
            watch_limit: None,
            batch_window: Duration::from_millis(10),
            max_batch_paths: 1_024,
            output_queue_capacity: 64,
        }
    }
}

impl SubscriptionOptions {
    fn validate(&self) -> Result<()> {
        if self.watch_limit == Some(0) {
            return Err(WatchboundError::new(
                ErrorCode::InvalidArgument,
                Operation::Subscribe,
                "watch_limit must be positive when set",
            ));
        }
        if self.batch_window.is_zero() {
            return Err(WatchboundError::new(
                ErrorCode::InvalidArgument,
                Operation::Subscribe,
                "batch_window must be non-zero",
            ));
        }
        if self.max_batch_paths == 0 {
            return Err(WatchboundError::new(
                ErrorCode::InvalidArgument,
                Operation::Subscribe,
                "max_batch_paths must be positive",
            ));
        }
        if self.output_queue_capacity == 0 {
            return Err(WatchboundError::new(
                ErrorCode::InvalidArgument,
                Operation::Subscribe,
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
    pub initial_exclusions: bool,
    pub dynamic_exclusions: bool,
    pub reconciliation: bool,
    pub root_replacement_recovery: bool,
    pub process_native_watch_budget: bool,
    pub shared_native_watches: bool,
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
    pub fn with_runtime_watch_budget(native_watches: usize) -> Result<Self> {
        if native_watches == 0 {
            return Err(WatchboundError::new(
                ErrorCode::InvalidArgument,
                Operation::CreateEngine,
                "runtime native-watch budget must be positive",
            ));
        }
        Ok(Self {
            runtime_watch_budget: Some(native_watches),
        })
    }

    /// Returns the process-wide native-watch budget requested by this engine
    /// value. Constructing an engine does not acquire or configure a runtime.
    pub const fn native_watch_budget(&self) -> Option<usize> {
        self.runtime_watch_budget
    }

    pub const fn capabilities(&self) -> Capabilities {
        Capabilities {
            recursive: true,
            moved_in_tree_discovery: true,
            explicit_watch_limits: true,
            overflow_reporting: true,
            initial_exclusions: true,
            dynamic_exclusions: true,
            reconciliation: true,
            root_replacement_recovery: true,
            process_native_watch_budget: true,
            shared_native_watches: true,
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
    ) -> Result<Subscription> {
        self.begin_subscribe(root, options)?.wait()
    }

    /// Admits a subscription attempt and returns a handle that can wait for or
    /// cooperatively cancel its initial traversal.
    pub fn begin_subscribe(
        &self,
        root: impl AsRef<Path>,
        options: SubscriptionOptions,
    ) -> Result<PendingSubscription> {
        options.validate()?;
        let cancellation = EstablishmentCancellation::new()?;
        self.begin_subscribe_validated_options(root.as_ref(), options, cancellation)
    }

    /// Admits a subscription attempt using a caller-created, single-bind
    /// cancellation token.
    pub fn begin_subscribe_with_cancellation(
        &self,
        root: impl AsRef<Path>,
        options: SubscriptionOptions,
        cancellation: EstablishmentCancellation,
    ) -> Result<PendingSubscription> {
        options.validate()?;
        self.begin_subscribe_validated_options(root.as_ref(), options, cancellation)
    }

    fn begin_subscribe_validated_options(
        &self,
        root: &Path,
        options: SubscriptionOptions,
        cancellation: EstablishmentCancellation,
    ) -> Result<PendingSubscription> {
        cancellation.shared.bind()?;
        if cancellation.shared.cancellation_requested() {
            cancellation.shared.finish_cancelled();
            return Err(operation_cancelled_error());
        }

        let validated_root = (|| {
            let root = reject_symlink_ancestry(&absolute_path(root)?)?;
            let metadata = std::fs::symlink_metadata(&root).map_err(|error| {
                WatchboundError::from_io(
                    ErrorCode::RootUnavailable,
                    Operation::Subscribe,
                    format!("watch root is unavailable: {}", root.display()),
                    &error,
                )
            })?;
            if !metadata.is_dir() {
                return Err(WatchboundError::new(
                    ErrorCode::InvalidArgument,
                    Operation::Subscribe,
                    format!("watch root is not a directory: {}", root.display()),
                ));
            }
            Ok(root)
        })();
        let root = match validated_root {
            Ok(root) => root,
            Err(error) => return Err(commit_pre_runtime_failure(&cancellation.shared, error)),
        };
        if let Err(error) = backend::linux::validate_exclusion_prefixes(
            &root,
            options.initial_exclusions.clone(),
            Operation::Subscribe,
        ) {
            return Err(commit_pre_runtime_failure(&cancellation.shared, error));
        }
        self.begin_subscribe_admitted_root(root, options, cancellation)
    }

    fn begin_subscribe_admitted_root(
        &self,
        root: PathBuf,
        options: SubscriptionOptions,
        cancellation: EstablishmentCancellation,
    ) -> Result<PendingSubscription> {
        if cancellation.shared.cancellation_requested() {
            cancellation.shared.finish_cancelled();
            return Err(operation_cancelled_error());
        }

        let stats = Arc::new(SharedStats::new());
        let runtime = match acquire_runtime(self.runtime_watch_budget) {
            Ok(runtime) => runtime,
            Err(error) => {
                return Err(commit_pre_runtime_failure(&cancellation.shared, error));
            }
        };
        cancellation.shared.attach_runtime(&runtime);
        if cancellation.shared.cancellation_requested() {
            cancellation.shared.finish_cancelled();
            return match release_runtime(&runtime) {
                Ok(()) => Err(operation_cancelled_error()),
                Err(error) => Err(error),
            };
        }
        let pending =
            match runtime.begin_subscribe(root, options, Arc::clone(&stats), cancellation.shared())
            {
                Ok(pending) => pending,
                Err(error) => {
                    cancellation.shared.detach_runtime();
                    return match release_runtime(&runtime) {
                        Ok(()) => Err(error),
                        Err(release_error) => Err(release_error),
                    };
                }
            };

        Ok(PendingSubscription {
            pending: Some(pending),
            runtime: Some(runtime),
            stats,
            cancellation,
        })
    }

    #[cfg(test)]
    fn subscribe_validated_root(
        &self,
        root: PathBuf,
        options: SubscriptionOptions,
    ) -> Result<Subscription> {
        options.validate()?;
        let cancellation = EstablishmentCancellation::new()?;
        cancellation.shared.bind()?;
        self.begin_subscribe_admitted_root(root, options, cancellation)?
            .wait()
    }
}

/// A joined initial-establishment operation.
pub struct PendingSubscription {
    pending: Option<backend::linux::PendingEstablishedSubscription>,
    runtime: Option<Arc<backend::linux::Runtime>>,
    stats: Arc<SharedStats>,
    cancellation: EstablishmentCancellation,
}

impl PendingSubscription {
    pub fn cancellation_handle(&self) -> EstablishmentCancellation {
        self.cancellation.clone()
    }

    pub fn wait(mut self) -> Result<Subscription> {
        self.finish()
    }

    fn finish(&mut self) -> Result<Subscription> {
        let pending = self
            .pending
            .take()
            .expect("pending subscription may only be completed once");
        let runtime = self
            .runtime
            .take()
            .expect("pending subscription runtime may only be completed once");
        match pending.wait() {
            Ok(established) => {
                self.cancellation.shared.detach_runtime();
                Ok(subscription_from_established(
                    runtime,
                    Arc::clone(&self.stats),
                    established,
                ))
            }
            Err(error) => {
                self.cancellation.shared.detach_runtime();
                match release_runtime(&runtime) {
                    Ok(()) => Err(error),
                    Err(release_error) => Err(release_error),
                }
            }
        }
    }
}

impl Drop for PendingSubscription {
    fn drop(&mut self) {
        if self.pending.is_none() {
            return;
        }
        self.cancellation.cancel();
        if let Ok(subscription) = self.finish() {
            let _ = subscription.dispose();
        }
    }
}

fn commit_pre_runtime_failure(
    cancellation: &EstablishmentCancellationState,
    error: WatchboundError,
) -> WatchboundError {
    if cancellation.try_commit_failure() {
        cancellation.detach_runtime();
        error
    } else {
        cancellation.finish_cancelled();
        operation_cancelled_error()
    }
}

fn subscription_from_established(
    runtime: Arc<backend::linux::Runtime>,
    stats: Arc<SharedStats>,
    established: backend::linux::EstablishedSubscription,
) -> Subscription {
    Subscription {
        initial_coverage: established.initial_coverage,
        initial_root_state: established.initial_root_state,
        receiver: Mutex::new(established.receiver),
        stats,
        control: Arc::new(SubscriptionControl {
            lifecycle: Mutex::new(Lifecycle::Active {
                runtime,
                subscription_id: established.id,
            }),
            disposed: Condvar::new(),
            exclusion_generation: AtomicU64::new(0),
            root_state: established.root_state,
            topology_transaction_in_flight: AtomicBool::new(false),
            topology_transaction_finished: Condvar::new(),
        }),
    }
}

pub struct Subscription {
    initial_coverage: Coverage,
    initial_root_state: RootState,
    receiver: Mutex<Receiver<ChangeBatch>>,
    stats: Arc<SharedStats>,
    control: Arc<SubscriptionControl>,
}

struct SubscriptionControl {
    lifecycle: Mutex<Lifecycle>,
    disposed: Condvar,
    exclusion_generation: AtomicU64,
    root_state: Arc<Mutex<RootState>>,
    topology_transaction_in_flight: AtomicBool,
    topology_transaction_finished: Condvar,
}

enum Lifecycle {
    Active {
        runtime: Arc<backend::linux::Runtime>,
        subscription_id: u64,
    },
    Disposing,
    Disposed(Option<WatchboundError>),
}

impl Subscription {
    pub fn initial_coverage(&self) -> &Coverage {
        &self.initial_coverage
    }

    /// Returns the root identity state committed by the same establishment
    /// acknowledgement as [`Self::initial_coverage`].
    pub fn initial_root_state(&self) -> &RootState {
        &self.initial_root_state
    }

    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> std::result::Result<ChangeBatch, RecvTimeoutError> {
        self.receiver
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .recv_timeout(timeout)
    }

    pub fn try_recv(&self) -> std::result::Result<ChangeBatch, TryRecvError> {
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

    /// Returns the last exclusion generation whose topology transaction was
    /// committed and acknowledged by the shared worker.
    pub fn exclusion_generation(&self) -> u64 {
        self.control.exclusion_generation.load(Ordering::Acquire)
    }

    pub fn root_state(&self) -> RootState {
        self.root_state_handle().root_state()
    }

    /// Returns a cloneable snapshot handle for bindings whose receiving
    /// subscription is owned by a delivery thread.
    pub fn root_state_handle(&self) -> RootStateHandle {
        RootStateHandle {
            shared: Arc::clone(&self.control.root_state),
        }
    }

    /// Returns a cloneable command handle for bindings that move the receiving
    /// subscription onto a delivery thread.
    pub fn exclusion_handle(&self) -> ExclusionHandle {
        ExclusionHandle {
            control: Arc::clone(&self.control),
        }
    }

    /// Returns a cloneable reconciliation handle for bindings whose receiving
    /// subscription is owned by a delivery thread.
    pub fn reconciliation_handle(&self) -> ReconciliationHandle {
        ReconciliationHandle {
            control: Arc::clone(&self.control),
        }
    }

    pub fn root_recovery_handle(&self) -> RootRecoveryHandle {
        RootRecoveryHandle {
            control: Arc::clone(&self.control),
        }
    }

    /// Atomically replaces the complete set of root-relative directory-prefix
    /// exclusions and returns the committed coverage snapshot.
    pub fn replace_exclusions(&self, generation: u64, prefixes: Vec<PathBuf>) -> Result<Coverage> {
        self.exclusion_handle()
            .replace_exclusions(generation, prefixes)
    }

    /// Rebuilds this subscription's included topology under its currently
    /// committed exclusion generation and returns only after the conservative
    /// root invalidation and final coverage snapshot are committed.
    pub fn reconcile(&self) -> Result<ReconciliationResult> {
        self.reconciliation_handle().reconcile()
    }

    /// Explicitly recovers a lost lexical root under the required identity
    /// acceptance policy. This never changes the root pathname.
    pub fn recover_root(&self, identity_policy: RootIdentityPolicy) -> Result<RootRecoveryResult> {
        self.root_recovery_handle().recover_root(identity_policy)
    }

    /// Joins removal of this subscription from the shared worker. Once this
    /// returns, the engine can no longer enqueue a batch for this subscription.
    /// Disposing the final subscription also joins the worker thread.
    pub fn dispose(&self) -> Result<()> {
        let (runtime, subscription_id) = {
            let mut lifecycle = self
                .control
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
                            .control
                            .disposed
                            .wait(lifecycle)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                    Lifecycle::Disposed(error) => return stored_result(error),
                }
            }
        };

        let mut result = runtime.dispose(subscription_id);
        drain_disconnected_output(
            &self
                .receiver
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
        if let Err(error) = release_runtime(&runtime)
            && result.is_ok()
        {
            result = Err(error);
        }
        self.stats.disposed.store(true, Ordering::Release);

        let stored_error = result.as_ref().err().cloned();
        let mut lifecycle = self
            .control
            .lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while self
            .control
            .topology_transaction_in_flight
            .load(Ordering::Acquire)
        {
            lifecycle = self
                .control
                .topology_transaction_finished
                .wait(lifecycle)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *lifecycle = Lifecycle::Disposed(stored_error);
        self.control.disposed.notify_all();
        result
    }
}

/// A cloneable exclusion command handle. It does not keep the subscription's
/// batch receiver alive and dropping it does not dispose the subscription.
#[derive(Clone)]
pub struct ExclusionHandle {
    control: Arc<SubscriptionControl>,
}

impl ExclusionHandle {
    pub fn exclusion_generation(&self) -> u64 {
        self.control.exclusion_generation.load(Ordering::Acquire)
    }

    pub fn replace_exclusions(&self, generation: u64, prefixes: Vec<PathBuf>) -> Result<Coverage> {
        if self
            .control
            .topology_transaction_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(WatchboundError::new(
                ErrorCode::TopologyTransactionConflict,
                Operation::ReplaceExclusions,
                "a topology transaction is already in progress for this subscription",
            ));
        }
        let _in_flight = InFlightTopologyTransaction(&self.control);
        let pending = {
            let lifecycle = self
                .control
                .lifecycle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Lifecycle::Active {
                runtime,
                subscription_id,
            } = &*lifecycle
            else {
                return Err(WatchboundError::new(
                    ErrorCode::SubscriptionClosed,
                    Operation::ReplaceExclusions,
                    "subscription is disposing or disposed",
                ));
            };
            runtime.queue_replace_exclusions(*subscription_id, generation, prefixes)?
        };
        let coverage = pending.wait()?;
        self.control
            .exclusion_generation
            .store(generation, Ordering::Release);
        Ok(coverage)
    }
}

/// A cloneable reconciliation command handle. It does not keep the batch
/// receiver alive and dropping it does not dispose the subscription.
#[derive(Clone)]
pub struct ReconciliationHandle {
    control: Arc<SubscriptionControl>,
}

/// A cloneable explicit root-recovery command handle.
#[derive(Clone)]
pub struct RootRecoveryHandle {
    control: Arc<SubscriptionControl>,
}

/// A cloneable read-only handle to the last root state published by the worker.
#[derive(Clone)]
pub struct RootStateHandle {
    shared: Arc<Mutex<RootState>>,
}

impl RootStateHandle {
    pub fn root_state(&self) -> RootState {
        *self
            .shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl RootRecoveryHandle {
    pub fn recover_root(&self, identity_policy: RootIdentityPolicy) -> Result<RootRecoveryResult> {
        if self
            .control
            .topology_transaction_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(WatchboundError::new(
                ErrorCode::TopologyTransactionConflict,
                Operation::RecoverRoot,
                "a topology transaction is already in progress for this subscription",
            ));
        }
        let _in_flight = InFlightTopologyTransaction(&self.control);
        let pending = {
            let lifecycle = self
                .control
                .lifecycle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Lifecycle::Active {
                runtime,
                subscription_id,
            } = &*lifecycle
            else {
                return Err(WatchboundError::new(
                    ErrorCode::SubscriptionClosed,
                    Operation::RecoverRoot,
                    "subscription is disposing or disposed",
                ));
            };
            runtime.queue_root_recovery(*subscription_id, identity_policy)?
        };
        pending.wait()
    }
}

impl ReconciliationHandle {
    pub fn reconcile(&self) -> Result<ReconciliationResult> {
        if self
            .control
            .topology_transaction_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(WatchboundError::new(
                ErrorCode::TopologyTransactionConflict,
                Operation::Reconcile,
                "a topology transaction is already in progress for this subscription",
            ));
        }
        let _in_flight = InFlightTopologyTransaction(&self.control);
        let pending = {
            let lifecycle = self
                .control
                .lifecycle
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Lifecycle::Active {
                runtime,
                subscription_id,
            } = &*lifecycle
            else {
                return Err(WatchboundError::new(
                    ErrorCode::SubscriptionClosed,
                    Operation::Reconcile,
                    "subscription is disposing or disposed",
                ));
            };
            runtime.queue_reconciliation(*subscription_id)?
        };
        pending.wait()
    }
}

struct InFlightTopologyTransaction<'a>(&'a SubscriptionControl);

impl Drop for InFlightTopologyTransaction<'_> {
    fn drop(&mut self) {
        self.0
            .topology_transaction_in_flight
            .store(false, Ordering::Release);
        self.0.topology_transaction_finished.notify_all();
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let _ = self.dispose();
    }
}

fn stored_result(error: &Option<WatchboundError>) -> Result<()> {
    match error {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

fn drain_disconnected_output(receiver: &Receiver<ChangeBatch>) -> usize {
    let mut batch: Option<ChangeBatch> = None;
    let mut quanta = 0;
    loop {
        quanta += 1;
        let mut removed = 0;
        while removed < MAX_OUTPUT_DISPOSAL_ITEMS_PER_TURN {
            if let Some(current) = batch.as_mut() {
                if current.invalidated_paths.pop().is_some() {
                    removed += 1;
                } else {
                    batch.take();
                    removed += 1;
                }
                continue;
            }
            match receiver.try_recv() {
                Ok(next) => {
                    batch = Some(next);
                    removed += 1;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return quanta,
            }
        }
        // The worker has already closed this subscription's sender. Yielding
        // between fixed destructor quanta keeps cleanup from monopolizing the
        // calling thread while unrelated runtime peers continue independently.
        std::thread::yield_now();
    }
}

static RUNTIME: OnceLock<Mutex<Option<Weak<backend::linux::Runtime>>>> = OnceLock::new();

fn runtime_registry() -> &'static Mutex<Option<Weak<backend::linux::Runtime>>> {
    RUNTIME.get_or_init(|| Mutex::new(None))
}

fn acquire_runtime(native_watch_budget: Option<usize>) -> Result<Arc<backend::linux::Runtime>> {
    let mut registry = runtime_registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(runtime) = registry.as_ref().and_then(Weak::upgrade) {
        if runtime.native_watch_budget() != native_watch_budget {
            return Err(WatchboundError::new(
                ErrorCode::RuntimeConfigurationConflict,
                Operation::Subscribe,
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

fn release_runtime(runtime: &Arc<backend::linux::Runtime>) -> Result<()> {
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

fn absolute_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .map_err(|error| {
                WatchboundError::from_io(
                    ErrorCode::RootUnavailable,
                    Operation::Subscribe,
                    "current directory is unavailable while resolving the watch root",
                    &error,
                )
            })
    }
}

fn reject_symlink_ancestry(path: &Path) -> Result<PathBuf> {
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
                    return Err(WatchboundError::new(
                        ErrorCode::InvalidArgument,
                        Operation::Subscribe,
                        format!(
                            "watch root has a non-directory path component: {}",
                            current.display()
                        ),
                    ));
                }
                current.pop();
                current_is_directory = true;
                continue;
            }
            Component::Normal(component) => {
                if !current_is_directory {
                    return Err(WatchboundError::new(
                        ErrorCode::InvalidArgument,
                        Operation::Subscribe,
                        format!(
                            "watch root has a non-directory path component: {}",
                            current.display()
                        ),
                    ));
                }
                current.push(component);
            }
        }
        if current == Path::new("/") {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&current).map_err(|error| {
            let code = if matches!(error.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)) {
                ErrorCode::InvalidArgument
            } else {
                ErrorCode::RootUnavailable
            };
            WatchboundError::from_io(
                code,
                Operation::Subscribe,
                format!("watch root path is unavailable: {}", current.display()),
                &error,
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(WatchboundError::new(
                ErrorCode::InvalidArgument,
                Operation::Subscribe,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    static SERIAL: Mutex<()> = Mutex::new(());

    fn assert_error_contract(
        error: &WatchboundError,
        code: ErrorCode,
        operation: Operation,
        retryable: bool,
        retry_after: Option<RetryAfter>,
    ) {
        assert_eq!(error.code(), code);
        assert_eq!(error.operation(), operation);
        assert_eq!(error.retryable(), retryable);
        assert_eq!(error.retry_after(), retry_after);
    }

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let serial = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "watchbound-control-{label}-{}-{nonce}-{serial}",
                std::process::id()
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn error_codes_define_retry_policy_centrally() {
        let cases = [
            (ErrorCode::InvalidArgument, false, None),
            (ErrorCode::SubscriptionClosed, false, None),
            (
                ErrorCode::TopologyTransactionConflict,
                true,
                Some(RetryAfter::TopologyTransactionSettles),
            ),
            (ErrorCode::OperationCancelled, false, None),
            (ErrorCode::OperationInterrupted, false, None),
            (
                ErrorCode::ConsumerBackpressure,
                true,
                Some(RetryAfter::DeliveryDrains),
            ),
            (
                ErrorCode::RootStateConflict,
                true,
                Some(RetryAfter::RootStateChanges),
            ),
            (
                ErrorCode::RootUnavailable,
                true,
                Some(RetryAfter::FilesystemStateChanges),
            ),
            (
                ErrorCode::ResourceUnavailable,
                true,
                Some(RetryAfter::ResourcesAvailable),
            ),
            (
                ErrorCode::RuntimeConfigurationConflict,
                true,
                Some(RetryAfter::RuntimeDisposed),
            ),
            (ErrorCode::Internal, false, None),
        ];

        for (code, retryable, retry_after) in cases {
            let error = WatchboundError::new(code, Operation::Reconcile, "test error");
            assert_error_contract(&error, code, Operation::Reconcile, retryable, retry_after);
        }
    }

    #[test]
    fn exhausted_establishment_attempt_ids_fail_without_wrapping() {
        let next = AtomicU64::new(u64::MAX - 1);
        assert_eq!(
            allocate_establishment_attempt_id(&next).unwrap(),
            u64::MAX - 1
        );
        let error = allocate_establishment_attempt_id(&next).unwrap_err();
        assert_error_contract(
            &error,
            ErrorCode::Internal,
            Operation::Subscribe,
            false,
            None,
        );
        assert_eq!(next.load(Ordering::Acquire), u64::MAX);
    }

    #[test]
    fn repeated_cancellation_requests_do_not_request_another_runtime_wakeup() {
        let cancellation = EstablishmentCancellation::new().unwrap();
        assert!(cancellation.shared.request_cancel());
        assert!(!cancellation.shared.request_cancel());
        assert!(!cancellation.shared.request_cancel());
    }

    #[test]
    fn zero_runtime_budget_is_an_invalid_engine_argument() {
        let error = Engine::with_runtime_watch_budget(0).unwrap_err();
        assert_error_contract(
            &error,
            ErrorCode::InvalidArgument,
            Operation::CreateEngine,
            false,
            None,
        );
    }

    #[test]
    fn engine_values_report_their_requested_native_watch_budget() {
        assert_eq!(Engine::new().native_watch_budget(), None);
        assert_eq!(
            Engine::with_runtime_watch_budget(17)
                .unwrap()
                .native_watch_budget(),
            Some(17)
        );
        assert_eq!(VERSION, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn public_error_messages_are_bounded_on_utf8_boundaries() {
        let error = WatchboundError::new(
            ErrorCode::Internal,
            Operation::Subscribe,
            "é".repeat(MAX_ERROR_MESSAGE_BYTES),
        );

        assert_eq!(error.message().len(), MAX_ERROR_MESSAGE_BYTES);
        assert!(error.message().is_char_boundary(error.message().len()));
    }

    #[test]
    fn disconnected_output_is_destroyed_in_path_bounded_quanta() {
        let batch_count = 3;
        let paths_per_batch = MAX_OUTPUT_DISPOSAL_ITEMS_PER_TURN * 2 + 1;
        let (sender, receiver) = std::sync::mpsc::sync_channel(batch_count);
        for batch in 0..batch_count {
            sender
                .send(ChangeBatch {
                    sequence: batch as u64,
                    exclusion_generation: 0,
                    root_state: RootState {
                        generation: 0,
                        identity: RootIdentity {
                            device: 1,
                            inode: 1,
                        },
                        attachment: RootAttachment::Attached,
                        loss_evidence: None,
                    },
                    invalidated_paths: (0..paths_per_batch)
                        .map(|path| PathBuf::from(format!("batch-{batch}/path-{path}")))
                        .collect(),
                    coverage: Coverage::Complete,
                })
                .unwrap();
        }
        drop(sender);

        let quanta = drain_disconnected_output(&receiver);

        assert_eq!(quanta, 7);
        assert_eq!(receiver.try_recv(), Err(TryRecvError::Disconnected));
    }

    #[test]
    fn disposal_closes_sender_before_waiting_for_a_blocked_receiver() {
        let _serial = SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = TestRoot::new("blocked-receiver-disposal");
        let subscription = Arc::new(
            Engine::new()
                .subscribe(&root.0, SubscriptionOptions::default())
                .unwrap(),
        );
        let waiting_subscription = Arc::clone(&subscription);
        let (locked, receiver_locked) = std::sync::mpsc::sync_channel(1);
        let waiter = std::thread::spawn(move || {
            let receiver = waiting_subscription
                .receiver
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locked.send(()).unwrap();
            assert_eq!(
                receiver.recv_timeout(Duration::from_secs(5)),
                Err(RecvTimeoutError::Disconnected)
            );
        });
        receiver_locked.recv().unwrap();

        subscription.dispose().unwrap();

        waiter.join().unwrap();
        assert_eq!(subscription.try_recv(), Err(TryRecvError::Disconnected));
    }

    #[test]
    fn concurrent_reconciliation_request_is_rejected_explicitly() {
        let _serial = SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = TestRoot::new("reconciliation-conflict");
        let subscription = Engine::new()
            .subscribe(&root.0, SubscriptionOptions::default())
            .unwrap();
        {
            subscription
                .control
                .topology_transaction_in_flight
                .store(true, Ordering::Release);
            let _gate = InFlightTopologyTransaction(&subscription.control);

            let error = subscription.reconcile().unwrap_err();
            assert_error_contract(
                &error,
                ErrorCode::TopologyTransactionConflict,
                Operation::Reconcile,
                true,
                Some(RetryAfter::TopologyTransactionSettles),
            );
        }
        subscription.dispose().unwrap();
    }

    #[test]
    fn reconciliation_and_exclusion_update_conflict_explicitly() {
        let _serial = SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = TestRoot::new("exclusion-conflict");
        let subscription = Engine::new()
            .subscribe(&root.0, SubscriptionOptions::default())
            .unwrap();
        {
            subscription
                .control
                .topology_transaction_in_flight
                .store(true, Ordering::Release);
            let _gate = InFlightTopologyTransaction(&subscription.control);

            let error = subscription.replace_exclusions(1, vec![]).unwrap_err();
            assert_error_contract(
                &error,
                ErrorCode::TopologyTransactionConflict,
                Operation::ReplaceExclusions,
                true,
                Some(RetryAfter::TopologyTransactionSettles),
            );
        }
        subscription.dispose().unwrap();
    }

    #[test]
    fn post_disposal_operations_are_closed_not_interrupted() {
        let _serial = SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = TestRoot::new("closed-operations");
        let subscription = Engine::new()
            .subscribe(&root.0, SubscriptionOptions::default())
            .unwrap();
        subscription.dispose().unwrap();

        let cases = [
            (
                subscription.replace_exclusions(1, vec![]).unwrap_err(),
                Operation::ReplaceExclusions,
            ),
            (subscription.reconcile().unwrap_err(), Operation::Reconcile),
            (
                subscription
                    .recover_root(RootIdentityPolicy::AcceptReplacement)
                    .unwrap_err(),
                Operation::RecoverRoot,
            ),
        ];
        for (error, operation) in cases {
            assert_error_contract(
                &error,
                ErrorCode::SubscriptionClosed,
                operation,
                false,
                None,
            );
        }
    }

    #[test]
    fn recovery_while_attached_is_a_root_state_conflict() {
        let _serial = SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = TestRoot::new("attached-recovery-conflict");
        let subscription = Engine::new()
            .subscribe(&root.0, SubscriptionOptions::default())
            .unwrap();

        let error = subscription
            .recover_root(RootIdentityPolicy::AcceptReplacement)
            .unwrap_err();
        assert_error_contract(
            &error,
            ErrorCode::RootStateConflict,
            Operation::RecoverRoot,
            true,
            Some(RetryAfter::RootStateChanges),
        );
        subscription.dispose().unwrap();
    }

    #[test]
    fn failed_establishment_releases_provisional_runtime_ownership() {
        let _serial = SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let vanished = TestRoot::new("post-acquire-rejection");
        let valid = TestRoot::new("post-acquire-reconfiguration");
        std::fs::remove_dir(&vanished.0).unwrap();

        let first_engine = Engine::with_runtime_watch_budget(2).unwrap();
        let error = match first_engine
            .subscribe_validated_root(vanished.0.clone(), SubscriptionOptions::default())
        {
            Ok(subscription) => {
                subscription.dispose().unwrap();
                panic!("a vanished admitted root should not establish a subscription");
            }
            Err(error) => error,
        };
        assert_error_contract(
            &error,
            ErrorCode::RootUnavailable,
            Operation::Subscribe,
            true,
            Some(RetryAfter::FilesystemStateChanges),
        );
        assert_eq!(first_engine.runtime_stats(), RuntimeStats::default());

        let reconfigured_engine = Engine::with_runtime_watch_budget(3).unwrap();
        let subscription = reconfigured_engine
            .subscribe(&valid.0, SubscriptionOptions::default())
            .unwrap();
        assert_eq!(
            reconfigured_engine.runtime_stats().native_watch_budget,
            Some(3)
        );
        subscription.dispose().unwrap();
        assert_eq!(reconfigured_engine.runtime_stats(), RuntimeStats::default());
    }
}
