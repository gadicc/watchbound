use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use watchbound_engine::{
    Coverage, Engine, PartialReason, Subscription, SubscriptionOptions, UncertainReason,
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
            "watchbound-shared-{label}-{}-{nonce}-{serial}",
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
        max_batch_paths: 64,
        output_queue_capacity: 8,
        ..SubscriptionOptions::default()
    }
}

fn wait_for_path(subscription: &Subscription, expected: &Path) -> watchbound_engine::ChangeBatch {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|error| panic!("waiting for {}: {error}", expected.display()));
        if batch.invalidated_paths.iter().any(|path| path == expected) {
            return batch;
        }
    }
}

#[test]
fn two_subscriptions_share_one_inotify_instance_and_worker() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let first_root = TestDir::new("one-runtime-first");
    let second_root = TestDir::new("one-runtime-second");
    let first_engine = Engine::new();
    let second_engine = Engine::new();
    let first = first_engine
        .subscribe(first_root.path(), options())
        .unwrap();
    let second = second_engine
        .subscribe(second_root.path(), options())
        .unwrap();

    let runtime = first_engine.runtime_stats();
    assert_eq!(runtime.inotify_instances, 1);
    assert_eq!(runtime.worker_threads, 1);
    assert_eq!(runtime.subscriptions, 2);
    assert_eq!(runtime.native_watches, 2);

    first.dispose().unwrap();
    second.dispose().unwrap();
}

#[test]
fn a_large_topology_scan_does_not_starve_a_small_root() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let large_root = TestDir::new("fair-large");
    let incoming_parent = TestDir::new("fair-incoming");
    let small_root = TestDir::new("fair-small");
    let engine = Engine::new();
    let large = engine.subscribe(large_root.path(), options()).unwrap();
    let small = engine.subscribe(small_root.path(), options()).unwrap();

    let incoming = incoming_parent.path().join("tree");
    fs::create_dir(&incoming).unwrap();
    for index in 0..4_000 {
        fs::create_dir(incoming.join(format!("directory-{index:04}"))).unwrap();
    }
    fs::rename(&incoming, large_root.path().join("incoming")).unwrap();

    let changed = small_root.path().join("prompt.txt");
    let started = Instant::now();
    fs::write(&changed, "change").unwrap();
    wait_for_path(&small, &changed);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "small-root delivery was starved for {:?}",
        started.elapsed()
    );

    large.dispose().unwrap();
    small.dispose().unwrap();
}

#[test]
fn concurrent_establishment_is_round_robin_with_live_delivery() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let first_large = TestDir::new("concurrent-first");
    let second_large = TestDir::new("concurrent-second");
    let small_root = TestDir::new("concurrent-small");
    for index in 0..2_000 {
        fs::create_dir(first_large.path().join(format!("directory-{index:04}"))).unwrap();
        fs::create_dir(second_large.path().join(format!("directory-{index:04}"))).unwrap();
    }

    let engine = Engine::new();
    let small = engine.subscribe(small_root.path(), options()).unwrap();
    let first_path = first_large.path().to_path_buf();
    let second_path = second_large.path().to_path_buf();
    let first = std::thread::spawn(move || Engine::new().subscribe(first_path, options()));
    let second = std::thread::spawn(move || Engine::new().subscribe(second_path, options()));

    let deadline = Instant::now() + TIMEOUT;
    while engine.runtime_stats().subscriptions < 3 && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert_eq!(engine.runtime_stats().subscriptions, 3);
    let changed = small_root.path().join("during-establishment.txt");
    let started = Instant::now();
    fs::write(&changed, "change").unwrap();
    wait_for_path(&small, &changed);
    assert!(started.elapsed() < Duration::from_secs(1));

    let first = first.join().unwrap().unwrap();
    let second = second.join().unwrap().unwrap();
    assert_eq!(first.initial_coverage(), &Coverage::Complete);
    assert_eq!(second.initial_coverage(), &Coverage::Complete);
    first.dispose().unwrap();
    second.dispose().unwrap();
    small.dispose().unwrap();
}

