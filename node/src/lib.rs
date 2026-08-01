//! Thin Node-API proof for watchbound-engine.

use std::io;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use napi::bindgen_prelude::{
    AsyncTask, BigInt, Buffer, Either, FnArgs, Function, JsValue, Null, ObjectFinalize, PromiseRaw,
    ToNapiValue,
};
use napi::{Env, Error, Result, Status, Task, sys};
use napi_derive::napi;
use watchbound_engine::{
    ChangeBatch, Coverage, Engine, ErrorCode, EstablishmentCancellation, ExclusionHandle,
    ExclusionPolicy, MAX_ERROR_MESSAGE_BYTES, Operation, PartialReason, ReconciliationHandle,
    ReconciliationResult, RootAttachment, RootIdentity, RootIdentityPolicy, RootLossEvidence,
    RootRecoveryAttachment, RootRecoveryFailureReason, RootRecoveryHandle, RootRecoveryResult,
    RootState, RootStateHandle, RuntimeStats, Stats, StatsHandle, Subscription,
    SubscriptionOptions, SystemCause, UncertainReason, VERSION, WatchboundError,
};

mod delivery;
mod dispose_completion;

type NodeResult<T> = std::result::Result<T, NodeErrorDetails>;
type TaskOutcome<T> = NodeResult<T>;

const MAX_SYSTEM_DETAIL_BYTES: usize = 128;
const BINDING_API_VERSION: u32 = 4;
const CAPABILITY_SCHEMA_VERSION: u32 = 4;
const NODE_API_VERSION: u32 = 6;

#[derive(Clone, Debug)]
enum NodeSystemCode {
    Number(i32),
    Text(String),
}

#[derive(Clone, Debug)]
struct NodeSystemCause {
    domain: &'static str,
    code: Option<NodeSystemCode>,
    kind: Option<String>,
    message: String,
}

impl NodeSystemCause {
    fn from_engine(cause: &SystemCause) -> Self {
        Self {
            domain: "os",
            code: cause.raw_os_error().map(NodeSystemCode::Number),
            kind: Some(bounded_string(
                format!("{:?}", cause.kind()),
                MAX_SYSTEM_DETAIL_BYTES,
            )),
            message: bounded_string(cause.to_string(), MAX_ERROR_MESSAGE_BYTES),
        }
    }

    fn from_io(cause: &io::Error) -> Self {
        Self {
            domain: "os",
            code: cause.raw_os_error().map(NodeSystemCode::Number),
            kind: Some(bounded_string(
                format!("{:?}", cause.kind()),
                MAX_SYSTEM_DETAIL_BYTES,
            )),
            message: bounded_string(cause.to_string(), MAX_ERROR_MESSAGE_BYTES),
        }
    }

    fn from_napi(cause: Error) -> Self {
        Self {
            domain: "node-api",
            code: Some(NodeSystemCode::Text(bounded_string(
                cause.status.as_ref().to_owned(),
                MAX_SYSTEM_DETAIL_BYTES,
            ))),
            kind: None,
            message: bounded_string(cause.reason, MAX_ERROR_MESSAGE_BYTES),
        }
    }

    fn from_napi_status(status: Status, message: impl Into<String>) -> Self {
        Self {
            domain: "node-api",
            code: Some(NodeSystemCode::Text(bounded_string(
                status.as_ref().to_owned(),
                MAX_SYSTEM_DETAIL_BYTES,
            ))),
            kind: None,
            message: bounded_string(message.into(), MAX_ERROR_MESSAGE_BYTES),
        }
    }
}

#[derive(Clone, Debug)]
pub struct NodeErrorDetails {
    code: ErrorCode,
    operation: Operation,
    message: String,
    system_cause: Option<NodeSystemCause>,
}

impl NodeErrorDetails {
    fn new(code: ErrorCode, operation: Operation, message: impl Into<String>) -> Self {
        Self {
            code,
            operation,
            message: bounded_string(message.into(), MAX_ERROR_MESSAGE_BYTES),
            system_cause: None,
        }
    }

    fn from_io(
        code: ErrorCode,
        operation: Operation,
        message: impl Into<String>,
        cause: &io::Error,
    ) -> Self {
        Self::new(code, operation, message).with_system_cause(NodeSystemCause::from_io(cause))
    }

    fn from_napi(
        code: ErrorCode,
        operation: Operation,
        message: impl Into<String>,
        cause: Error,
    ) -> Self {
        Self::new(code, operation, message).with_system_cause(NodeSystemCause::from_napi(cause))
    }

    fn from_napi_status(
        code: ErrorCode,
        operation: Operation,
        status: Status,
        message: impl Into<String>,
    ) -> Self {
        Self::new(code, operation, message).with_system_cause(NodeSystemCause::from_napi_status(
            status,
            "Node-API operation failed",
        ))
    }

    fn internal(operation: Operation, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, operation, message)
    }

    fn operation_interrupted(operation: Operation, message: impl Into<String>) -> Self {
        Self::new(ErrorCode::OperationInterrupted, operation, message)
    }

    fn delivery_failure(status: Status) -> Self {
        Self::new(
            ErrorCode::Internal,
            Operation::DeliverBatch,
            "Node callback bridge could not deliver a batch",
        )
        .with_system_cause(NodeSystemCause::from_napi_status(
            status,
            format!("Node callback bridge delivery failed: {status}"),
        ))
    }

    fn with_system_cause(mut self, system_cause: NodeSystemCause) -> Self {
        self.system_cause = Some(system_cause);
        self
    }

    fn into_napi_error(self, env: &Env) -> Result<Error> {
        let mut error = env.create_error(Error::from_reason(self.message))?;
        error.set("name", "WatchboundError")?;
        error.set("code", self.code.as_str())?;
        error.set("operation", self.operation.as_str())?;
        error.set("retryable", self.code.retryable())?;
        if let Some(retry_after) = self.code.retry_after() {
            error.set("retryAfter", retry_after.as_str())?;
        }
        if let Some(system_cause) = self.system_cause {
            let mut cause = napi::bindgen_prelude::Object::new(env)?;
            cause.set("domain", system_cause.domain)?;
            if let Some(code) = system_cause.code {
                match code {
                    NodeSystemCode::Number(code) => cause.set("code", code)?,
                    NodeSystemCode::Text(code) => cause.set("code", code)?,
                }
            }
            if let Some(kind) = system_cause.kind {
                cause.set("kind", kind)?;
            }
            cause.set("message", system_cause.message)?;
            error.set("systemCause", cause)?;
        }
        Ok(Error::from((&error).into_unknown(env)?))
    }
}

impl From<WatchboundError> for NodeErrorDetails {
    fn from(error: WatchboundError) -> Self {
        let system_cause = error.system_cause().map(NodeSystemCause::from_engine);
        Self {
            code: error.code(),
            operation: error.operation(),
            message: error.message().to_owned(),
            system_cause,
        }
    }
}

fn bounded_string(mut value: String, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value;
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    value
}

fn task_result<T>(env: &Env, outcome: TaskOutcome<T>) -> Result<T> {
    outcome.map_err(|error| sync_error(env, error))
}

fn sync_error(env: &Env, error: NodeErrorDetails) -> Error {
    error
        .into_napi_error(env)
        .unwrap_or_else(|conversion_error| conversion_error)
}

#[napi(object)]
pub struct JsSubscriptionOptions {
    pub initial_exclusions: Option<Vec<Buffer>>,
    pub excluded_directory_names: Option<Vec<Buffer>>,
    pub observed_excluded_paths: Option<Vec<Buffer>>,
    pub watch_limit: Option<f64>,
    pub batch_window_ms: Option<f64>,
    pub max_batch_paths: Option<f64>,
    pub output_queue_capacity: Option<f64>,
}

