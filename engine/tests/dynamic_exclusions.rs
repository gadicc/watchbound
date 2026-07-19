#![cfg(target_os = "linux")]

use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use watchbound_engine::{Coverage, Engine, PartialReason, Subscription, SubscriptionOptions};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before Unix epoch")
            .as_nanos();
        let serial = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "watchbound-{label}-{}-{nonce}-{serial}",
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
        batch_window: Duration::from_millis(5),
        ..SubscriptionOptions::default()
    }
}

fn wait_for_batch(subscription: &Subscription) -> watchbound_engine::ChangeBatch {
    subscription
        .recv_timeout(Duration::from_secs(3))
        .expect("timed out waiting for batch")
}

fn wait_for_path(subscription: &Subscription, expected: &Path) -> watchbound_engine::ChangeBatch {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("timed out waiting for path");
        if batch.invalidated_paths.iter().any(|path| path == expected) {
            return batch;
        }
    }
}

#[test]
fn generation_zero_is_visible_on_initial_state_and_batches() {
    let _serial = serial();
    let root = TestDir::new("exclusion-generation-zero");
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    assert_eq!(subscription.exclusion_generation(), 0);

    let changed = root.path().join("changed");
    fs::write(&changed, b"value").unwrap();
    assert_eq!(
        wait_for_path(&subscription, &changed).exclusion_generation,
        0
    );
    subscription.dispose().unwrap();
}

#[test]
fn update_advances_once_and_rejects_duplicate_stale_and_non_monotonic_generations() {
    let _serial = serial();
    let root = TestDir::new("exclusion-generations");
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();

    assert_eq!(
        subscription
            .replace_exclusions(1, vec![PathBuf::from("future")])
            .unwrap(),
        Coverage::Complete
    );
    assert_eq!(subscription.exclusion_generation(), 1);
    for generation in [1, 0] {
        let error = subscription
            .replace_exclusions(generation, Vec::new())
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(subscription.exclusion_generation(), 1);
    }

    assert_eq!(
        subscription
            .replace_exclusions(3, vec![PathBuf::from("future")])
            .unwrap(),
        Coverage::Complete
    );
    assert_eq!(subscription.exclusion_generation(), 3);
    subscription.dispose().unwrap();
}

#[test]
fn invalid_prefixes_are_rejected_without_changing_generation() {
    let _serial = serial();
    let root = TestDir::new("exclusion-validation");
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();

    for invalid in [
        PathBuf::from("/absolute"),
        PathBuf::from("../outside"),
        PathBuf::from("child/../sibling"),
        PathBuf::from("./child"),
        PathBuf::from("child//grandchild"),
    ] {
        let error = subscription
            .replace_exclusions(1, vec![invalid])
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(subscription.exclusion_generation(), 0);
    }
    subscription.dispose().unwrap();
}

#[test]
fn empty_prefix_excludes_the_root_and_future_paths_until_reincluded() {
    let _serial = serial();
    let root = TestDir::new("exclusion-empty-root");
    fs::create_dir(root.path().join("existing")).unwrap();
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    assert_eq!(subscription.stats().watched_directories, 2);

    assert_eq!(
        subscription
            .replace_exclusions(1, vec![PathBuf::new()])
            .unwrap(),
        Coverage::Complete
    );
    assert_eq!(subscription.stats().watched_directories, 0);
    fs::create_dir(root.path().join("future")).unwrap();
    fs::write(root.path().join("future/hidden"), b"hidden").unwrap();
    assert!(
        subscription
            .recv_timeout(Duration::from_millis(100))
            .is_err()
    );

    assert_eq!(
        subscription.replace_exclusions(2, Vec::new()).unwrap(),
        Coverage::Complete
    );
    let batch = wait_for_path(&subscription, root.path());
    assert_eq!(batch.exclusion_generation, 2);
    assert!(subscription.stats().watched_directories >= 3);
    subscription.dispose().unwrap();
}

