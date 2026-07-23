use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use watchbound_engine::{
    Coverage, Engine, ErrorCode, EstablishmentCancellation, Operation, RuntimeStats,
    SubscriptionOptions,
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
static SERIAL: Mutex<()> = Mutex::new(());

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before Unix epoch")
            .as_nanos();
        let serial = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "watchbound-cancellable-{label}-{}-{nonce}-{serial}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create test directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn large_root(label: &str) -> TestDir {
    let root = TestDir::new(label);
    for index in 0..4_096 {
        fs::create_dir(root.path().join(format!("directory-{index:04}")))
            .expect("create establishment directory");
    }
    root
}

#[test]
fn already_cancelled_attempt_never_starts_the_runtime() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("already-cancelled");
    let engine = Engine::new();
    let cancellation = EstablishmentCancellation::new().unwrap();
    cancellation.cancel();

    let error = match engine.begin_subscribe_with_cancellation(
        root.path(),
        SubscriptionOptions::default(),
        cancellation,
    ) {
        Ok(pending) => {
            drop(pending);
            panic!("an already-cancelled attempt must not be admitted")
        }
        Err(error) => error,
    };

    assert_eq!(error.code(), ErrorCode::OperationCancelled);
    assert_eq!(error.operation(), Operation::Subscribe);
    assert!(!error.retryable());
    assert_eq!(engine.runtime_stats(), RuntimeStats::default());
}

#[test]
fn pure_option_validation_precedes_an_already_cancelled_token() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("validation-precedence");
    let cancellation = EstablishmentCancellation::new().unwrap();
    cancellation.cancel();
    let options = SubscriptionOptions {
        watch_limit: Some(0),
        ..SubscriptionOptions::default()
    };

    let error =
        match Engine::new().begin_subscribe_with_cancellation(root.path(), options, cancellation) {
            Ok(pending) => {
                drop(pending);
                panic!("invalid options must not create a pending subscription")
            }
            Err(error) => error,
        };

    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    assert_eq!(error.operation(), Operation::Subscribe);
}

#[test]
fn already_cancelled_attempt_precedes_symlink_ancestry_validation() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent = TestDir::new("cancelled-symlink");
    let target = parent.path().join("target");
    let link = parent.path().join("link");
    fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();
    let cancellation = EstablishmentCancellation::new().unwrap();
    cancellation.cancel();

    let error = match Engine::new().begin_subscribe_with_cancellation(
        &link,
        SubscriptionOptions::default(),
        cancellation,
    ) {
        Ok(pending) => {
            drop(pending);
            panic!("an already-cancelled symlink attempt must not reach path validation")
        }
        Err(error) => error,
    };

    assert_eq!(error.code(), ErrorCode::OperationCancelled);
    assert_eq!(error.operation(), Operation::Subscribe);
}

#[test]
fn already_cancelled_attempt_precedes_missing_root_failure() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent = TestDir::new("cancelled-missing");
    let missing = parent.path().join("missing");
    let cancellation = EstablishmentCancellation::new().unwrap();
    cancellation.cancel();

    let error = match Engine::new().begin_subscribe_with_cancellation(
        &missing,
        SubscriptionOptions::default(),
        cancellation,
    ) {
        Ok(pending) => {
            drop(pending);
            panic!("an already-cancelled missing root must not reach filesystem validation")
        }
        Err(error) => error,
    };

    assert_eq!(error.code(), ErrorCode::OperationCancelled);
    assert_eq!(error.operation(), Operation::Subscribe);
}

#[test]
fn cancellation_token_is_single_bind() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let first_root = large_root("single-bind-first");
    let second_root = TestDir::new("single-bind-second");
    let engine = Engine::new();
    let cancellation = EstablishmentCancellation::new().unwrap();
    let pending = engine
        .begin_subscribe_with_cancellation(
            first_root.path(),
            SubscriptionOptions::default(),
            cancellation.clone(),
        )
        .unwrap();

    let error = match engine.begin_subscribe_with_cancellation(
        second_root.path(),
        SubscriptionOptions::default(),
        cancellation.clone(),
    ) {
        Ok(second) => {
            drop(second);
            panic!("one cancellation token must not bind to two attempts")
        }
        Err(error) => error,
    };
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    assert_eq!(error.operation(), Operation::Subscribe);

    cancellation.cancel();
    let _ = pending.wait();
    assert_eq!(engine.runtime_stats(), RuntimeStats::default());
}