impl JsSubscriptionOptions {
    fn into_engine_options(self) -> NodeResult<SubscriptionOptions> {
        let defaults = SubscriptionOptions::default();
        let watch_limit = self
            .watch_limit
            .map(|value| positive_u32_option(value, "watchLimit", Operation::Subscribe))
            .transpose()?;
        let batch_window_ms = self
            .batch_window_ms
            .map(|value| positive_u32_option(value, "batchWindowMs", Operation::Subscribe))
            .transpose()?;
        let max_batch_paths = self
            .max_batch_paths
            .map(|value| positive_u32_option(value, "maxBatchPaths", Operation::Subscribe))
            .transpose()?;
        let output_queue_capacity = self
            .output_queue_capacity
            .map(|value| positive_u32_option(value, "outputQueueCapacity", Operation::Subscribe))
            .transpose()?;
        Ok(SubscriptionOptions {
            initial_exclusions: self
                .initial_exclusions
                .unwrap_or_default()
                .into_iter()
                .map(|prefix| PathBuf::from(std::ffi::OsString::from_vec(prefix.to_vec())))
                .collect(),
            excluded_directory_names: self
                .excluded_directory_names
                .unwrap_or_default()
                .into_iter()
                .map(|name| std::ffi::OsString::from_vec(name.to_vec()))
                .collect(),
            observed_excluded_paths: self
                .observed_excluded_paths
                .unwrap_or_default()
                .into_iter()
                .map(|path| PathBuf::from(std::ffi::OsString::from_vec(path.to_vec())))
                .collect(),
            watch_limit: watch_limit.map(|value| value as usize),
            batch_window: batch_window_ms.map_or(defaults.batch_window, |value| {
                Duration::from_millis(u64::from(value))
            }),
            max_batch_paths: max_batch_paths
                .map_or(defaults.max_batch_paths, |value| value as usize),
            output_queue_capacity: output_queue_capacity
                .map_or(defaults.output_queue_capacity, |value| value as usize),
        })
    }
}

fn positive_u32_option(value: f64, name: &str, operation: Operation) -> NodeResult<u32> {
    if !value.is_finite() || value < 1.0 || value > f64::from(u32::MAX) || value.fract() != 0.0 {
        return Err(NodeErrorDetails::new(
            ErrorCode::InvalidArgument,
            operation,
            format!(
                "{name} must be a finite positive integer no greater than {}",
                u32::MAX
            ),
        ));
    }
    Ok(value as u32)
}

#[napi(object)]
pub struct JsEngineOptions {
    pub native_watch_budget: Option<Either<f64, Null>>,
}

