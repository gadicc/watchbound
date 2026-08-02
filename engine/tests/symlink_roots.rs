#![cfg(target_os = "linux")]

use std::fs;
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use watchbound_engine::{
    Coverage, Engine, ErrorCode, ExclusionPolicy, RootAttachment, RootIdentityPolicy,
    RootPathPolicy, RootRecoveryAttachment, RootRecoveryFailureReason, Subscription,
    SubscriptionOptions,
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
            "watchbound-symlink-root-{label}-{}-{nonce}-{serial}",
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

fn physical_options() -> SubscriptionOptions {
    SubscriptionOptions {
        root_path_policy: RootPathPolicy::ResolvePhysical,
        batch_window: Duration::from_millis(5),
        ..SubscriptionOptions::default()
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
fn strict_policy_still_rejects_nested_and_lexically_cancelled_symlinks() {
    let _serial = serial();
    let parent = TestDir::new("strict");
    let target = parent.path().join("target");
    let aliases = parent.path().join("aliases");
    fs::create_dir_all(target.join("repo")).unwrap();
    fs::create_dir(&aliases).unwrap();
    symlink(&target, aliases.join("link")).unwrap();

    let engine = Engine::new();
    for root in [aliases.join("link/repo"), aliases.join("link/../repo")] {
        let error = match engine.subscribe(root, SubscriptionOptions::default()) {
            Ok(subscription) => {
                subscription.dispose().unwrap();
                panic!("strict policy accepted the symlink before lexical cancellation")
            }
            Err(error) => error,
        };
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
    }
    assert_eq!(engine.runtime_stats().subscriptions, 0);
    assert_eq!(engine.runtime_stats().native_watches, 0);
}

#[test]
fn resolve_physical_uses_os_order_for_nested_symlinks_and_dot_dot() {
    let _serial = serial();
    let parent = TestDir::new("nested");
    let physical = parent.path().join("physical");
    let aliases = parent.path().join("aliases");
    fs::create_dir_all(physical.join("nested")).unwrap();
    fs::create_dir(physical.join("repo")).unwrap();
    fs::create_dir(&aliases).unwrap();
    symlink(physical.join("nested"), aliases.join("inner")).unwrap();
    symlink(&aliases, parent.path().join("outer")).unwrap();
    let lexical = parent.path().join("outer/inner/../repo");
    let canonical = fs::canonicalize(&lexical).unwrap();
    assert_eq!(canonical, physical.join("repo"));

    let engine = Engine::new();
    let subscription = engine.subscribe(&lexical, physical_options()).unwrap();
    let resolution = subscription.resolved_root();
    assert_eq!(resolution.policy, RootPathPolicy::ResolvePhysical);
    assert_eq!(resolution.lexical_path, lexical);
    assert_eq!(resolution.physical_path, canonical);
    assert_eq!(
        resolution.identity,
        subscription.initial_root_state().identity
    );
    let metadata = fs::metadata(&canonical).unwrap();
    assert_eq!(resolution.identity.device, metadata.dev());
    assert_eq!(resolution.identity.inode, metadata.ino());

    let changed = canonical.join("physical-output");
    fs::write(&changed, b"changed").unwrap();
    wait_for_path(&subscription, &changed);
    subscription.dispose().unwrap();
    assert!(subscription.stats().disposed);
    assert_eq!(engine.runtime_stats().subscriptions, 0);
    assert_eq!(engine.runtime_stats().native_watches, 0);
}

#[test]
fn alias_removal_recreation_and_retargeting_do_not_move_physical_coverage() {
    let _serial = serial();
    let parent = TestDir::new("retarget");
    let original = parent.path().join("original");
    let replacement = parent.path().join("replacement");
    let alias = parent.path().join("repo");
    fs::create_dir_all(original.join("nested")).unwrap();
    fs::create_dir_all(replacement.join("nested")).unwrap();
    symlink(&original, &alias).unwrap();

    let engine = Engine::new();
    let subscription = engine.subscribe(&alias, physical_options()).unwrap();
    let initial = subscription.root_state();
    assert_eq!(subscription.resolved_root().physical_path, original);

    fs::remove_file(&alias).unwrap();
    let first = original.join("nested/while-alias-missing");
    fs::write(&first, b"first").unwrap();
    wait_for_path(&subscription, &first);

    symlink(&replacement, &alias).unwrap();
    let ignored = replacement.join("nested/not-covered");
    fs::write(&ignored, b"ignored").unwrap();
    let second = original.join("nested/still-covered");
    fs::write(&second, b"second").unwrap();
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        assert!(!batch.invalidated_paths.contains(&ignored));
        if batch.invalidated_paths.contains(&second) {
            break;
        }
    }
    assert_eq!(subscription.root_state(), initial);
    assert_eq!(
        subscription.root_state().attachment,
        RootAttachment::Attached
    );
    let error = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .expect_err("an alias retarget does not make the physical root recoverable");
    assert_eq!(error.code(), ErrorCode::RootStateConflict);
    assert!(error.retryable());

    subscription.dispose().unwrap();
    assert_eq!(engine.runtime_stats().native_watches, 0);
}

#[test]
fn recovery_is_anchored_to_the_captured_physical_path() {
    let _serial = serial();
    let parent = TestDir::new("recovery");
    let physical = parent.path().join("physical");
    let moved = parent.path().join("moved");
    let alternate = parent.path().join("alternate");
    let alias = parent.path().join("repo");
    fs::create_dir_all(physical.join("nested")).unwrap();
    fs::create_dir_all(alternate.join("nested")).unwrap();
    symlink(&physical, &alias).unwrap();

    let engine = Engine::new();
    let subscription = engine.subscribe(&alias, physical_options()).unwrap();
    fs::rename(&physical, &moved).unwrap();
    fs::remove_file(&alias).unwrap();
    symlink(&alternate, &alias).unwrap();

    let deadline = Instant::now() + TIMEOUT;
    loop {
        let batch = subscription
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("physical root loss batch");
        if batch.root_state.attachment == RootAttachment::Lost {
            assert_eq!(batch.invalidated_paths, vec![physical.clone()]);
            assert!(matches!(batch.coverage, Coverage::Uncertain { .. }));
            break;
        }
    }

    let missing = subscription
        .recover_root(RootIdentityPolicy::AcceptReplacement)
        .unwrap();
    assert_eq!(missing.attachment, RootRecoveryAttachment::NotAttached);
    assert_eq!(
        missing.reason,
        Some(RootRecoveryFailureReason::CandidateMissing)
    );
    assert_eq!(missing.candidate_identity, None);

    fs::rename(&moved, &physical).unwrap();
    let restored = subscription
        .recover_root(RootIdentityPolicy::OriginalOnly)
        .unwrap();
    assert_eq!(
        restored.attachment,
        RootRecoveryAttachment::OriginalRestored
    );
    assert_eq!(
        restored.current_root_state.attachment,
        RootAttachment::Attached
    );
    let changed = physical.join("nested/after");
    fs::write(&changed, b"after").unwrap();
    wait_for_path(&subscription, &changed);

    subscription.dispose().unwrap();
    assert_eq!(engine.runtime_stats().subscriptions, 0);
    assert_eq!(engine.runtime_stats().native_watches, 0);
}

#[test]
fn exclusions_are_contained_in_the_canonical_physical_namespace() {
    let _serial = serial();
    let parent = TestDir::new("exclusions");
    let physical = parent.path().join("physical");
    let alias = parent.path().join("repo");
    fs::create_dir_all(physical.join("visible")).unwrap();
    fs::create_dir_all(physical.join("hidden/deep")).unwrap();
    fs::create_dir_all(physical.join(".git/objects")).unwrap();
    symlink(&physical, &alias).unwrap();

    let mut options = physical_options();
    options.initial_exclusions = vec![PathBuf::from("hidden")];
    options.observed_excluded_paths = vec![PathBuf::from(".git")];
    let engine = Engine::new();
    let subscription = engine.subscribe(&alias, options).unwrap();
    assert_eq!(subscription.stats().watched_directories, 2);

    let hidden = physical.join("hidden/deep/ignored");
    fs::write(&hidden, b"ignored").unwrap();
    let visible = physical.join("visible/delivered");
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

    fs::remove_dir_all(physical.join(".git")).unwrap();
    wait_for_path(&subscription, &physical.join(".git"));
    let error = subscription
        .replace_exclusion_policy(
            1,
            ExclusionPolicy {
                prefixes: vec![PathBuf::from("../escape")],
                ..ExclusionPolicy::default()
            },
        )
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    assert_eq!(subscription.exclusion_generation(), 0);

    subscription.dispose().unwrap();
    assert_eq!(engine.runtime_stats().native_watches, 0);
}
