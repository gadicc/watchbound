use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use watchbound_engine::{
    Coverage, Engine, ErrorCode, ExclusionPolicy, Operation, PartialReason, Subscription,
    SubscriptionOptions,
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
static SERIAL: Mutex<()> = Mutex::new(());
const TIMEOUT: Duration = Duration::from_secs(5);

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before Unix epoch")
            .as_nanos();
        let serial = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "watchbound-reconcile-{label}-{}-{nonce}-{serial}",
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

fn options() -> SubscriptionOptions {
    SubscriptionOptions {
        batch_window: Duration::from_millis(10),
        max_batch_paths: 64,
        output_queue_capacity: 16,
        ..SubscriptionOptions::default()
    }
}

fn wait_for_root(subscription: &Subscription, root: &Path) -> watchbound_engine::ChangeBatch {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("reconciliation root invalidation");
        if batch.invalidated_paths.iter().any(|path| path == root) {
            return batch;
        }
    }
}

#[test]
fn reconciliation_under_generation_zero_preserves_generation_zero() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("generation-zero");
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();

    let result = subscription.reconcile().unwrap();
    assert_eq!(result.exclusion_generation, 0);
    assert_eq!(result.coverage, Coverage::Complete);
    let batch = wait_for_root(&subscription, root.path());
    assert_eq!(batch.exclusion_generation, 0);
    assert_eq!(batch.coverage, Coverage::Complete);
    subscription.dispose().unwrap();
}

#[test]
fn reconciliation_preserves_the_committed_exclusion_generation() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("generation-update");
    fs::create_dir_all(root.path().join("hidden/nested")).unwrap();
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    subscription
        .replace_exclusions(7, vec![PathBuf::from("hidden")])
        .unwrap();

    let result = subscription.reconcile().unwrap();
    assert_eq!(result.exclusion_generation, 7);
    assert_eq!(subscription.exclusion_generation(), 7);
    let batch = wait_for_root(&subscription, root.path());
    assert_eq!(batch.exclusion_generation, 7);
    subscription.dispose().unwrap();
}

#[test]
fn reconciliation_discovers_a_populated_subtree_and_watches_before_reading() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("discover");
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    let deep = root.path().join("created/while/unwatched");
    fs::create_dir_all(&deep).unwrap();

    let result = subscription.reconcile().unwrap();
    assert_eq!(result.coverage, Coverage::Complete);
    assert_eq!(subscription.stats().watched_directories, 4);
    wait_for_root(&subscription, root.path());

    let changed = deep.join("after.txt");
    fs::write(&changed, "after").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("deep change after reconciliation");
        if batch.invalidated_paths.contains(&changed) {
            break;
        }
    }
    subscription.dispose().unwrap();
}

#[test]
fn reconciliation_watch_limit_commits_truthful_partial_coverage() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("partial");
    fs::create_dir_all(root.path().join("one/two/three")).unwrap();
    let mut limited = options();
    limited.watch_limit = Some(2);
    let subscription = Engine::new().subscribe(root.path(), limited).unwrap();

    let result = subscription.reconcile().unwrap();
    assert_eq!(
        result.coverage,
        Coverage::Partial {
            reason: PartialReason::ResourceLimit,
            watched_directories: 2,
            deferred_directories: 1,
        }
    );
    assert_eq!(
        wait_for_root(&subscription, root.path()).coverage,
        result.coverage
    );
    subscription.dispose().unwrap();
}

#[test]
fn reconciliation_batches_never_mix_exclusion_generations() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("batch-generation");
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    fs::write(root.path().join("before"), "before").unwrap();
    subscription
        .replace_exclusions(3, vec![PathBuf::from("excluded")])
        .unwrap();
    subscription.reconcile().unwrap();

    let mut saw_reconciliation = false;
    while let Ok(batch) = subscription.recv_timeout(Duration::from_millis(100)) {
        assert!(batch.exclusion_generation == 0 || batch.exclusion_generation == 3);
        if batch.invalidated_paths == [root.path()] {
            assert_eq!(batch.exclusion_generation, 3);
            saw_reconciliation = true;
            break;
        }
    }
    assert!(saw_reconciliation);
    subscription.dispose().unwrap();
}

#[test]
fn reconciliation_does_not_clear_root_replaced_uncertainty() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let parent = TestDir::new("root-replaced");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    fs::create_dir(&root).unwrap();
    let subscription = Engine::new().subscribe(&root, options()).unwrap();
    fs::rename(&root, &moved).unwrap();
    let batch = wait_for_root(&subscription, &root);
    assert!(matches!(batch.coverage, Coverage::Uncertain { .. }));

    let error = subscription.reconcile().unwrap_err();
    assert_eq!(error.code(), ErrorCode::RootStateConflict);
    assert_eq!(error.operation(), Operation::Reconcile);
    subscription.dispose().unwrap();
}

