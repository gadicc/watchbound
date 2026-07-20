#![cfg(target_os = "linux")]

use std::fs;
use std::io;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use watchbound_engine::{
    ChangeBatch, Coverage, Engine, PartialReason, RootAttachment, RootIdentityPolicy,
    RootLossEvidence, RootRecoveryAttachment, RootRecoveryFailureReason, Subscription,
    SubscriptionOptions, UncertainReason,
};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
static SERIAL: Mutex<()> = Mutex::new(());
const TIMEOUT: Duration = Duration::from_secs(3);

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
            "watchbound-root-recovery-{label}-{}-{nonce}-{serial}",
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

fn wait_for_root_loss(subscription: &Subscription, root: &Path) -> ChangeBatch {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("root loss batch");
        if batch.invalidated_paths.contains(&root.to_path_buf())
            && batch.root_state.attachment == RootAttachment::Lost
        {
            assert!(matches!(batch.coverage, Coverage::Uncertain { .. }));
            return batch;
        }
    }
}

fn wait_for_path(subscription: &Subscription, expected: &Path) {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("expected path batch");
        if batch.invalidated_paths.contains(&expected.to_path_buf()) {
            return;
        }
    }
}

#[test]
fn initial_and_ordinary_batches_publish_attached_root_identity_generation_zero() {
    let _serial = serial();
    let root = TestDir::new("initial-state");
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    let initial = subscription.root_state();
    assert_eq!(initial.generation, 0);
    assert_eq!(initial.attachment, RootAttachment::Attached);
    assert_eq!(initial.loss_evidence, None);

    let changed = root.path().join("changed");
    fs::write(&changed, b"changed").unwrap();
    let batch = subscription.recv_timeout(TIMEOUT).unwrap();
    assert!(batch.invalidated_paths.contains(&changed));
    assert_eq!(batch.root_state, initial);
    subscription.dispose().unwrap();
}

#[test]
fn direct_replacement_requires_explicit_acceptance_and_keeps_one_subscription() {
    let _serial = serial();
    let parent = TestDir::new("direct");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    fs::create_dir_all(root.join("old/deep")).unwrap();
    let subscription = Engine::new().subscribe(&root, options()).unwrap();
    let original = subscription.root_state();

    fs::rename(&root, &moved).unwrap();
    fs::create_dir_all(root.join("new/deep")).unwrap();
    let loss = wait_for_root_loss(&subscription, &root);
    assert_eq!(
        loss.root_state.loss_evidence,
        Some(RootLossEvidence::RootSelfEvent)
    );

    let refused = subscription
        .recover_root(RootIdentityPolicy::OriginalOnly)
        .unwrap();
    assert_eq!(refused.attachment, RootRecoveryAttachment::NotAttached);
    assert_eq!(
        refused.reason,
        Some(RootRecoveryFailureReason::ReplacementNotAccepted)
    );
    assert_eq!(refused.previous_root_state.identity, original.identity);
    assert_eq!(refused.previous_root_state.generation, original.generation);
    assert_eq!(refused.previous_root_state.attachment, RootAttachment::Lost);
    assert_eq!(refused.current_root_state.attachment, RootAttachment::Lost);

    let recovered = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap();
    assert_eq!(
        recovered.attachment,
        RootRecoveryAttachment::ReplacementAdopted
    );
    assert_ne!(recovered.candidate_identity, Some(original.identity));
    assert_eq!(recovered.current_root_state.generation, 1);
    assert_eq!(
        recovered.current_root_state.attachment,
        RootAttachment::Attached
    );
    assert_eq!(recovered.exclusion_generation, 0);
    assert_eq!(recovered.coverage, Coverage::Complete);
    assert!(recovered.boundary_sequence.is_some());

    let boundary = subscription.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(boundary.invalidated_paths, vec![root.clone()]);
    assert_eq!(boundary.root_state, recovered.current_root_state);
    assert_eq!(boundary.sequence, recovered.boundary_sequence.unwrap());

    let changed = root.join("new/deep/after");
    fs::write(&changed, b"after").unwrap();
    wait_for_path(&subscription, &changed);
    subscription.dispose().unwrap();
}