#[test]
fn exclusion_flushes_old_pending_paths_before_new_generation_is_observable() {
    let _serial = serial();
    let root = TestDir::new("exclusion-batch-boundary");
    fs::create_dir(root.path().join("excluded")).unwrap();
    let mut tuned = options();
    tuned.batch_window = Duration::from_millis(200);
    let subscription = Engine::new().subscribe(root.path(), tuned).unwrap();

    let old_path = root.path().join("old");
    fs::write(&old_path, b"old").unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while subscription.stats().raw_events == 0 && Instant::now() < deadline {
        std::thread::yield_now();
    }
    subscription
        .replace_exclusions(1, vec![PathBuf::from("excluded")])
        .unwrap();
    let old = wait_for_batch(&subscription);
    assert_eq!(old.exclusion_generation, 0);
    assert!(old.invalidated_paths.contains(&old_path));

    let new_path = root.path().join("new");
    fs::write(&new_path, b"new").unwrap();
    let new = wait_for_path(&subscription, &new_path);
    assert_eq!(new.exclusion_generation, 1);
    subscription.dispose().unwrap();
}

#[test]
fn excluding_a_subtree_removes_interests_but_retains_an_overlapping_subscription() {
    let _serial = serial();
    let root = TestDir::new("exclusion-overlap");
    let nested = root.path().join("nested");
    fs::create_dir(&nested).unwrap();
    let engine = Engine::new();
    let outer = engine.subscribe(root.path(), options()).unwrap();
    let inner = engine.subscribe(&nested, options()).unwrap();
    assert_eq!(engine.runtime_stats().native_watches, 2);

    outer
        .replace_exclusions(1, vec![PathBuf::from("nested")])
        .unwrap();
    assert_eq!(outer.stats().watched_directories, 1);
    assert_eq!(inner.stats().watched_directories, 1);
    assert_eq!(engine.runtime_stats().native_watches, 2);
    let changed = nested.join("still-visible");
    fs::write(&changed, b"value").unwrap();
    assert_eq!(wait_for_path(&inner, &changed).exclusion_generation, 0);
    assert!(outer.recv_timeout(Duration::from_millis(100)).is_err());
    outer.dispose().unwrap();
    inner.dispose().unwrap();
}

#[test]
fn excluding_a_final_interest_returns_a_token_for_fair_promotion() {
    let _serial = serial();
    let first_root = TestDir::new("exclusion-token-first");
    let second_root = TestDir::new("exclusion-token-second");
    let engine = Engine::with_runtime_watch_budget(1).unwrap();
    let first = engine.subscribe(first_root.path(), options()).unwrap();
    let second = engine.subscribe(second_root.path(), options()).unwrap();
    assert_eq!(second.stats().deferred_directories, 1);

    first.replace_exclusions(1, vec![PathBuf::new()]).unwrap();
    let promoted = wait_for_path(&second, second_root.path());
    assert_eq!(promoted.exclusion_generation, 0);
    assert_eq!(second.stats().deferred_directories, 0);
    first.dispose().unwrap();
    second.dispose().unwrap();
}

#[test]
fn future_excluded_directory_is_neither_watched_nor_delivered() {
    let _serial = serial();
    let root = TestDir::new("exclusion-future");
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    subscription
        .replace_exclusions(1, vec![PathBuf::from("future")])
        .unwrap();

    fs::create_dir(root.path().join("future")).unwrap();
    fs::write(root.path().join("future/file"), b"value").unwrap();
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(subscription.stats().watched_directories, 1);
    assert!(
        subscription
            .recv_timeout(Duration::from_millis(100))
            .is_err()
    );
    subscription.dispose().unwrap();
}

#[test]
fn reinclusion_is_invalidated_after_watch_before_read_and_is_partial_at_limits() {
    let _serial = serial();
    let root = TestDir::new("exclusion-reinclude-limit");
    fs::create_dir_all(root.path().join("hidden/nested")).unwrap();
    fs::write(root.path().join("hidden/nested/existing"), b"value").unwrap();
    let mut limited = options();
    limited.watch_limit = Some(1);
    let subscription = Engine::new().subscribe(root.path(), limited).unwrap();
    subscription
        .replace_exclusions(1, vec![PathBuf::from("hidden")])
        .unwrap();

    let coverage = subscription.replace_exclusions(2, Vec::new()).unwrap();
    assert_eq!(
        coverage,
        Coverage::Partial {
            reason: PartialReason::ResourceLimit,
            watched_directories: 1,
            deferred_directories: 1,
        }
    );
    let batch = wait_for_path(&subscription, &root.path().join("hidden"));
    assert_eq!(batch.exclusion_generation, 2);
    assert_eq!(batch.coverage, coverage);
    subscription.dispose().unwrap();
}

