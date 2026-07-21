//! Thin Node-API proof for watchbound-engine.

use std::collections::HashMap;
use std::io;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use napi::bindgen_prelude::{
    AsyncTask, BigInt, Buffer, Either, FnArgs, Function, Null, ToNapiValue,
};
use napi::threadsafe_function::{
    ThreadsafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use watchbound_engine::{
    ChangeBatch, Coverage, Engine, ErrorCode, ExclusionHandle, MAX_ERROR_MESSAGE_BYTES, Operation,
    PartialReason, ReconciliationHandle, ReconciliationResult, RootAttachment, RootIdentity,
    RootIdentityPolicy, RootLossEvidence, RootRecoveryAttachment, RootRecoveryFailureReason,
    RootRecoveryHandle, RootRecoveryResult, RootState, RootStateHandle, RuntimeStats, Stats,
    StatsHandle, Subscription, SubscriptionOptions, SystemCause, UncertainReason, VERSION,
    WatchboundError,
};

type BatchThreadsafeFunction =
    ThreadsafeFunction<ChangeBatch, (), FnArgs<(JsChangeBatch,)>, Status, false, false, 1>;

type NodeResult<T> = std::result::Result<T, NodeErrorDetails>;
type TaskOutcome<T> = NodeResult<T>;

const MAX_SYSTEM_DETAIL_BYTES: usize = 128;
const BINDING_API_VERSION: u32 = 1;
const CAPABILITY_SCHEMA_VERSION: u32 = 1;
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
    pub dynamic_exclusions: bool,
    pub reconciliation: bool,
    pub root_replacement_recovery: bool,
    pub exact_path_bytes: bool,
    pub process_native_watch_budget: bool,
    pub shared_native_watches: bool,
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
        dynamic_exclusions: capabilities.dynamic_exclusions,
        reconciliation: capabilities.reconciliation,
        root_replacement_recovery: capabilities.root_replacement_recovery,
        exact_path_bytes: true,
        process_native_watch_budget: capabilities.process_native_watch_budget,
        shared_native_watches: capabilities.shared_native_watches,
        subscription_defaults: SubscriptionOptions::default().into(),
        positive_integer_minimum: 1,
        positive_integer_maximum: u32::MAX,
    }
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

    #[napi(ts_return_type = "Promise<NativeSubscription>")]
    pub fn subscribe(
        &self,
        env: Env,
        root: String,
        options: Option<JsSubscriptionOptions>,
        callback: Function<'_, FnArgs<(JsChangeBatch,)>, ()>,
    ) -> Result<AsyncTask<SubscribeTask>> {
        prepare_subscribe(env, self.engine, root, options, callback)
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
    callback: Function<'_, FnArgs<(JsChangeBatch,)>, ()>,
) -> Result<AsyncTask<SubscribeTask>> {
    prepare_subscribe(env, Engine::new(), root, options, callback)
}

fn prepare_subscribe(
    env: Env,
    engine: Engine,
    root: String,
    options: Option<JsSubscriptionOptions>,
    callback: Function<'_, FnArgs<(JsChangeBatch,)>, ()>,
) -> Result<AsyncTask<SubscribeTask>> {
    let root = resolve_root(root).map_err(|error| sync_error(&env, error))?;
    let options = options
        .map(JsSubscriptionOptions::into_engine_options)
        .transpose()
        .map_err(|error| sync_error(&env, error))?
        .unwrap_or_default();
    let threadsafe_function: BatchThreadsafeFunction = callback
        .build_threadsafe_function::<ChangeBatch>()
        .callee_handled::<false>()
        .weak::<false>()
        .max_queue_size::<1>()
        .build_callback(|context: ThreadsafeCallContext<ChangeBatch>| {
            Ok(FnArgs::from((JsChangeBatch::from(context.value),)))
        })
        .map_err(|error| {
            sync_error(
                &env,
                NodeErrorDetails::from_napi(
                    ErrorCode::ResourceUnavailable,
                    Operation::Subscribe,
                    "Node callback bridge could not be created",
                    error,
                ),
            )
        })?;
    let shutdown = Arc::new(ShutdownGate::new());
    let cleanup_registration =
        register_environment_cleanup(&env, &shutdown).map_err(|error| sync_error(&env, error))?;

    Ok(AsyncTask::new(SubscribeTask {
        engine,
        root,
        options,
        threadsafe_function: Some(threadsafe_function),
        shutdown,
        cleanup_registration: Some(cleanup_registration),
    }))
}

