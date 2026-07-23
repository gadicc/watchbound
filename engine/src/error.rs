use std::fmt;
use std::io;

/// Maximum UTF-8 byte length retained for a public error message.
pub const MAX_ERROR_MESSAGE_BYTES: usize = 1_024;

/// Stable machine-readable categories for rejected Watchbound operations.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ErrorCode {
    InvalidArgument,
    SubscriptionClosed,
    TopologyTransactionConflict,
    OperationCancelled,
    OperationInterrupted,
    ConsumerBackpressure,
    RootStateConflict,
    RootUnavailable,
    ResourceUnavailable,
    RuntimeConfigurationConflict,
    Internal,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "WATCHBOUND_INVALID_ARGUMENT",
            Self::SubscriptionClosed => "WATCHBOUND_SUBSCRIPTION_CLOSED",
            Self::TopologyTransactionConflict => "WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT",
            Self::OperationCancelled => "WATCHBOUND_OPERATION_CANCELLED",
            Self::OperationInterrupted => "WATCHBOUND_OPERATION_INTERRUPTED",
            Self::ConsumerBackpressure => "WATCHBOUND_CONSUMER_BACKPRESSURE",
            Self::RootStateConflict => "WATCHBOUND_ROOT_STATE_CONFLICT",
            Self::RootUnavailable => "WATCHBOUND_ROOT_UNAVAILABLE",
            Self::ResourceUnavailable => "WATCHBOUND_RESOURCE_UNAVAILABLE",
            Self::RuntimeConfigurationConflict => "WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT",
            Self::Internal => "WATCHBOUND_INTERNAL",
        }
    }

    pub const fn retry_after(self) -> Option<RetryAfter> {
        match self {
            Self::TopologyTransactionConflict => Some(RetryAfter::TopologyTransactionSettles),
            Self::ConsumerBackpressure => Some(RetryAfter::DeliveryDrains),
            Self::RootStateConflict => Some(RetryAfter::RootStateChanges),
            Self::RootUnavailable => Some(RetryAfter::FilesystemStateChanges),
            Self::ResourceUnavailable => Some(RetryAfter::ResourcesAvailable),
            Self::RuntimeConfigurationConflict => Some(RetryAfter::RuntimeDisposed),
            Self::InvalidArgument
            | Self::SubscriptionClosed
            | Self::OperationCancelled
            | Self::OperationInterrupted
            | Self::Internal => None,
        }
    }

    pub const fn retryable(self) -> bool {
        self.retry_after().is_some()
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The public operation which was rejected.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Operation {
    CreateEngine,
    Subscribe,
    ReplaceExclusions,
    Reconcile,
    RecoverRoot,
    Dispose,
    DeliverBatch,
}

impl Operation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CreateEngine => "create-engine",
            Self::Subscribe => "subscribe",
            Self::ReplaceExclusions => "replace-exclusions",
            Self::Reconcile => "reconcile",
            Self::RecoverRoot => "recover-root",
            Self::Dispose => "dispose",
            Self::DeliverBatch => "deliver-batch",
        }
    }
}

impl fmt::Display for Operation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The state transition after which retrying an operation can be meaningful.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum RetryAfter {
    TopologyTransactionSettles,
    DeliveryDrains,
    RootStateChanges,
    FilesystemStateChanges,
    ResourcesAvailable,
    RuntimeDisposed,
}

impl RetryAfter {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TopologyTransactionSettles => "topology-transaction-settles",
            Self::DeliveryDrains => "delivery-drains",
            Self::RootStateChanges => "root-state-changes",
            Self::FilesystemStateChanges => "filesystem-state-changes",
            Self::ResourcesAvailable => "resources-available",
            Self::RuntimeDisposed => "runtime-disposed",
        }
    }
}

impl fmt::Display for RetryAfter {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Bounded operating-system information retained without exposing path text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SystemCause {
    kind: io::ErrorKind,
    raw_os_error: Option<i32>,
}

impl SystemCause {
    pub fn from_io(error: &io::Error) -> Self {
        Self {
            kind: error.kind(),
            raw_os_error: error.raw_os_error(),
        }
    }

    pub const fn kind(&self) -> io::ErrorKind {
        self.kind
    }

    pub const fn raw_os_error(&self) -> Option<i32> {
        self.raw_os_error
    }
}

impl fmt::Display for SystemCause {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.raw_os_error {
            Some(code) => write!(formatter, "{} (OS error {code})", self.kind),
            None => self.kind.fmt(formatter),
        }
    }
}

impl std::error::Error for SystemCause {}

/// A structured rejection from the Watchbound engine.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchboundError {
    code: ErrorCode,
    operation: Operation,
    message: String,
    system_cause: Option<SystemCause>,
}

impl WatchboundError {
    /// Constructs an error while deriving retry metadata solely from `code`.
    pub fn new(code: ErrorCode, operation: Operation, message: impl Into<String>) -> Self {
        Self {
            code,
            operation,
            message: bounded_message(message.into()),
            system_cause: None,
        }
    }

    pub fn with_system_cause(mut self, system_cause: SystemCause) -> Self {
        self.system_cause = Some(system_cause);
        self
    }

    pub(crate) fn from_io(
        code: ErrorCode,
        operation: Operation,
        message: impl Into<String>,
        cause: &io::Error,
    ) -> Self {
        Self::new(code, operation, message).with_system_cause(SystemCause::from_io(cause))
    }

    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    pub const fn operation(&self) -> Operation {
        self.operation
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub const fn retryable(&self) -> bool {
        self.code.retryable()
    }

    pub const fn retry_after(&self) -> Option<RetryAfter> {
        self.code.retry_after()
    }

    pub const fn system_cause(&self) -> Option<&SystemCause> {
        self.system_cause.as_ref()
    }
}

impl fmt::Display for WatchboundError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for WatchboundError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.system_cause
            .as_ref()
            .map(|cause| cause as &(dyn std::error::Error + 'static))
    }
}

pub type Result<T> = std::result::Result<T, WatchboundError>;

fn bounded_message(mut message: String) -> String {
    if message.len() <= MAX_ERROR_MESSAGE_BYTES {
        return message;
    }
    let mut end = MAX_ERROR_MESSAGE_BYTES;
    while !message.is_char_boundary(end) {
        end -= 1;
    }
    message.truncate(end);
    message
}
