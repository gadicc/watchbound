use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use watchbound_engine::{
    Coverage, Engine, PartialReason, Subscription, SubscriptionOptions, UncertainReason,
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
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
        batch_window: Duration::from_millis(12),
        max_batch_paths: 256,
        output_queue_capacity: 16,
        ..SubscriptionOptions::default()
    }
}

fn wait_for_path(subscription: &Subscription, expected: &Path) {
    let _ = wait_for_batch_containing(subscription, expected);
}

fn wait_for_batch_containing(
    subscription: &Subscription,
    expected: &Path,
) -> watchbound_engine::ChangeBatch {
    let deadline = Instant::now() + TIMEOUT;
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let batch = subscription
            .recv_timeout(remaining)
            .unwrap_or_else(|error| {
                panic!("timed out waiting for {}: {error}", expected.display())
            });
        if batch.invalidated_paths.iter().any(|path| path == expected) {
            return batch;
        }
    }
    panic!("timed out waiting for {}", expected.display());
}

#[test]
fn establishes_recursive_coverage_before_subscribe_returns() {
    let root = TestDir::new("initial");
    let nested = root.path().join("one/two");
    fs::create_dir_all(&nested).unwrap();

    let engine = Engine::new();
    let mut subscription = engine.subscribe(root.path(), options()).unwrap();

    assert_eq!(subscription.initial_coverage(), &Coverage::Complete);
    assert_eq!(subscription.stats().watched_directories, 3);

    let changed = nested.join("changed.txt");
    fs::write(&changed, "first").unwrap();
    wait_for_path(&subscription, &changed);

    subscription.dispose().unwrap();
}

#[test]
fn scans_a_populated_tree_moved_into_the_root() {
    let root = TestDir::new("move-root");
    let source_parent = TestDir::new("move-source");
    let source = source_parent.path().join("populated");
    let deep = source.join("a/b/c");
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("existing.txt"), "before").unwrap();

    let engine = Engine::new();
    let mut subscription = engine.subscribe(root.path(), options()).unwrap();
    let destination = root.path().join("incoming");
    fs::rename(&source, &destination).unwrap();

    wait_for_path(&subscription, &destination);
    assert_eq!(subscription.stats().watched_directories, 5);

    let changed = destination.join("a/b/c/existing.txt");
    fs::write(&changed, "after").unwrap();
    wait_for_path(&subscription, &changed);

    subscription.dispose().unwrap();
}

#[test]
fn batches_a_file_burst_with_monotonic_sequences() {
    let root = TestDir::new("burst");
    let engine = Engine::new();
    let mut burst_options = options();
    burst_options.max_batch_paths = 17;
    let mut subscription = engine.subscribe(root.path(), burst_options).unwrap();
    let expected: BTreeSet<_> = (0..100)
        .map(|index| root.path().join(format!("file-{index:03}.txt")))
        .collect();

    for path in &expected {
        fs::write(path, "change").unwrap();
    }

    let deadline = Instant::now() + TIMEOUT;
    let mut observed = BTreeSet::new();
    let mut sequences = Vec::new();
    while observed != expected && Instant::now() < deadline {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("burst batch");
        assert!(
            batch.invalidated_paths.len() <= 17,
            "batch exceeded max_batch_paths: {:?}",
            batch.invalidated_paths
        );
        sequences.push(batch.sequence);
        observed.extend(
            batch
                .invalidated_paths
                .into_iter()
                .filter(|path| expected.contains(path)),
        );
    }

    assert_eq!(observed, expected);
    assert!(sequences.len() <= 12, "burst fragmented into {sequences:?}");
    assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(
        subscription.stats().batches_delivered,
        sequences.len() as u64
    );

    subscription.dispose().unwrap();
}

