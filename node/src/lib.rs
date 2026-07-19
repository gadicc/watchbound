//! Thin Node-API proof for watchbound-engine.

use std::collections::HashMap;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use napi::bindgen_prelude::{AsyncTask, Buffer, FnArgs, Function};
use napi::threadsafe_function::{
    ThreadsafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use watchbound_engine::{
    ChangeBatch, Coverage, Engine, PartialReason, Stats, StatsHandle, Subscription,
    SubscriptionOptions, UncertainReason,
};

type BatchThreadsafeFunction =
    ThreadsafeFunction<ChangeBatch, (), FnArgs<(JsChangeBatch,)>, Status, false, false, 1>;

#[napi(object)]
pub struct JsSubscriptionOptions {
    pub watch_limit: Option<f64>,
    pub batch_window_ms: Option<f64>,
    pub max_batch_paths: Option<f64>,
    pub output_queue_capacity: Option<f64>,
}

impl JsSubscriptionOptions {
    fn into_engine_options(self) -> Result<SubscriptionOptions> {
        let defaults = SubscriptionOptions::default();
        let watch_limit = self
            .watch_limit
            .map(|value| positive_u32_option(value, "watchLimit"))
            .transpose()?;
        let batch_window_ms = self
            .batch_window_ms
            .map(|value| positive_u32_option(value, "batchWindowMs"))
            .transpose()?;
        let max_batch_paths = self
            .max_batch_paths
            .map(|value| positive_u32_option(value, "maxBatchPaths"))
            .transpose()?;
        let output_queue_capacity = self
            .output_queue_capacity
            .map(|value| positive_u32_option(value, "outputQueueCapacity"))
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

fn positive_u32_option(value: f64, name: &str) -> Result<u32> {
    if !value.is_finite() || value < 1.0 || value > f64::from(u32::MAX) || value.fract() != 0.0 {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "{name} must be a finite positive integer no greater than {}",
                u32::MAX
            ),
        ));
    }
    Ok(value as u32)
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
    /// Exact Linux path bytes. The JavaScript wrapper may decode UTF-8 paths,
    /// but the native boundary never performs a lossy conversion.
    pub invalidated_paths: Vec<Buffer>,
    pub coverage: JsCoverage,
}

