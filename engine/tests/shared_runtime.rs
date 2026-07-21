use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use watchbound_engine::{
    Coverage, Engine, ErrorCode, Operation, PartialReason, Subscription, SubscriptionOptions,
    UncertainReason,
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

fn bounded_engine(native_watch_budget: usize) -> Engine {
    Engine::with_runtime_watch_budget(native_watch_budget).unwrap()
}

fn wait_for_stats(
    subscription: &Subscription,
    predicate: impl Fn(watchbound_engine::Stats) -> bool,
) {
    let deadline = Instant::now() + TIMEOUT;
    while !predicate(subscription.stats()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        predicate(subscription.stats()),
        "subscription stats did not reach the expected state: {:?}",
        subscription.stats()
    );
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
    assert_eq!(runtime.native_watch_budget, None);

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

#[test]
fn runtime_never_exceeds_its_unique_native_watch_budget() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("runtime-budget");
    for index in 0..32 {
        fs::create_dir(root.path().join(format!("directory-{index:02}"))).unwrap();
    }
    let engine = bounded_engine(3);
    let subscription = engine.subscribe(root.path(), options()).unwrap();

    let runtime = engine.runtime_stats();
    assert_eq!(runtime.native_watch_budget, Some(3));
    assert_eq!(runtime.native_watches, 3);
    assert!(runtime.native_watches <= runtime.native_watch_budget.unwrap());
    assert_eq!(subscription.stats().watched_directories, 3);
    assert_eq!(subscription.stats().deferred_directories, 30);

    subscription.dispose().unwrap();
}

#[test]
fn bounded_overlap_uses_one_token_with_independent_subscription_accounting() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = TestDir::new("bounded-overlap");
    fs::create_dir(root.path().join("child")).unwrap();
    let engine = bounded_engine(1);
    let first = engine.subscribe(root.path(), options()).unwrap();
    let second = engine.subscribe(root.path(), options()).unwrap();

    assert_eq!(engine.runtime_stats().native_watches, 1);
    assert_eq!(first.stats().watched_directories, 1);
    assert_eq!(second.stats().watched_directories, 1);
    assert_eq!(first.stats().deferred_directories, 1);
    assert_eq!(second.stats().deferred_directories, 1);

    first.dispose().unwrap();
    second.dispose().unwrap();
}

#[test]
fn concurrent_large_subscriptions_share_initial_budget_fairly() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let first_root = TestDir::new("budget-fair-first");
    let second_root = TestDir::new("budget-fair-second");
    for index in 0..2_000 {
        fs::create_dir(first_root.path().join(format!("directory-{index:04}"))).unwrap();
        fs::create_dir(second_root.path().join(format!("directory-{index:04}"))).unwrap();
    }
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let first_path = first_root.path().to_path_buf();
    let first_barrier = Arc::clone(&barrier);
    let first = std::thread::spawn(move || {
        first_barrier.wait();
        bounded_engine(4).subscribe(first_path, options())
    });
    let second_path = second_root.path().to_path_buf();
    let second_barrier = Arc::clone(&barrier);
    let second = std::thread::spawn(move || {
        second_barrier.wait();
        bounded_engine(4).subscribe(second_path, options())
    });
    barrier.wait();

    let first = first.join().unwrap().unwrap();
    let second = second.join().unwrap().unwrap();
    assert!(first.stats().watched_directories >= 1);
    assert!(second.stats().watched_directories >= 1);
    assert_eq!(
        first.stats().watched_directories + second.stats().watched_directories,
        4
    );

    first.dispose().unwrap();
    second.dispose().unwrap();
}

#[test]
fn subscription_limit_cannot_consume_newly_available_runtime_tokens() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let limited_root = TestDir::new("subscription-limit");
    fs::create_dir(limited_root.path().join("deferred")).unwrap();
    let holder_root = TestDir::new("subscription-limit-holder");
    let engine = bounded_engine(2);
    let mut limited_options = options();
    limited_options.watch_limit = Some(1);
    let limited = engine
        .subscribe(limited_root.path(), limited_options)
        .unwrap();
    let holder = engine.subscribe(holder_root.path(), options()).unwrap();
    assert_eq!(engine.runtime_stats().native_watches, 2);

    holder.dispose().unwrap();
    std::thread::sleep(Duration::from_millis(50));

    assert_eq!(limited.stats().watched_directories, 1);
    assert_eq!(limited.stats().deferred_directories, 1);
    assert_eq!(engine.runtime_stats().native_watches, 1);
    limited.dispose().unwrap();
}

#[test]
fn disposing_a_subscription_promotes_another_subscriptions_deferred_interest() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let holder_root = TestDir::new("dispose-promote-holder");
    let promoted_root = TestDir::new("dispose-promote-target");
    let engine = bounded_engine(1);
    let holder = engine.subscribe(holder_root.path(), options()).unwrap();
    let promoted = engine.subscribe(promoted_root.path(), options()).unwrap();
    assert_eq!(promoted.stats().watched_directories, 0);
    assert_eq!(promoted.stats().deferred_directories, 1);

    holder.dispose().unwrap();
    let batch = wait_for_path(&promoted, promoted_root.path());

    assert_eq!(batch.coverage, Coverage::Complete);
    assert_eq!(promoted.stats().watched_directories, 1);
    assert_eq!(promoted.stats().deferred_directories, 0);
    promoted.dispose().unwrap();
}