#[test]
fn cancellation_during_initial_traversal_is_joined_and_idempotent() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = large_root("during-traversal");
    let engine = Engine::new();
    let pending = engine
        .begin_subscribe(root.path(), SubscriptionOptions::default())
        .unwrap();
    let cancellation = pending.cancellation_handle();

    cancellation.cancel();
    cancellation.cancel();
    let error = match pending.wait() {
        Ok(subscription) => {
            subscription.dispose().unwrap();
            panic!("cancellation should win a large pending traversal")
        }
        Err(error) => error,
    };

    assert_eq!(error.code(), ErrorCode::OperationCancelled);
    assert_eq!(error.operation(), Operation::Subscribe);
    assert!(cancellation.is_cancelled());
    assert_eq!(engine.runtime_stats(), RuntimeStats::default());
}

#[test]
fn dropping_pending_subscription_requests_joined_rollback() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = large_root("drop-pending");
    let engine = Engine::new();
    let pending = engine
        .begin_subscribe(root.path(), SubscriptionOptions::default())
        .unwrap();

    drop(pending);

    assert_eq!(engine.runtime_stats(), RuntimeStats::default());
}

#[test]
fn cancellation_preserves_an_established_shared_peer() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = large_root("shared-peer");
    let engine = Engine::new();
    let options = SubscriptionOptions {
        batch_window: Duration::from_millis(5),
        ..SubscriptionOptions::default()
    };
    let peer = engine.subscribe(root.path(), options.clone()).unwrap();
    let peer_watches = peer.stats().watched_directories;
    let runtime_watches = engine.runtime_stats().native_watches;

    let pending = engine.begin_subscribe(root.path(), options).unwrap();
    pending.cancellation_handle().cancel();
    let error = match pending.wait() {
        Ok(subscription) => {
            subscription.dispose().unwrap();
            panic!("cancellation should win the overlapping pending traversal")
        }
        Err(error) => error,
    };

    assert_eq!(error.code(), ErrorCode::OperationCancelled);
    assert_eq!(peer.stats().watched_directories, peer_watches);
    assert_eq!(engine.runtime_stats().native_watches, runtime_watches);

    let changed = root.path().join("peer-remains-live.txt");
    fs::write(&changed, "change").unwrap();
    let batch = peer.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(batch.invalidated_paths.contains(&changed));
    assert_eq!(batch.coverage, Coverage::Complete);

    peer.dispose().unwrap();
    assert_eq!(engine.runtime_stats(), RuntimeStats::default());
}

#[test]
fn cancellation_after_engine_success_is_a_no_op() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("late-cancellation");
    let engine = Engine::new();
    let pending = engine
        .begin_subscribe(root.path(), SubscriptionOptions::default())
        .unwrap();
    let cancellation = pending.cancellation_handle();
    let subscription = pending.wait().unwrap();

    cancellation.cancel();
    assert!(!cancellation.is_cancelled());
    let changed = root.path().join("success-remains-live.txt");
    fs::write(&changed, "change").unwrap();
    let batch = subscription.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(batch.invalidated_paths.contains(&changed));

    subscription.dispose().unwrap();
    assert_eq!(engine.runtime_stats(), RuntimeStats::default());
}

#[test]
fn committed_filesystem_failure_is_not_retroactively_cancelled() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent = TestDir::new("late-cancel-failure");
    let missing = parent.path().join("missing");
    let engine = Engine::new();
    let cancellation = EstablishmentCancellation::new().unwrap();

    let error = match engine.begin_subscribe_with_cancellation(
        &missing,
        SubscriptionOptions::default(),
        cancellation.clone(),
    ) {
        Ok(pending) => {
            drop(pending);
            panic!("missing root unexpectedly admitted")
        }
        Err(error) => error,
    };
    cancellation.cancel();

    assert_eq!(error.code(), ErrorCode::RootUnavailable);
    assert!(!cancellation.is_cancelled());
    assert_eq!(engine.runtime_stats(), RuntimeStats::default());
}