pub struct SubscribeTask {
    engine: Engine,
    root: PathBuf,
    options: SubscriptionOptions,
    threadsafe_function: Option<BatchThreadsafeFunction>,
    shutdown: Arc<ShutdownGate>,
    cleanup_registration: Option<EnvironmentCleanupRegistration>,
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
            let subscription = self
                .engine
                .subscribe(&self.root, self.options.clone())
                .map_err(NodeErrorDetails::from)?;
            if self.shutdown.stop.load(Ordering::Acquire) {
                subscription.dispose().map_err(NodeErrorDetails::from)?;
                return Err(NodeErrorDetails::new(
                    ErrorCode::OperationInterrupted,
                    Operation::Subscribe,
                    "Node environment teardown interrupted subscription setup",
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
            SubscriptionState::start(
                subscription,
                threadsafe_function,
                Arc::clone(&self.shutdown),
                cleanup_registration,
            )
            .map(Arc::new)
        })();
        Ok(outcome)
    }

    fn resolve(&mut self, env: Env, state: Self::Output) -> Result<Self::JsValue> {
        let state = task_result(&env, state)?;
        Ok(NativeSubscription { state })
    }
}

#[napi]
pub struct NativeSubscription {
    state: Arc<SubscriptionState>,
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
            self.state
                .callback_tracker
                .callback_errors
                .load(Ordering::Relaxed),
            self.state
                .callback_tracker
                .bridge_delivery_errors
                .load(Ordering::Relaxed),
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
        prefixes: Vec<Buffer>,
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
            prefixes: prefixes
                .into_iter()
                .map(|prefix| PathBuf::from(std::ffi::OsString::from_vec(prefix.to_vec())))
                .collect(),
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
    pub fn dispose(&self) -> AsyncTask<DisposeTask> {
        AsyncTask::new(DisposeTask {
            state: Arc::clone(&self.state),
        })
    }
}

impl Drop for NativeSubscription {
    fn drop(&mut self) {
        if self.state.cleanup_finished() {
            return;
        }
        self.state.shutdown.signal();
        let state = Arc::clone(&self.state);
        let _ = std::thread::Builder::new()
            .name("watchbound-node-reaper".to_owned())
            .spawn(move || {
                let _ = state.dispose_join_and_drain();
            });
    }
}

pub struct DisposeTask {
    state: Arc<SubscriptionState>,
}