#[test]
fn current_and_future_excluded_prefixes_stay_excluded_during_reconciliation() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("excluded");
    fs::create_dir_all(root.path().join("hidden/current/deep")).unwrap();
    fs::create_dir_all(root.path().join(".git/objects")).unwrap();
    fs::create_dir_all(root.path().join("visible/.git/objects")).unwrap();
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    subscription
        .replace_exclusion_policy(
            1,
            ExclusionPolicy {
                prefixes: vec![PathBuf::from("hidden")],
                excluded_directory_names: vec![OsString::from(".git")],
                observed_excluded_paths: vec![PathBuf::from(".git")],
            },
        )
        .unwrap();
    let result = subscription.reconcile().unwrap();
    assert_eq!(result.exclusion_generation, 1);
    assert_eq!(subscription.stats().watched_directories, 2);
    wait_for_root(&subscription, root.path());

    fs::remove_dir_all(root.path().join(".git")).unwrap();
    let observed = wait_for_root(&subscription, &root.path().join(".git"));
    assert_eq!(observed.exclusion_generation, 1);

    let future = root.path().join("hidden/future/deep");
    fs::create_dir_all(&future).unwrap();
    fs::write(future.join("ignored"), "ignored").unwrap();
    assert!(
        subscription
            .recv_timeout(Duration::from_millis(100))
            .is_err()
    );
    assert_eq!(subscription.stats().watched_directories, 2);
    subscription.dispose().unwrap();
}

#[test]
fn reconciliation_preserves_non_utf8_included_and_excluded_path_bytes() {
    use std::os::unix::ffi::OsStringExt;

    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("non-utf8");
    let included = PathBuf::from(OsString::from_vec(b"included-\xff".to_vec()));
    let excluded = PathBuf::from(OsString::from_vec(b"excluded-\xfe".to_vec()));
    fs::create_dir(root.path().join(&included)).unwrap();
    fs::create_dir(root.path().join(&excluded)).unwrap();
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    subscription
        .replace_exclusions(1, vec![excluded.clone()])
        .unwrap();

    subscription.reconcile().unwrap();
    assert_eq!(subscription.stats().watched_directories, 2);
    wait_for_root(&subscription, root.path());
    let changed = root.path().join(&included).join("changed");
    fs::write(&changed, "changed").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("non-UTF-8 included change");
        if batch.invalidated_paths.contains(&changed) {
            break;
        }
    }
    subscription.dispose().unwrap();
}

#[test]
fn stale_interests_are_swept_and_native_tokens_are_returned() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("stale-sweep");
    let stale = root.path().join("stale/nested");
    fs::create_dir_all(&stale).unwrap();
    let engine = Engine::new();
    let subscription = engine.subscribe(root.path(), options()).unwrap();
    assert_eq!(subscription.stats().watched_directories, 3);
    fs::remove_dir_all(root.path().join("stale")).unwrap();

    subscription.reconcile().unwrap();
    assert_eq!(subscription.stats().watched_directories, 1);
    assert_eq!(engine.runtime_stats().native_watches, 1);
    subscription.dispose().unwrap();
}

#[test]
fn overlapping_subscription_keeps_shared_watches_and_independent_coverage() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("overlap");
    let nested = root.path().join("nested/deep");
    fs::create_dir_all(&nested).unwrap();
    let engine = Engine::new();
    let outer = engine.subscribe(root.path(), options()).unwrap();
    let inner = engine
        .subscribe(root.path().join("nested"), options())
        .unwrap();
    assert_eq!(engine.runtime_stats().native_watches, 3);

    outer.reconcile().unwrap();
    assert_eq!(engine.runtime_stats().native_watches, 3);
    assert_eq!(inner.stats().watched_directories, 2);
    let changed = nested.join("shared");
    fs::write(&changed, "shared").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    let mut outer_seen = false;
    let mut inner_seen = false;
    while (!outer_seen || !inner_seen) && Instant::now() < deadline {
        if let Ok(batch) = outer.recv_timeout(Duration::from_millis(20)) {
            outer_seen |= batch.invalidated_paths.contains(&changed);
        }
        if let Ok(batch) = inner.recv_timeout(Duration::from_millis(20)) {
            inner_seen |= batch.invalidated_paths.contains(&changed);
        }
    }
    assert!(outer_seen && inner_seen);
    outer.dispose().unwrap();
    inner.dispose().unwrap();
}