#[test]
fn original_only_recovers_the_same_identity_after_it_returns() {
    let _serial = serial();
    let parent = TestDir::new("original-returned");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    fs::create_dir_all(root.join("nested")).unwrap();
    let subscription = Engine::new().subscribe(&root, options()).unwrap();
    let original = subscription.root_state();

    fs::rename(&root, &moved).unwrap();
    wait_for_root_loss(&subscription, &root);
    fs::rename(&moved, &root).unwrap();

    let recovered = subscription
        .recover_root(RootIdentityPolicy::OriginalOnly)
        .unwrap();
    assert_eq!(
        recovered.attachment,
        RootRecoveryAttachment::OriginalRestored
    );
    assert_eq!(recovered.candidate_identity, Some(original.identity));
    assert_eq!(recovered.current_root_state.identity, original.identity);
    assert_eq!(recovered.current_root_state.generation, 1);
    assert_eq!(recovered.coverage, Coverage::Complete);
    subscription.dispose().unwrap();
}

#[test]
fn ancestor_replacement_uses_path_identity_evidence_and_recovers_without_ancestor_watch() {
    let _serial = serial();
    let parent = TestDir::new("ancestor");
    let ancestor = parent.path().join("active");
    let moved = parent.path().join("moved");
    let root = ancestor.join("root");
    fs::create_dir_all(root.join("nested/deep")).unwrap();
    let subscription = Engine::new().subscribe(&root, options()).unwrap();

    fs::rename(&ancestor, &moved).unwrap();
    fs::create_dir_all(root.join("replacement/deep")).unwrap();
    let loss = wait_for_root_loss(&subscription, &root);
    assert_eq!(
        loss.root_state.loss_evidence,
        Some(RootLossEvidence::PathIdentityMismatch)
    );
    assert_eq!(subscription.stats().watched_directories, 3);

    let recovered = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap();
    assert_eq!(
        recovered.attachment,
        RootRecoveryAttachment::ReplacementAdopted
    );
    assert_eq!(subscription.stats().watched_directories, 3);
    let changed = root.join("replacement/deep/after");
    fs::write(&changed, b"after").unwrap();
    wait_for_path(&subscription, &changed);
    subscription.dispose().unwrap();
}

#[test]
fn replacement_recovery_preserves_exclusions_and_committed_generation() {
    let _serial = serial();
    let parent = TestDir::new("exclusions");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    fs::create_dir_all(root.join("visible")).unwrap();
    fs::create_dir_all(root.join("hidden/current")).unwrap();
    let subscription = Engine::new().subscribe(&root, options()).unwrap();
    subscription
        .replace_exclusions(1, vec![PathBuf::from("hidden")])
        .unwrap();

    fs::rename(&root, &moved).unwrap();
    fs::create_dir_all(root.join("visible/deep")).unwrap();
    fs::create_dir_all(root.join("hidden/current")).unwrap();
    wait_for_root_loss(&subscription, &root);
    let recovered = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap();
    assert_eq!(recovered.exclusion_generation, 1);
    assert_eq!(subscription.exclusion_generation(), 1);
    assert_eq!(recovered.coverage, Coverage::Complete);
    assert_eq!(subscription.stats().watched_directories, 3);
    let boundary = subscription.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(boundary.exclusion_generation, 1);
    assert_eq!(boundary.invalidated_paths, vec![root.clone()]);

    let hidden = root.join("hidden/current/ignored");
    fs::write(&hidden, b"ignored").unwrap();
    let visible = root.join("visible/deep/delivered");
    fs::write(&visible, b"delivered").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        assert!(!batch.invalidated_paths.contains(&hidden));
        if batch.invalidated_paths.contains(&visible) {
            break;
        }
    }
    let future = root.join("hidden/future/deep");
    fs::create_dir_all(&future).unwrap();
    fs::write(future.join("ignored"), b"ignored").unwrap();
    assert!(
        subscription
            .recv_timeout(Duration::from_millis(100))
            .is_err()
    );
    subscription.dispose().unwrap();
}

#[test]
fn replacement_recovery_commits_truthful_partial_coverage_at_watch_limit() {
    let _serial = serial();
    let parent = TestDir::new("partial");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    fs::create_dir(&root).unwrap();
    let mut limited = options();
    limited.watch_limit = Some(2);
    let subscription = Engine::new().subscribe(&root, limited).unwrap();

    fs::rename(&root, &moved).unwrap();
    fs::create_dir_all(root.join("one/deep")).unwrap();
    fs::create_dir_all(root.join("two/deep")).unwrap();
    wait_for_root_loss(&subscription, &root);
    let recovered = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap();
    assert!(matches!(
        recovered.coverage,
        Coverage::Partial {
            reason: PartialReason::ResourceLimit,
            watched_directories: 2,
            deferred_directories: 2,
        }
    ));
    assert!(recovered.boundary_sequence.is_some());
    let boundary = subscription.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(boundary.invalidated_paths, vec![root.clone()]);
    assert_eq!(boundary.coverage, recovered.coverage);
    subscription.dispose().unwrap();
}

