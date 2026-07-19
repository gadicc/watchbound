use std::collections::{BTreeSet, HashMap, VecDeque};
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::time::{Duration, Instant};

use crate::{
    ChangeBatch, Coverage, PartialReason, SharedStats, SubscriptionOptions, UncertainReason,
};

const WATCH_MASK: u32 = libc::IN_ATTRIB
    | libc::IN_CLOSE_WRITE
    | libc::IN_CREATE
    | libc::IN_DELETE
    | libc::IN_DELETE_SELF
    | libc::IN_MODIFY
    | libc::IN_MOVE_SELF
    | libc::IN_MOVED_FROM
    | libc::IN_MOVED_TO
    | libc::IN_DONT_FOLLOW
    | libc::IN_ONLYDIR;
const READ_BUFFER_BYTES: usize = 64 * 1024;
const MAX_POLL_INTERVAL: Duration = Duration::from_millis(5);
const MAX_READS_PER_TURN: usize = 8;
// Checking the lexical root four times per second detects replacements above
// the watched inode without consuming an inotify watch for every ancestor.
const ROOT_IDENTITY_CHECK_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RootIdentity {
    device: u64,
    inode: u64,
}

impl RootIdentity {
    fn capture(path: &Path) -> io::Result<Self> {
        let canonical = fs::canonicalize(path)?;
        if canonical != path {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "watch root path resolved through a symbolic link: {}",
                    path.display()
                ),
            ));
        }

        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "watch root is no longer a real directory: {}",
                    path.display()
                ),
            ));
        }

        Ok(Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

#[derive(Clone, Copy)]
struct RuntimeControl<'a> {
    stop: &'a AtomicBool,
}

pub(crate) struct InitializedWatcher {
    fd: OwnedFd,
    root: PathBuf,
    root_identity: RootIdentity,
    next_root_identity_check: Option<Instant>,
    options: SubscriptionOptions,
    stats: Arc<SharedStats>,
    by_descriptor: HashMap<i32, PathBuf>,
    by_path: HashMap<PathBuf, i32>,
    expected_ignored: BTreeSet<i32>,
    deferred_directories: HashMap<PathBuf, PartialReason>,
    uncertain_reason: Option<UncertainReason>,
    pending_paths: BTreeSet<PathBuf>,
    pending_started: Option<Instant>,
    next_sequence: u64,
}