#[test]
fn deleting_watched_topology_returns_a_token_and_promotes_fairly() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let holder_root = TestDir::new("delete-promote-holder");
    let held_child = holder_root.path().join("held");
    fs::create_dir(&held_child).unwrap();
    let promoted_root = TestDir::new("delete-promote-target");
    let engine = bounded_engine(2);
    let holder = engine.subscribe(holder_root.path(), options()).unwrap();
    let promoted = engine.subscribe(promoted_root.path(), options()).unwrap();
    assert_eq!(promoted.stats().watched_directories, 0);

    fs::remove_dir(&held_child).unwrap();
    wait_for_stats(&promoted, |stats| stats.watched_directories == 1);
    let batch = wait_for_path(&promoted, promoted_root.path());

    assert_eq!(batch.coverage, Coverage::Complete);
    assert_eq!(engine.runtime_stats().native_watches, 2);
    holder.dispose().unwrap();
    promoted.dispose().unwrap();
}

#[test]
fn returned_tokens_promote_large_subscriptions_round_robin() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let holder_root = TestDir::new("round-robin-holder");
    for index in 0..2 {
        fs::create_dir(holder_root.path().join(format!("held-{index}"))).unwrap();
    }
    let roots = [
        TestDir::new("round-robin-first"),
        TestDir::new("round-robin-second"),
        TestDir::new("round-robin-third"),
    ];
    for root in &roots {
        for index in 0..32 {
            fs::create_dir(root.path().join(format!("directory-{index:02}"))).unwrap();
        }
    }
    let engine = bounded_engine(3);
    let holder = engine.subscribe(holder_root.path(), options()).unwrap();
    let subscriptions: Vec<_> = roots
        .iter()
        .map(|root| engine.subscribe(root.path(), options()).unwrap())
        .collect();
    assert!(
        subscriptions
            .iter()
            .all(|subscription| subscription.stats().watched_directories == 0)
    );

    holder.dispose().unwrap();
    for subscription in &subscriptions {
        wait_for_stats(subscription, |stats| stats.watched_directories >= 1);
    }

    assert_eq!(engine.runtime_stats().native_watches, 3);
    assert!(
        subscriptions
            .iter()
            .all(|subscription| subscription.stats().watched_directories == 1)
    );
    for subscription in subscriptions {
        subscription.dispose().unwrap();
    }
}

#[test]
fn promotion_watches_before_reading_and_discovers_a_populated_deferred_subtree() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let holder_root = TestDir::new("promotion-discovery-holder");
    let promoted_root = TestDir::new("promotion-discovery-target");
    let engine = bounded_engine(3);
    for index in 0..2 {
        fs::create_dir(holder_root.path().join(format!("held-{index}"))).unwrap();
    }
    let holder = engine.subscribe(holder_root.path(), options()).unwrap();
    let promoted = engine.subscribe(promoted_root.path(), options()).unwrap();
    assert_eq!(promoted.stats().watched_directories, 0);

    let nested = promoted_root.path().join("incoming/nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("already-present.txt"), "present").unwrap();
    holder.dispose().unwrap();
    wait_for_stats(&promoted, |stats| stats.watched_directories == 3);
    let promotion = wait_for_path(&promoted, promoted_root.path());
    assert_eq!(promotion.coverage, Coverage::Complete);

    let changed = nested.join("after-promotion.txt");
    fs::write(&changed, "watched").unwrap();
    assert_eq!(
        wait_for_path(&promoted, &changed).coverage,
        Coverage::Complete
    );
    promoted.dispose().unwrap();
}

#[test]
fn promotion_invalidates_only_after_its_topology_barrier_completes() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let holder_root = TestDir::new("promotion-barrier-holder");
    let promoted_root = TestDir::new("promotion-barrier-target");
    for index in 0..4_000 {
        fs::write(promoted_root.path().join(format!("entry-{index:04}")), "x").unwrap();
    }
    let engine = bounded_engine(1);
    let holder = engine.subscribe(holder_root.path(), options()).unwrap();
    let promoted = engine.subscribe(promoted_root.path(), options()).unwrap();
    assert!(matches!(
        promoted.initial_coverage(),
        Coverage::Partial { .. }
    ));

    holder.dispose().unwrap();
    wait_for_stats(&promoted, |stats| stats.watched_directories == 1);
    let batch = wait_for_path(&promoted, promoted_root.path());

    assert_eq!(batch.coverage, Coverage::Complete);
    assert_eq!(
        batch.invalidated_paths,
        vec![promoted_root.path().to_path_buf()]
    );
    promoted.dispose().unwrap();
}