#[test]
fn full_output_queue_attaches_identity_but_returns_uncertain_without_boundary_credit() {
    let _serial = serial();
    let parent = TestDir::new("backpressure");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    fs::create_dir(&root).unwrap();
    let mut bounded = options();
    bounded.output_queue_capacity = 1;
    let subscription = Engine::new().subscribe(&root, bounded).unwrap();

    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    wait_for_root_loss(&subscription, &root);
    let delivered_before = subscription.stats().batches_delivered;
    fs::write(moved.join("fills-output"), b"filled").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    while subscription.stats().batches_delivered == delivered_before && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert!(subscription.stats().batches_delivered > delivered_before);

    let recovered = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap();
    assert_eq!(
        recovered.attachment,
        RootRecoveryAttachment::ReplacementAdopted
    );
    assert_eq!(
        recovered.current_root_state.attachment,
        RootAttachment::Attached
    );
    assert_eq!(recovered.boundary_sequence, None);
    assert_eq!(
        recovered.coverage,
        Coverage::Uncertain {
            reason: UncertainReason::ConsumerBackpressure,
        }
    );
    assert_eq!(subscription.stats().batches_dropped, 1);
    subscription.dispose().unwrap();
}

#[test]
fn shared_old_root_watch_can_make_new_root_explicitly_unavailable() {
    let _serial = serial();
    let parent = TestDir::new("shared-budget");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    fs::create_dir(&root).unwrap();
    let engine = Engine::with_runtime_watch_budget(1).unwrap();
    let primary = engine.subscribe(&root, options()).unwrap();
    let peer = engine.subscribe(&root, options()).unwrap();
    assert_eq!(engine.runtime_stats().native_watches, 1);

    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    wait_for_root_loss(&primary, &root);
    let result = primary
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap();
    assert_eq!(result.attachment, RootRecoveryAttachment::NotAttached);
    assert_eq!(
        result.reason,
        Some(RootRecoveryFailureReason::RootWatchUnavailable)
    );
    assert_eq!(primary.stats().watched_directories, 0);
    assert_eq!(peer.stats().watched_directories, 1);
    primary.dispose().unwrap();
    peer.dispose().unwrap();
}

#[test]
fn candidate_identity_change_during_scan_is_not_followed() {
    let _serial = serial();
    let parent = TestDir::new("unstable");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    let shifted = parent.path().join("shifted");
    fs::create_dir(&root).unwrap();
    let subscription = Engine::new().subscribe(&root, options()).unwrap();
    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    for index in 0..5_000 {
        fs::create_dir(root.join(format!("dir-{index:04}"))).unwrap();
    }
    wait_for_root_loss(&subscription, &root);
    let scans_before = subscription.stats().topology_scans;
    let recovery = subscription.root_recovery_handle();
    let running =
        std::thread::spawn(move || recovery.recover_root(RootIdentityPolicy::AcceptReplacement));
    let deadline = Instant::now() + TIMEOUT;
    while subscription.stats().topology_scans == scans_before && Instant::now() < deadline {
        std::thread::yield_now();
    }
    fs::rename(&root, &shifted).unwrap();
    fs::create_dir(&root).unwrap();
    let result = running.join().unwrap().unwrap();
    assert_eq!(result.attachment, RootRecoveryAttachment::NotAttached);
    assert_eq!(
        result.reason,
        Some(RootRecoveryFailureReason::IdentityUnstable)
    );
    assert_eq!(result.current_root_state.attachment, RootAttachment::Lost);
    assert_eq!(subscription.stats().watched_directories, 0);
    subscription.dispose().unwrap();
}

#[test]
fn large_recovery_yields_to_peer_delivery_and_disposal_joins() {
    let _serial = serial();
    let parent = TestDir::new("peer");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    let peer_root = parent.path().join("peer-root");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&peer_root).unwrap();
    let engine = Engine::new();
    let subscription = engine.subscribe(&root, options()).unwrap();
    let peer = engine.subscribe(&peer_root, options()).unwrap();
    fs::rename(&root, &moved).unwrap();
    fs::create_dir(&root).unwrap();
    for index in 0..3_000 {
        fs::create_dir(root.join(format!("dir-{index:04}"))).unwrap();
    }
    wait_for_root_loss(&subscription, &root);
    let recovery = subscription.root_recovery_handle();
    let running =
        std::thread::spawn(move || recovery.recover_root(RootIdentityPolicy::AcceptReplacement));

    let peer_change = peer_root.join("during-recovery");
    fs::write(&peer_change, b"peer").unwrap();
    wait_for_path(&peer, &peer_change);
    subscription.dispose().unwrap();
    let result = running.join().unwrap();
    assert!(
        result.is_ok()
            || matches!(
                result.unwrap_err().kind(),
                io::ErrorKind::Interrupted | io::ErrorKind::NotConnected
            )
    );
    subscription.dispose().unwrap();
    peer.dispose().unwrap();
    assert_eq!(
        engine.runtime_stats(),
        watchbound_engine::RuntimeStats::default()
    );
}