#[test]
fn reports_partial_coverage_when_the_watch_limit_is_reached() {
    let root = TestDir::new("limit");
    for index in 0..5 {
        fs::create_dir_all(root.path().join(format!("dir-{index}/nested"))).unwrap();
    }
    let mut limited = options();
    limited.watch_limit = Some(3);

    let engine = Engine::new();
    let mut subscription = engine.subscribe(root.path(), limited).unwrap();

    assert!(matches!(
        subscription.initial_coverage(),
        Coverage::Partial {
            reason: PartialReason::ResourceLimit,
            watched_directories: 3,
            deferred_directories: 8,
        }
    ));
    let stats = subscription.stats();
    assert_eq!(stats.watched_directories, 3);
    assert_eq!(stats.deferred_directories, 8);

    subscription.dispose().unwrap();
}

#[test]
fn deleting_a_deferred_subtree_restores_current_coverage_accounting() {
    let root = TestDir::new("deferred-delete");
    let deferred = root.path().join("gone");
    fs::create_dir_all(deferred.join("nested")).unwrap();
    let mut limited = options();
    limited.watch_limit = Some(1);

    let engine = Engine::new();
    let mut subscription = engine.subscribe(root.path(), limited).unwrap();
    assert_eq!(subscription.stats().deferred_directories, 2);

    fs::remove_dir_all(&deferred).unwrap();
    let batch = wait_for_batch_containing(&subscription, &deferred);

    assert_eq!(batch.coverage, Coverage::Complete);
    assert_eq!(subscription.stats().deferred_directories, 0);
    subscription.dispose().unwrap();
}

#[test]
fn stale_create_events_do_not_permanently_degrade_coverage() {
    let root = TestDir::new("transient-churn");
    let engine = Engine::new();
    let mut subscription = engine.subscribe(root.path(), options()).unwrap();

    for index in 0..64 {
        let transient = root.path().join(format!("transient-{index}"));
        fs::create_dir(&transient).unwrap();
        fs::remove_dir(&transient).unwrap();
    }

    let deadline = Instant::now() + TIMEOUT;
    let mut final_coverage = None;
    while Instant::now() < deadline {
        let stats = subscription.stats();
        if stats.raw_events >= 128
            && stats.deferred_directories == 0
            && final_coverage == Some(Coverage::Complete)
        {
            break;
        }
        if let Ok(batch) = subscription.recv_timeout(Duration::from_millis(50)) {
            final_coverage = Some(batch.coverage);
        }
    }
    while let Ok(batch) = subscription.try_recv() {
        final_coverage = Some(batch.coverage);
    }

    assert!(subscription.stats().raw_events >= 128);
    assert_eq!(subscription.stats().deferred_directories, 0);
    assert_eq!(final_coverage, Some(Coverage::Complete));
    subscription.dispose().unwrap();
}

#[test]
fn discovers_new_nested_directories_and_releases_deleted_watches() {
    let root = TestDir::new("new-topology");
    let engine = Engine::new();
    let mut subscription = engine.subscribe(root.path(), options()).unwrap();
    let nested = root.path().join("new/a/b");

    fs::create_dir_all(&nested).unwrap();
    let deadline = Instant::now() + TIMEOUT;
    while subscription.stats().watched_directories < 4 && Instant::now() < deadline {
        let _ = subscription.recv_timeout(Duration::from_millis(50));
    }
    assert_eq!(subscription.stats().watched_directories, 4);

    let changed = nested.join("deep.txt");
    fs::write(&changed, "deep").unwrap();
    wait_for_path(&subscription, &changed);

    let removed = root.path().join("new");
    fs::remove_dir_all(&removed).unwrap();
    let deletion_batch = wait_for_batch_containing(&subscription, &removed);
    assert_eq!(deletion_batch.coverage, Coverage::Complete);
    let deadline = Instant::now() + TIMEOUT;
    while subscription.stats().watched_directories != 1 && Instant::now() < deadline {
        let _ = subscription.recv_timeout(Duration::from_millis(50));
    }
    assert_eq!(subscription.stats().watched_directories, 1);

    subscription.dispose().unwrap();
}