#[test]
fn bounded_promotion_yields_to_event_delivery_on_another_root() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let live_root = TestDir::new("promotion-yield-live");
    let holder_root = TestDir::new("promotion-yield-holder");
    let promoted_root = TestDir::new("promotion-yield-target");
    for index in 0..4_000 {
        fs::create_dir(promoted_root.path().join(format!("directory-{index:04}"))).unwrap();
    }
    let engine = bounded_engine(2);
    let live = engine.subscribe(live_root.path(), options()).unwrap();
    let holder = engine.subscribe(holder_root.path(), options()).unwrap();
    let promoted = engine.subscribe(promoted_root.path(), options()).unwrap();
    assert_eq!(promoted.stats().watched_directories, 0);

    holder.dispose().unwrap();
    let changed = live_root.path().join("during-promotion.txt");
    let started = Instant::now();
    fs::write(&changed, "live").unwrap();
    wait_for_path(&live, &changed);
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "promotion starved live delivery for {:?}",
        started.elapsed()
    );

    live.dispose().unwrap();
    promoted.dispose().unwrap();
}

#[test]
fn overlapping_disposal_releases_no_token_until_the_final_interest_is_removed() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let shared_root = TestDir::new("final-overlap-shared");
    let deferred_root = TestDir::new("final-overlap-deferred");
    let engine = bounded_engine(1);
    let first = engine.subscribe(shared_root.path(), options()).unwrap();
    let second = engine.subscribe(shared_root.path(), options()).unwrap();
    let deferred = engine.subscribe(deferred_root.path(), options()).unwrap();

    first.dispose().unwrap();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(engine.runtime_stats().native_watches, 1);
    assert_eq!(deferred.stats().watched_directories, 0);

    second.dispose().unwrap();
    wait_for_stats(&deferred, |stats| stats.watched_directories == 1);
    assert_eq!(
        wait_for_path(&deferred, deferred_root.path()).coverage,
        Coverage::Complete
    );
    deferred.dispose().unwrap();
}

#[test]
fn backpressure_isolated_from_bounded_allocator_coverage_and_delivery() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let slow_root = TestDir::new("bounded-backpressure-slow");
    let fast_root = TestDir::new("bounded-backpressure-fast");
    let engine = bounded_engine(2);
    let mut slow_options = options();
    slow_options.max_batch_paths = 1;
    slow_options.output_queue_capacity = 1;
    let slow = engine.subscribe(slow_root.path(), slow_options).unwrap();
    let fast = engine.subscribe(fast_root.path(), options()).unwrap();

    for index in 0..32 {
        fs::write(slow_root.path().join(format!("pressure-{index:02}")), "x").unwrap();
        std::thread::sleep(Duration::from_millis(7));
    }
    wait_for_stats(&slow, |stats| stats.batches_dropped > 0);
    assert_eq!(engine.runtime_stats().native_watches, 2);
    assert_eq!(fast.stats().watched_directories, 1);
    assert_eq!(fast.stats().deferred_directories, 0);

    let changed = fast_root.path().join("fast.txt");
    fs::write(&changed, "fast").unwrap();
    assert_eq!(wait_for_path(&fast, &changed).coverage, Coverage::Complete);
    slow.dispose().unwrap();
    fast.dispose().unwrap();
}

#[test]
fn final_bounded_runtime_shutdown_releases_allocator_and_native_state() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let watched_root = TestDir::new("bounded-shutdown-watched");
    let deferred_root = TestDir::new("bounded-shutdown-deferred");
    let engine = bounded_engine(1);
    let watched = engine.subscribe(watched_root.path(), options()).unwrap();
    let deferred = engine.subscribe(deferred_root.path(), options()).unwrap();
    assert_eq!(engine.runtime_stats().deferred_interests, 1);

    watched.dispose().unwrap();
    deferred.dispose().unwrap();

    assert_eq!(
        engine.runtime_stats(),
        watchbound_engine::RuntimeStats::default()
    );
}

#[test]
fn conflicting_runtime_budgets_are_rejected_for_one_runtime_lifetime() {
    let _serial = SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let first_root = TestDir::new("budget-config-first");
    let second_root = TestDir::new("budget-config-second");
    let first = bounded_engine(2)
        .subscribe(first_root.path(), options())
        .unwrap();

    let error = match bounded_engine(3).subscribe(second_root.path(), options()) {
        Ok(subscription) => {
            subscription.dispose().unwrap();
            panic!("conflicting budget should fail");
        }
        Err(error) => error,
    };
    assert_eq!(error.code(), ErrorCode::RuntimeConfigurationConflict);
    assert_eq!(error.operation(), Operation::Subscribe);

    first.dispose().unwrap();
    let second = bounded_engine(3)
        .subscribe(second_root.path(), options())
        .unwrap();
    assert_eq!(
        bounded_engine(3).runtime_stats().native_watch_budget,
        Some(3)
    );
    second.dispose().unwrap();
}
