export const WatchboundErrorCode = Object.freeze({
  INVALID_ARGUMENT: "WATCHBOUND_INVALID_ARGUMENT",
  SUBSCRIPTION_CLOSED: "WATCHBOUND_SUBSCRIPTION_CLOSED",
  TOPOLOGY_TRANSACTION_CONFLICT: "WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT",
  OPERATION_INTERRUPTED: "WATCHBOUND_OPERATION_INTERRUPTED",
  CONSUMER_BACKPRESSURE: "WATCHBOUND_CONSUMER_BACKPRESSURE",
  ROOT_STATE_CONFLICT: "WATCHBOUND_ROOT_STATE_CONFLICT",
  ROOT_UNAVAILABLE: "WATCHBOUND_ROOT_UNAVAILABLE",
  RESOURCE_UNAVAILABLE: "WATCHBOUND_RESOURCE_UNAVAILABLE",
  RUNTIME_CONFIGURATION_CONFLICT: "WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT",
  INTERNAL: "WATCHBOUND_INTERNAL",
});

export const WatchboundRetryAfter = Object.freeze({
  TOPOLOGY_TRANSACTION_SETTLES: "topology-transaction-settles",
  DELIVERY_DRAINS: "delivery-drains",
  ROOT_STATE_CHANGES: "root-state-changes",
  FILESYSTEM_STATE_CHANGES: "filesystem-state-changes",
  RESOURCES_AVAILABLE: "resources-available",
  RUNTIME_DISPOSED: "runtime-disposed",
});

const errorCodes = new Set(Object.values(WatchboundErrorCode));
const retryAfterValues = new Set(Object.values(WatchboundRetryAfter));
const retryAfterByCode = Object.freeze({
  [WatchboundErrorCode.TOPOLOGY_TRANSACTION_CONFLICT]:
    WatchboundRetryAfter.TOPOLOGY_TRANSACTION_SETTLES,
  [WatchboundErrorCode.CONSUMER_BACKPRESSURE]: WatchboundRetryAfter.DELIVERY_DRAINS,
  [WatchboundErrorCode.ROOT_STATE_CONFLICT]: WatchboundRetryAfter.ROOT_STATE_CHANGES,
  [WatchboundErrorCode.ROOT_UNAVAILABLE]: WatchboundRetryAfter.FILESYSTEM_STATE_CHANGES,
  [WatchboundErrorCode.RESOURCE_UNAVAILABLE]: WatchboundRetryAfter.RESOURCES_AVAILABLE,
  [WatchboundErrorCode.RUNTIME_CONFIGURATION_CONFLICT]:
    WatchboundRetryAfter.RUNTIME_DISPOSED,
});
const operations = new Set([
  "create-engine",
  "subscribe",
  "replace-exclusions",
  "reconcile",
  "recover-root",
  "dispose",
  "deliver-batch",
]);
const systemCauseDomains = new Set(["os", "node-api"]);
const MAX_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_SYSTEM_DETAIL_LENGTH = 128;

export class WatchboundError extends Error {
  constructor(message, { code, operation, systemCause, cause }) {
    super(
      boundedString(message, MAX_ERROR_MESSAGE_LENGTH),
      cause === undefined ? undefined : { cause },
    );
    const retryAfter = retryAfterForCode(code);
    const normalizedSystemCause = normalizeSystemCause(systemCause);
    Object.defineProperties(this, {
      name: { value: "WatchboundError" },
      code: { value: code, enumerable: true },
      operation: { value: operation, enumerable: true },
      retryable: { value: retryAfter !== undefined, enumerable: true },
      ...(retryAfter === undefined
        ? {}
        : { retryAfter: { value: retryAfter, enumerable: true } }),
      ...(normalizedSystemCause === undefined
        ? {}
        : {
            systemCause: {
              value: Object.freeze(normalizedSystemCause),
              enumerable: true,
            },
          }),
    });
  }
}

export function isWatchboundError(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      error.name === "WatchboundError" &&
      errorCodes.has(error.code) &&
      operations.has(error.operation) &&
      error.retryable === (retryAfterForCode(error.code) !== undefined) &&
      error.retryAfter === retryAfterForCode(error.code) &&
      (error.systemCause === undefined ||
        normalizeSystemCause(error.systemCause) !== undefined),
  );
}

export function normalizeWatchboundError(error, operation) {
  if (error instanceof WatchboundError && isWatchboundError(error)) return error;

  if (isWatchboundError(error)) {
    return new WatchboundError(errorMessage(error), {
      code: error.code,
      operation: error.operation,
      systemCause: normalizeSystemCause(error.systemCause),
      cause: error,
    });
  }

  return new WatchboundError(errorMessage(error), {
    code: WatchboundErrorCode.INTERNAL,
    operation,
    cause: error,
  });
}

export function invalidArgumentError(operation, message) {
  return new WatchboundError(message, {
    code: WatchboundErrorCode.INVALID_ARGUMENT,
    operation,
  });
}

export function invokeWatchbound(operation, invoke) {
  try {
    const result = invoke();
    if (!result || typeof result.then !== "function") return result;
    return Promise.resolve(result).catch((error) => {
      throw normalizeWatchboundError(error, operation);
    });
  } catch (error) {
    throw normalizeWatchboundError(error, operation);
  }
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeSystemCause(systemCause) {
  if (
    !systemCause ||
    typeof systemCause !== "object" ||
    !systemCauseDomains.has(systemCause.domain) ||
    typeof systemCause.message !== "string" ||
    (systemCause.code !== undefined &&
      typeof systemCause.code !== "string" &&
      typeof systemCause.code !== "number") ||
    (systemCause.kind !== undefined && typeof systemCause.kind !== "string")
  ) {
    return undefined;
  }
  return {
    domain: systemCause.domain,
    ...(systemCause.code === undefined
      ? {}
      : {
          code: typeof systemCause.code === "string"
            ? boundedString(systemCause.code, MAX_SYSTEM_DETAIL_LENGTH)
            : systemCause.code,
        }),
    ...(systemCause.kind === undefined
      ? {}
      : { kind: boundedString(systemCause.kind, MAX_SYSTEM_DETAIL_LENGTH) }),
    message: boundedString(systemCause.message, MAX_ERROR_MESSAGE_LENGTH),
  };
}

function retryAfterForCode(code) {
  const retryAfter = retryAfterByCode[code];
  return retryAfterValues.has(retryAfter) ? retryAfter : undefined;
}

function boundedString(value, maximumLength) {
  const string = String(value);
  if (Buffer.byteLength(string, "utf8") <= maximumLength) return string;

  let byteLength = 0;
  let end = 0;
  for (const character of string) {
    const characterByteLength = Buffer.byteLength(character, "utf8");
    if (byteLength + characterByteLength > maximumLength) break;
    byteLength += characterByteLength;
    end += character.length;
  }
  return string.slice(0, end);
}