impl From<ChangeBatch> for JsChangeBatch {
    fn from(batch: ChangeBatch) -> Self {
        Self {
            sequence: batch.sequence,
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
pub struct JsCapabilities {
    pub recursive: bool,
    pub moved_in_tree_discovery: bool,
    pub explicit_watch_limits: bool,
    pub overflow_reporting: bool,
    pub dynamic_exclusions: bool,
    pub root_replacement_recovery: bool,
    pub exact_path_bytes: bool,
}

#[napi]
pub fn capabilities() -> JsCapabilities {
    let capabilities = Engine::new().capabilities();
    JsCapabilities {
        recursive: capabilities.recursive,
        moved_in_tree_discovery: capabilities.moved_in_tree_discovery,
        explicit_watch_limits: capabilities.explicit_watch_limits,
        overflow_reporting: capabilities.overflow_reporting,
        dynamic_exclusions: capabilities.dynamic_exclusions,
        root_replacement_recovery: capabilities.root_replacement_recovery,
        exact_path_bytes: true,
    }
}

fn resolve_root(root: String) -> Result<PathBuf> {
    let root = PathBuf::from(root);
    if root.is_absolute() {
        Ok(root)
    } else {
        std::env::current_dir()
            .map(|current_dir| current_dir.join(root))
            .map_err(node_error)
    }
}

#[napi(ts_return_type = "Promise<NativeSubscription>")]
pub fn subscribe(
    env: Env,
    root: String,
    options: Option<JsSubscriptionOptions>,
    callback: Function<'_, FnArgs<(JsChangeBatch,)>, ()>,
) -> Result<AsyncTask<SubscribeTask>> {
    let root = resolve_root(root)?;
    let options = options
        .map(JsSubscriptionOptions::into_engine_options)
        .transpose()?
        .unwrap_or_default();
    let threadsafe_function: BatchThreadsafeFunction = callback
        .build_threadsafe_function::<ChangeBatch>()
        .callee_handled::<false>()
        .weak::<false>()
        .max_queue_size::<1>()
        .build_callback(|context: ThreadsafeCallContext<ChangeBatch>| {
            Ok(FnArgs::from((JsChangeBatch::from(context.value),)))
        })?;
    let shutdown = Arc::new(ShutdownGate::new());
    let cleanup_registration = register_environment_cleanup(&env, &shutdown)?;

    Ok(AsyncTask::new(SubscribeTask {
        root,
        options,
        threadsafe_function: Some(threadsafe_function),
        shutdown,
        cleanup_registration: Some(cleanup_registration),
    }))
}

pub struct SubscribeTask {
    root: PathBuf,
    options: SubscriptionOptions,
    threadsafe_function: Option<BatchThreadsafeFunction>,
    shutdown: Arc<ShutdownGate>,
    cleanup_registration: Option<EnvironmentCleanupRegistration>,
}

impl Task for SubscribeTask {
    type Output = Arc<SubscriptionState>;
    type JsValue = NativeSubscription;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.shutdown.stop.load(Ordering::Acquire) {
            return Err(Error::from_reason("Node environment is shutting down"));
        }
        let mut subscription = Engine::new()
            .subscribe(&self.root, self.options.clone())
            .map_err(node_error)?;
        if self.shutdown.stop.load(Ordering::Acquire) {
            subscription.dispose().map_err(node_error)?;
            return Err(Error::from_reason("Node environment is shutting down"));
        }
        let threadsafe_function = self
            .threadsafe_function
            .take()
            .ok_or_else(|| Error::from_reason("subscribe task was already consumed"))?;
        let cleanup_registration = self.cleanup_registration.take().ok_or_else(|| {
            Error::from_reason("subscribe cleanup registration was already consumed")
        })?;
        SubscriptionState::start(
            subscription,
            threadsafe_function,
            Arc::clone(&self.shutdown),
            cleanup_registration,
        )
        .map(Arc::new)
        .map_err(node_error)
    }

    fn resolve(&mut self, _env: Env, state: Self::Output) -> Result<Self::JsValue> {
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

impl Task for DisposeTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<Self::Output> {
        self.state.dispose_join_and_drain().map_err(node_error)
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> Result<Self::JsValue> {
        Ok(())
    }
}

pub struct SubscriptionState {
    initial_coverage: Coverage,
    stats: StatsHandle,
    threadsafe_function: Mutex<Option<Arc<BatchThreadsafeFunction>>>,
    bridge: Mutex<Option<JoinHandle<io::Result<()>>>>,
    shutdown: Arc<ShutdownGate>,
    callback_tracker: Arc<CallbackTracker>,
    cleanup_started: AtomicBool,
    cleanup_result: Mutex<Option<io::Result<()>>>,
    cleanup_condition: Condvar,
    cleanup_registration: Mutex<Option<EnvironmentCleanupRegistration>>,
}

impl SubscriptionState {
    fn start(
        subscription: Subscription,
        threadsafe_function: BatchThreadsafeFunction,
        shutdown: Arc<ShutdownGate>,
        cleanup_registration: EnvironmentCleanupRegistration,
    ) -> io::Result<Self> {
        let initial_coverage = subscription.initial_coverage().clone();
        let stats = subscription.stats_handle();
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
            })?;

        Ok(Self {
            initial_coverage,
            stats,
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

    fn dispose_join_and_drain(&self) -> io::Result<()> {
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
                bridge
                    .join()
                    .map_err(|_| io::Error::other("Node bridge thread panicked"))?
            });
        if !self.shutdown.environment_closing.load(Ordering::Acquire) {
            self.callback_tracker
                .wait_until_empty_or_environment_closing(&self.shutdown);
        }
        lock_unpoisoned(&self.threadsafe_function).take();
        lock_unpoisoned(&self.cleanup_registration).take();

        let stored_result = result
            .as_ref()
            .map(|_| ())
            .map_err(|error| io::Error::new(error.kind(), error.to_string()));
        *lock_unpoisoned(&self.cleanup_result) = Some(stored_result);
        self.cleanup_condition.notify_all();
        result
    }

    fn wait_for_cleanup(&self) -> io::Result<()> {
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
            .as_ref()
            .map(|_| ())
            .map_err(|error| io::Error::new(error.kind(), error.to_string()))
    }

    fn cleanup_finished(&self) -> bool {
        lock_unpoisoned(&self.cleanup_result).is_some()
    }
}

fn bridge_batches(
    mut subscription: Subscription,
    threadsafe_function: Arc<BatchThreadsafeFunction>,
    callback_tracker: Arc<CallbackTracker>,
    shutdown: Arc<ShutdownGate>,
) -> io::Result<()> {
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
            delivery_error = Some(io::Error::other(format!(
                "Node callback bridge delivery failed: {status}"
            )));
            break;
        }
    }

    let dispose_result = subscription.dispose();
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

    fn register(&mut self, shutdown: &Arc<ShutdownGate>) -> Result<u64> {
        let registration_id = self.next_registration_id;
        self.next_registration_id = self
            .next_registration_id
            .checked_add(1)
            .ok_or_else(|| Error::from_reason("environment cleanup registration IDs exhausted"))?;
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
) -> Result<EnvironmentCleanupRegistration> {
    let environment_key = env.raw() as usize;
    let mut environments = lock_unpoisoned(environment_cleanup_registries());
    if let std::collections::hash_map::Entry::Vacant(environment) =
        environments.entry(environment_key)
    {
        env.add_env_cleanup_hook(environment_key, cleanup_environment)?;
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

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn node_error(error: io::Error) -> Error {
    Error::from_reason(error.to_string())
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
