use std::collections::{BTreeMap, HashMap};
use std::ffi::c_void;
use std::io;
use std::ops::Bound;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use napi::bindgen_prelude::{Function, JsValue, ToNapiValue};
use napi::{Env, Status, sys};
use watchbound_engine::ChangeBatch;

use crate::{
    NodeErrorDetails, NodeResult, Operation, ShutdownGate, SubscriptionState, lock_unpoisoned,
};

pub(crate) const DISPATCHER_WORK_QUANTUM: usize = 64;
pub(crate) const DISPATCHER_POLL_MILLISECONDS: u32 = 5;
const DISPATCHER_POLL: Duration = Duration::from_millis(DISPATCHER_POLL_MILLISECONDS as u64);

static ACTIVE_DISPATCHER_ENVIRONMENTS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_DISPATCHER_THREADS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_REGISTRATIONS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_OUTSTANDING_CALLBACKS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_CLEANUP_COORDINATORS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_CLEANUP_REQUESTS: AtomicUsize = AtomicUsize::new(0);
static ACTIVE_THREADSAFE_FUNCTIONS: AtomicUsize = AtomicUsize::new(0);
static ENVIRONMENT_GENERATIONS: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
static FAIL_NEXT_CLEANUP_COORDINATOR_SPAWN: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct DeliveryDiagnostics {
    pub dispatcher_environments: usize,
    pub dispatcher_threads: usize,
    pub registrations: usize,
    pub outstanding_callbacks: usize,
    pub cleanup_coordinator_threads: usize,
    pub cleanup_requests: usize,
    pub active_threadsafe_functions: usize,
    pub environment_generations: u64,
}