#[test]
fn overlapping_roots_share_native_watches_and_receive_their_coverage() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let outer = TestDir::new("overlap");
    let inner = outer.path().join("inner");
    fs::create_dir_all(inner.join("nested")).unwrap();
    let engine = Engine::new();
    let outer_subscription = engine.subscribe(outer.path(), options()).unwrap();
    let mut inner_options = options();
    inner_options.watch_limit = Some(1);
    let inner_subscription = engine.subscribe(&inner, inner_options).unwrap();

    assert_eq!(outer_subscription.stats().watched_directories, 3);
    assert_eq!(inner_subscription.stats().watched_directories, 1);
    assert_eq!(inner_subscription.stats().deferred_directories, 1);
    assert_eq!(engine.runtime_stats().native_watches, 3);

    let changed = inner.join("shared.txt");
    fs::write(&changed, "change").unwrap();
    assert_eq!(
        wait_for_path(&outer_subscription, &changed).coverage,
        Coverage::Complete
    );
    assert_eq!(
        wait_for_path(&inner_subscription, &changed).coverage,
        Coverage::Partial {
            reason: PartialReason::ResourceLimit,
            watched_directories: 1,
            deferred_directories: 1,
        }
    );

    outer_subscription.dispose().unwrap();
    inner_subscription.dispose().unwrap();
}

#[test]
fn backpressure_on_one_subscription_does_not_degrade_another() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let slow_root = TestDir::new("isolated-backpressure-slow");
    let fast_root = TestDir::new("isolated-backpressure-fast");
    let engine = Engine::new();
    let mut slow_options = options();
    slow_options.max_batch_paths = 1;
    slow_options.output_queue_capacity = 1;
    let slow = engine.subscribe(slow_root.path(), slow_options).unwrap();
    let fast = engine.subscribe(fast_root.path(), options()).unwrap();

    for index in 0..32 {
        fs::write(
            slow_root.path().join(format!("pressure-{index:02}.txt")),
            "x",
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(7));
    }
    let deadline = Instant::now() + TIMEOUT;
    while slow.stats().batches_dropped == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(slow.stats().batches_dropped > 0);

    let changed = fast_root.path().join("fast.txt");
    fs::write(&changed, "fast").unwrap();
    let batch = wait_for_path(&fast, &changed);
    assert_eq!(batch.coverage, Coverage::Complete);
    assert!(!matches!(
        batch.coverage,
        Coverage::Uncertain {
            reason: UncertainReason::ConsumerBackpressure
        }
    ));

    slow.dispose().unwrap();
    fast.dispose().unwrap();
}

#[test]
fn disposing_one_overlap_retains_the_other_interests() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let outer = TestDir::new("dispose-overlap");
    let inner = outer.path().join("inner");
    fs::create_dir(&inner).unwrap();
    let engine = Engine::new();
    let outer_subscription = engine.subscribe(outer.path(), options()).unwrap();
    let inner_subscription = engine.subscribe(&inner, options()).unwrap();

    outer_subscription.dispose().unwrap();
    assert_eq!(engine.runtime_stats().native_watches, 1);
    assert_eq!(inner_subscription.stats().watched_directories, 1);

    let changed = inner.join("retained.txt");
    fs::write(&changed, "retained").unwrap();
    wait_for_path(&inner_subscription, &changed);
    inner_subscription.dispose().unwrap();
}

#[test]
fn concurrent_repeated_disposal_is_joined_and_prevents_later_delivery() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("concurrent-dispose");
    let subscription = Arc::new(Engine::new().subscribe(root.path(), options()).unwrap());
    let mut disposers = Vec::new();
    for _ in 0..8 {
        let subscription = Arc::clone(&subscription);
        disposers.push(std::thread::spawn(move || subscription.dispose()));
    }
    for disposer in disposers {
        disposer.join().unwrap().unwrap();
    }
    subscription.dispose().unwrap();

    fs::write(root.path().join("after.txt"), "after").unwrap();
    assert!(subscription.try_recv().is_err());
    assert!(subscription.stats().disposed);
}

#[test]
fn final_disposal_shuts_down_the_runtime_and_releases_all_native_state() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("final-shutdown");
    let engine = Engine::new();
    let subscription = engine.subscribe(root.path(), options()).unwrap();
    assert_eq!(engine.runtime_stats().inotify_instances, 1);
    assert_eq!(engine.runtime_stats().native_watches, 1);

    subscription.dispose().unwrap();

    let runtime = engine.runtime_stats();
    assert_eq!(runtime.inotify_instances, 0);
    assert_eq!(runtime.worker_threads, 0);
    assert_eq!(runtime.native_watches, 0);
    assert_eq!(runtime.subscriptions, 0);
}