pub struct ReplaceExclusionsTask {
    exclusions: ExclusionHandle,
    generation: u64,
    prefixes: Vec<PathBuf>,
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
            .replace_exclusions(self.generation, std::mem::take(&mut self.prefixes))
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

impl Task for DisposeTask {
    type Output = TaskOutcome<()>;
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(self.state.dispose_join_and_drain())
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue> {
        task_result(&env, output)
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
    threadsafe_function: Mutex<Option<Arc<BatchThreadsafeFunction>>>,
    bridge: Mutex<Option<JoinHandle<NodeResult<()>>>>,
    shutdown: Arc<ShutdownGate>,
    callback_tracker: Arc<CallbackTracker>,
    cleanup_started: AtomicBool,
    cleanup_result: Mutex<Option<NodeResult<()>>>,
    cleanup_condition: Condvar,
    cleanup_registration: Mutex<Option<EnvironmentCleanupRegistration>>,
}

impl SubscriptionState {
    fn start(
        subscription: Subscription,
        threadsafe_function: BatchThreadsafeFunction,
        shutdown: Arc<ShutdownGate>,
        cleanup_registration: EnvironmentCleanupRegistration,
    ) -> NodeResult<Self> {
        let initial_coverage = subscription.initial_coverage().clone();
        let initial_root_state = *subscription.initial_root_state();
        let stats = subscription.stats_handle();
        let exclusions = subscription.exclusion_handle();
        let reconciliation = subscription.reconciliation_handle();
        let root_state = subscription.root_state_handle();
        let root_recovery = subscription.root_recovery_handle();
        let callback_tracker = Arc::new(CallbackTracker::new());
        let threadsafe_function = Arc::new(threadsafe_function);
        let bridge_callback_tracker = Arc::clone(&callback_tracker);
        let bridge_shutdown = Arc::clone(&shutdown);
        let bridge_threadsafe_function = Arc::clone(&threadsafe_function);
        let bridge = std::thread::Builder::new()
            .name("watchbound-node-bridge".to_owned())
            .spawn(move || {
                bridge_batches(
                    subscription,
                    bridge_threadsafe_function,
                    bridge_callback_tracker,
                    bridge_shutdown,
                )
            })
            .map_err(|error| {
                NodeErrorDetails::from_io(
                    ErrorCode::ResourceUnavailable,
                    Operation::Subscribe,
                    "Node callback bridge thread could not be created",
                    &error,
                )
            })?;

        Ok(Self {
            initial_coverage,
            initial_root_state,
            stats,
            exclusions,
            reconciliation,
            root_state,
            root_recovery,
            threadsafe_function: Mutex::new(Some(threadsafe_function)),
            bridge: Mutex::new(Some(bridge)),
            shutdown,
            callback_tracker,
            cleanup_started: AtomicBool::new(false),
            cleanup_result: Mutex::new(None),
            cleanup_condition: Condvar::new(),
            cleanup_registration: Mutex::new(Some(cleanup_registration)),
        })
    }