#[test]
fn reports_root_moves_as_uncertain_instead_of_claiming_complete_coverage() {
    let parent = TestDir::new("root-replacement");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    fs::create_dir(&root).unwrap();

    let engine = Engine::new();
    let mut subscription = engine.subscribe(&root, options()).unwrap();
    fs::rename(&root, &moved).unwrap();

    let batch = subscription.recv_timeout(TIMEOUT).expect("root move batch");
    assert_eq!(
        batch.coverage,
        Coverage::Uncertain {
            reason: UncertainReason::RootReplaced,
        }
    );
    assert!(batch.invalidated_paths.contains(&root));

    subscription.dispose().unwrap();
}

#[test]
fn reports_ancestor_replacement_as_root_replacement_without_extra_watches() {
    let parent = TestDir::new("ancestor-replacement");
    let ancestor = parent.path().join("active");
    let moved_ancestor = parent.path().join("moved");
    let root = ancestor.join("root");
    fs::create_dir_all(&root).unwrap();

    let engine = Engine::new();
    let mut subscription = engine.subscribe(&root, options()).unwrap();
    assert_eq!(subscription.stats().watched_directories, 1);

    fs::rename(&ancestor, &moved_ancestor).unwrap();
    fs::create_dir_all(&root).unwrap();

    let deadline = Instant::now() + Duration::from_secs(2);
    let batch = loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("ancestor replacement should invalidate the root");
        if batch.invalidated_paths.contains(&root) {
            break batch;
        }
    };
    assert_eq!(
        batch.coverage,
        Coverage::Uncertain {
            reason: UncertainReason::RootReplaced,
        }
    );
    assert_eq!(subscription.stats().raw_events, 0);
    assert_eq!(subscription.stats().watched_directories, 1);

    subscription.dispose().unwrap();
}

#[test]
fn dispose_joins_the_worker_and_prevents_later_delivery() {
    let root = TestDir::new("dispose");
    let engine = Engine::new();
    let mut subscription = engine.subscribe(root.path(), options()).unwrap();

    subscription.dispose().unwrap();
    fs::write(root.path().join("after.txt"), "after dispose").unwrap();

    assert!(subscription.try_recv().is_err());
    let stats = subscription.stats();
    assert!(stats.disposed);
    assert_eq!(stats.watched_directories, 0);
    assert_eq!(stats.deferred_directories, 0);
}

#[test]
fn rejects_a_symlink_root_instead_of_escaping_the_named_topology() {
    let parent = TestDir::new("symlink-root");
    let target = parent.path().join("target");
    let link = parent.path().join("link");
    fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();

    let error = match Engine::new().subscribe(&link, options()) {
        Ok(mut subscription) => {
            subscription.dispose().unwrap();
            panic!("symlink root was accepted")
        }
        Err(error) => error,
    };
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert!(error.to_string().contains("symbolic link"));
}

#[test]
fn rejects_a_root_with_a_symlink_in_its_ancestry() {
    let parent = TestDir::new("symlink-ancestor");
    let target = parent.path().join("target");
    let nested = target.join("nested");
    let link = parent.path().join("link");
    fs::create_dir_all(&nested).unwrap();
    symlink(&target, &link).unwrap();

    let root_through_link = link.join("nested");
    let error = match Engine::new().subscribe(&root_through_link, options()) {
        Ok(mut subscription) => {
            subscription.dispose().unwrap();
            panic!("root with a symbolic-link ancestor was accepted")
        }
        Err(error) => error,
    };
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert!(error.to_string().contains("symbolic link"));
}

#[test]
fn rejects_a_symlink_component_even_when_parent_navigation_cancels_it_lexically() {
    let parent = TestDir::new("symlink-parent-navigation");
    let target = parent.path().join("target");
    let link = parent.path().join("link");
    fs::create_dir(&target).unwrap();
    symlink(&target, &link).unwrap();
    let root = link.join("..").join("target");

    let error = match Engine::new().subscribe(&root, options()) {
        Ok(mut subscription) => {
            subscription.dispose().unwrap();
            panic!("lexically cancelled symbolic-link component was accepted")
        }
        Err(error) => error,
    };
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    assert!(error.to_string().contains("symbolic link"));
}