#[test]
fn runtime_budget_exhaustion_defers_reconciliation_and_promotes_after_return() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let holder_root = TestDir::new("budget-holder");
    let target_root = TestDir::new("budget-target");
    fs::create_dir(target_root.path().join("deferred")).unwrap();
    let engine = Engine::with_runtime_watch_budget(2).unwrap();
    let holder = engine.subscribe(holder_root.path(), options()).unwrap();
    let target = engine.subscribe(target_root.path(), options()).unwrap();

    let result = target.reconcile().unwrap();
    assert!(matches!(
        result.coverage,
        Coverage::Partial {
            reason: PartialReason::ResourceLimit,
            deferred_directories: 1,
            ..
        }
    ));
    wait_for_root(&target, target_root.path());
    holder.dispose().unwrap();

    let deadline = Instant::now() + TIMEOUT;
    while target.stats().deferred_directories != 0 && Instant::now() < deadline {
        let _ = target.recv_timeout(Duration::from_millis(20));
    }
    assert_eq!(target.stats().deferred_directories, 0);
    assert_eq!(target.stats().watched_directories, 2);
    target.dispose().unwrap();
}

#[test]
fn a_large_reconciliation_yields_to_another_subscriptions_events() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let large_root = TestDir::new("large");
    let live_root = TestDir::new("live");
    for index in 0..2_000 {
        fs::create_dir(large_root.path().join(format!("dir-{index:04}"))).unwrap();
    }
    let engine = Engine::new();
    let large = engine.subscribe(large_root.path(), options()).unwrap();
    let live = engine.subscribe(live_root.path(), options()).unwrap();
    let handle = large.reconciliation_handle();
    let reconciliation = std::thread::spawn(move || handle.reconcile());

    let changed = live_root.path().join("during");
    fs::write(&changed, "during").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    let mut observed = false;
    while Instant::now() < deadline {
        if let Ok(batch) = live.recv_timeout(Duration::from_millis(20))
            && batch.invalidated_paths.contains(&changed)
        {
            observed = true;
            break;
        }
    }
    assert!(observed);
    reconciliation.join().unwrap().unwrap();
    large.dispose().unwrap();
    live.dispose().unwrap();
}

#[test]
fn reconciliation_backpressure_is_isolated_from_another_subscription() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let slow_root = TestDir::new("slow");
    let fast_root = TestDir::new("fast");
    let engine = Engine::new();
    let mut slow_options = options();
    slow_options.output_queue_capacity = 1;
    let slow = engine.subscribe(slow_root.path(), slow_options).unwrap();
    let fast = engine.subscribe(fast_root.path(), options()).unwrap();
    fs::write(slow_root.path().join("fill"), "fill").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    while slow.stats().batches_delivered == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let error = slow.reconcile().unwrap_err();
    assert_eq!(error.code(), ErrorCode::ConsumerBackpressure);
    assert_eq!(error.operation(), Operation::Reconcile);

    let changed = fast_root.path().join("independent");
    fs::write(&changed, "independent").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let batch = fast
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("independent event");
        if batch.invalidated_paths.contains(&changed) {
            assert_eq!(batch.coverage, Coverage::Complete);
            break;
        }
    }
    slow.dispose().unwrap();
    fast.dispose().unwrap();
}

#[test]
fn disposal_during_reconciliation_joins_safely_and_is_idempotent() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("dispose");
    for index in 0..3_000 {
        fs::create_dir(root.path().join(format!("dir-{index:04}"))).unwrap();
    }
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    let reconciliation = subscription.reconciliation_handle();
    let running = std::thread::spawn(move || reconciliation.reconcile());
    subscription.dispose().unwrap();
    let result = running.join().unwrap();
    assert!(
        result.is_ok() || {
            matches!(
                result.unwrap_err().code(),
                ErrorCode::OperationInterrupted | ErrorCode::SubscriptionClosed
            )
        }
    );
    subscription.dispose().unwrap();
    assert!(subscription.stats().disposed);
}

#[test]
fn final_shutdown_releases_reconciliation_resources_and_worker() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("shutdown");
    fs::create_dir_all(root.path().join("one/two")).unwrap();
    let engine = Engine::new();
    let subscription = engine.subscribe(root.path(), options()).unwrap();
    subscription.reconcile().unwrap();
    subscription.dispose().unwrap();

    let stats = engine.runtime_stats();
    assert_eq!(stats.native_watches, 0);
    assert_eq!(stats.deferred_interests, 0);
    assert_eq!(stats.subscriptions, 0);
    assert_eq!(stats.inotify_instances, 0);
    assert_eq!(stats.worker_threads, 0);
}