    fn dispose_join_and_drain(&self) -> NodeResult<()> {
        let owns_cleanup = self
            .cleanup_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        if !owns_cleanup {
            return self.wait_for_cleanup();
        }

        self.shutdown.signal();
        let result = lock_unpoisoned(&self.bridge)
            .take()
            .map_or(Ok(()), |bridge| {
                bridge.join().map_err(|_| {
                    NodeErrorDetails::new(
                        ErrorCode::Internal,
                        Operation::Dispose,
                        "Node callback bridge thread panicked",
                    )
                })?
            });
        if !self.shutdown.environment_closing.load(Ordering::Acquire) {
            self.callback_tracker
                .wait_until_empty_or_environment_closing(&self.shutdown);
        }
        lock_unpoisoned(&self.threadsafe_function).take();
        lock_unpoisoned(&self.cleanup_registration).take();

        *lock_unpoisoned(&self.cleanup_result) = Some(result.clone());
        self.cleanup_condition.notify_all();
        result
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
}

fn bridge_batches(
    subscription: Subscription,
    threadsafe_function: Arc<BatchThreadsafeFunction>,
    callback_tracker: Arc<CallbackTracker>,
    shutdown: Arc<ShutdownGate>,
) -> NodeResult<()> {
    let mut delivery_error = None;
    while !shutdown.stop.load(Ordering::Acquire) {
        let received = subscription.recv_timeout(Duration::from_millis(10));
        let batch = match received {
            Ok(batch) => batch,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        if shutdown.stop.load(Ordering::Acquire) {
            break;
        }

        callback_tracker.begin();
        let completion_tracker = Arc::clone(&callback_tracker);
        let status = threadsafe_function.call_with_return_value(
            batch,
            ThreadsafeFunctionCallMode::Blocking,
            move |result, _env| {
                completion_tracker.finish_callback(result.is_err());
                Ok(())
            },
        );
        if status != Status::Ok {
            callback_tracker.finish_delivery_error();
            delivery_error = Some(
                NodeErrorDetails::new(
                    ErrorCode::Internal,
                    Operation::DeliverBatch,
                    "Node callback bridge could not deliver a batch",
                )
                .with_system_cause(NodeSystemCause::from_napi_status(
                    status,
                    format!("Node callback bridge delivery failed: {status}"),
                )),
            );
            break;
        }
    }

    let dispose_result = subscription.dispose().map_err(NodeErrorDetails::from);
    delivery_error.map_or(dispose_result, Err)
}

struct ShutdownGate {
    stop: AtomicBool,
    environment_closing: AtomicBool,
}

impl ShutdownGate {
    fn new() -> Self {
        Self {
            stop: AtomicBool::new(false),
            environment_closing: AtomicBool::new(false),
        }
    }

    fn signal(&self) {
        self.stop.store(true, Ordering::Release);
    }

    fn signal_environment_teardown(&self) {
        self.environment_closing.store(true, Ordering::Release);
        self.signal();
    }
}

struct EnvironmentCleanupRegistry {
    next_registration_id: u64,
    registrations: HashMap<u64, Weak<ShutdownGate>>,
}

impl EnvironmentCleanupRegistry {
    fn new() -> Self {
        Self {
            next_registration_id: 1,
            registrations: HashMap::new(),
        }
    }

    fn register(&mut self, shutdown: &Arc<ShutdownGate>) -> NodeResult<u64> {
        let registration_id = self.next_registration_id;
        self.next_registration_id = self.next_registration_id.checked_add(1).ok_or_else(|| {
            NodeErrorDetails::new(
                ErrorCode::Internal,
                Operation::Subscribe,
                "environment cleanup registration IDs exhausted",
            )
        })?;
        self.registrations
            .insert(registration_id, Arc::downgrade(shutdown));
        Ok(registration_id)
    }
}

struct EnvironmentCleanupRegistration {
    environment_key: usize,
    registration_id: u64,
}

impl Drop for EnvironmentCleanupRegistration {
    fn drop(&mut self) {
        let mut environments = lock_unpoisoned(environment_cleanup_registries());
        if let Some(environment) = environments.get_mut(&self.environment_key) {
            environment.registrations.remove(&self.registration_id);
        }
    }
}

static ENVIRONMENT_CLEANUP_REGISTRIES: OnceLock<Mutex<HashMap<usize, EnvironmentCleanupRegistry>>> =
    OnceLock::new();

fn environment_cleanup_registries() -> &'static Mutex<HashMap<usize, EnvironmentCleanupRegistry>> {
    ENVIRONMENT_CLEANUP_REGISTRIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_environment_cleanup(
    env: &Env,
    shutdown: &Arc<ShutdownGate>,
) -> NodeResult<EnvironmentCleanupRegistration> {
    let environment_key = env.raw() as usize;
    let mut environments = lock_unpoisoned(environment_cleanup_registries());
    if let std::collections::hash_map::Entry::Vacant(environment) =
        environments.entry(environment_key)
    {
        env.add_env_cleanup_hook(environment_key, cleanup_environment)
            .map_err(|error| {
                NodeErrorDetails::from_napi(
                    ErrorCode::Internal,
                    Operation::Subscribe,
                    "Node environment cleanup hook could not be registered",
                    error,
                )
            })?;
        environment.insert(EnvironmentCleanupRegistry::new());
    }
    let registration_id = environments
        .get_mut(&environment_key)
        .expect("environment registry inserted above")
        .register(shutdown)?;
    Ok(EnvironmentCleanupRegistration {
        environment_key,
        registration_id,
    })
}

fn cleanup_environment(environment_key: usize) {
    let registrations = lock_unpoisoned(environment_cleanup_registries())
        .remove(&environment_key)
        .map(|environment| environment.registrations)
        .unwrap_or_default();
    for shutdown in registrations
        .into_values()
        .filter_map(|shutdown| shutdown.upgrade())
    {
        shutdown.signal_environment_teardown();
    }
}

struct CallbackTracker {
    outstanding: Mutex<usize>,
    condition: Condvar,
    callback_errors: AtomicU64,
    bridge_delivery_errors: AtomicU64,
}

impl CallbackTracker {
    fn new() -> Self {
        Self {
            outstanding: Mutex::new(0),
            condition: Condvar::new(),
            callback_errors: AtomicU64::new(0),
            bridge_delivery_errors: AtomicU64::new(0),
        }
    }

    fn begin(&self) {
        *lock_unpoisoned(&self.outstanding) += 1;
    }

    fn finish_callback(&self, error: bool) {
        if error {
            self.callback_errors.fetch_add(1, Ordering::Relaxed);
        }
        self.finish_one();
    }

    fn finish_delivery_error(&self) {
        self.bridge_delivery_errors.fetch_add(1, Ordering::Relaxed);
        self.finish_one();
    }

    fn finish_one(&self) {
        let mut outstanding = lock_unpoisoned(&self.outstanding);
        *outstanding = outstanding
            .checked_sub(1)
            .expect("callback tracker completed without a matching begin");
        self.condition.notify_all();
    }

    fn wait_until_empty_or_environment_closing(&self, shutdown: &ShutdownGate) {
        let mut outstanding = lock_unpoisoned(&self.outstanding);
        while *outstanding != 0 && !shutdown.environment_closing.load(Ordering::Acquire) {
            let (next, _) = self
                .condition
                .wait_timeout(outstanding, Duration::from_millis(10))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            outstanding = next;
        }
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
    fn cleanup_registration_is_weak_and_removable() {
        let environment_key = usize::MAX;
        let shutdown = Arc::new(ShutdownGate::new());
        let registration_id = {
            let mut environments = lock_unpoisoned(environment_cleanup_registries());
            let environment = environments
                .entry(environment_key)
                .or_insert_with(EnvironmentCleanupRegistry::new);
            environment.register(&shutdown).unwrap()
        };
        assert_eq!(Arc::strong_count(&shutdown), 1);

        drop(EnvironmentCleanupRegistration {
            environment_key,
            registration_id,
        });

        let mut environments = lock_unpoisoned(environment_cleanup_registries());
        assert!(
            environments
                .get(&environment_key)
                .unwrap()
                .registrations
                .is_empty()
        );
        environments.remove(&environment_key);
    }

    #[test]
    fn environment_cleanup_signals_live_registrations() {
        let environment_key = usize::MAX - 1;
        let shutdown = Arc::new(ShutdownGate::new());
        {
            let mut environments = lock_unpoisoned(environment_cleanup_registries());
            let environment = environments
                .entry(environment_key)
                .or_insert_with(EnvironmentCleanupRegistry::new);
            environment.register(&shutdown).unwrap();
        }

        cleanup_environment(environment_key);

        assert!(shutdown.stop.load(Ordering::Acquire));
        assert!(shutdown.environment_closing.load(Ordering::Acquire));
        assert!(!lock_unpoisoned(environment_cleanup_registries()).contains_key(&environment_key));
    }

    #[test]
    fn callback_tracker_separates_callback_and_delivery_errors() {
        let tracker = CallbackTracker::new();
        tracker.begin();
        tracker.finish_callback(true);
        tracker.begin();
        tracker.finish_delivery_error();

        assert_eq!(tracker.callback_errors.load(Ordering::Relaxed), 1);
        assert_eq!(tracker.bridge_delivery_errors.load(Ordering::Relaxed), 1);
        assert_eq!(*lock_unpoisoned(&tracker.outstanding), 0);
    }
}