impl JsEngineOptions {
    fn into_engine(self) -> NodeResult<Engine> {
        match self.native_watch_budget {
            None | Some(Either::B(_)) => Ok(Engine::new()),
            Some(Either::A(value)) => {
                let budget =
                    positive_u32_option(value, "nativeWatchBudget", Operation::CreateEngine)?;
                Engine::with_runtime_watch_budget(budget as usize).map_err(NodeErrorDetails::from)
            }
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsCoverage {
    pub state: String,
    pub reason: Option<String>,
    pub watched_directories: Option<u32>,
    pub deferred_directories: Option<u32>,
}

impl From<&Coverage> for JsCoverage {
    fn from(coverage: &Coverage) -> Self {
        match coverage {
            Coverage::Complete => Self {
                state: "complete".to_owned(),
                reason: None,
                watched_directories: None,
                deferred_directories: None,
            },
            Coverage::Partial {
                reason,
                watched_directories,
                deferred_directories,
            } => Self {
                state: "partial".to_owned(),
                reason: Some(partial_reason_name(*reason).to_owned()),
                watched_directories: Some(saturating_u32(*watched_directories)),
                deferred_directories: Some(saturating_u32(*deferred_directories)),
            },
            Coverage::Uncertain { reason } => Self {
                state: "uncertain".to_owned(),
                reason: Some(uncertain_reason_name(*reason).to_owned()),
                watched_directories: None,
                deferred_directories: None,
            },
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsChangeBatch {
    pub sequence: u64,
    pub exclusion_generation: u64,
    pub root_state: JsRootState,
    /// Exact Linux path bytes. The JavaScript wrapper may decode UTF-8 paths,
    /// but the native boundary never performs a lossy conversion.
    pub invalidated_paths: Vec<Buffer>,
    pub coverage: JsCoverage,
}

#[napi(object, object_from_js = false)]
pub struct JsReconciliationResult {
    pub exclusion_generation: u64,
    pub coverage: JsCoverage,
}

#[napi(object, object_from_js = false)]
pub struct JsRootIdentity {
    pub device: u64,
    pub inode: u64,
}

impl From<RootIdentity> for JsRootIdentity {
    fn from(identity: RootIdentity) -> Self {
        Self {
            device: identity.device,
            inode: identity.inode,
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsRootState {
    pub generation: u64,
    pub identity: JsRootIdentity,
    pub attachment: String,
    pub loss_evidence: Option<String>,
}

impl From<RootState> for JsRootState {
    fn from(state: RootState) -> Self {
        Self {
            generation: state.generation,
            identity: state.identity.into(),
            attachment: root_attachment_name(state.attachment).to_owned(),
            loss_evidence: state
                .loss_evidence
                .map(|evidence| root_loss_evidence_name(evidence).to_owned()),
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsRootRecoveryResult {
    pub attachment: String,
    pub reason: Option<String>,
    pub previous_root_state: JsRootState,
    pub candidate_identity: Option<JsRootIdentity>,
    pub current_root_state: JsRootState,
    pub exclusion_generation: u64,
    pub coverage: JsCoverage,
    pub boundary_sequence: Option<u64>,
}

impl From<RootRecoveryResult> for JsRootRecoveryResult {
    fn from(result: RootRecoveryResult) -> Self {
        Self {
            attachment: root_recovery_attachment_name(result.attachment).to_owned(),
            reason: result
                .reason
                .map(|reason| root_recovery_failure_name(reason).to_owned()),
            previous_root_state: result.previous_root_state.into(),
            candidate_identity: result.candidate_identity.map(Into::into),
            current_root_state: result.current_root_state.into(),
            exclusion_generation: result.exclusion_generation,
            coverage: JsCoverage::from(&result.coverage),
            boundary_sequence: result.boundary_sequence,
        }
    }
}

impl From<ReconciliationResult> for JsReconciliationResult {
    fn from(result: ReconciliationResult) -> Self {
        Self {
            exclusion_generation: result.exclusion_generation,
            coverage: JsCoverage::from(&result.coverage),
        }
    }
}

impl From<ChangeBatch> for JsChangeBatch {
    fn from(batch: ChangeBatch) -> Self {
        Self {
            sequence: batch.sequence,
            exclusion_generation: batch.exclusion_generation,
            root_state: batch.root_state.into(),
            invalidated_paths: batch
                .invalidated_paths
                .iter()
                .map(|path| Buffer::from(path.as_os_str().as_bytes().to_vec()))
                .collect(),
            coverage: JsCoverage::from(&batch.coverage),
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsStats {
    pub watched_directories: u32,
    pub deferred_directories: u32,
    pub raw_events: u64,
    pub batches_delivered: u64,
    pub batches_dropped: u64,
    pub topology_scans: u64,
    pub overflow_events: u64,
    pub callback_errors: u64,
    pub bridge_delivery_errors: u64,
    pub disposed: bool,
}

impl JsStats {
    fn from_engine(stats: Stats, callback_errors: u64, bridge_delivery_errors: u64) -> Self {
        Self {
            watched_directories: saturating_u32(stats.watched_directories),
            deferred_directories: saturating_u32(stats.deferred_directories),
            raw_events: stats.raw_events,
            batches_delivered: stats.batches_delivered,
            batches_dropped: stats.batches_dropped,
            topology_scans: stats.topology_scans,
            overflow_events: stats.overflow_events,
            callback_errors,
            bridge_delivery_errors,
            disposed: stats.disposed,
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsRuntimeStats {
    pub active: bool,
    pub inotify_instances: u32,
    pub worker_threads: u32,
    pub native_watches: u32,
    pub native_watch_budget: Option<u32>,
    pub deferred_interests: u32,
    pub subscriptions: u32,
}

impl From<RuntimeStats> for JsRuntimeStats {
    fn from(stats: RuntimeStats) -> Self {
        Self {
            active: stats.inotify_instances != 0,
            inotify_instances: saturating_u32(stats.inotify_instances),
            worker_threads: saturating_u32(stats.worker_threads),
            native_watches: saturating_u32(stats.native_watches),
            native_watch_budget: stats.native_watch_budget.map(saturating_u32),
            deferred_interests: saturating_u32(stats.deferred_interests),
            subscriptions: saturating_u32(stats.subscriptions),
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsSubscriptionDefaults {
    pub watch_limit: Option<u32>,
    pub batch_window_ms: u32,
    pub max_batch_paths: u32,
    pub output_queue_capacity: u32,
}

impl From<SubscriptionOptions> for JsSubscriptionDefaults {
    fn from(options: SubscriptionOptions) -> Self {
        Self {
            watch_limit: options.watch_limit.map(saturating_u32),
            batch_window_ms: u32::try_from(options.batch_window.as_millis())
                .expect("the Rust default batch window must fit in u32 milliseconds"),
            max_batch_paths: saturating_u32(options.max_batch_paths),
            output_queue_capacity: saturating_u32(options.output_queue_capacity),
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct JsCapabilities {
    pub schema_version: u32,
    pub recursive: bool,
    pub moved_in_tree_discovery: bool,
    pub explicit_watch_limits: bool,
    pub overflow_reporting: bool,
    pub initial_exclusions: bool,
    pub dynamic_exclusions: bool,
    pub directory_name_exclusions: bool,
    pub observed_excluded_paths: bool,
    pub reconciliation: bool,
    pub root_replacement_recovery: bool,
    pub exact_path_bytes: bool,
    pub process_native_watch_budget: bool,
    pub shared_native_watches: bool,
    pub cancellable_establishment: bool,
    pub shared_node_delivery: bool,
    pub native_callback_queue_capacity: u32,
    pub delivery_dispatcher_scope: String,
    pub delivery_admission: String,
    pub callback_completion: String,
    pub callback_max_in_flight: u32,
    pub callback_error_policy: String,
    pub callback_disposal_policy: String,
    pub callback_teardown_policy: String,
    pub delivery_dispatcher_work_quantum: u32,
    pub delivery_dispatcher_poll_milliseconds: u32,
    pub subscription_defaults: JsSubscriptionDefaults,
    pub positive_integer_minimum: u32,
    pub positive_integer_maximum: u32,
}

#[napi]
pub fn capabilities() -> JsCapabilities {
    let capabilities = Engine::new().capabilities();
    JsCapabilities {
        schema_version: CAPABILITY_SCHEMA_VERSION,
        recursive: capabilities.recursive,
        moved_in_tree_discovery: capabilities.moved_in_tree_discovery,
        explicit_watch_limits: capabilities.explicit_watch_limits,
        overflow_reporting: capabilities.overflow_reporting,
        initial_exclusions: capabilities.initial_exclusions,
        dynamic_exclusions: capabilities.dynamic_exclusions,
        directory_name_exclusions: capabilities.directory_name_exclusions,
        observed_excluded_paths: capabilities.observed_excluded_paths,
        reconciliation: capabilities.reconciliation,
        root_replacement_recovery: capabilities.root_replacement_recovery,
        exact_path_bytes: true,
        process_native_watch_budget: capabilities.process_native_watch_budget,
        shared_native_watches: capabilities.shared_native_watches,
        cancellable_establishment: true,
        shared_node_delivery: true,
        native_callback_queue_capacity: 1,
        delivery_dispatcher_scope: "node-environment".to_owned(),
        delivery_admission: "single-credit".to_owned(),
        callback_completion: "wrapper-acknowledged-promise-settlement".to_owned(),
        callback_max_in_flight: 1,
        callback_error_policy: "count-and-continue".to_owned(),
        callback_disposal_policy: "join-pending-completion".to_owned(),
        callback_teardown_policy: "abandon-pending-completion".to_owned(),
        delivery_dispatcher_work_quantum: delivery::DISPATCHER_WORK_QUANTUM as u32,
        delivery_dispatcher_poll_milliseconds: delivery::DISPATCHER_POLL_MILLISECONDS,
        subscription_defaults: SubscriptionOptions::default().into(),
        positive_integer_minimum: 1,
        positive_integer_maximum: u32::MAX,
    }
}

#[napi(object, object_from_js = false)]
pub struct JsDeliveryDiagnostics {
    pub dispatcher_environments: u32,
    pub dispatcher_threads: u32,
    pub registrations: u32,
    pub outstanding_callbacks: u32,
    pub cleanup_coordinator_threads: u32,
    pub cleanup_requests: u32,
    pub active_threadsafe_functions: u32,
    pub environment_generations: u64,
}

#[napi]
pub fn delivery_diagnostics() -> JsDeliveryDiagnostics {
    let diagnostics = delivery::diagnostics();
    JsDeliveryDiagnostics {
        dispatcher_environments: saturating_u32(diagnostics.dispatcher_environments),
        dispatcher_threads: saturating_u32(diagnostics.dispatcher_threads),
        registrations: saturating_u32(diagnostics.registrations),
        outstanding_callbacks: saturating_u32(diagnostics.outstanding_callbacks),
        cleanup_coordinator_threads: saturating_u32(diagnostics.cleanup_coordinator_threads),
        cleanup_requests: saturating_u32(diagnostics.cleanup_requests),
        active_threadsafe_functions: saturating_u32(diagnostics.active_threadsafe_functions),
        environment_generations: diagnostics.environment_generations,
    }
}

#[napi(js_name = "__watchboundTestOnlySynchronizeDispatcher")]
pub fn synchronize_dispatcher_test(env: Env) -> Result<()> {
    let environment = delivery::environment_for(&env).map_err(|error| sync_error(&env, error))?;
    environment
        .synchronize_dispatcher_entry()
        .map_err(|error| sync_error(&env, error))
}

#[napi]
pub fn complete_delivery(
    env: Env,
    delivery_id: BigInt,
    callback_error: bool,
    stop: bool,
) -> Result<bool> {
    let (negative, delivery_id, lossless) = delivery_id.get_u64();
    if negative || !lossless || delivery_id == 0 {
        return Err(sync_error(
            &env,
            NodeErrorDetails::new(
                ErrorCode::InvalidArgument,
                Operation::DeliverBatch,
                "deliveryId must be a positive bigint",
            ),
        ));
    }
    let environment = delivery::environment_for(&env).map_err(|error| sync_error(&env, error))?;
    Ok(delivery::complete_delivery(
        environment.id(),
        delivery_id,
        callback_error,
        stop,
    ))
}

#[napi(object, object_from_js = false)]
pub struct JsBindingMetadata {
    pub schema_version: u32,
    pub binding_api_version: u32,
    pub native_version: String,
    pub engine_version: String,
    pub node_api_version: u32,
    pub target_triple: String,
    pub build_profile: String,
}

#[napi]
pub fn binding_metadata() -> JsBindingMetadata {
    JsBindingMetadata {
        schema_version: 1,
        binding_api_version: BINDING_API_VERSION,
        native_version: env!("CARGO_PKG_VERSION").to_owned(),
        engine_version: VERSION.to_owned(),
        node_api_version: NODE_API_VERSION,
        target_triple: env!("WATCHBOUND_TARGET_TRIPLE").to_owned(),
        build_profile: env!("WATCHBOUND_BUILD_PROFILE").to_owned(),
    }
}

#[napi]
pub struct NativeEngine {
    engine: Engine,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NodeAttemptPhase {
    Unbound,
    Bound,
    NodeReadyProvisional,
    PublicCommitted,
}

struct EstablishmentAttemptInner {
    phase: NodeAttemptPhase,
    cancel_requested: bool,
    handoff_ready: bool,
    state: Weak<SubscriptionState>,
}

struct EstablishmentAttempt {
    engine: EstablishmentCancellation,
    inner: Mutex<EstablishmentAttemptInner>,
}

impl EstablishmentAttempt {
    fn new() -> NodeResult<Self> {
        Ok(Self {
            engine: EstablishmentCancellation::new().map_err(NodeErrorDetails::from)?,
            inner: Mutex::new(EstablishmentAttemptInner {
                phase: NodeAttemptPhase::Unbound,
                cancel_requested: false,
                handoff_ready: false,
                state: Weak::new(),
            }),
        })
    }

    fn bind(&self) -> NodeResult<()> {
        let mut inner = lock_unpoisoned(&self.inner);
        if inner.phase != NodeAttemptPhase::Unbound {
            return Err(NodeErrorDetails::new(
                ErrorCode::InvalidArgument,
                Operation::Subscribe,
                "establishment cancellation token is already bound to a subscription attempt",
            ));
        }
        inner.phase = NodeAttemptPhase::Bound;
        Ok(())
    }

    fn cancel(&self) {
        self.cancel_with_delivery_close(true);
    }

    fn cancel_without_delivery_close(&self) {
        self.cancel_with_delivery_close(false);
    }

    fn cancel_with_delivery_close(&self, close_delivery: bool) {
        let state = {
            let mut inner = lock_unpoisoned(&self.inner);
            if inner.phase == NodeAttemptPhase::PublicCommitted || inner.cancel_requested {
                return;
            }
            inner.cancel_requested = true;
            inner.state.upgrade()
        };
        self.engine.cancel();
        if close_delivery && let Some(state) = state {
            state.close_delivery_admission();
        }
    }

    fn cancellation_requested(&self) -> bool {
        lock_unpoisoned(&self.inner).cancel_requested
    }

    fn attach_provisional_state(&self, state: &Arc<SubscriptionState>) -> bool {
        let mut inner = lock_unpoisoned(&self.inner);
        debug_assert_eq!(inner.phase, NodeAttemptPhase::Bound);
        inner.state = Arc::downgrade(state);
        !inner.cancel_requested
    }

    fn note_node_ready(&self, auto_commit: bool) -> bool {
        let mut inner = lock_unpoisoned(&self.inner);
        debug_assert_eq!(inner.phase, NodeAttemptPhase::Bound);
        inner.phase = if auto_commit && !inner.cancel_requested {
            NodeAttemptPhase::PublicCommitted
        } else {
            NodeAttemptPhase::NodeReadyProvisional
        };
        !inner.cancel_requested
    }

    fn mark_handoff_ready(&self) {
        let mut inner = lock_unpoisoned(&self.inner);
        if inner.phase == NodeAttemptPhase::NodeReadyProvisional {
            inner.handoff_ready = true;
        }
    }

    fn commit_public_success(&self) -> NodeResult<bool> {
        let mut inner = lock_unpoisoned(&self.inner);
        match inner.phase {
            NodeAttemptPhase::NodeReadyProvisional => {
                if !inner.handoff_ready {
                    Err(NodeErrorDetails::new(
                        ErrorCode::InvalidArgument,
                        Operation::Subscribe,
                        "establishment success has not reached the native handoff",
                    ))
                } else if inner.cancel_requested {
                    Ok(false)
                } else {
                    inner.phase = NodeAttemptPhase::PublicCommitted;
                    Ok(true)
                }
            }
            NodeAttemptPhase::PublicCommitted => Ok(true),
            NodeAttemptPhase::Unbound | NodeAttemptPhase::Bound => Err(NodeErrorDetails::new(
                ErrorCode::InvalidArgument,
                Operation::Subscribe,
                "establishment success is not ready to be publicly committed",
            )),
        }
    }
}

#[napi]
pub struct NativeEstablishmentCancellation {
    attempt: Arc<EstablishmentAttempt>,
}

#[napi]
impl NativeEstablishmentCancellation {
    #[napi]
    pub fn cancel(&self) {
        self.attempt.cancel();
    }

    #[napi]
    pub fn commit_public_success(&self, env: Env) -> Result<bool> {
        self.attempt
            .commit_public_success()
            .map_err(|error| sync_error(&env, error))
    }
}

#[napi]
pub fn create_establishment_cancellation(env: Env) -> Result<NativeEstablishmentCancellation> {
    Ok(NativeEstablishmentCancellation {
        attempt: Arc::new(EstablishmentAttempt::new().map_err(|error| sync_error(&env, error))?),
    })
}

struct ThreadpoolTestBlockerState {
    started: AtomicBool,
    released: Mutex<bool>,
    changed: Condvar,
}

#[napi(js_name = "__WatchboundTestOnlyThreadpoolBlocker")]
pub struct TestOnlyThreadpoolBlocker {
    state: Arc<ThreadpoolTestBlockerState>,
}

#[napi]
impl TestOnlyThreadpoolBlocker {
    #[napi(getter)]
    pub fn started(&self) -> bool {
        self.state.started.load(Ordering::Acquire)
    }

    #[napi]
    pub fn block(&self) -> AsyncTask<ThreadpoolBlockTask> {
        AsyncTask::new(ThreadpoolBlockTask {
            state: Arc::clone(&self.state),
        })
    }

    #[napi]
    pub fn release(&self) {
        *lock_unpoisoned(&self.state.released) = true;
        self.state.changed.notify_all();
    }
}

pub struct ThreadpoolBlockTask {
    state: Arc<ThreadpoolTestBlockerState>,
}

impl Task for ThreadpoolBlockTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        self.state.started.store(true, Ordering::Release);
        let mut released = lock_unpoisoned(&self.state.released);
        while !*released {
            released = self
                .state
                .changed
                .wait(released)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

#[napi(js_name = "__watchboundTestOnlyCreateThreadpoolBlocker")]
pub fn create_threadpool_test_blocker() -> TestOnlyThreadpoolBlocker {
    TestOnlyThreadpoolBlocker {
        state: Arc::new(ThreadpoolTestBlockerState {
            started: AtomicBool::new(false),
            released: Mutex::new(false),
            changed: Condvar::new(),
        }),
    }
}

#[napi]
impl NativeEngine {
    #[napi(getter)]
    pub fn native_watch_budget(&self) -> Option<u32> {
        self.engine.native_watch_budget().map(saturating_u32)
    }

    #[napi]
    pub fn runtime_stats(&self) -> JsRuntimeStats {
        self.engine.runtime_stats().into()
    }

    #[napi]
    pub fn create_establishment_cancellation(
        &self,
        env: Env,
    ) -> Result<NativeEstablishmentCancellation> {
        create_establishment_cancellation(env)
    }

    #[napi(ts_return_type = "Promise<NativeSubscription>")]
    pub fn subscribe(
        &self,
        env: Env,
        root: String,
        options: Option<JsSubscriptionOptions>,
        callback: Function<'_, FnArgs<(JsChangeBatch, BigInt)>, bool>,
        cancellation: Option<&NativeEstablishmentCancellation>,
    ) -> Result<AsyncTask<SubscribeTask>> {
        prepare_subscribe(env, self.engine, root, options, callback, cancellation)
    }
}

#[napi]
pub fn create_engine(env: Env, options: Option<JsEngineOptions>) -> Result<NativeEngine> {
    let engine = options
        .map(JsEngineOptions::into_engine)
        .transpose()
        .map_err(|error| sync_error(&env, error))?
        .unwrap_or_default();
    Ok(NativeEngine { engine })
}

fn resolve_root(root: String) -> NodeResult<PathBuf> {
    let root = PathBuf::from(root);
    if root.is_absolute() {
        Ok(root)
    } else {
        std::env::current_dir()
            .map(|current_dir| current_dir.join(root))
            .map_err(|error| {
                NodeErrorDetails::from_io(
                    ErrorCode::RootUnavailable,
                    Operation::Subscribe,
                    "current working directory is unavailable",
                    &error,
                )
            })
    }
}

#[napi(ts_return_type = "Promise<NativeSubscription>")]
pub fn subscribe(
    env: Env,
    root: String,
    options: Option<JsSubscriptionOptions>,
    callback: Function<'_, FnArgs<(JsChangeBatch, BigInt)>, bool>,
    cancellation: Option<&NativeEstablishmentCancellation>,
) -> Result<AsyncTask<SubscribeTask>> {
    prepare_subscribe(env, Engine::new(), root, options, callback, cancellation)
}

fn prepare_subscribe(
    env: Env,
    engine: Engine,
    root: String,
    options: Option<JsSubscriptionOptions>,
    callback: Function<'_, FnArgs<(JsChangeBatch, BigInt)>, bool>,
    cancellation: Option<&NativeEstablishmentCancellation>,
) -> Result<AsyncTask<SubscribeTask>> {
    let root = resolve_root(root).map_err(|error| sync_error(&env, error))?;
    let options = options
        .map(JsSubscriptionOptions::into_engine_options)
        .transpose()
        .map_err(|error| sync_error(&env, error))?
        .unwrap_or_default();
    let externally_committed = cancellation.is_some();
    let attempt = match cancellation {
        Some(cancellation) => Arc::clone(&cancellation.attempt),
        None => Arc::new(EstablishmentAttempt::new().map_err(|error| sync_error(&env, error))?),
    };
    attempt.bind().map_err(|error| sync_error(&env, error))?;
    if attempt.cancellation_requested() {
        return Err(sync_error(
            &env,
            NodeErrorDetails::new(
                ErrorCode::OperationCancelled,
                Operation::Subscribe,
                "subscription establishment was cancelled",
            ),
        ));
    }
    let shutdown = Arc::new(ShutdownGate::new(Arc::clone(&attempt)));
    let environment = delivery::environment_for(&env).map_err(|error| sync_error(&env, error))?;
    let delivery = delivery::DeliveryState::new(&environment);
    let cleanup_registration = environment
        .register(&shutdown)
        .map_err(|error| sync_error(&env, error))?;
    let threadsafe_function =
        match delivery::RawBatchThreadsafeFunction::new(&env, &callback, &delivery) {
            Ok(threadsafe_function) => Arc::new(threadsafe_function),
            Err(error) => {
                drop(cleanup_registration);
                let cleanup_result = environment.join_dispatcher_if_inactive();
                return Err(sync_error(&env, cleanup_result.err().unwrap_or(error)));
            }
        };
    // Attachment and environment teardown share the admission barrier. A
    // forced embedding teardown therefore either observes this bridge or wins
    // first and makes this path release the unobserved bridge itself.
    if let Err(error) = cleanup_registration.attach_threadsafe_function(&threadsafe_function) {
        delivery.close_admission();
        drop(cleanup_registration);
        let release_status = threadsafe_function.release(true);
        drop(threadsafe_function);
        let release_result = if release_status == Status::Ok || release_status == Status::Closing {
            Ok(())
        } else {
            Err(NodeErrorDetails::from_napi_status(
                ErrorCode::Internal,
                Operation::Subscribe,
                release_status,
                "unattached Node callback bridge could not be released",
            ))
        };
        // An interrupted environment is already draining Node-API resources,
        // so waiting for its JavaScript-thread finalizer here would deadlock.
        let dispatcher_result = environment.join_dispatcher_if_inactive();
        return Err(sync_error(
            &env,
            release_result.and(dispatcher_result).err().unwrap_or(error),
        ));
    }

    Ok(AsyncTask::new(SubscribeTask {
        engine,
        root,
        options,
        threadsafe_function: Some(threadsafe_function),
        delivery,
        shutdown,
        attempt,
        auto_commit: !externally_committed,
        cleanup_registration: Some(cleanup_registration),
    }))
}

pub struct SubscribeTask {
    engine: Engine,
    root: PathBuf,
    options: SubscriptionOptions,
    threadsafe_function: Option<Arc<delivery::RawBatchThreadsafeFunction>>,
    delivery: Arc<delivery::DeliveryState>,
    shutdown: Arc<ShutdownGate>,
    attempt: Arc<EstablishmentAttempt>,
    auto_commit: bool,
    cleanup_registration: Option<delivery::EnvironmentRegistration>,
}

impl SubscribeTask {
    fn cleanup_unpublished_delivery(&mut self) -> NodeResult<()> {
        self.delivery.close_admission();
        self.shutdown.signal();

        let environment = self
            .cleanup_registration
            .as_ref()
            .map(delivery::EnvironmentRegistration::environment);
        // Removing the pending registration first lets the shared dispatcher
        // stop while the thread-safe function's main-loop finalizer runs.
        self.cleanup_registration.take();

        let release_result = self.threadsafe_function.take().map_or(Ok(()), |bridge| {
            let status = bridge.release(true);
            if status == Status::Ok {
                // This compute method runs on libuv, so the JavaScript thread
                // remains free to execute the Node-API finalizer. Promise
                // rejection is not published until that finalizer has run.
                self.delivery.wait_until_finalized_or_environment_closing();
            }
            if status == Status::Ok || status == Status::Closing {
                Ok(())
            } else {
                Err(NodeErrorDetails::from_napi_status(
                    ErrorCode::Internal,
                    Operation::Subscribe,
                    status,
                    "pending Node callback bridge could not be released",
                ))
            }
        });
        let dispatcher_result = environment.map_or(Ok(()), |environment| {
            environment.join_dispatcher_if_inactive()
        });
        release_result.and(dispatcher_result)
    }
}

impl Task for SubscribeTask {
    type Output = TaskOutcome<Arc<SubscriptionState>>;
    type JsValue = NativeSubscription;

    fn compute(&mut self) -> Result<Self::Output> {
        let outcome = (|| {
            if self.shutdown.stop.load(Ordering::Acquire) {
                return Err(NodeErrorDetails::new(
                    ErrorCode::OperationInterrupted,
                    Operation::Subscribe,
                    "Node environment teardown interrupted subscription setup",
                ));
            }
            let pending = match self.engine.begin_subscribe_with_cancellation(
                &self.root,
                self.options.clone(),
                self.attempt.engine.clone(),
            ) {
                Ok(pending) => pending,
                Err(error)
                    if self.shutdown.environment_closing.load(Ordering::Acquire)
                        && error.code() == ErrorCode::OperationCancelled =>
                {
                    return Err(NodeErrorDetails::operation_interrupted(
                        Operation::Subscribe,
                        "Node environment teardown interrupted subscription setup",
                    ));
                }
                Err(error) => return Err(NodeErrorDetails::from(error)),
            };
            let subscription = match pending.wait() {
                Ok(subscription) => subscription,
                Err(error)
                    if self.shutdown.environment_closing.load(Ordering::Acquire)
                        && error.code() == ErrorCode::OperationCancelled =>
                {
                    return Err(NodeErrorDetails::operation_interrupted(
                        Operation::Subscribe,
                        "Node environment teardown interrupted subscription setup",
                    ));
                }
                Err(error) => return Err(NodeErrorDetails::from(error)),
            };
            if self.shutdown.stop.load(Ordering::Acquire) {
                subscription.dispose().map_err(NodeErrorDetails::from)?;
                return Err(NodeErrorDetails::new(
                    ErrorCode::OperationInterrupted,
                    Operation::Subscribe,
                    "Node environment teardown interrupted subscription setup",
                ));
            }
            if self.attempt.cancellation_requested() {
                subscription.dispose().map_err(NodeErrorDetails::from)?;
                return Err(NodeErrorDetails::new(
                    ErrorCode::OperationCancelled,
                    Operation::Subscribe,
                    "subscription establishment was cancelled",
                ));
            }
            if self.threadsafe_function.is_none() {
                return Err(NodeErrorDetails::new(
                    ErrorCode::Internal,
                    Operation::Subscribe,
                    "subscribe task callback bridge was already consumed",
                ));
            }
            if self.cleanup_registration.is_none() {
                return Err(NodeErrorDetails::new(
                    ErrorCode::Internal,
                    Operation::Subscribe,
                    "subscribe task cleanup registration was already consumed",
                ));
            }
            let threadsafe_function = self.threadsafe_function.take().ok_or_else(|| {
                NodeErrorDetails::new(
                    ErrorCode::Internal,
                    Operation::Subscribe,
                    "subscribe task callback bridge was already consumed",
                )
            })?;
            let cleanup_registration = self.cleanup_registration.take().ok_or_else(|| {
                NodeErrorDetails::new(
                    ErrorCode::Internal,
                    Operation::Subscribe,
                    "subscribe task cleanup registration was already consumed",
                )
            })?;
            let state = SubscriptionState::start(
                subscription,
                threadsafe_function,
                Arc::clone(&self.delivery),
                Arc::clone(&self.shutdown),
                cleanup_registration,
            );
            let may_publish = self.attempt.attach_provisional_state(&state);
            if may_publish {
                if let Err(error) = state.publish_delivery() {
                    let cleanup_result = state.dispose_join_and_drain();
                    return match cleanup_result {
                        Ok(()) => Err(error),
                        Err(cleanup_error) => Err(cleanup_error),
                    };
                }
            } else {
                state.close_delivery_admission();
            }
            let ready = self.attempt.note_node_ready(self.auto_commit);
            if !ready {
                state.close_delivery_admission();
            }
            Ok(state)
        })();
        if outcome.is_err()
            && (self.threadsafe_function.is_some() || self.cleanup_registration.is_some())
            && let Err(cleanup_error) = self.cleanup_unpublished_delivery()
        {
            return Ok(Err(cleanup_error));
        }
        Ok(outcome)
    }

    fn resolve(&mut self, env: Env, state: Self::Output) -> Result<Self::JsValue> {
        let state = task_result(&env, state)?;
        self.attempt.mark_handoff_ready();
        Ok(NativeSubscription {
            state,
            dispose_promise: Mutex::new(None),
        })
    }
}

#[napi(custom_finalize)]
pub struct NativeSubscription {
    state: Arc<SubscriptionState>,
    dispose_promise: Mutex<Option<DisposePromiseReference>>,
}

#[napi(object)]
pub struct JsExclusionPolicy {
    pub prefixes: Option<Vec<Buffer>>,
    pub excluded_directory_names: Option<Vec<Buffer>>,
    pub observed_excluded_paths: Option<Vec<Buffer>>,
}

impl JsExclusionPolicy {
    fn into_engine_policy(self) -> ExclusionPolicy {
        ExclusionPolicy {
            prefixes: self
                .prefixes
                .unwrap_or_default()
                .into_iter()
                .map(|prefix| PathBuf::from(std::ffi::OsString::from_vec(prefix.to_vec())))
                .collect(),
            excluded_directory_names: self
                .excluded_directory_names
                .unwrap_or_default()
                .into_iter()
                .map(|name| std::ffi::OsString::from_vec(name.to_vec()))
                .collect(),
            observed_excluded_paths: self
                .observed_excluded_paths
                .unwrap_or_default()
                .into_iter()
                .map(|path| PathBuf::from(std::ffi::OsString::from_vec(path.to_vec())))
                .collect(),
        }
    }
}

#[napi]
impl NativeSubscription {
    #[napi(getter)]
    pub fn initial_coverage(&self) -> JsCoverage {
        JsCoverage::from(&self.state.initial_coverage)
    }

    #[napi(getter)]
    pub fn initial_root_state(&self) -> JsRootState {
        self.state.initial_root_state.into()
    }

    #[napi]
    pub fn stats(&self) -> JsStats {
        let stats = self.state.stats.stats();
        JsStats::from_engine(
            stats,
            self.state.delivery.callback_errors(),
            self.state.delivery.bridge_delivery_errors(),
        )
    }

    #[napi(getter)]
    pub fn exclusion_generation(&self) -> u64 {
        self.state.exclusions.exclusion_generation()
    }

    #[napi(getter)]
    pub fn root_state(&self) -> JsRootState {
        self.state.root_state.root_state().into()
    }

    #[napi(ts_return_type = "Promise<JsCoverage>")]
    pub fn replace_exclusions(
        &self,
        env: Env,
        generation: BigInt,
        policy: Either<Vec<Buffer>, JsExclusionPolicy>,
    ) -> Result<AsyncTask<ReplaceExclusionsTask>> {
        let (negative, generation, lossless) = generation.get_u64();
        if negative || !lossless {
            return Err(sync_error(
                &env,
                NodeErrorDetails::new(
                    ErrorCode::InvalidArgument,
                    Operation::ReplaceExclusions,
                    "generation must be a non-negative bigint no greater than u64::MAX",
                ),
            ));
        }
        Ok(AsyncTask::new(ReplaceExclusionsTask {
            exclusions: self.state.exclusions.clone(),
            generation,
            policy: match policy {
                Either::A(prefixes) => JsExclusionPolicy {
                    prefixes: Some(prefixes),
                    excluded_directory_names: None,
                    observed_excluded_paths: None,
                }
                .into_engine_policy(),
                Either::B(policy) => policy.into_engine_policy(),
            },
        }))
    }

    #[napi(ts_return_type = "Promise<JsReconciliationResult>")]
    pub fn reconcile(&self) -> AsyncTask<ReconcileTask> {
        AsyncTask::new(ReconcileTask {
            reconciliation: self.state.reconciliation.clone(),
        })
    }

    #[napi(ts_return_type = "Promise<JsRootRecoveryResult>")]
    pub fn recover_root(
        &self,
        env: Env,
        identity_policy: String,
    ) -> Result<AsyncTask<RecoverRootTask>> {
        let identity_policy = match identity_policy.as_str() {
            "original-only" => RootIdentityPolicy::OriginalOnly,
            "accept-replacement" => RootIdentityPolicy::AcceptReplacement,
            _ => {
                return Err(sync_error(
                    &env,
                    NodeErrorDetails::new(
                        ErrorCode::InvalidArgument,
                        Operation::RecoverRoot,
                        "identityPolicy must be \"original-only\" or \"accept-replacement\"",
                    ),
                ));
            }
        };
        Ok(AsyncTask::new(RecoverRootTask {
            recovery: self.state.root_recovery.clone(),
            identity_policy,
        }))
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn dispose(&self, env: Env) -> Result<PromiseRaw<'static, ()>> {
        let mut cached = lock_unpoisoned(&self.dispose_promise);
        if let Some(cached) = cached.as_ref() {
            return cached.get(&env).map_err(|error| sync_error(&env, error));
        }

        // Preserve the synchronous admission barrier of the former AsyncTask
        // path: no new callback may be admitted while Promise resources are
        // being allocated for this disposal request.
        self.state.close_delivery_admission();
        let (completion, promise) = dispose_completion::RawDisposeCompletion::new(&env)
            .map_err(|error| sync_error(&env, error))?;
        let reference = DisposePromiseReference::new(&env, promise.raw())
            .map_err(|error| sync_error(&env, error))?;
        *cached = Some(reference);
        self.state.begin_explicit_disposal(completion);
        Ok(promise)
    }
}

impl ObjectFinalize for NativeSubscription {
    fn finalize(self, env: Env) -> Result<()> {
        if let Some(reference) = lock_unpoisoned(&self.dispose_promise).take() {
            reference.release(&env);
        }
        Ok(())
    }
}

impl Drop for NativeSubscription {
    fn drop(&mut self) {
        if self.state.cleanup_finished() {
            return;
        }
        // A collected JavaScript subscription without an explicit joiner must
        // not let a never-settling user promise retain native watcher state.
        // Once dispose() has returned its Promise, however, receiver GC cannot
        // weaken that Promise's joined callback-completion guarantee.
        if !self.state.explicit_disposal_requested() {
            self.state.delivery.abandon_in_flight();
        }
        self.state.request_background_cleanup();
    }
}

pub struct ReplaceExclusionsTask {
    exclusions: ExclusionHandle,
    generation: u64,
    policy: ExclusionPolicy,
}

pub struct ReconcileTask {
    reconciliation: ReconciliationHandle,
}

pub struct RecoverRootTask {
    recovery: RootRecoveryHandle,
    identity_policy: RootIdentityPolicy,
}

impl Task for ReplaceExclusionsTask {
    type Output = TaskOutcome<Coverage>;
    type JsValue = JsCoverage;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self
            .exclusions
            .replace_exclusion_policy(self.generation, std::mem::take(&mut self.policy))
            .map_err(NodeErrorDetails::from))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        let output = task_result(&env, output)?;
        Ok(JsCoverage::from(&output))
    }
}

impl Task for ReconcileTask {
    type Output = TaskOutcome<ReconciliationResult>;
    type JsValue = JsReconciliationResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self
            .reconciliation
            .reconcile()
            .map_err(NodeErrorDetails::from))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(task_result(&env, output)?.into())
    }
}

impl Task for RecoverRootTask {
    type Output = TaskOutcome<RootRecoveryResult>;
    type JsValue = JsRootRecoveryResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self
            .recovery
            .recover_root(self.identity_policy)
            .map_err(NodeErrorDetails::from))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(task_result(&env, output)?.into())
    }
}

pub struct SubscriptionState {
    initial_coverage: Coverage,
    initial_root_state: RootState,
    stats: StatsHandle,
    exclusions: ExclusionHandle,
    reconciliation: ReconciliationHandle,
    root_state: RootStateHandle,
    root_recovery: RootRecoveryHandle,
    subscription: Arc<Subscription>,
    threadsafe_function: Arc<delivery::RawBatchThreadsafeFunction>,
    delivery: Arc<delivery::DeliveryState>,
    environment: Arc<delivery::EnvironmentRecord>,
    shutdown: Arc<ShutdownGate>,
    explicit_disposal_requested: AtomicBool,
    dispose_completion: Mutex<Option<Arc<dispose_completion::RawDisposeCompletion>>>,
    cleanup_started: AtomicBool,
    cleanup_finalizing: AtomicBool,
    cleanup_requested: AtomicBool,
    cleanup_engine_result: Mutex<Option<NodeResult<()>>>,
    cleanup_coordination_error: Mutex<Option<NodeErrorDetails>>,
    cleanup_result: Mutex<Option<NodeResult<()>>>,
    cleanup_condition: Condvar,
    cleanup_registration: Mutex<Option<delivery::EnvironmentRegistration>>,
}

impl SubscriptionState {
    fn start(
        subscription: Subscription,
        threadsafe_function: Arc<delivery::RawBatchThreadsafeFunction>,
        delivery: Arc<delivery::DeliveryState>,
        shutdown: Arc<ShutdownGate>,
        cleanup_registration: delivery::EnvironmentRegistration,
    ) -> Arc<Self> {
        let initial_coverage = subscription.initial_coverage().clone();
        let initial_root_state = *subscription.initial_root_state();
        let stats = subscription.stats_handle();
        let exclusions = subscription.exclusion_handle();
        let reconciliation = subscription.reconciliation_handle();
        let root_state = subscription.root_state_handle();
        let root_recovery = subscription.root_recovery_handle();
        let environment = cleanup_registration.environment();
        let subscription = Arc::new(subscription);
        let state = Arc::new(Self {
            initial_coverage,
            initial_root_state,
            stats,
            exclusions,
            reconciliation,
            root_state,
            root_recovery,
            subscription,
            threadsafe_function,
            delivery,
            environment,
            shutdown,
            explicit_disposal_requested: AtomicBool::new(false),
            dispose_completion: Mutex::new(None),
            cleanup_started: AtomicBool::new(false),
            cleanup_finalizing: AtomicBool::new(false),
            cleanup_requested: AtomicBool::new(false),
            cleanup_engine_result: Mutex::new(None),
            cleanup_coordination_error: Mutex::new(None),
            cleanup_result: Mutex::new(None),
            cleanup_condition: Condvar::new(),
            cleanup_registration: Mutex::new(Some(cleanup_registration)),
        });
        state.delivery.attach_state(&state);
        state
    }

    fn mark_explicit_disposal_requested(&self) {
        self.explicit_disposal_requested
            .store(true, Ordering::Release);
    }

    fn explicit_disposal_requested(&self) -> bool {
        self.explicit_disposal_requested.load(Ordering::Acquire)
    }

    fn begin_explicit_disposal(
        self: &Arc<Self>,
        completion: Arc<dispose_completion::RawDisposeCompletion>,
    ) {
        self.mark_explicit_disposal_requested();
        let terminal_result = {
            let result = lock_unpoisoned(&self.cleanup_result);
            if let Some(result) = result.as_ref() {
                Some(result.clone())
            } else {
                *lock_unpoisoned(&self.dispose_completion) = Some(Arc::clone(&completion));
                None
            }
        };
        if let Some(result) = terminal_result {
            completion.complete(Arc::clone(&self.environment), result);
        } else {
            self.request_background_cleanup();
        }
    }

    fn publish_delivery(self: &Arc<Self>) -> NodeResult<()> {
        let publish_result = {
            let mut registration = lock_unpoisoned(&self.cleanup_registration);
            registration
                .as_mut()
                .expect("subscription registration was stored above")
                .publish(self)
        };
        publish_result?;
        Ok(())
    }

    fn dispose_join_and_drain(&self) -> NodeResult<()> {
        let owns_cleanup = self
            .cleanup_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        if !owns_cleanup {
            let cleanup_result = self.wait_for_cleanup();
            let dispatcher_result = self.environment.join_dispatcher_if_inactive();
            let coordinator_result = self.environment.join_cleanup_if_inactive();
            return cleanup_result
                .and(dispatcher_result)
                .and(coordinator_result);
        }

        self.perform_engine_cleanup(true);
        if !self.shutdown.environment_closing.load(Ordering::Acquire) {
            self.delivery.wait_until_drained_or_environment_closing();
        }
        self.finalize_cleanup();
        let cleanup_result = self.wait_for_cleanup();
        // Coordinator-failure assignment can race the first join while
        // background cleanup is handing ownership to an explicit disposer.
        // Finalization removes this registration, so these final joins cannot
        // be suppressed by a late marker for the disposed subscription.
        let dispatcher_result = self.environment.join_dispatcher_if_inactive();
        let coordinator_result = self.environment.join_cleanup_if_inactive();
        cleanup_result
            .and(dispatcher_result)
            .and(coordinator_result)
    }

    fn wait_for_cleanup(&self) -> NodeResult<()> {
        let mut result = lock_unpoisoned(&self.cleanup_result);
        while result.is_none() {
            result = self
                .cleanup_condition
                .wait(result)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        result
            .as_ref()
            .expect("cleanup result checked above")
            .clone()
    }

    fn cleanup_finished(&self) -> bool {
        lock_unpoisoned(&self.cleanup_result).is_some()
    }

    pub(crate) fn dispatch_one(self: &Arc<Self>) -> bool {
        if self.shutdown.stop.load(Ordering::Acquire) || !self.delivery.can_receive() {
            return false;
        }
        match self.subscription.try_recv() {
            Ok(batch) => self.delivery.try_admit(batch, &self.threadsafe_function),
            Err(std::sync::mpsc::TryRecvError::Empty) => false,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                self.request_background_cleanup();
                false
            }
        }
    }

    fn close_delivery_admission(&self) {
        self.delivery.close_admission();
        if let Some(registration) = lock_unpoisoned(&self.cleanup_registration).as_ref() {
            registration.deactivate();
        }
        self.environment.notify_dispatcher();
    }

    pub(crate) fn abort_delivery_for_environment(&self) {
        self.delivery.close_admission_with_barrier_held();
        let _ = self.threadsafe_function.release(true);
    }

    pub(crate) fn abort_dispose_completion_for_environment(&self) {
        if let Some(completion) = lock_unpoisoned(&self.dispose_completion).as_ref() {
            completion.abort();
        }
    }

    fn request_background_cleanup(self: &Arc<Self>) {
        self.delivery.close_admission();
        self.shutdown.signal();
        // Finalization removes this same registration. Keep its guard through
        // cleanup-thread coordination so an explicit disposer cannot publish
        // a terminal result between a spawn failure and storing that failure,
        // or let a late fallback assignment resurrect cleanup afterward.
        let registration = lock_unpoisoned(&self.cleanup_registration);
        let Some(registration) = registration.as_ref() else {
            return;
        };
        let retained = registration.begin_background_cleanup(self);
        if self
            .cleanup_requested
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            delivery::cleanup_request_started();
        }
        if retained || self.background_cleanup_requested() {
            let coordinator = self.environment.request_cleanup();
            match coordinator {
                Ok(()) => registration.coordinator_ready(),
                Err(error) => {
                    self.note_cleanup_coordination_error(error.clone());
                    registration.coordinator_failed(error);
                }
            }
        }
    }

    pub(crate) fn request_delivery_failure_cleanup(self: &Arc<Self>) {
        self.request_background_cleanup();
    }

    pub(crate) fn mark_environment_cleanup_requested(&self) {
        if self
            .cleanup_requested
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            delivery::cleanup_request_started();
        }
    }

    pub(crate) fn background_cleanup_requested(&self) -> bool {
        self.cleanup_requested.load(Ordering::Acquire) && !self.cleanup_finished()
    }

    pub(crate) fn note_cleanup_coordination_error(&self, error: NodeErrorDetails) {
        let mut stored = lock_unpoisoned(&self.cleanup_coordination_error);
        if stored.is_none() {
            *stored = Some(error);
        }
    }

    pub(crate) fn advance_background_cleanup(&self, join_dispatcher: bool) -> bool {
        if self.cleanup_finished() {
            return true;
        }
        if self
            .cleanup_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.perform_engine_cleanup(join_dispatcher);
        }
        if lock_unpoisoned(&self.cleanup_engine_result).is_none() {
            return false;
        }
        if !self.shutdown.environment_closing.load(Ordering::Acquire)
            && self.delivery.outstanding_callbacks() != 0
        {
            return false;
        }
        self.finalize_cleanup();
        self.cleanup_finished()
    }

    fn perform_engine_cleanup(&self, join_dispatcher: bool) {
        self.close_delivery_admission();
        self.shutdown.signal();
        let coordination_error = lock_unpoisoned(&self.cleanup_registration)
            .as_ref()
            .and_then(|registration| registration.prepare_engine_cleanup(join_dispatcher));
        if let Some(error) = coordination_error {
            self.note_cleanup_coordination_error(error);
        }
        let dispose_result = self.subscription.dispose().map_err(NodeErrorDetails::from);
        let dispatcher_result = if join_dispatcher {
            self.environment.join_dispatcher_if_inactive()
        } else {
            Ok(())
        };
        let result = dispose_result.and(dispatcher_result);
        *lock_unpoisoned(&self.cleanup_engine_result) = Some(result);
        self.cleanup_condition.notify_all();
    }

    fn finalize_cleanup(&self) {
        if self
            .cleanup_finalizing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let environment_closing = self.shutdown.environment_closing.load(Ordering::Acquire);
        let release_status = self.threadsafe_function.release(environment_closing);
        if release_status == Status::Ok {
            self.delivery.wait_until_finalized_or_environment_closing();
        }
        let mut result = lock_unpoisoned(&self.cleanup_engine_result)
            .clone()
            .unwrap_or_else(|| {
                Err(NodeErrorDetails::internal(
                    Operation::Dispose,
                    "Node cleanup finalized before engine disposal completed",
                ))
            });
        if release_status != Status::Ok && release_status != Status::Closing && result.is_ok() {
            result = Err(NodeErrorDetails::from_napi_status(
                ErrorCode::Internal,
                Operation::Dispose,
                release_status,
                "Node callback bridge could not be released",
            ));
        }
        result = cleanup_result_with_coordination_error(
            result,
            lock_unpoisoned(&self.cleanup_coordination_error).clone(),
        );
        result = cleanup_result_with_delivery_error(result, self.delivery.delivery_error());
        lock_unpoisoned(&self.cleanup_registration).take();
        let completion = {
            let mut cleanup_result = lock_unpoisoned(&self.cleanup_result);
            *cleanup_result = Some(result.clone());
            lock_unpoisoned(&self.dispose_completion).take()
        };
        if self.cleanup_requested.swap(false, Ordering::AcqRel) {
            delivery::cleanup_request_finished();
        }
        self.cleanup_condition.notify_all();
        self.environment.notify_dispatcher();
        if let Some(completion) = completion {
            completion.complete(Arc::clone(&self.environment), result);
        }
    }
}

struct DisposePromiseReference {
    raw: sys::napi_ref,
}

unsafe impl Send for DisposePromiseReference {}

impl DisposePromiseReference {
    fn new(env: &Env, promise: sys::napi_value) -> NodeResult<Self> {
        let mut raw = ptr::null_mut();
        let status = unsafe { sys::napi_create_reference(env.raw(), promise, 1, &mut raw) };
        if status != sys::Status::napi_ok {
            return Err(NodeErrorDetails::from_napi_status(
                ErrorCode::ResourceUnavailable,
                Operation::Dispose,
                Status::from(status),
                "Node disposal Promise reference could not be created",
            ));
        }
        Ok(Self { raw })
    }

    fn get(&self, env: &Env) -> NodeResult<PromiseRaw<'static, ()>> {
        let mut promise = ptr::null_mut();
        let status = unsafe { sys::napi_get_reference_value(env.raw(), self.raw, &mut promise) };
        if status != sys::Status::napi_ok {
            return Err(NodeErrorDetails::from_napi_status(
                ErrorCode::Internal,
                Operation::Dispose,
                Status::from(status),
                "Node disposal Promise reference could not be read",
            ));
        }
        Ok(PromiseRaw::new(env.raw(), promise))
    }

    fn release(self, env: &Env) {
        let _ = unsafe { sys::napi_delete_reference(env.raw(), self.raw) };
    }
}

fn cleanup_result_with_coordination_error(
    cleanup_result: NodeResult<()>,
    coordination_error: Option<NodeErrorDetails>,
) -> NodeResult<()> {
    match (cleanup_result, coordination_error) {
        (Ok(()), Some(coordination_error)) => Err(coordination_error),
        (cleanup_result, _) => cleanup_result,
    }
}

fn cleanup_result_with_delivery_error(
    cleanup_result: NodeResult<()>,
    delivery_error: Option<NodeErrorDetails>,
) -> NodeResult<()> {
    match (cleanup_result, delivery_error) {
        (Ok(()), Some(delivery_error)) => Err(delivery_error),
        (cleanup_result, _) => cleanup_result,
    }
}

pub(crate) struct ShutdownGate {
    stop: AtomicBool,
    environment_closing: AtomicBool,
    attempt: Arc<EstablishmentAttempt>,
}

impl ShutdownGate {
    fn new(attempt: Arc<EstablishmentAttempt>) -> Self {
        Self {
            stop: AtomicBool::new(false),
            environment_closing: AtomicBool::new(false),
            attempt,
        }
    }

    fn signal(&self) {
        self.stop.store(true, Ordering::Release);
    }

    fn signal_environment_teardown_under_admission_barrier(&self) {
        self.environment_closing.store(true, Ordering::Release);
        self.attempt.cancel_without_delivery_close();
        self.signal();
    }
}

fn partial_reason_name(reason: PartialReason) -> &'static str {
    match reason {
        PartialReason::ResourceLimit => "resource-limit",
        PartialReason::Permission => "permission",
        PartialReason::TransientError => "transient-error",
    }
}

fn uncertain_reason_name(reason: UncertainReason) -> &'static str {
    match reason {
        UncertainReason::EventOverflow => "event-overflow",
        UncertainReason::RootReplaced => "root-replaced",
        UncertainReason::TopologyRace => "topology-race",
        UncertainReason::ConsumerBackpressure => "consumer-backpressure",
    }
}

fn root_attachment_name(attachment: RootAttachment) -> &'static str {
    match attachment {
        RootAttachment::Attached => "attached",
        RootAttachment::Lost => "lost",
    }
}

fn root_loss_evidence_name(evidence: RootLossEvidence) -> &'static str {
    match evidence {
        RootLossEvidence::RootSelfEvent => "root-self-event",
        RootLossEvidence::RootWatchLoss => "root-watch-loss",
        RootLossEvidence::PathIdentityMismatch => "path-identity-mismatch",
        RootLossEvidence::Multiple => "multiple",
    }
}

fn root_recovery_attachment_name(attachment: RootRecoveryAttachment) -> &'static str {
    match attachment {
        RootRecoveryAttachment::OriginalRestored => "original-restored",
        RootRecoveryAttachment::ReplacementAdopted => "replacement-adopted",
        RootRecoveryAttachment::NotAttached => "not-attached",
    }
}

fn root_recovery_failure_name(reason: RootRecoveryFailureReason) -> &'static str {
    match reason {
        RootRecoveryFailureReason::ReplacementNotAccepted => "replacement-not-accepted",
        RootRecoveryFailureReason::CandidateMissing => "candidate-missing",
        RootRecoveryFailureReason::CandidateNotDirectory => "candidate-not-directory",
        RootRecoveryFailureReason::SymlinkAncestry => "symlink-ancestry",
        RootRecoveryFailureReason::IdentityUnstable => "identity-unstable",
        RootRecoveryFailureReason::RootWatchUnavailable => "root-watch-unavailable",
    }
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_establishment_token_is_single_bind() {
        let attempt = EstablishmentAttempt::new().unwrap();
        attempt.bind().unwrap();
        let error = attempt.bind().unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidArgument);
        assert_eq!(error.operation, Operation::Subscribe);
    }

    #[test]
    fn raw_establishment_token_remembers_pre_bind_cancellation() {
        let attempt = EstablishmentAttempt::new().unwrap();
        attempt.cancel();
        attempt.cancel();
        attempt.bind().unwrap();
        assert!(attempt.cancellation_requested());
        assert!(attempt.engine.is_cancelled());
    }

    #[test]
    fn public_commit_is_invalid_before_node_ready() {
        let attempt = EstablishmentAttempt::new().unwrap();
        attempt.bind().unwrap();
        let error = attempt.commit_public_success().unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidArgument);
    }

    #[test]
    fn cleanup_failure_precedes_an_earlier_delivery_failure() {
        let cleanup_error = NodeErrorDetails::internal(Operation::Dispose, "engine cleanup failed");
        let delivery_error = NodeErrorDetails::delivery_failure(Status::Closing);
        let result =
            cleanup_result_with_delivery_error(Err(cleanup_error.clone()), Some(delivery_error))
                .unwrap_err();
        assert_eq!(result.code, cleanup_error.code);
        assert_eq!(result.message, cleanup_error.message);
    }

    #[test]
    fn cleanup_coordination_failure_precedes_a_delivery_failure() {
        let coordination_error = NodeErrorDetails::new(
            ErrorCode::ResourceUnavailable,
            Operation::Dispose,
            "cleanup coordinator could not be created",
        );
        let delivery_error = NodeErrorDetails::delivery_failure(Status::Closing);
        let result = cleanup_result_with_delivery_error(
            cleanup_result_with_coordination_error(Ok(()), Some(coordination_error.clone())),
            Some(delivery_error),
        )
        .unwrap_err();
        assert_eq!(result.code, coordination_error.code);
        assert_eq!(result.message, coordination_error.message);
    }
}