pub(crate) fn diagnostics() -> DeliveryDiagnostics {
    DeliveryDiagnostics {
        dispatcher_environments: ACTIVE_DISPATCHER_ENVIRONMENTS.load(Ordering::Acquire),
        dispatcher_threads: ACTIVE_DISPATCHER_THREADS.load(Ordering::Acquire),
        registrations: ACTIVE_REGISTRATIONS.load(Ordering::Acquire),
        outstanding_callbacks: ACTIVE_OUTSTANDING_CALLBACKS.load(Ordering::Acquire),
        cleanup_coordinator_threads: ACTIVE_CLEANUP_COORDINATORS.load(Ordering::Acquire),
        cleanup_requests: ACTIVE_CLEANUP_REQUESTS.load(Ordering::Acquire),
        active_threadsafe_functions: ACTIVE_THREADSAFE_FUNCTIONS.load(Ordering::Acquire),
        environment_generations: ENVIRONMENT_GENERATIONS.load(Ordering::Acquire),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EnvironmentLifecycle {
    Starting,
    Running,
    Closing,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DispatcherLifecycle {
    Stopped,
    Starting,
    Running,
    Stopping,
}

#[derive(Debug, Default)]
struct FairRound {
    cursor: Option<u64>,
    upper_bound: Option<u64>,
}

struct RegistrationRecord {
    shutdown: Weak<ShutdownGate>,
    state: Option<Weak<SubscriptionState>>,
    threadsafe_function: Weak<RawBatchThreadsafeFunction>,
    cleanup_hold: Option<Arc<SubscriptionState>>,
    cleanup_coordination_error: Option<NodeErrorDetails>,
    pending_establishment: bool,
    cleanup_keepalive: bool,
    dispatcher_cleanup: bool,
    active: bool,
}

impl RegistrationRecord {
    fn keeps_dispatcher_alive(&self) -> bool {
        self.active
            || self.pending_establishment
            || self.cleanup_keepalive
            || self.dispatcher_cleanup
    }

    fn assign_cleanup_to_coordinator(&mut self) {
        self.cleanup_keepalive = false;
    }

    fn assign_cleanup_to_dispatcher(&mut self, error: NodeErrorDetails) {
        self.cleanup_keepalive = false;
        self.dispatcher_cleanup = true;
        self.cleanup_coordination_error = Some(error);
    }
}

struct EnvironmentInner {
    lifecycle: EnvironmentLifecycle,
    startup_error: Option<NodeErrorDetails>,
    next_registration_id: u64,
    registrations: BTreeMap<u64, RegistrationRecord>,
    dispatcher_round: FairRound,
    dispatcher_lifecycle: DispatcherLifecycle,
    dispatcher_thread: Option<JoinHandle<()>>,
    cleanup_round: FairRound,
    cleanup_lifecycle: DispatcherLifecycle,
    cleanup_thread: Option<JoinHandle<()>>,
}

pub(crate) struct EnvironmentRecord {
    id: u64,
    admission_closing: Mutex<bool>,
    inner: Mutex<EnvironmentInner>,
    changed: Condvar,
    #[cfg(test)]
    fail_next_dispatcher_spawn: AtomicBool,
}

#[derive(Clone, Copy)]
enum ManagedThreadKind {
    Dispatcher,
    Cleanup,
}

struct ManagedThreadExit {
    environment: Weak<EnvironmentRecord>,
    kind: ManagedThreadKind,
}

impl ManagedThreadExit {
    fn new(environment: &Arc<EnvironmentRecord>, kind: ManagedThreadKind) -> Self {
        match kind {
            ManagedThreadKind::Dispatcher => {
                ACTIVE_DISPATCHER_ENVIRONMENTS.fetch_add(1, Ordering::AcqRel);
                ACTIVE_DISPATCHER_THREADS.fetch_add(1, Ordering::AcqRel);
            }
            ManagedThreadKind::Cleanup => {
                ACTIVE_CLEANUP_COORDINATORS.fetch_add(1, Ordering::AcqRel);
            }
        }
        Self {
            environment: Arc::downgrade(environment),
            kind,
        }
    }
}

impl Drop for ManagedThreadExit {
    fn drop(&mut self) {
        if let Some(environment) = self.environment.upgrade() {
            let mut inner = lock_unpoisoned(&environment.inner);
            match self.kind {
                ManagedThreadKind::Dispatcher => {
                    inner.dispatcher_lifecycle = DispatcherLifecycle::Stopped;
                }
                ManagedThreadKind::Cleanup => {
                    inner.cleanup_lifecycle = DispatcherLifecycle::Stopped;
                }
            }
            environment.changed.notify_all();
        }
        match self.kind {
            ManagedThreadKind::Dispatcher => {
                ACTIVE_DISPATCHER_THREADS.fetch_sub(1, Ordering::AcqRel);
                ACTIVE_DISPATCHER_ENVIRONMENTS.fetch_sub(1, Ordering::AcqRel);
            }
            ManagedThreadKind::Cleanup => {
                ACTIVE_CLEANUP_COORDINATORS.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }
}

impl EnvironmentRecord {
    fn new(id: u64) -> Self {
        Self {
            id,
            admission_closing: Mutex::new(false),
            inner: Mutex::new(EnvironmentInner {
                lifecycle: EnvironmentLifecycle::Starting,
                startup_error: None,
                next_registration_id: 1,
                registrations: BTreeMap::new(),
                dispatcher_round: FairRound::default(),
                dispatcher_lifecycle: DispatcherLifecycle::Stopped,
                dispatcher_thread: None,
                cleanup_round: FairRound::default(),
                cleanup_lifecycle: DispatcherLifecycle::Stopped,
                cleanup_thread: None,
            }),
            changed: Condvar::new(),
            #[cfg(test)]
            fail_next_dispatcher_spawn: AtomicBool::new(false),
        }
    }

    fn wait_until_running(&self) -> NodeResult<()> {
        let mut inner = lock_unpoisoned(&self.inner);
        while inner.lifecycle == EnvironmentLifecycle::Starting {
            inner = self
                .changed
                .wait(inner)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        match inner.lifecycle {
            EnvironmentLifecycle::Running => Ok(()),
            EnvironmentLifecycle::Closing => Err(NodeErrorDetails::operation_interrupted(
                Operation::Subscribe,
                "Node environment teardown interrupted subscription setup",
            )),
            EnvironmentLifecycle::Failed => Err(inner.startup_error.clone().unwrap_or_else(|| {
                NodeErrorDetails::internal(
                    Operation::Subscribe,
                    "Node environment startup failed without an error",
                )
            })),
            EnvironmentLifecycle::Starting => unreachable!("starting handled above"),
        }
    }

    fn mark_running(&self) {
        let mut inner = lock_unpoisoned(&self.inner);
        inner.lifecycle = EnvironmentLifecycle::Running;
        self.changed.notify_all();
    }

    fn mark_startup_failed(&self, error: NodeErrorDetails) {
        let mut inner = lock_unpoisoned(&self.inner);
        inner.lifecycle = EnvironmentLifecycle::Failed;
        inner.startup_error = Some(error);
        self.changed.notify_all();
    }

    pub(crate) fn register(
        self: &Arc<Self>,
        shutdown: &Arc<ShutdownGate>,
    ) -> NodeResult<EnvironmentRegistration> {
        self.wait_until_running()?;
        let registration_id = {
            let mut inner = lock_unpoisoned(&self.inner);
            if inner.lifecycle != EnvironmentLifecycle::Running {
                return Err(NodeErrorDetails::operation_interrupted(
                    Operation::Subscribe,
                    "Node environment teardown interrupted subscription setup",
                ));
            }
            let registration_id = inner.next_registration_id;
            inner.next_registration_id =
                inner.next_registration_id.checked_add(1).ok_or_else(|| {
                    NodeErrorDetails::internal(
                        Operation::Subscribe,
                        "Node environment registration IDs exhausted",
                    )
                })?;
            let replaced = inner.registrations.insert(
                registration_id,
                RegistrationRecord {
                    shutdown: Arc::downgrade(shutdown),
                    state: None,
                    threadsafe_function: Weak::new(),
                    cleanup_hold: None,
                    cleanup_coordination_error: None,
                    pending_establishment: true,
                    cleanup_keepalive: false,
                    dispatcher_cleanup: false,
                    active: false,
                },
            );
            debug_assert!(replaced.is_none());
            registration_id
        };
        if let Err(error) = self.ensure_dispatcher() {
            self.remove(registration_id);
            return Err(error);
        }
        Ok(EnvironmentRegistration {
            environment: Arc::clone(self),
            registration_id,
            published: false,
        })
    }

    fn publish(
        self: &Arc<Self>,
        registration_id: u64,
        state: &Arc<SubscriptionState>,
    ) -> NodeResult<()> {
        {
            let mut inner = lock_unpoisoned(&self.inner);
            if inner.lifecycle != EnvironmentLifecycle::Running {
                return Err(NodeErrorDetails::operation_interrupted(
                    Operation::Subscribe,
                    "Node environment teardown interrupted subscription setup",
                ));
            }
            let registration = inner
                .registrations
                .get_mut(&registration_id)
                .ok_or_else(|| {
                    NodeErrorDetails::internal(
                        Operation::Subscribe,
                        "Node environment registration disappeared before publication",
                    )
                })?;
            if registration.active || registration.state.is_some() {
                return Err(NodeErrorDetails::internal(
                    Operation::Subscribe,
                    "Node environment registration was published twice",
                ));
            }
            registration.state = Some(Arc::downgrade(state));
            registration.pending_establishment = false;
            registration.active = true;
            ACTIVE_REGISTRATIONS.fetch_add(1, Ordering::AcqRel);
        }
        if let Err(error) = self.ensure_dispatcher() {
            self.deactivate(registration_id, true);
            return Err(error);
        }
        self.changed.notify_all();
        Ok(())
    }

    fn deactivate(&self, registration_id: u64, keep_alive_for_cleanup: bool) {
        let mut inner = lock_unpoisoned(&self.inner);
        if let Some(registration) = inner.registrations.get_mut(&registration_id) {
            if registration.active {
                registration.active = false;
                ACTIVE_REGISTRATIONS.fetch_sub(1, Ordering::AcqRel);
            }
            registration.cleanup_keepalive |= keep_alive_for_cleanup;
        }
        self.changed.notify_all();
    }

    fn remove(&self, registration_id: u64) {
        let mut inner = lock_unpoisoned(&self.inner);
        if let Some(registration) = inner.registrations.remove(&registration_id)
            && registration.active
        {
            ACTIVE_REGISTRATIONS.fetch_sub(1, Ordering::AcqRel);
        }
        self.changed.notify_all();
    }

    fn ensure_dispatcher(self: &Arc<Self>) -> NodeResult<()> {
        loop {
            let finished = {
                let mut inner = lock_unpoisoned(&self.inner);
                if inner.lifecycle != EnvironmentLifecycle::Running {
                    return Err(NodeErrorDetails::operation_interrupted(
                        Operation::Subscribe,
                        "Node environment teardown interrupted subscription setup",
                    ));
                }
                match inner.dispatcher_lifecycle {
                    DispatcherLifecycle::Running => return Ok(()),
                    DispatcherLifecycle::Starting | DispatcherLifecycle::Stopping => {
                        inner = self
                            .changed
                            .wait(inner)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        drop(inner);
                        continue;
                    }
                    DispatcherLifecycle::Stopped => {
                        if inner.dispatcher_thread.is_some() {
                            inner.dispatcher_lifecycle = DispatcherLifecycle::Stopping;
                            inner.dispatcher_thread.take()
                        } else {
                            inner.dispatcher_round = FairRound::default();
                            inner.dispatcher_lifecycle = DispatcherLifecycle::Starting;
                            None
                        }
                    }
                }
            };

            if let Some(finished) = finished {
                let result = finished.join().map_err(|_| {
                    NodeErrorDetails::internal(
                        Operation::Subscribe,
                        "Node delivery dispatcher thread panicked",
                    )
                });
                let mut inner = lock_unpoisoned(&self.inner);
                inner.dispatcher_lifecycle = DispatcherLifecycle::Stopped;
                self.changed.notify_all();
                result?;
                continue;
            }

            let environment = Arc::clone(self);
            let thread = match spawn_dispatcher(environment) {
                Ok(thread) => thread,
                Err(error) => {
                    let mut inner = lock_unpoisoned(&self.inner);
                    inner.dispatcher_lifecycle = DispatcherLifecycle::Stopped;
                    self.changed.notify_all();
                    return Err(NodeErrorDetails::from_io(
                        crate::ErrorCode::ResourceUnavailable,
                        Operation::Subscribe,
                        "Node delivery dispatcher thread could not be created",
                        &error,
                    ));
                }
            };
            let mut inner = lock_unpoisoned(&self.inner);
            debug_assert_eq!(inner.dispatcher_lifecycle, DispatcherLifecycle::Starting);
            inner.dispatcher_thread = Some(thread);
            inner.dispatcher_lifecycle = DispatcherLifecycle::Running;
            self.changed.notify_all();
            return Ok(());
        }
    }

    fn dispatcher_loop(self: Arc<Self>) {
        let _thread_exit = ManagedThreadExit::new(&self, ManagedThreadKind::Dispatcher);
        {
            let mut inner = lock_unpoisoned(&self.inner);
            while inner.dispatcher_lifecycle == DispatcherLifecycle::Starting {
                inner = self
                    .changed
                    .wait(inner)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
        loop {
            let selection = {
                let mut inner = lock_unpoisoned(&self.inner);
                let selection = {
                    let EnvironmentInner {
                        registrations,
                        dispatcher_round,
                        ..
                    } = &mut *inner;
                    fair_round_dispatcher(registrations, dispatcher_round, DISPATCHER_WORK_QUANTUM)
                };
                if selection.entries.is_empty() {
                    if selection.scan_pending {
                        drop(inner);
                        continue;
                    }
                    if inner
                        .registrations
                        .values()
                        .any(RegistrationRecord::keeps_dispatcher_alive)
                    {
                        drop(
                            self.changed
                                .wait(inner)
                                .unwrap_or_else(|poisoned| poisoned.into_inner()),
                        );
                        continue;
                    }
                    inner.dispatcher_lifecycle = DispatcherLifecycle::Stopping;
                    self.changed.notify_all();
                    break;
                }
                selection
            };

            let mut made_progress = false;
            let mut pending_cleanup = false;
            for (_, work) in selection.entries {
                match work {
                    DispatcherWork::Delivery(state) => {
                        if let Some(state) = state.upgrade() {
                            made_progress |= state.dispatch_one();
                        }
                    }
                    DispatcherWork::Cleanup {
                        state,
                        coordination_error,
                    } => {
                        if let Some(error) = coordination_error {
                            state.note_cleanup_coordination_error(error);
                        }
                        let finished = state.advance_background_cleanup(false);
                        made_progress |= finished;
                        pending_cleanup |= !finished;
                    }
                }
            }

            if !selection.scan_pending && (!made_progress || pending_cleanup) {
                let inner = lock_unpoisoned(&self.inner);
                if inner.dispatcher_lifecycle == DispatcherLifecycle::Running {
                    let _ = self
                        .changed
                        .wait_timeout(inner, DISPATCHER_POLL)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
            }
        }
    }

    pub(crate) fn with_delivery_admission<T>(&self, operation: impl FnOnce(bool) -> T) -> T {
        let closing = lock_unpoisoned(&self.admission_closing);
        operation(*closing)
    }

    pub(crate) fn notify_dispatcher(&self) {
        self.changed.notify_all();
    }

    pub(crate) fn join_dispatcher_if_inactive(&self) -> NodeResult<()> {
        let thread = {
            let mut inner = lock_unpoisoned(&self.inner);
            loop {
                if inner
                    .registrations
                    .values()
                    .any(RegistrationRecord::keeps_dispatcher_alive)
                {
                    return Ok(());
                }
                match inner.dispatcher_lifecycle {
                    DispatcherLifecycle::Stopped => {
                        if inner.dispatcher_thread.is_some() {
                            inner.dispatcher_lifecycle = DispatcherLifecycle::Stopping;
                            break inner.dispatcher_thread.take();
                        }
                        break None;
                    }
                    DispatcherLifecycle::Starting
                    | DispatcherLifecycle::Running
                    | DispatcherLifecycle::Stopping => {
                        inner = self
                            .changed
                            .wait(inner)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                }
            }
        };
        let result = thread.map_or(Ok(()), |thread| {
            thread.join().map_err(|_| {
                NodeErrorDetails::internal(
                    Operation::Dispose,
                    "Node delivery dispatcher thread panicked",
                )
            })
        });
        let mut inner = lock_unpoisoned(&self.inner);
        if inner.dispatcher_lifecycle == DispatcherLifecycle::Stopping {
            inner.dispatcher_lifecycle = DispatcherLifecycle::Stopped;
        }
        self.changed.notify_all();
        result
    }

    pub(crate) fn join_cleanup_if_inactive(&self) -> NodeResult<()> {
        let thread = {
            let mut inner = lock_unpoisoned(&self.inner);
            loop {
                if inner
                    .registrations
                    .values()
                    .any(|registration| registration.cleanup_hold.is_some())
                {
                    return Ok(());
                }
                match inner.cleanup_lifecycle {
                    DispatcherLifecycle::Stopped => {
                        if inner.cleanup_thread.is_some() {
                            inner.cleanup_lifecycle = DispatcherLifecycle::Stopping;
                            break inner.cleanup_thread.take();
                        }
                        break None;
                    }
                    DispatcherLifecycle::Starting
                    | DispatcherLifecycle::Running
                    | DispatcherLifecycle::Stopping => {
                        inner = self
                            .changed
                            .wait(inner)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                    }
                }
            }
        };
        let result = thread.map_or(Ok(()), |thread| {
            thread.join().map_err(|_| {
                NodeErrorDetails::internal(
                    Operation::Dispose,
                    "Node cleanup coordinator thread panicked",
                )
            })
        });
        let mut inner = lock_unpoisoned(&self.inner);
        if inner.cleanup_lifecycle == DispatcherLifecycle::Stopping {
            inner.cleanup_lifecycle = DispatcherLifecycle::Stopped;
        }
        self.changed.notify_all();
        result
    }

    pub(crate) fn request_cleanup(self: &Arc<Self>) -> NodeResult<()> {
        loop {
            let finished = {
                let mut inner = lock_unpoisoned(&self.inner);
                match inner.cleanup_lifecycle {
                    DispatcherLifecycle::Running => {
                        self.changed.notify_all();
                        return Ok(());
                    }
                    DispatcherLifecycle::Starting | DispatcherLifecycle::Stopping => {
                        inner = self
                            .changed
                            .wait(inner)
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        drop(inner);
                        continue;
                    }
                    DispatcherLifecycle::Stopped => {
                        if inner.cleanup_thread.is_some() {
                            inner.cleanup_lifecycle = DispatcherLifecycle::Stopping;
                            inner.cleanup_thread.take()
                        } else {
                            inner.cleanup_round = FairRound::default();
                            inner.cleanup_lifecycle = DispatcherLifecycle::Starting;
                            None
                        }
                    }
                }
            };
            if let Some(finished) = finished {
                let result = finished.join().map_err(|_| {
                    NodeErrorDetails::internal(
                        Operation::Dispose,
                        "Node cleanup coordinator thread panicked",
                    )
                });
                let mut inner = lock_unpoisoned(&self.inner);
                inner.cleanup_lifecycle = DispatcherLifecycle::Stopped;
                self.changed.notify_all();
                result?;
                continue;
            }

            let environment = Arc::clone(self);
            let thread = match spawn_cleanup_coordinator(environment) {
                Ok(thread) => thread,
                Err(error) => {
                    let mut inner = lock_unpoisoned(&self.inner);
                    inner.cleanup_lifecycle = DispatcherLifecycle::Stopped;
                    self.changed.notify_all();
                    return Err(NodeErrorDetails::from_io(
                        crate::ErrorCode::ResourceUnavailable,
                        Operation::Dispose,
                        "Node cleanup coordinator thread could not be created",
                        &error,
                    ));
                }
            };
            let mut inner = lock_unpoisoned(&self.inner);
            inner.cleanup_thread = Some(thread);
            inner.cleanup_lifecycle = DispatcherLifecycle::Running;
            self.changed.notify_all();
            return Ok(());
        }
    }

    fn cleanup_loop(self: Arc<Self>) {
        let _thread_exit = ManagedThreadExit::new(&self, ManagedThreadKind::Cleanup);
        {
            let mut inner = lock_unpoisoned(&self.inner);
            while inner.cleanup_lifecycle == DispatcherLifecycle::Starting {
                inner = self
                    .changed
                    .wait(inner)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
        loop {
            let selection = {
                let mut inner = lock_unpoisoned(&self.inner);
                let EnvironmentInner {
                    registrations,
                    cleanup_round,
                    ..
                } = &mut *inner;
                fair_round_cleanup(registrations, cleanup_round, DISPATCHER_WORK_QUANTUM)
            };
            if selection.entries.is_empty() {
                if selection.scan_pending {
                    continue;
                }
                let mut inner = lock_unpoisoned(&self.inner);
                if !inner
                    .registrations
                    .values()
                    .any(|registration| registration.cleanup_hold.is_some())
                {
                    inner.cleanup_lifecycle = DispatcherLifecycle::Stopping;
                    self.changed.notify_all();
                    break;
                }
                let _ = self
                    .changed
                    .wait_timeout(inner, DISPATCHER_POLL)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                continue;
            }

            let mut pending = false;
            for (_, state) in selection.entries {
                pending |= !state.advance_background_cleanup(true);
            }
            if !selection.scan_pending && pending {
                let inner = lock_unpoisoned(&self.inner);
                let _ = self
                    .changed
                    .wait_timeout(inner, DISPATCHER_POLL)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }
    }

    fn begin_environment_teardown(self: &Arc<Self>) {
        let mut needs_cleanup = false;
        {
            let mut closing = lock_unpoisoned(&self.admission_closing);
            *closing = true;
            let mut inner = lock_unpoisoned(&self.inner);
            inner.lifecycle = EnvironmentLifecycle::Closing;
            for registration in inner.registrations.values_mut() {
                registration.pending_establishment = false;
                if let Some(shutdown) = registration.shutdown.upgrade() {
                    shutdown.signal_environment_teardown_under_admission_barrier();
                }
                if let Some(threadsafe_function) = registration.threadsafe_function.upgrade() {
                    let _ = threadsafe_function.release(true);
                }
                let state = registration.state.as_ref().and_then(Weak::upgrade);
                if let Some(state) = state {
                    state.abort_delivery_for_environment();
                    if registration.cleanup_hold.is_none() {
                        state.mark_environment_cleanup_requested();
                        registration.cleanup_hold = Some(state);
                    }
                    registration.cleanup_keepalive = true;
                    needs_cleanup = true;
                }
                if registration.active {
                    registration.active = false;
                    ACTIVE_REGISTRATIONS.fetch_sub(1, Ordering::AcqRel);
                }
            }
            self.changed.notify_all();
        }
        if needs_cleanup {
            match self.request_cleanup() {
                Ok(()) => self.assign_environment_cleanup_to_coordinator(),
                Err(error) => self.assign_environment_cleanup_to_dispatcher(error),
            }
        }
    }

    pub(crate) fn environment_closing(&self) -> bool {
        *lock_unpoisoned(&self.admission_closing)
    }

    fn assign_environment_cleanup_to_coordinator(&self) {
        let mut inner = lock_unpoisoned(&self.inner);
        for registration in inner.registrations.values_mut() {
            if registration.cleanup_hold.is_some() {
                registration.assign_cleanup_to_coordinator();
            }
        }
        self.changed.notify_all();
    }

    fn assign_environment_cleanup_to_dispatcher(&self, error: NodeErrorDetails) {
        let mut inner = lock_unpoisoned(&self.inner);
        for registration in inner.registrations.values_mut() {
            if registration.cleanup_hold.is_some() {
                registration.assign_cleanup_to_dispatcher(error.clone());
            }
        }
        self.changed.notify_all();
    }
}

fn spawn_dispatcher(environment: Arc<EnvironmentRecord>) -> io::Result<JoinHandle<()>> {
    #[cfg(test)]
    if environment
        .fail_next_dispatcher_spawn
        .swap(false, Ordering::AcqRel)
    {
        return Err(io::Error::other(
            "injected delivery dispatcher creation failure",
        ));
    }
    std::thread::Builder::new()
        .name("watchbound-node-dispatcher".to_owned())
        .spawn(move || environment.dispatcher_loop())
}

fn spawn_cleanup_coordinator(environment: Arc<EnvironmentRecord>) -> io::Result<JoinHandle<()>> {
    #[cfg(test)]
    if FAIL_NEXT_CLEANUP_COORDINATOR_SPAWN.swap(false, Ordering::AcqRel) {
        return Err(io::Error::other(
            "injected cleanup coordinator creation failure",
        ));
    }
    std::thread::Builder::new()
        .name("watchbound-node-cleanup".to_owned())
        .spawn(move || environment.cleanup_loop())
}

enum DispatcherWork {
    Delivery(Weak<SubscriptionState>),
    Cleanup {
        state: Arc<SubscriptionState>,
        coordination_error: Option<NodeErrorDetails>,
    },
}

struct FairSelection<T> {
    entries: Vec<(u64, T)>,
    scan_pending: bool,
}

fn fair_round_dispatcher(
    registrations: &BTreeMap<u64, RegistrationRecord>,
    round: &mut FairRound,
    limit: usize,
) -> FairSelection<DispatcherWork> {
    fair_round_entries(registrations, round, limit, |registration| {
        if registration.dispatcher_cleanup {
            registration
                .cleanup_hold
                .as_ref()
                .map(|state| DispatcherWork::Cleanup {
                    state: Arc::clone(state),
                    coordination_error: registration.cleanup_coordination_error.clone(),
                })
        } else {
            registration
                .active
                .then(|| registration.state.clone())
                .flatten()
                .map(DispatcherWork::Delivery)
        }
    })
}

fn fair_round_cleanup(
    registrations: &BTreeMap<u64, RegistrationRecord>,
    round: &mut FairRound,
    limit: usize,
) -> FairSelection<Arc<SubscriptionState>> {
    fair_round_entries(registrations, round, limit, |registration| {
        registration.cleanup_hold.as_ref().map(Arc::clone)
    })
}

fn fair_round_entries<T>(
    registrations: &BTreeMap<u64, RegistrationRecord>,
    round: &mut FairRound,
    limit: usize,
    select: impl Fn(&RegistrationRecord) -> Option<T>,
) -> FairSelection<T> {
    if limit == 0 || registrations.is_empty() {
        return FairSelection {
            entries: Vec::new(),
            scan_pending: false,
        };
    }

    let mut initialized_round = false;
    let mut inspected = 0;
    let mut selected = Vec::with_capacity(limit.min(registrations.len()));
    loop {
        if round.upper_bound.is_none() {
            round.upper_bound = registrations.keys().next_back().copied();
            round.cursor = None;
            initialized_round = true;
        }
        let Some(upper_bound) = round.upper_bound else {
            return FairSelection {
                entries: selected,
                scan_pending: false,
            };
        };
        let lower_bound = round.cursor.map_or(Bound::Unbounded, Bound::Excluded);
        for (registration_id, registration) in
            registrations.range((lower_bound, Bound::Included(upper_bound)))
        {
            round.cursor = Some(*registration_id);
            inspected += 1;
            if let Some(value) = select(registration) {
                selected.push((*registration_id, value));
            }
            if inspected == limit {
                let round_complete = *registration_id == upper_bound;
                if round_complete {
                    round.cursor = None;
                    round.upper_bound = None;
                }
                return FairSelection {
                    entries: selected,
                    scan_pending: !round_complete,
                };
            }
        }
        round.cursor = None;
        round.upper_bound = None;
        if !selected.is_empty() || initialized_round {
            return FairSelection {
                entries: selected,
                scan_pending: false,
            };
        }
    }
}

pub(crate) struct EnvironmentRegistration {
    environment: Arc<EnvironmentRecord>,
    registration_id: u64,
    published: bool,
}

impl EnvironmentRegistration {
    pub(crate) fn environment(&self) -> Arc<EnvironmentRecord> {
        Arc::clone(&self.environment)
    }

    pub(crate) fn publish(&mut self, state: &Arc<SubscriptionState>) -> NodeResult<()> {
        self.environment.publish(self.registration_id, state)?;
        self.published = true;
        Ok(())
    }

    pub(crate) fn attach_threadsafe_function(
        &self,
        threadsafe_function: &Arc<RawBatchThreadsafeFunction>,
    ) -> NodeResult<()> {
        self.attach_threadsafe_function_weak(Arc::downgrade(threadsafe_function))
    }

    fn attach_threadsafe_function_weak(
        &self,
        threadsafe_function: Weak<RawBatchThreadsafeFunction>,
    ) -> NodeResult<()> {
        let closing = lock_unpoisoned(&self.environment.admission_closing);
        let mut inner = lock_unpoisoned(&self.environment.inner);
        if *closing || inner.lifecycle != EnvironmentLifecycle::Running {
            return Err(NodeErrorDetails::operation_interrupted(
                Operation::Subscribe,
                "Node environment teardown interrupted callback bridge setup",
            ));
        }
        let registration = inner
            .registrations
            .get_mut(&self.registration_id)
            .ok_or_else(|| {
                NodeErrorDetails::internal(
                    Operation::Subscribe,
                    "pending Node environment registration disappeared during callback bridge setup",
                )
            })?;
        registration.threadsafe_function = threadsafe_function;
        Ok(())
    }

    pub(crate) fn deactivate(&self) {
        if self.published {
            self.environment.deactivate(self.registration_id, true);
        }
    }

    pub(crate) fn begin_background_cleanup(&self, state: &Arc<SubscriptionState>) -> bool {
        let mut inner = lock_unpoisoned(&self.environment.inner);
        let Some(registration) = inner.registrations.get_mut(&self.registration_id) else {
            return false;
        };
        if registration.cleanup_hold.is_some() {
            return false;
        }
        registration.cleanup_hold = Some(Arc::clone(state));
        registration.pending_establishment = false;
        registration.cleanup_keepalive = true;
        if registration.active {
            registration.active = false;
            ACTIVE_REGISTRATIONS.fetch_sub(1, Ordering::AcqRel);
        }
        self.environment.changed.notify_all();
        true
    }

    pub(crate) fn coordinator_ready(&self) {
        let mut inner = lock_unpoisoned(&self.environment.inner);
        if let Some(registration) = inner.registrations.get_mut(&self.registration_id) {
            registration.assign_cleanup_to_coordinator();
        }
        self.environment.changed.notify_all();
    }

    pub(crate) fn coordinator_failed(&self, error: NodeErrorDetails) {
        let mut inner = lock_unpoisoned(&self.environment.inner);
        if let Some(registration) = inner.registrations.get_mut(&self.registration_id) {
            registration.assign_cleanup_to_dispatcher(error);
        }
        self.environment.changed.notify_all();
    }

    pub(crate) fn prepare_engine_cleanup(&self, join_dispatcher: bool) -> Option<NodeErrorDetails> {
        let mut inner = lock_unpoisoned(&self.environment.inner);
        let coordination_error =
            inner
                .registrations
                .get_mut(&self.registration_id)
                .and_then(|registration| {
                    registration.pending_establishment = false;
                    registration.cleanup_keepalive = false;
                    // A cleanup coordinator or explicit disposer can clear the
                    // dispatcher fallback before joining it. The dispatcher
                    // fallback cannot surrender its own selection/liveness
                    // marker until callback quiescence permits finalization;
                    // doing so would leave no thread able to advance cleanup.
                    if join_dispatcher {
                        registration.dispatcher_cleanup = false;
                    }
                    registration.cleanup_coordination_error.clone()
                });
        self.environment.changed.notify_all();
        coordination_error
    }
}

impl Drop for EnvironmentRegistration {
    fn drop(&mut self) {
        self.environment.remove(self.registration_id);
    }
}

struct GlobalEnvironmentRegistry {
    next_environment_id: u64,
    records: HashMap<usize, Arc<EnvironmentRecord>>,
}

impl GlobalEnvironmentRegistry {
    fn new() -> Self {
        Self {
            next_environment_id: 1,
            records: HashMap::new(),
        }
    }

    fn allocate_environment_id(&mut self) -> NodeResult<u64> {
        let environment_id = self.next_environment_id;
        self.next_environment_id = self.next_environment_id.checked_add(1).ok_or_else(|| {
            NodeErrorDetails::internal(
                Operation::Subscribe,
                "Node environment generation IDs exhausted",
            )
        })?;
        ENVIRONMENT_GENERATIONS.store(environment_id, Ordering::Release);
        Ok(environment_id)
    }
}

static ENVIRONMENTS: OnceLock<Mutex<GlobalEnvironmentRegistry>> = OnceLock::new();

fn environments() -> &'static Mutex<GlobalEnvironmentRegistry> {
    ENVIRONMENTS.get_or_init(|| Mutex::new(GlobalEnvironmentRegistry::new()))
}

struct EnvironmentCleanupHook {
    raw_key: usize,
    environment_id: u64,
    record: Arc<EnvironmentRecord>,
}

pub(crate) fn environment_for(env: &Env) -> NodeResult<Arc<EnvironmentRecord>> {
    let raw_key = env.raw() as usize;
    let (environment, created) = {
        let mut registry = lock_unpoisoned(environments());
        if let Some(environment) = registry.records.get(&raw_key) {
            (Arc::clone(environment), false)
        } else {
            let environment_id = registry.allocate_environment_id()?;
            let environment = Arc::new(EnvironmentRecord::new(environment_id));
            registry.records.insert(raw_key, Arc::clone(&environment));
            (environment, true)
        }
    };

    if created {
        let hook = EnvironmentCleanupHook {
            raw_key,
            environment_id: environment.id,
            record: Arc::clone(&environment),
        };
        if let Err(error) = env.add_env_cleanup_hook(hook, cleanup_environment) {
            let details = NodeErrorDetails::from_napi(
                crate::ErrorCode::Internal,
                Operation::Subscribe,
                "Node environment cleanup hook could not be registered",
                error,
            );
            {
                let mut registry = lock_unpoisoned(environments());
                if registry
                    .records
                    .get(&raw_key)
                    .is_some_and(|candidate| Arc::ptr_eq(candidate, &environment))
                {
                    registry.records.remove(&raw_key);
                }
            }
            environment.mark_startup_failed(details.clone());
            return Err(details);
        }
        environment.mark_running();
    } else {
        environment.wait_until_running()?;
    }

    Ok(environment)
}

fn cleanup_environment(hook: EnvironmentCleanupHook) {
    {
        let mut registry = lock_unpoisoned(environments());
        if registry
            .records
            .get(&hook.raw_key)
            .is_some_and(|candidate| {
                candidate.id == hook.environment_id && Arc::ptr_eq(candidate, &hook.record)
            })
        {
            registry.records.remove(&hook.raw_key);
        }
    }
    hook.record.begin_environment_teardown();
}

pub(crate) struct DeliveryState {
    environment: Weak<EnvironmentRecord>,
    state: Mutex<Weak<SubscriptionState>>,
    slot: Mutex<Option<ChangeBatch>>,
    admission: Mutex<DeliveryAdmission>,
    drained: Condvar,
    threadsafe_function_finalized: Mutex<bool>,
    finalized: Condvar,
    callback_errors: AtomicU64,
    bridge_delivery_errors: AtomicU64,
    delivery_error: Mutex<Option<NodeErrorDetails>>,
}

struct DeliveryAdmission {
    open: bool,
    credit: bool,
    outstanding_callbacks: usize,
}

impl DeliveryState {
    pub(crate) fn new(environment: &Arc<EnvironmentRecord>) -> Arc<Self> {
        Arc::new(Self {
            environment: Arc::downgrade(environment),
            state: Mutex::new(Weak::new()),
            slot: Mutex::new(None),
            admission: Mutex::new(DeliveryAdmission {
                open: true,
                credit: true,
                outstanding_callbacks: 0,
            }),
            drained: Condvar::new(),
            threadsafe_function_finalized: Mutex::new(false),
            finalized: Condvar::new(),
            callback_errors: AtomicU64::new(0),
            bridge_delivery_errors: AtomicU64::new(0),
            delivery_error: Mutex::new(None),
        })
    }

    pub(crate) fn attach_state(&self, state: &Arc<SubscriptionState>) {
        *lock_unpoisoned(&self.state) = Arc::downgrade(state);
    }

    pub(crate) fn callback_errors(&self) -> u64 {
        self.callback_errors.load(Ordering::Relaxed)
    }

    pub(crate) fn bridge_delivery_errors(&self) -> u64 {
        self.bridge_delivery_errors.load(Ordering::Relaxed)
    }

    pub(crate) fn delivery_error(&self) -> Option<NodeErrorDetails> {
        lock_unpoisoned(&self.delivery_error).clone()
    }

    pub(crate) fn close_admission(&self) {
        if let Some(environment) = self.environment.upgrade() {
            environment.with_delivery_admission(|_| {
                self.close_admission_with_barrier_held();
            });
            environment.notify_dispatcher();
        } else {
            self.close_admission_with_barrier_held();
        }
    }

    pub(crate) fn close_admission_with_barrier_held(&self) {
        lock_unpoisoned(&self.admission).open = false;
    }

    pub(crate) fn can_receive(&self) -> bool {
        let Some(environment) = self.environment.upgrade() else {
            return false;
        };
        environment.with_delivery_admission(|environment_closing| {
            let admission = lock_unpoisoned(&self.admission);
            !environment_closing && admission.open && admission.credit
        })
    }

    pub(crate) fn try_admit(
        &self,
        batch: ChangeBatch,
        threadsafe_function: &RawBatchThreadsafeFunction,
    ) -> bool {
        self.try_admit_with(batch, || threadsafe_function.call())
    }

    fn try_admit_with(&self, batch: ChangeBatch, wake: impl FnOnce() -> Status) -> bool {
        let Some(environment) = self.environment.upgrade() else {
            return false;
        };
        let status = environment.with_delivery_admission(|environment_closing| {
            let mut admission = lock_unpoisoned(&self.admission);
            if environment_closing || !admission.open || !admission.credit {
                return None;
            }
            {
                let mut slot = lock_unpoisoned(&self.slot);
                debug_assert!(slot.is_none(), "delivery credit existed with a full slot");
                *slot = Some(batch);
            }
            admission.credit = false;
            admission.outstanding_callbacks += 1;
            ACTIVE_OUTSTANDING_CALLBACKS.fetch_add(1, Ordering::AcqRel);

            let status = wake();
            if status == Status::Ok {
                return Some(Status::Ok);
            }

            lock_unpoisoned(&self.slot).take();
            self.rollback_failed_admission(&mut admission);
            Some(status)
        });
        match status {
            Some(Status::Ok) => true,
            Some(status) => {
                self.record_delivery_failure(status);
                false
            }
            None => false,
        }
    }

    fn rollback_failed_admission(&self, admission: &mut DeliveryAdmission) {
        admission.credit = true;
        admission.outstanding_callbacks = admission
            .outstanding_callbacks
            .checked_sub(1)
            .expect("delivery admission rolled back without an outstanding callback");
        ACTIVE_OUTSTANDING_CALLBACKS.fetch_sub(1, Ordering::AcqRel);
        self.drained.notify_all();
    }

    fn record_delivery_failure(&self, status: Status) {
        let error = NodeErrorDetails::delivery_failure(status);
        let mut stored = lock_unpoisoned(&self.delivery_error);
        if stored.is_some() {
            return;
        }
        *stored = Some(error);
        self.bridge_delivery_errors.fetch_add(1, Ordering::Relaxed);
        drop(stored);
        self.close_admission();
        if let Some(state) = lock_unpoisoned(&self.state).upgrade() {
            state.request_delivery_failure_cleanup();
        }
    }

    fn complete_wake(&self, callback_error: bool, delivery_status: Option<Status>) {
        lock_unpoisoned(&self.slot).take();
        {
            let mut admission = lock_unpoisoned(&self.admission);
            if admission.outstanding_callbacks != 0 {
                admission.outstanding_callbacks -= 1;
                ACTIVE_OUTSTANDING_CALLBACKS.fetch_sub(1, Ordering::AcqRel);
            }
            admission.credit = true;
            if callback_error {
                self.callback_errors.fetch_add(1, Ordering::Relaxed);
            }
        }
        self.drained.notify_all();
        if let Some(environment) = self.environment.upgrade() {
            environment.notify_dispatcher();
        }
        if let Some(status) = delivery_status {
            self.record_delivery_failure(status);
        }
    }

    pub(crate) fn outstanding_callbacks(&self) -> usize {
        lock_unpoisoned(&self.admission).outstanding_callbacks
    }

    pub(crate) fn wait_until_drained_or_environment_closing(&self) {
        loop {
            if self
                .environment
                .upgrade()
                .is_none_or(|environment| environment.environment_closing())
            {
                return;
            }
            let admission = lock_unpoisoned(&self.admission);
            if admission.outstanding_callbacks == 0 {
                return;
            }
            let (admission, _) = self
                .drained
                .wait_timeout(admission, DISPATCHER_POLL)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            drop(admission);
        }
    }

    pub(crate) fn wait_until_finalized_or_environment_closing(&self) {
        loop {
            if self
                .environment
                .upgrade()
                .is_none_or(|environment| environment.environment_closing())
            {
                return;
            }
            let finalized = lock_unpoisoned(&self.threadsafe_function_finalized);
            if *finalized {
                return;
            }
            let (finalized, _) = self
                .finalized
                .wait_timeout(finalized, DISPATCHER_POLL)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            drop(finalized);
        }
    }

    fn mark_threadsafe_function_finalized(&self) {
        *lock_unpoisoned(&self.threadsafe_function_finalized) = true;
        self.finalized.notify_all();
    }

    fn invoke_callback(&self, raw_env: sys::napi_env, callback: sys::napi_value) {
        if raw_env.is_null() || callback.is_null() {
            self.complete_wake(false, None);
            return;
        }
        let Some(batch) = lock_unpoisoned(&self.slot).take() else {
            self.complete_wake(false, Some(Status::GenericFailure));
            return;
        };
        let batch = match unsafe {
            <crate::JsChangeBatch as ToNapiValue>::to_napi_value(
                raw_env,
                crate::JsChangeBatch::from(batch),
            )
        } {
            Ok(batch) => batch,
            Err(error) => {
                clear_pending_exception(raw_env);
                self.complete_wake(false, Some(error.status));
                return;
            }
        };
        let mut receiver = ptr::null_mut();
        let undefined_status = unsafe { sys::napi_get_undefined(raw_env, &mut receiver) };
        if undefined_status != sys::Status::napi_ok {
            self.complete_wake(false, Some(Status::from(undefined_status)));
            return;
        }
        let mut return_value = ptr::null_mut();
        let call_status = unsafe {
            sys::napi_call_function(raw_env, receiver, callback, 1, &batch, &mut return_value)
        };
        if call_status == sys::Status::napi_pending_exception {
            clear_pending_exception(raw_env);
            self.complete_wake(true, None);
        } else if call_status == sys::Status::napi_ok {
            self.complete_wake(false, None);
        } else {
            self.complete_wake(false, Some(Status::from(call_status)));
        }
    }
}

fn clear_pending_exception(raw_env: sys::napi_env) {
    let mut pending = false;
    if unsafe { sys::napi_is_exception_pending(raw_env, &mut pending) } == sys::Status::napi_ok
        && pending
    {
        let mut exception = ptr::null_mut();
        let _ = unsafe { sys::napi_get_and_clear_last_exception(raw_env, &mut exception) };
    }
}

pub(crate) struct RawBatchThreadsafeFunction {
    raw: sys::napi_threadsafe_function,
    released: AtomicBool,
}

unsafe impl Send for RawBatchThreadsafeFunction {}
unsafe impl Sync for RawBatchThreadsafeFunction {}

impl RawBatchThreadsafeFunction {
    pub(crate) fn new(
        env: &Env,
        callback: &Function<'_, napi::bindgen_prelude::FnArgs<(crate::JsChangeBatch,)>, ()>,
        delivery: &Arc<DeliveryState>,
    ) -> NodeResult<Self> {
        let mut resource_name = ptr::null_mut();
        let name = b"watchbound delivery";
        let status = unsafe {
            sys::napi_create_string_utf8(
                env.raw(),
                name.as_ptr().cast(),
                name.len() as isize,
                &mut resource_name,
            )
        };
        if status != sys::Status::napi_ok {
            return Err(NodeErrorDetails::from_napi_status(
                crate::ErrorCode::ResourceUnavailable,
                Operation::Subscribe,
                Status::from(status),
                "Node delivery resource name could not be created",
            ));
        }

        let context = Arc::into_raw(Arc::clone(delivery))
            .cast_mut()
            .cast::<c_void>();
        let mut raw = ptr::null_mut();
        let status = unsafe {
            sys::napi_create_threadsafe_function(
                env.raw(),
                callback.raw(),
                ptr::null_mut(),
                resource_name,
                1,
                1,
                context,
                Some(finalize_delivery_context),
                context,
                Some(call_js_delivery),
                &mut raw,
            )
        };
        if status != sys::Status::napi_ok {
            drop(unsafe { Arc::<DeliveryState>::from_raw(context.cast()) });
            return Err(NodeErrorDetails::from_napi_status(
                crate::ErrorCode::ResourceUnavailable,
                Operation::Subscribe,
                Status::from(status),
                "Node callback bridge could not be created",
            ));
        }
        ACTIVE_THREADSAFE_FUNCTIONS.fetch_add(1, Ordering::AcqRel);
        Ok(Self {
            raw,
            released: AtomicBool::new(false),
        })
    }

    fn call(&self) -> Status {
        if self.released.load(Ordering::Acquire) {
            return Status::Closing;
        }
        Status::from(unsafe {
            sys::napi_call_threadsafe_function(
                self.raw,
                ptr::null_mut(),
                sys::ThreadsafeFunctionCallMode::blocking,
            )
        })
    }

    pub(crate) fn release(&self, abort: bool) -> Status {
        if self
            .released
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Status::Ok;
        }
        Status::from(unsafe {
            sys::napi_release_threadsafe_function(
                self.raw,
                if abort {
                    sys::ThreadsafeFunctionReleaseMode::abort
                } else {
                    sys::ThreadsafeFunctionReleaseMode::release
                },
            )
        })
    }
}

impl Drop for RawBatchThreadsafeFunction {
    fn drop(&mut self) {
        let _ = self.release(true);
    }
}

unsafe extern "C" fn finalize_delivery_context(
    _raw_env: sys::napi_env,
    finalize_data: *mut c_void,
    _finalize_hint: *mut c_void,
) {
    if finalize_data.is_null() {
        return;
    }
    let delivery = unsafe { Arc::<DeliveryState>::from_raw(finalize_data.cast()) };
    if delivery.outstanding_callbacks() != 0 {
        delivery.complete_wake(false, None);
    }
    ACTIVE_THREADSAFE_FUNCTIONS.fetch_sub(1, Ordering::AcqRel);
    delivery.mark_threadsafe_function_finalized();
}

unsafe extern "C" fn call_js_delivery(
    raw_env: sys::napi_env,
    callback: sys::napi_value,
    context: *mut c_void,
    _data: *mut c_void,
) {
    if context.is_null() {
        return;
    }
    let delivery = unsafe { &*context.cast::<DeliveryState>() };
    let invocation = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        delivery.invoke_callback(raw_env, callback);
    }));
    if invocation.is_err() {
        delivery.complete_wake(false, Some(Status::GenericFailure));
    }
}

pub(crate) fn cleanup_request_started() {
    ACTIVE_CLEANUP_REQUESTS.fetch_add(1, Ordering::AcqRel);
}

pub(crate) fn cleanup_request_finished() {
    ACTIVE_CLEANUP_REQUESTS.fetch_sub(1, Ordering::AcqRel);
}

#[cfg(test)]
mod tests {
    use super::*;
    use watchbound_engine::{Coverage, RootAttachment, RootIdentity, RootState};

    static CLEANUP_SPAWN_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn test_registration(active: bool) -> RegistrationRecord {
        RegistrationRecord {
            shutdown: Weak::new(),
            state: Some(Weak::new()),
            threadsafe_function: Weak::new(),
            cleanup_hold: None,
            cleanup_coordination_error: None,
            pending_establishment: false,
            cleanup_keepalive: false,
            dispatcher_cleanup: false,
            active,
        }
    }

    fn test_shutdown() -> Arc<ShutdownGate> {
        Arc::new(ShutdownGate::new(Arc::new(
            crate::EstablishmentAttempt::new().unwrap(),
        )))
    }

    #[test]
    fn dispatcher_spawn_failure_removes_the_pending_placeholder() {
        let environment = Arc::new(EnvironmentRecord::new(11));
        environment.mark_running();
        environment
            .fail_next_dispatcher_spawn
            .store(true, Ordering::Release);

        let error = match environment.register(&test_shutdown()) {
            Ok(_) => panic!("injected dispatcher creation unexpectedly succeeded"),
            Err(error) => error,
        };
        assert_eq!(error.code, crate::ErrorCode::ResourceUnavailable);
        assert_eq!(error.operation, Operation::Subscribe);
        let inner = lock_unpoisoned(&environment.inner);
        assert!(inner.registrations.is_empty());
        assert_eq!(inner.dispatcher_lifecycle, DispatcherLifecycle::Stopped);
        assert!(inner.dispatcher_thread.is_none());
    }

    #[test]
    fn pending_placeholder_without_a_threadsafe_function_is_teardown_safe() {
        let environment = Arc::new(EnvironmentRecord::new(13));
        environment.mark_running();
        let shutdown = test_shutdown();
        let registration = environment.register(&shutdown).unwrap();
        {
            let inner = lock_unpoisoned(&environment.inner);
            let record = inner
                .registrations
                .get(&registration.registration_id)
                .unwrap();
            assert!(record.pending_establishment);
            assert!(record.threadsafe_function.upgrade().is_none());
        }

        environment.begin_environment_teardown();
        assert!(shutdown.stop.load(Ordering::Acquire));
        assert!(shutdown.environment_closing.load(Ordering::Acquire));
        let attach_error = registration
            .attach_threadsafe_function_weak(Weak::new())
            .unwrap_err();
        assert_eq!(attach_error.code, crate::ErrorCode::OperationInterrupted);
        assert_eq!(attach_error.operation, Operation::Subscribe);
        {
            let inner = lock_unpoisoned(&environment.inner);
            let record = inner
                .registrations
                .get(&registration.registration_id)
                .unwrap();
            assert!(!record.pending_establishment);
            assert!(record.threadsafe_function.upgrade().is_none());
        }

        drop(registration);
        environment.join_dispatcher_if_inactive().unwrap();
        let inner = lock_unpoisoned(&environment.inner);
        assert!(inner.registrations.is_empty());
        assert_eq!(inner.dispatcher_lifecycle, DispatcherLifecycle::Stopped);
        assert!(inner.dispatcher_thread.is_none());
    }

    #[test]
    fn checked_environment_ids_never_reuse_the_terminal_value() {
        let mut registry = GlobalEnvironmentRegistry {
            next_environment_id: u64::MAX - 1,
            records: HashMap::new(),
        };
        assert_eq!(registry.allocate_environment_id().unwrap(), u64::MAX - 1);
        assert!(registry.allocate_environment_id().is_err());
    }

    #[test]
    fn fair_round_refreshes_from_the_terminal_registration_id_without_overflow() {
        let registrations = [1, 2, u64::MAX]
            .into_iter()
            .map(|registration_id| (registration_id, test_registration(true)))
            .collect();
        let mut round = FairRound {
            cursor: Some(u64::MAX),
            upper_bound: Some(u64::MAX),
        };
        let selected = fair_round_entries(&registrations, &mut round, 2, |_| Some(()));
        assert_eq!(
            selected
                .entries
                .into_iter()
                .map(|(registration_id, _)| registration_id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn fair_round_repairs_its_cursor_across_removed_entries() {
        let registrations = [1, 3, 4]
            .into_iter()
            .map(|registration_id| (registration_id, test_registration(true)))
            .collect();
        let mut round = FairRound {
            cursor: Some(2),
            upper_bound: Some(4),
        };
        let selected = fair_round_entries(&registrations, &mut round, 3, |_| Some(()));
        assert_eq!(
            selected
                .entries
                .into_iter()
                .map(|(registration_id, _)| registration_id)
                .collect::<Vec<_>>(),
            vec![3, 4]
        );
        let next = fair_round_entries(&registrations, &mut round, 3, |_| Some(()));
        assert_eq!(
            next.entries
                .into_iter()
                .map(|(registration_id, _)| registration_id)
                .collect::<Vec<_>>(),
            vec![1, 3, 4]
        );
    }

    #[test]
    fn frozen_round_fence_prevents_new_higher_ids_from_starving_an_old_low_id() {
        let mut registrations = (1..=8)
            .map(|registration_id| (registration_id, test_registration(true)))
            .collect::<BTreeMap<_, _>>();
        let mut round = FairRound {
            cursor: Some(1),
            upper_bound: Some(8),
        };

        let mut selected_ids = Vec::new();
        for new_registration_id in 9..=16 {
            registrations.insert(new_registration_id, test_registration(true));
            let selected = fair_round_entries(&registrations, &mut round, 1, |_| Some(()));
            selected_ids.push(selected.entries[0].0);
        }
        assert_eq!(
            selected_ids,
            vec![2, 3, 4, 5, 6, 7, 8, 1],
            "continually admitted higher IDs bypassed the old low ID at the frozen round boundary"
        );
    }

    #[test]
    fn fair_round_caps_inspected_inactive_entries_per_turn() {
        let registrations = (1..=(DISPATCHER_WORK_QUANTUM as u64 + 9))
            .map(|registration_id| (registration_id, test_registration(false)))
            .collect::<BTreeMap<_, _>>();
        let mut round = FairRound::default();

        let selected =
            fair_round_entries(&registrations, &mut round, DISPATCHER_WORK_QUANTUM, |_| {
                None::<()>
            });
        assert!(selected.entries.is_empty());
        assert!(selected.scan_pending);
        assert_eq!(round.cursor, Some(DISPATCHER_WORK_QUANTUM as u64));
    }

    #[test]
    fn fair_round_exact_quantum_reports_the_round_complete() {
        let registrations = (1..=DISPATCHER_WORK_QUANTUM as u64)
            .map(|registration_id| (registration_id, test_registration(false)))
            .collect::<BTreeMap<_, _>>();
        let mut round = FairRound::default();

        let selected =
            fair_round_entries(&registrations, &mut round, DISPATCHER_WORK_QUANTUM, |_| {
                None::<()>
            });
        assert!(selected.entries.is_empty());
        assert!(!selected.scan_pending);
        assert_eq!(round.cursor, None);
        assert_eq!(round.upper_bound, None);
    }

    #[test]
    fn fair_round_exact_multiple_completes_on_the_last_quantum() {
        let registrations = (1..=(DISPATCHER_WORK_QUANTUM as u64 * 2))
            .map(|registration_id| (registration_id, test_registration(false)))
            .collect::<BTreeMap<_, _>>();
        let mut round = FairRound::default();

        let first = fair_round_entries(&registrations, &mut round, DISPATCHER_WORK_QUANTUM, |_| {
            None::<()>
        });
        assert!(first.entries.is_empty());
        assert!(first.scan_pending);
        assert_eq!(round.cursor, Some(DISPATCHER_WORK_QUANTUM as u64));

        let second =
            fair_round_entries(&registrations, &mut round, DISPATCHER_WORK_QUANTUM, |_| {
                None::<()>
            });
        assert!(second.entries.is_empty());
        assert!(!second.scan_pending);
        assert_eq!(round.cursor, None);
        assert_eq!(round.upper_bound, None);
    }

    #[test]
    fn cleanup_spawn_failure_has_a_terminal_dispatcher_fallback_transition() {
        let _spawn_test = lock_unpoisoned(&CLEANUP_SPAWN_TEST_LOCK);
        let environment = Arc::new(EnvironmentRecord::new(23));
        environment.mark_running();
        FAIL_NEXT_CLEANUP_COORDINATOR_SPAWN.store(true, Ordering::Release);

        let error = environment.request_cleanup().unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::ResourceUnavailable);
        assert_eq!(error.operation, Operation::Dispose);
        let inner = lock_unpoisoned(&environment.inner);
        assert_eq!(inner.cleanup_lifecycle, DispatcherLifecycle::Stopped);
        assert!(inner.cleanup_thread.is_none());
        drop(inner);

        let mut registration = test_registration(false);
        registration.cleanup_keepalive = true;
        registration.assign_cleanup_to_dispatcher(error.clone());
        assert!(!registration.cleanup_keepalive);
        assert!(registration.dispatcher_cleanup);
        assert_eq!(
            registration
                .cleanup_coordination_error
                .as_ref()
                .map(|stored| stored.code),
            Some(error.code)
        );
    }

    #[test]
    fn dispatcher_fallback_stays_live_until_an_outstanding_callback_is_quiescent() {
        let environment = Arc::new(EnvironmentRecord::new(29));
        environment.mark_running();
        let delivery = DeliveryState::new(&environment);
        let outstanding_before = diagnostics().outstanding_callbacks;
        let batch = ChangeBatch {
            sequence: 1,
            exclusion_generation: 0,
            root_state: RootState {
                generation: 0,
                identity: RootIdentity {
                    device: 1,
                    inode: 2,
                },
                attachment: RootAttachment::Attached,
                loss_evidence: None,
            },
            invalidated_paths: Vec::new(),
            coverage: Coverage::Complete,
        };
        assert!(delivery.try_admit_with(batch, || Status::Ok));
        assert_eq!(delivery.outstanding_callbacks(), 1);

        let coordination_error =
            NodeErrorDetails::internal(Operation::Dispose, "injected cleanup coordinator failure");
        let registration_id = 1;
        {
            let mut inner = lock_unpoisoned(&environment.inner);
            let mut record = test_registration(false);
            record.cleanup_keepalive = true;
            record.assign_cleanup_to_dispatcher(coordination_error.clone());
            inner.registrations.insert(registration_id, record);
        }
        let registration = EnvironmentRegistration {
            environment: Arc::clone(&environment),
            registration_id,
            published: true,
        };

        assert_eq!(
            registration
                .prepare_engine_cleanup(false)
                .map(|error| error.message),
            Some(coordination_error.message.clone())
        );
        {
            let inner = lock_unpoisoned(&environment.inner);
            let record = inner.registrations.get(&registration_id).unwrap();
            assert!(
                record.dispatcher_cleanup && record.keeps_dispatcher_alive(),
                "dispatcher-owned cleanup surrendered its only progress marker while a callback remained"
            );
        }

        assert_eq!(
            registration
                .prepare_engine_cleanup(true)
                .map(|error| error.message),
            Some(coordination_error.message)
        );
        {
            let inner = lock_unpoisoned(&environment.inner);
            let record = inner.registrations.get(&registration_id).unwrap();
            assert!(
                !record.dispatcher_cleanup && !record.keeps_dispatcher_alive(),
                "an explicit disposer taking ownership did not release the fallback dispatcher"
            );
        }

        delivery.complete_wake(false, None);
        assert_eq!(delivery.outstanding_callbacks(), 0);
        assert_eq!(diagnostics().outstanding_callbacks, outstanding_before);
        drop(registration);
        assert!(lock_unpoisoned(&environment.inner).registrations.is_empty());
    }

    #[test]
    fn post_finalization_join_consumes_a_late_dispatcher_fallback_assignment() {
        let environment = Arc::new(EnvironmentRecord::new(31));
        environment.mark_running();
        let registration_id = 1;
        let guard_id = 2;
        {
            let mut inner = lock_unpoisoned(&environment.inner);
            let mut registration = test_registration(false);
            registration.pending_establishment = true;
            inner.registrations.insert(registration_id, registration);
            let mut guard = test_registration(false);
            guard.pending_establishment = true;
            inner.registrations.insert(guard_id, guard);
        }
        environment.ensure_dispatcher().unwrap();
        let registration = EnvironmentRegistration {
            environment: Arc::clone(&environment),
            registration_id,
            published: true,
        };

        assert!(registration.prepare_engine_cleanup(true).is_none());
        registration.coordinator_failed(NodeErrorDetails::internal(
            Operation::Dispose,
            "injected late cleanup coordinator failure",
        ));
        environment.remove(guard_id);
        {
            let inner = lock_unpoisoned(&environment.inner);
            let record = inner.registrations.get(&registration_id).unwrap();
            assert!(record.dispatcher_cleanup && record.keeps_dispatcher_alive());
        }

        // Subscription finalization removes the record before the explicit
        // owner's second join, so the resurrected fallback marker can no
        // longer make that join return early.
        drop(registration);
        environment.join_dispatcher_if_inactive().unwrap();
        let inner = lock_unpoisoned(&environment.inner);
        assert_eq!(inner.dispatcher_lifecycle, DispatcherLifecycle::Stopped);
        assert!(inner.dispatcher_thread.is_none());
    }

    #[test]
    fn inactive_cleanup_coordinator_is_joined() {
        let _spawn_test = lock_unpoisoned(&CLEANUP_SPAWN_TEST_LOCK);
        let environment = Arc::new(EnvironmentRecord::new(37));
        environment.mark_running();
        environment.request_cleanup().unwrap();
        environment.join_cleanup_if_inactive().unwrap();
        let inner = lock_unpoisoned(&environment.inner);
        assert_eq!(inner.cleanup_lifecycle, DispatcherLifecycle::Stopped);
        assert!(inner.cleanup_thread.is_none());
    }

    #[test]
    fn unexpected_non_ok_wake_balances_credit_and_closes_without_relocking_barrier() {
        let environment = Arc::new(EnvironmentRecord::new(17));
        environment.mark_running();
        let delivery = DeliveryState::new(&environment);
        let outstanding_before = diagnostics().outstanding_callbacks;
        let batch = ChangeBatch {
            sequence: 1,
            exclusion_generation: 0,
            root_state: RootState {
                generation: 0,
                identity: RootIdentity {
                    device: 1,
                    inode: 2,
                },
                attachment: RootAttachment::Attached,
                loss_evidence: None,
            },
            invalidated_paths: Vec::new(),
            coverage: Coverage::Complete,
        };

        assert!(!delivery.try_admit_with(batch, || Status::Closing));
        assert_eq!(delivery.bridge_delivery_errors(), 1);
        assert_eq!(delivery.outstanding_callbacks(), 0);
        assert_eq!(diagnostics().outstanding_callbacks, outstanding_before);
        assert!(!delivery.can_receive());
        assert!(lock_unpoisoned(&delivery.slot).is_none());
        delivery.record_delivery_failure(Status::GenericFailure);
        assert_eq!(
            delivery.bridge_delivery_errors(),
            1,
            "one failed wake was counted more than once"
        );
    }
}