impl InitializedWatcher {
    pub(crate) fn new(
        root: PathBuf,
        options: SubscriptionOptions,
        stats: Arc<SharedStats>,
    ) -> io::Result<Self> {
        let root_identity = RootIdentity::capture(&root)?;
        // SAFETY: inotify_init1 has no pointer arguments and returns a new owned
        // descriptor on success.
        let raw_fd = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
        if raw_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: raw_fd was just returned uniquely by inotify_init1.
        let fd = unsafe { OwnedFd::from_raw_fd(raw_fd) };
        let mut watcher = Self {
            fd,
            root: root.clone(),
            root_identity,
            next_root_identity_check: None,
            options,
            stats,
            by_descriptor: HashMap::new(),
            by_path: HashMap::new(),
            expected_ignored: BTreeSet::new(),
            deferred_directories: HashMap::new(),
            uncertain_reason: None,
            pending_paths: BTreeSet::new(),
            pending_started: None,
            next_sequence: 1,
        };
        watcher.scan_subtree(&root);
        watcher.ensure_root_accounted()?;
        if RootIdentity::capture(&root)? != root_identity {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "watch root changed during establishment: {}",
                    root.display()
                ),
            ));
        }
        watcher.next_root_identity_check = Some(Instant::now() + ROOT_IDENTITY_CHECK_INTERVAL);
        watcher.publish_resource_counts();
        Ok(watcher)
    }

    pub(crate) fn coverage(&self) -> Coverage {
        if let Some(reason) = self.uncertain_reason {
            Coverage::Uncertain { reason }
        } else if let Some(reason) = self.current_partial_reason() {
            Coverage::Partial {
                reason,
                watched_directories: self.by_path.len(),
                deferred_directories: self.deferred_directories.len(),
            }
        } else {
            Coverage::Complete
        }
    }

    pub(crate) fn run(
        mut self,
        sender: SyncSender<ChangeBatch>,
        stop: Arc<AtomicBool>,
        stats: Arc<SharedStats>,
    ) {
        let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
        while !stop.load(Ordering::Acquire) {
            let timeout = self.poll_timeout();
            let timeout_ms = timeout.as_millis().min(i32::MAX as u128) as i32;
            let mut poll_fd = libc::pollfd {
                fd: self.fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: poll_fd points to one initialized pollfd for the duration
            // of this call.
            let poll_result = unsafe { libc::poll(&mut poll_fd, 1, timeout_ms) };
            if poll_result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    self.mark_uncertain(UncertainReason::TopologyRace, self.root.clone());
                }
            } else if poll_result > 0 {
                if poll_fd.revents & libc::POLLIN != 0 {
                    self.read_available_events(&mut buffer, &sender, &stop);
                }
                if poll_fd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                    self.mark_uncertain(UncertainReason::TopologyRace, self.root.clone());
                }
            }

            if stop.load(Ordering::Acquire) {
                break;
            }
            self.check_root_identity_if_due();
            if self.batch_is_due() {
                self.flush(&sender);
            }
        }
        stats.watched_directories.store(0, Ordering::Release);
        stats.deferred_directories.store(0, Ordering::Release);
    }

    fn read_available_events(
        &mut self,
        buffer: &mut [u8],
        sender: &SyncSender<ChangeBatch>,
        stop: &AtomicBool,
    ) {
        for _ in 0..MAX_READS_PER_TURN {
            if stop.load(Ordering::Acquire) {
                return;
            }
            // SAFETY: buffer is valid for writes of buffer.len() bytes, and fd
            // is a live nonblocking inotify descriptor.
            let read = unsafe {
                libc::read(
                    self.fd.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            if read < 0 {
                let error = io::Error::last_os_error();
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) {
                    return;
                }
                self.mark_uncertain(UncertainReason::TopologyRace, self.root.clone());
                return;
            }
            if read == 0 {
                return;
            }
            self.parse_events(&buffer[..read as usize], sender, stop);
            if self.batch_is_due() {
                self.flush(sender);
            }
        }
    }

    fn parse_events(&mut self, bytes: &[u8], sender: &SyncSender<ChangeBatch>, stop: &AtomicBool) {
        let header_size = std::mem::size_of::<libc::inotify_event>();
        let mut offset = 0;
        while offset + header_size <= bytes.len() {
            if stop.load(Ordering::Acquire) {
                return;
            }
            // SAFETY: the bounds check above provides header_size readable
            // bytes. read_unaligned is required because Vec<u8> has alignment 1.
            let event = unsafe {
                std::ptr::read_unaligned(bytes.as_ptr().add(offset).cast::<libc::inotify_event>())
            };
            let event_size = header_size.saturating_add(event.len as usize);
            if event_size < header_size || offset + event_size > bytes.len() {
                self.mark_uncertain(UncertainReason::TopologyRace, self.root.clone());
                return;
            }
            let name = if event.len == 0 {
                None
            } else {
                let raw_name = &bytes[offset + header_size..offset + event_size];
                let length = raw_name
                    .iter()
                    .position(|byte| *byte == 0)
                    .unwrap_or(raw_name.len());
                Some(std::ffi::OsString::from_vec(raw_name[..length].to_vec()))
            };
            self.handle_event_with_control(
                event.wd,
                event.mask,
                name.as_deref(),
                Some(RuntimeControl { stop }),
            );
            self.stats.raw_events.fetch_add(1, Ordering::Relaxed);
            if self.pending_paths.len() >= self.options.max_batch_paths || self.batch_is_due() {
                self.flush(sender);
            }
            offset += event_size;
        }
        if offset != bytes.len() {
            self.mark_uncertain(UncertainReason::TopologyRace, self.root.clone());
        }
    }

    #[cfg(test)]
    fn handle_event(&mut self, descriptor: i32, mask: u32, name: Option<&std::ffi::OsStr>) {
        self.handle_event_with_control(descriptor, mask, name, None);
    }

    fn handle_event_with_control(
        &mut self,
        descriptor: i32,
        mask: u32,
        name: Option<&std::ffi::OsStr>,
        control: Option<RuntimeControl<'_>>,
    ) {
        if mask & libc::IN_Q_OVERFLOW != 0 {
            self.stats.overflow_events.fetch_add(1, Ordering::Relaxed);
            self.mark_uncertain(UncertainReason::EventOverflow, self.root.clone());
            return;
        }

        let Some(directory) = self.by_descriptor.get(&descriptor).cloned() else {
            return;
        };
        let event_path = name.map_or_else(|| directory.clone(), |name| directory.join(name));

        if mask & libc::IN_UNMOUNT != 0 {
            self.mark_uncertain(UncertainReason::TopologyRace, self.root.clone());
            return;
        }

        if mask & libc::IN_IGNORED != 0 {
            let expected = self.expected_ignored.remove(&descriptor);
            self.by_descriptor.remove(&descriptor);
            if self.by_path.get(&directory) == Some(&descriptor) {
                self.by_path.remove(&directory);
            }
            self.publish_resource_counts();
            if directory == self.root {
                self.mark_uncertain(UncertainReason::RootReplaced, self.root.clone());
            } else if !expected {
                self.mark_uncertain(UncertainReason::TopologyRace, self.root.clone());
            }
            return;
        }

        if mask & libc::IN_DELETE_SELF != 0 {
            if directory == self.root {
                self.mark_uncertain(UncertainReason::RootReplaced, self.root.clone());
            } else {
                self.expected_ignored.insert(descriptor);
            }
        } else if mask & libc::IN_MOVE_SELF != 0 && directory == self.root {
            self.mark_uncertain(UncertainReason::RootReplaced, self.root.clone());
        }

        self.queue_path(event_path.clone());
        if mask & libc::IN_ISDIR != 0 {
            if mask & (libc::IN_MOVED_FROM | libc::IN_DELETE) != 0 {
                self.remove_subtree(&event_path);
            }
            if mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0 {
                self.scan_subtree_with_control(&event_path, control);
            }
        }
    }

    fn scan_subtree(&mut self, start: &Path) {
        self.scan_subtree_with_control(start, None);
    }

    fn scan_subtree_with_control(&mut self, start: &Path, control: Option<RuntimeControl<'_>>) {
        self.stats.topology_scans.fetch_add(1, Ordering::Relaxed);
        let mut queue = VecDeque::from([start.to_path_buf()]);
        while let Some(directory) = queue.pop_front() {
            if !self.runtime_checkpoint(control) {
                break;
            }

            let mut deferred_at_limit = false;
            if !self.by_path.contains_key(&directory) {
                let at_limit = self
                    .options
                    .watch_limit
                    .is_some_and(|limit| self.by_path.len() >= limit);
                if at_limit {
                    match fs::symlink_metadata(&directory) {
                        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                            deferred_at_limit = true;
                            self.defer(directory.clone(), PartialReason::ResourceLimit);
                        }
                        Ok(_) => {
                            self.remove_deferred_subtree(&directory);
                            continue;
                        }
                        Err(error) if path_is_stale_or_not_directory(&error) => {
                            self.remove_deferred_subtree(&directory);
                            continue;
                        }
                        Err(error) => {
                            self.defer(directory.clone(), partial_reason_for_error(&error));
                            continue;
                        }
                    }
                } else {
                    match self.add_watch(&directory) {
                        Ok(()) => {
                            self.deferred_directories.remove(&directory);
                        }
                        Err(error) if path_is_stale_or_not_directory(&error) => {
                            self.remove_deferred_subtree(&directory);
                            continue;
                        }
                        Err(error) => {
                            self.defer(directory.clone(), partial_reason_for_error(&error));
                            continue;
                        }
                    }
                }
            }

            match fs::read_dir(&directory) {
                Ok(entries) => {
                    if !deferred_at_limit {
                        self.deferred_directories.remove(&directory);
                    }
                    for entry in entries {
                        if !self.runtime_checkpoint(control) {
                            self.publish_resource_counts();
                            return;
                        }
                        match entry.and_then(|entry| {
                            let file_type = entry.file_type()?;
                            Ok((entry.path(), file_type))
                        }) {
                            Ok((path, file_type))
                                if file_type.is_dir() && !file_type.is_symlink() =>
                            {
                                queue.push_back(path);
                            }
                            Ok(_) => {}
                            Err(error) => {
                                self.defer(directory.clone(), partial_reason_for_error(&error));
                            }
                        }
                    }
                }
                Err(error) if path_is_stale_or_not_directory(&error) => {
                    self.remove_deferred_subtree(&directory);
                }
                Err(error) => {
                    self.defer(directory.clone(), partial_reason_for_error(&error));
                }
            }
        }
        self.publish_resource_counts();
    }

    fn add_watch(&mut self, path: &Path) -> io::Result<()> {
        let path_bytes = path.as_os_str().as_bytes();
        let c_path = CString::new(path_bytes).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("watch path contains NUL: {}", path.display()),
            )
        })?;
        // SAFETY: c_path is NUL-terminated and valid for this call; fd is a
        // live inotify descriptor.
        let descriptor =
            unsafe { libc::inotify_add_watch(self.fd.as_raw_fd(), c_path.as_ptr(), WATCH_MASK) };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        if let Some(previous_path) = self.by_descriptor.get(&descriptor) {
            if previous_path != path {
                let previous_path = previous_path.clone();
                self.mark_uncertain(UncertainReason::TopologyRace, self.root.clone());
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "inotify descriptor {descriptor} aliases {} and {}",
                        previous_path.display(),
                        path.display()
                    ),
                ));
            }
            return Ok(());
        }
        self.by_descriptor.insert(descriptor, path.to_path_buf());
        self.by_path.insert(path.to_path_buf(), descriptor);
        Ok(())
    }

    fn remove_subtree(&mut self, path: &Path) {
        let descriptors: Vec<_> = self
            .by_path
            .iter()
            .filter(|(candidate, _)| candidate.starts_with(path))
            .map(|(candidate, descriptor)| (candidate.clone(), *descriptor))
            .collect();
        for (watched_path, descriptor) in descriptors {
            self.by_path.remove(&watched_path);
            self.by_descriptor.remove(&descriptor);
            self.expected_ignored.remove(&descriptor);
            // SAFETY: fd is live. Failure is benign when the kernel has already
            // removed a watch for a deleted inode.
            unsafe {
                libc::inotify_rm_watch(self.fd.as_raw_fd(), descriptor);
            }
        }
        self.remove_deferred_subtree(path);
        self.publish_resource_counts();
    }

    fn queue_path(&mut self, path: PathBuf) {
        if path == self.root {
            self.pending_paths.clear();
            self.pending_paths.insert(path);
        } else if !self.pending_paths.contains(&self.root) {
            self.pending_paths.insert(path);
        }
        self.pending_started.get_or_insert_with(Instant::now);
    }

    fn mark_uncertain(&mut self, reason: UncertainReason, invalidated_path: PathBuf) {
        self.uncertain_reason = Some(match self.uncertain_reason {
            Some(current) if uncertainty_priority(current) >= uncertainty_priority(reason) => {
                current
            }
            _ => reason,
        });
        self.queue_path(invalidated_path);
    }

    fn defer(&mut self, path: PathBuf, reason: PartialReason) {
        self.deferred_directories
            .entry(path)
            .and_modify(|current| {
                if partial_priority(reason) > partial_priority(*current) {
                    *current = reason;
                }
            })
            .or_insert(reason);
    }

    fn remove_deferred_subtree(&mut self, path: &Path) {
        self.deferred_directories
            .retain(|candidate, _| !candidate.starts_with(path));
    }

    fn current_partial_reason(&self) -> Option<PartialReason> {
        self.deferred_directories
            .values()
            .copied()
            .max_by_key(|reason| partial_priority(*reason))
    }

    fn runtime_checkpoint(&self, control: Option<RuntimeControl<'_>>) -> bool {
        let Some(control) = control else {
            return true;
        };
        // A topology scan is part of handling the event that discovered it.
        // The caller flushes immediately after that event, once every
        // discovered directory is watched. Crossing the batch deadline here
        // is therefore latency, not evidence that filesystem coverage raced.
        !control.stop.load(Ordering::Acquire)
    }

    fn ensure_root_accounted(&self) -> io::Result<()> {
        if self.by_path.contains_key(&self.root)
            || self.deferred_directories.contains_key(&self.root)
        {
            return Ok(());
        }

        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "watch root disappeared during establishment: {}",
                self.root.display()
            ),
        ))
    }

    fn check_root_identity_if_due(&mut self) {
        let Some(due_at) = self.next_root_identity_check else {
            return;
        };
        let now = Instant::now();
        if now < due_at {
            return;
        }

        match RootIdentity::capture(&self.root) {
            Ok(identity) if identity == self.root_identity => {
                self.next_root_identity_check = Some(now + ROOT_IDENTITY_CHECK_INTERVAL);
            }
            Ok(_) | Err(_) => {
                self.next_root_identity_check = None;
                self.mark_uncertain(UncertainReason::RootReplaced, self.root.clone());
            }
        }
    }

    fn publish_resource_counts(&self) {
        self.stats
            .watched_directories
            .store(self.by_path.len(), Ordering::Release);
        self.stats
            .deferred_directories
            .store(self.deferred_directories.len(), Ordering::Release);
    }

    fn poll_timeout(&self) -> Duration {
        let batch_timeout = self.pending_started.map_or(MAX_POLL_INTERVAL, |started| {
            let remaining = self.options.batch_window.saturating_sub(started.elapsed());
            remaining.min(MAX_POLL_INTERVAL)
        });
        let identity_timeout = self
            .next_root_identity_check
            .map_or(MAX_POLL_INTERVAL, |due_at| {
                due_at.saturating_duration_since(Instant::now())
            });
        batch_timeout.min(identity_timeout).min(MAX_POLL_INTERVAL)
    }

    fn batch_is_due(&self) -> bool {
        self.pending_started
            .is_some_and(|started| started.elapsed() >= self.options.batch_window)
    }

    fn flush(&mut self, sender: &SyncSender<ChangeBatch>) {
        if self.pending_paths.is_empty() {
            self.pending_started = None;
            return;
        }
        if self.pending_paths.len() > self.options.max_batch_paths {
            self.mark_uncertain(UncertainReason::ConsumerBackpressure, self.root.clone());
        }
        let batch = ChangeBatch {
            sequence: self.next_sequence,
            invalidated_paths: std::mem::take(&mut self.pending_paths)
                .into_iter()
                .collect(),
            coverage: self.coverage(),
        };
        self.pending_started = None;
        match sender.try_send(batch) {
            Ok(()) => {
                self.next_sequence += 1;
                self.stats.batches_delivered.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Full(_)) => {
                self.stats.batches_dropped.fetch_add(1, Ordering::Relaxed);
                self.mark_uncertain(UncertainReason::ConsumerBackpressure, self.root.clone());
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }
}

fn path_is_stale_or_not_directory(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP)
    )
}