#[test]
fn non_utf8_prefixes_round_trip_without_loss() {
    let _serial = serial();
    let root = TestDir::new("exclusion-non-utf8");
    let relative = PathBuf::from(OsString::from_vec(vec![b'd', b'i', b'r', 0xff]));
    let directory = root.path().join(&relative);
    fs::create_dir(&directory).unwrap();
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();

    subscription
        .replace_exclusions(1, vec![relative.clone()])
        .unwrap();
    fs::write(directory.join("hidden"), b"value").unwrap();
    assert!(
        subscription
            .recv_timeout(Duration::from_millis(100))
            .is_err()
    );
    subscription.replace_exclusions(2, Vec::new()).unwrap();
    let batch = wait_for_path(&subscription, &directory);
    assert_eq!(
        batch.invalidated_paths[0].as_os_str().as_encoded_bytes(),
        directory.as_os_str().as_encoded_bytes()
    );
    subscription.dispose().unwrap();
}

#[test]
fn concurrent_conflicting_updates_are_rejected_and_disposal_remains_joined() {
    let _serial = serial();
    let root = TestDir::new("exclusion-concurrent");
    for index in 0..2_000 {
        fs::create_dir(root.path().join(format!("tree/d{index}"))).unwrap_or_else(|error| {
            if error.kind() != io::ErrorKind::NotFound {
                panic!("{error}")
            }
            fs::create_dir_all(root.path().join(format!("tree/d{index}"))).unwrap();
        });
    }
    let subscription = Arc::new(Engine::new().subscribe(root.path(), options()).unwrap());
    subscription
        .replace_exclusions(1, vec![PathBuf::from("tree")])
        .unwrap();
    let control = subscription.exclusion_handle();
    let barrier = Arc::new(Barrier::new(2));
    let worker_barrier = Arc::clone(&barrier);
    let update = std::thread::spawn(move || {
        worker_barrier.wait();
        control.replace_exclusions(2, Vec::new())
    });
    barrier.wait();

    let mut conflict = None;
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        match subscription.replace_exclusions(3, Vec::new()) {
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                conflict = Some(error);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => std::thread::yield_now(),
            result => panic!("unexpected concurrent result: {result:?}"),
        }
    }
    assert!(
        conflict.is_some(),
        "concurrent update was never observed in flight"
    );
    update.join().unwrap().unwrap();
    subscription.dispose().unwrap();
    subscription.dispose().unwrap();
    assert!(subscription.stats().disposed);
}

#[test]
fn runtime_limited_reinclusion_defers_then_promotes_when_a_token_returns() {
    let _serial = serial();
    let blocker_root = TestDir::new("exclusion-runtime-blocker");
    let target_root = TestDir::new("exclusion-runtime-target");
    let engine = Engine::with_runtime_watch_budget(3).unwrap();
    let blocker = engine.subscribe(blocker_root.path(), options()).unwrap();
    let target = engine.subscribe(target_root.path(), options()).unwrap();
    target
        .replace_exclusions(1, vec![PathBuf::from("hidden")])
        .unwrap();
    fs::create_dir_all(target_root.path().join("hidden/nested")).unwrap();
    fs::write(target_root.path().join("hidden/nested/existing"), b"value").unwrap();

    let coverage = target.replace_exclusions(2, Vec::new()).unwrap();
    assert_eq!(
        coverage,
        Coverage::Partial {
            reason: PartialReason::ResourceLimit,
            watched_directories: 2,
            deferred_directories: 1,
        }
    );
    assert_eq!(engine.runtime_stats().native_watches, 3);

    blocker.dispose().unwrap();
    let promoted = wait_for_path(&target, &target_root.path().join("hidden"));
    assert_eq!(promoted.exclusion_generation, 2);
    let deadline = Instant::now() + Duration::from_secs(3);
    while target.stats().watched_directories < 3 && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(target.stats().watched_directories, 3);
    assert_eq!(target.stats().deferred_directories, 0);
    target.dispose().unwrap();
}

