use std::ffi::c_void;
use std::ptr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use napi::bindgen_prelude::PromiseRaw;
use napi::{Env, JsError, Status, sys};
use watchbound_engine::{ErrorCode, Operation};

use crate::delivery::EnvironmentRecord;
use crate::{NodeErrorDetails, NodeResult, sync_error};

struct DisposeCompletionContext {
    deferred: sys::napi_deferred,
    released: Arc<AtomicBool>,
}

struct DisposeCompletionData {
    completion: Arc<RawDisposeCompletion>,
    environment: Arc<EnvironmentRecord>,
    result: NodeResult<()>,
}

/// One environment-bound, one-shot bridge from the shared cleanup coordinator
/// back to the JavaScript Promise returned by `NativeSubscription.dispose()`.
pub(crate) struct RawDisposeCompletion {
    raw: sys::napi_threadsafe_function,
    released: Arc<AtomicBool>,
    queued: AtomicBool,
}

unsafe impl Send for RawDisposeCompletion {}
unsafe impl Sync for RawDisposeCompletion {}

impl RawDisposeCompletion {
    pub(crate) fn new(env: &Env) -> NodeResult<(Arc<Self>, PromiseRaw<'static, ()>)> {
        let mut deferred = ptr::null_mut();
        let mut promise = ptr::null_mut();
        let status = unsafe { sys::napi_create_promise(env.raw(), &mut deferred, &mut promise) };
        if status != sys::Status::napi_ok {
            return Err(dispose_bridge_error(
                status,
                "Node disposal Promise could not be created",
            ));
        }

        let resource_name_bytes = b"watchbound disposal completion";
        let mut resource_name = ptr::null_mut();
        let status = unsafe {
            sys::napi_create_string_utf8(
                env.raw(),
                resource_name_bytes.as_ptr().cast(),
                resource_name_bytes.len() as isize,
                &mut resource_name,
            )
        };
        if status != sys::Status::napi_ok {
            return Err(dispose_bridge_error(
                status,
                "Node disposal completion resource name could not be created",
            ));
        }

        let released = Arc::new(AtomicBool::new(false));
        let context = Box::into_raw(Box::new(DisposeCompletionContext {
            deferred,
            released: Arc::clone(&released),
        }));
        let mut raw = ptr::null_mut();
        let status = unsafe {
            sys::napi_create_threadsafe_function(
                env.raw(),
                ptr::null_mut(),
                ptr::null_mut(),
                resource_name,
                1,
                1,
                context.cast(),
                Some(finalize_dispose_completion),
                context.cast(),
                Some(call_js_dispose_completion),
                &mut raw,
            )
        };
        if status != sys::Status::napi_ok {
            drop(unsafe { Box::from_raw(context) });
            return Err(dispose_bridge_error(
                status,
                "Node disposal completion bridge could not be created",
            ));
        }

        Ok((
            Arc::new(Self {
                raw,
                released,
                queued: AtomicBool::new(false),
            }),
            PromiseRaw::new(env.raw(), promise),
        ))
    }

    pub(crate) fn complete(
        self: &Arc<Self>,
        environment: Arc<EnvironmentRecord>,
        result: NodeResult<()>,
    ) {
        if self
            .queued
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
            || self.released.load(Ordering::Acquire)
        {
            return;
        }

        let mut data = Some(Box::new(DisposeCompletionData {
            completion: Arc::clone(self),
            environment: Arc::clone(&environment),
            result,
        }));
        let status = environment.with_delivery_admission(|environment_closing| {
            if environment_closing {
                return None;
            }
            let raw_data =
                Box::into_raw(data.take().expect("disposal completion data stored above"));
            let status = unsafe {
                sys::napi_call_threadsafe_function(
                    self.raw,
                    raw_data.cast(),
                    sys::ThreadsafeFunctionCallMode::nonblocking,
                )
            };
            if status != sys::Status::napi_ok {
                // A failed call does not transfer ownership to N-API.
                data.replace(unsafe { Box::from_raw(raw_data) });
            }
            Some(status)
        });
        drop(data);
        let Some(status) = status else {
            // The environment cleanup hook owns native resource teardown now.
            self.released.store(true, Ordering::Release);
            return;
        };
        if status == sys::Status::napi_closing {
            self.released.store(true, Ordering::Release);
        } else if status != sys::Status::napi_ok {
            let _ = self.release(true);
        }
    }

    pub(crate) fn abort(&self) {
        let _ = self.release(true);
    }

    fn release(&self, abort: bool) -> Status {
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

impl Drop for RawDisposeCompletion {
    fn drop(&mut self) {
        let _ = self.release(true);
    }
}

fn dispose_bridge_error(status: sys::napi_status, message: &'static str) -> NodeErrorDetails {
    NodeErrorDetails::from_napi_status(
        ErrorCode::ResourceUnavailable,
        Operation::Dispose,
        Status::from(status),
        message,
    )
}

unsafe extern "C" fn finalize_dispose_completion(
    _raw_env: sys::napi_env,
    finalize_data: *mut c_void,
    _finalize_hint: *mut c_void,
) {
    if finalize_data.is_null() {
        return;
    }
    let context = unsafe { Box::from_raw(finalize_data.cast::<DisposeCompletionContext>()) };
    context.released.store(true, Ordering::Release);
}

unsafe extern "C" fn call_js_dispose_completion(
    raw_env: sys::napi_env,
    _callback: sys::napi_value,
    context: *mut c_void,
    data: *mut c_void,
) {
    if data.is_null() {
        return;
    }
    let data = unsafe { Box::from_raw(data.cast::<DisposeCompletionData>()) };
    if raw_env.is_null() || context.is_null() {
        // N-API is already draining this queue during environment teardown.
        // Balance the Rust-side owner without calling back into a dead env.
        data.completion.released.store(true, Ordering::Release);
        return;
    }

    let context = unsafe { &*context.cast::<DisposeCompletionContext>() };
    let joined = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let dispatcher_result = data.environment.join_dispatcher_if_inactive();
        let coordinator_result = data.environment.join_cleanup_if_inactive();
        data.result
            .clone()
            .and(dispatcher_result)
            .and(coordinator_result)
    }))
    .unwrap_or_else(|_| {
        Err(NodeErrorDetails::internal(
            Operation::Dispose,
            "Node disposal completion join panicked",
        ))
    });

    let env = Env::from_raw(raw_env);
    match joined {
        Ok(()) => {
            let mut undefined = ptr::null_mut();
            let status = unsafe { sys::napi_get_undefined(raw_env, &mut undefined) };
            if status == sys::Status::napi_ok {
                let _ = unsafe { sys::napi_resolve_deferred(raw_env, context.deferred, undefined) };
            } else {
                reject_dispose_completion(
                    raw_env,
                    context.deferred,
                    sync_error(
                        &env,
                        NodeErrorDetails::from_napi_status(
                            ErrorCode::Internal,
                            Operation::Dispose,
                            Status::from(status),
                            "Node disposal completion value could not be created",
                        ),
                    ),
                );
            }
        }
        Err(error) => reject_dispose_completion(raw_env, context.deferred, sync_error(&env, error)),
    }
    let _ = data.completion.release(false);
}

fn reject_dispose_completion(
    raw_env: sys::napi_env,
    deferred: sys::napi_deferred,
    error: napi::Error,
) {
    let value = unsafe { JsError::from(error).into_value(raw_env) };
    let _ = unsafe { sys::napi_reject_deferred(raw_env, deferred, value) };
}