fn partial_priority(reason: PartialReason) -> u8 {
    match reason {
        PartialReason::TransientError => 1,
        PartialReason::ResourceLimit => 2,
        PartialReason::Permission => 3,
    }
}

fn uncertainty_priority(reason: UncertainReason) -> u8 {
    match reason {
        UncertainReason::ConsumerBackpressure => 1,
        UncertainReason::TopologyRace => 2,
        UncertainReason::RootReplaced => 3,
        UncertainReason::EventOverflow => 4,
    }
}

fn partial_reason_for_error(error: &io::Error) -> PartialReason {
    if error.kind() == io::ErrorKind::PermissionDenied {
        return PartialReason::Permission;
    }
    match error.raw_os_error() {
        Some(libc::ENOSPC | libc::EMFILE | libc::ENFILE | libc::ENOMEM) => {
            PartialReason::ResourceLimit
        }
        _ => PartialReason::TransientError,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);

    fn temporary_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let serial = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "watchbound-backend-{label}-{}-{nonce}-{serial}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        root
    }

    fn watcher(root: &Path) -> InitializedWatcher {
        InitializedWatcher::new(
            root.to_path_buf(),
            SubscriptionOptions::default(),
            Arc::new(SharedStats::new()),
        )
        .unwrap()
    }

    #[test]
    fn missing_root_cannot_initialize_with_complete_zero_watch_coverage() {
        let root = temporary_root("missing-root");
        fs::remove_dir(&root).unwrap();

        let result = InitializedWatcher::new(
            root,
            SubscriptionOptions::default(),
            Arc::new(SharedStats::new()),
        );

        match result {
            Ok(watcher) => panic!(
                "missing root initialized with {:?} and {} watches",
                watcher.coverage(),
                watcher.by_path.len()
            ),
            Err(error) => assert_eq!(error.kind(), io::ErrorKind::NotFound),
        }
    }

    #[test]
    fn native_overflow_invalidates_the_root_and_marks_coverage_uncertain() {
        let root = temporary_root("overflow");
        let mut watcher = watcher(&root);

        watcher.handle_event(-1, libc::IN_Q_OVERFLOW, None);

        assert_eq!(
            watcher.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::EventOverflow
            }
        );
        assert!(watcher.pending_paths.contains(&root));
        assert_eq!(watcher.stats.overflow_events.load(Ordering::Relaxed), 1);
        drop(watcher);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn full_output_queue_degrades_to_a_root_invalidation() {
        let root = temporary_root("backpressure");
        let mut watcher = watcher(&root);
        watcher.options.max_batch_paths = 1;
        let (sender, receiver) = mpsc::sync_channel(1);

        watcher.queue_path(root.join("first"));
        watcher.flush(&sender);
        watcher.queue_path(root.join("second"));
        watcher.flush(&sender);

        let first = receiver.recv().unwrap();
        assert_eq!(first.sequence, 1);
        watcher.queue_path(root.join("after-backpressure"));
        watcher.flush(&sender);
        let recovery = receiver.recv().unwrap();
        assert_eq!(recovery.sequence, 2);
        assert!(recovery.invalidated_paths.len() <= 1);
        assert_eq!(recovery.invalidated_paths, vec![root.clone()]);
        assert_eq!(
            recovery.coverage,
            Coverage::Uncertain {
                reason: UncertainReason::ConsumerBackpressure
            }
        );
        assert_eq!(watcher.stats.batches_dropped.load(Ordering::Relaxed), 1);

        drop(watcher);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_overflow_reason_is_not_replaced_by_weaker_uncertainty() {
        let root = temporary_root("uncertainty-priority");
        let mut watcher = watcher(&root);

        watcher.mark_uncertain(UncertainReason::EventOverflow, root.clone());
        watcher.mark_uncertain(UncertainReason::ConsumerBackpressure, root.clone());

        assert_eq!(
            watcher.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::EventOverflow
            }
        );
        drop(watcher);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unmount_and_unexpected_ignored_events_make_coverage_uncertain() {
        let root = temporary_root("unmount");
        let child = root.join("child");
        fs::create_dir(&child).unwrap();
        let mut unmount_watcher = watcher(&root);
        let descriptor = unmount_watcher.by_path[&child];

        unmount_watcher.handle_event(descriptor, libc::IN_UNMOUNT, None);
        assert_eq!(
            unmount_watcher.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::TopologyRace
            }
        );
        assert_eq!(
            unmount_watcher.pending_paths,
            BTreeSet::from([root.clone()])
        );

        drop(unmount_watcher);
        fs::remove_dir_all(root).unwrap();

        let root = temporary_root("ignored");
        let child = root.join("child");
        fs::create_dir(&child).unwrap();
        let mut watcher = watcher(&root);
        let descriptor = watcher.by_path[&child];
        watcher.handle_event(descriptor, libc::IN_IGNORED, None);
        assert_eq!(
            watcher.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::TopologyRace
            }
        );
        assert_eq!(watcher.pending_paths, BTreeSet::from([root.clone()]));

        drop(watcher);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_self_makes_the_following_ignored_event_expected() {
        let root = temporary_root("expected-ignored");
        let child = root.join("child");
        fs::create_dir(&child).unwrap();
        let mut watcher = watcher(&root);
        let descriptor = watcher.by_path[&child];

        watcher.handle_event(descriptor, libc::IN_DELETE_SELF, None);
        watcher.handle_event(descriptor, libc::IN_IGNORED, None);

        assert_eq!(watcher.coverage(), Coverage::Complete);
        assert!(!watcher.by_path.contains_key(&child));

        drop(watcher);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_symlink_watch_does_not_scan_through_the_link() {
        use std::os::unix::fs::symlink;

        let root = temporary_root("scan-symlink");
        let target = temporary_root("scan-symlink-target");
        fs::create_dir(target.join("nested")).unwrap();
        let link = root.join("link");
        symlink(&target, &link).unwrap();
        let mut watcher = watcher(&root);

        watcher.scan_subtree(&link);

        assert_eq!(watcher.by_path.len(), 1);
        assert!(!watcher.by_path.keys().any(|path| path.starts_with(&link)));
        assert_eq!(watcher.coverage(), Coverage::Complete);

        drop(watcher);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(target).unwrap();
    }

    #[test]
    fn descriptor_alias_collision_is_reported_conservatively() {
        use std::os::unix::fs::symlink;

        let container = temporary_root("descriptor-alias");
        let root = container.join("root");
        fs::create_dir(&root).unwrap();
        let alias_parent = container.join("alias-parent");
        symlink(&container, &alias_parent).unwrap();
        let mut watcher = watcher(&root);
        let original_descriptor = watcher.by_path[&root];
        let alias = alias_parent.join("root");

        assert!(watcher.add_watch(&alias).is_err());
        assert_eq!(watcher.by_path.get(&root), Some(&original_descriptor));
        assert!(!watcher.by_path.contains_key(&alias));
        assert_eq!(
            watcher.coverage(),
            Coverage::Uncertain {
                reason: UncertainReason::TopologyRace
            }
        );

        drop(watcher);
        fs::remove_dir_all(container).unwrap();
    }

    #[test]
    fn runtime_scan_observes_stop_before_watching_more_directories() {
        let root = temporary_root("scan-stop");
        let incoming = root.join("incoming");
        let mut watcher = watcher(&root);
        let watched_before = watcher.by_path.len();
        fs::create_dir_all(incoming.join("nested")).unwrap();
        let stop = AtomicBool::new(true);

        watcher.scan_subtree_with_control(&incoming, Some(RuntimeControl { stop: &stop }));

        assert_eq!(watcher.by_path.len(), watched_before);
        assert!(
            !watcher
                .by_path
                .keys()
                .any(|path| path.starts_with(&incoming))
        );

        drop(watcher);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_scan_keeps_detail_when_it_crosses_the_batch_deadline() {
        let root = temporary_root("scan-deadline");
        let incoming = root.join("incoming");
        let mut watcher = watcher(&root);
        fs::create_dir_all(incoming.join("nested")).unwrap();
        let (sender, receiver) = mpsc::sync_channel(1);
        let stop = AtomicBool::new(false);
        watcher.queue_path(incoming.clone());
        watcher.pending_started = Some(Instant::now() - watcher.options.batch_window);

        watcher.scan_subtree_with_control(&incoming, Some(RuntimeControl { stop: &stop }));

        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert_eq!(watcher.coverage(), Coverage::Complete);
        assert!(watcher.by_path.contains_key(&incoming));
        assert!(watcher.by_path.contains_key(&incoming.join("nested")));

        watcher.flush(&sender);
        let batch = receiver.recv().unwrap();
        assert_eq!(batch.invalidated_paths, vec![incoming]);
        assert_eq!(batch.coverage, Coverage::Complete);

        drop(watcher);
        fs::remove_dir_all(root).unwrap();
    }
}