#[test]
fn large_reinclusion_yields_to_delivery_on_another_subscription() {
    let _serial = serial();
    let large_root = TestDir::new("exclusion-large-inclusion");
    let live_root = TestDir::new("exclusion-large-live");
    let engine = Engine::new();
    let mut large_options = options();
    large_options.max_batch_paths = 1;
    let large = engine.subscribe(large_root.path(), large_options).unwrap();
    let live = engine.subscribe(live_root.path(), options()).unwrap();
    large
        .replace_exclusions(1, vec![PathBuf::from("tree")])
        .unwrap();
    for index in 0..2_000 {
        fs::create_dir_all(large_root.path().join(format!("tree/d{index}"))).unwrap();
    }

    let scans_before = large.stats().topology_scans;
    let update = large.exclusion_handle();
    let reinclude = std::thread::spawn(move || update.replace_exclusions(2, Vec::new()));
    let scan_deadline = Instant::now() + Duration::from_secs(3);
    while large.stats().topology_scans == scans_before && Instant::now() < scan_deadline {
        std::thread::yield_now();
    }
    for index in 0..32 {
        fs::write(
            large_root.path().join(format!("pressure-{index}")),
            b"value",
        )
        .unwrap();
    }
    let changed = live_root.path().join("delivered-during-scan");
    fs::write(&changed, b"value").unwrap();
    let batch = wait_for_path(&live, &changed);
    assert_eq!(batch.exclusion_generation, 0);
    assert_eq!(batch.coverage, Coverage::Complete);
    reinclude.join().unwrap().unwrap();
    large.dispose().unwrap();
    live.dispose().unwrap();
}

#[test]
fn backpressure_and_updates_do_not_change_another_generation_or_coverage() {
    let _serial = serial();
    let slow_root = TestDir::new("exclusion-backpressure-slow");
    let fast_root = TestDir::new("exclusion-backpressure-fast");
    let engine = Engine::new();
    let mut slow_options = options();
    slow_options.max_batch_paths = 1;
    slow_options.output_queue_capacity = 1;
    let slow = engine.subscribe(slow_root.path(), slow_options).unwrap();
    let fast = engine.subscribe(fast_root.path(), options()).unwrap();

    for index in 0..100 {
        fs::write(slow_root.path().join(format!("change-{index}")), b"value").unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    while slow.stats().batches_dropped == 0 && Instant::now() < deadline {
        std::thread::yield_now();
    }
    slow.replace_exclusions(1, vec![PathBuf::from("future")])
        .unwrap();

    let changed = fast_root.path().join("unaffected");
    fs::write(&changed, b"value").unwrap();
    let batch = wait_for_path(&fast, &changed);
    assert_eq!(batch.exclusion_generation, 0);
    assert_eq!(batch.coverage, Coverage::Complete);
    assert_eq!(fast.exclusion_generation(), 0);
    slow.dispose().unwrap();
    fast.dispose().unwrap();
}

#[test]
fn disposal_waits_for_an_active_update_and_final_shutdown_releases_all_state() {
    let _serial = serial();
    let root = TestDir::new("exclusion-dispose-update");
    let engine = Engine::new();
    let subscription = Arc::new(engine.subscribe(root.path(), options()).unwrap());
    subscription
        .replace_exclusions(1, vec![PathBuf::from("tree")])
        .unwrap();
    for index in 0..1_000 {
        fs::create_dir_all(root.path().join(format!("tree/d{index}"))).unwrap();
    }
    let handle = subscription.exclusion_handle();
    let update = std::thread::spawn(move || handle.replace_exclusions(2, Vec::new()));
    subscription.dispose().unwrap();
    let result = update.join().unwrap();
    assert!(
        result.is_ok()
            || matches!(
                result.unwrap_err().kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::NotConnected
            )
    );
    subscription.dispose().unwrap();
    assert!(subscription.stats().disposed);
    assert_eq!(
        engine.runtime_stats(),
        watchbound_engine::RuntimeStats::default()
    );
}