#[test]
fn root_loss_blocks_exclusion_updates_and_hidden_deferred_promotion() {
    let _serial = serial();
    let parent = TestDir::new("freeze");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    fs::create_dir_all(root.join("deferred")).unwrap();
    let mut limited = options();
    limited.watch_limit = Some(1);
    let subscription = Engine::new().subscribe(&root, limited).unwrap();
    assert_eq!(subscription.stats().watched_directories, 1);
    assert_eq!(subscription.stats().deferred_directories, 1);

    fs::rename(&root, &moved).unwrap();
    fs::create_dir_all(root.join("deferred")).unwrap();
    wait_for_root_loss(&subscription, &root);
    fs::remove_dir_all(&moved).unwrap();
    std::thread::sleep(Duration::from_millis(350));

    let error = subscription
        .replace_exclusions(1, vec![PathBuf::from("future")])
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert_eq!(subscription.root_state().attachment, RootAttachment::Lost);
    assert_eq!(subscription.stats().watched_directories, 0);
    fs::write(root.join("deferred/hidden"), b"hidden").unwrap();
    while let Ok(batch) = subscription.recv_timeout(Duration::from_millis(100)) {
        assert!(
            !batch
                .invalidated_paths
                .contains(&root.join("deferred/hidden"))
        );
        assert_eq!(batch.invalidated_paths, vec![root.clone()]);
        assert_eq!(batch.root_state.attachment, RootAttachment::Lost);
    }
    subscription.dispose().unwrap();
}

#[test]
fn symlink_ancestor_candidate_is_not_attached() {
    let _serial = serial();
    let parent = TestDir::new("symlink-candidate");
    let ancestor = parent.path().join("active");
    let moved = parent.path().join("moved");
    let target = parent.path().join("target");
    let root = ancestor.join("root");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(target.join("root")).unwrap();
    let subscription = Engine::new().subscribe(&root, options()).unwrap();

    fs::rename(&ancestor, &moved).unwrap();
    symlink(&target, &ancestor).unwrap();
    wait_for_root_loss(&subscription, &root);
    let result = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap();
    assert_eq!(result.attachment, RootRecoveryAttachment::NotAttached);
    assert_eq!(
        result.reason,
        Some(RootRecoveryFailureReason::SymlinkAncestry)
    );
    assert_eq!(result.current_root_state.attachment, RootAttachment::Lost);
    subscription.dispose().unwrap();
}

#[test]
fn missing_and_non_directory_candidates_return_structured_failures() {
    let _serial = serial();
    let parent = TestDir::new("invalid-candidates");
    let root = parent.path().join("root");
    let moved = parent.path().join("moved");
    fs::create_dir(&root).unwrap();
    let subscription = Engine::new().subscribe(&root, options()).unwrap();

    fs::rename(&root, &moved).unwrap();
    wait_for_root_loss(&subscription, &root);
    let missing = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap();
    assert_eq!(missing.attachment, RootRecoveryAttachment::NotAttached);
    assert_eq!(
        missing.reason,
        Some(RootRecoveryFailureReason::CandidateMissing)
    );
    assert_eq!(missing.candidate_identity, None);

    fs::write(&root, b"not a directory").unwrap();
    let non_directory = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap();
    assert_eq!(
        non_directory.reason,
        Some(RootRecoveryFailureReason::CandidateNotDirectory)
    );
    assert_eq!(
        non_directory.current_root_state.attachment,
        RootAttachment::Lost
    );
    subscription.dispose().unwrap();
}

#[test]
fn recovery_is_rejected_while_the_root_is_still_attached() {
    let _serial = serial();
    let root = TestDir::new("still-attached");
    let subscription = Engine::new().subscribe(root.path(), options()).unwrap();
    let error = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    assert_eq!(
        subscription.root_state().attachment,
        RootAttachment::Attached
    );
    subscription.dispose().unwrap();
}
