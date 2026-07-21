"use strict";

const fs = require("node:fs");
const path = require("node:path");

const packageVersion = require("./package.json").version;

const NATIVE_BASENAME = "watchbound.linux-x64-gnu.node";
const REQUIRED_NODE_API_VERSION = 6;
const REQUIRED_METADATA_SCHEMA_VERSION = 1;
const REQUIRED_BINDING_API_VERSION = 1;
const REQUIRED_TARGET_TRIPLE = "x86_64-unknown-linux-gnu";
const MAX_MESSAGE_BYTES = 1_024;
const MAX_CAUSE_MESSAGE_BYTES = 512;
const MAX_CAUSE_FIELD_BYTES = 128;

const WatchboundLoaderErrorCode = Object.freeze({
  UNSUPPORTED_PLATFORM: "WATCHBOUND_UNSUPPORTED_PLATFORM",
  UNSUPPORTED_LIBC: "WATCHBOUND_UNSUPPORTED_LIBC",
  UNSUPPORTED_NODE_API: "WATCHBOUND_UNSUPPORTED_NODE_API",
  NATIVE_NOT_BUILT: "WATCHBOUND_NATIVE_NOT_BUILT",
  NATIVE_LOAD_FAILED: "WATCHBOUND_NATIVE_LOAD_FAILED",
  NATIVE_VERSION_MISMATCH: "WATCHBOUND_NATIVE_VERSION_MISMATCH",
  NATIVE_API_MISMATCH: "WATCHBOUND_NATIVE_API_MISMATCH",
});

class WatchboundLoaderError extends Error {
  constructor(code, message, cause) {
    super(boundedUtf8(message, MAX_MESSAGE_BYTES));
    Object.defineProperties(this, {
      name: { value: "WatchboundLoaderError", enumerable: false },
      code: { value: code, enumerable: true },
      ...(cause === undefined
        ? {}
        : { cause: { value: cause, enumerable: false } }),
    });
  }
}

function loadNative(options = {}) {
  const platform = injected(options, "platform", process.platform);
  const arch = injected(options, "arch", process.arch);
  if (platform !== "linux" || arch !== "x64") {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.UNSUPPORTED_PLATFORM,
      "Watchbound supports only Linux x64",
    );
  }

  const report = injected(options, "report", process.report);
  if (detectLibc(report) !== "glibc") {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.UNSUPPORTED_LIBC,
      "Watchbound requires a detected glibc runtime",
    );
  }

  const napiVersion = injected(options, "napiVersion", process.versions?.napi);
  if (!supportsRequiredNodeApi(napiVersion)) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.UNSUPPORTED_NODE_API,
      `Watchbound requires process Node-API ${REQUIRED_NODE_API_VERSION} or newer`,
    );
  }

  const directory = injected(options, "directory", __dirname);
  const binaryPath = path.join(directory, NATIVE_BASENAME);
  const existsSync = injected(options, "existsSync", fs.existsSync);
  let exists;
  try {
    exists = existsSync(binaryPath);
  } catch (error) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_LOAD_FAILED,
      "Watchbound could not inspect its local native addon",
      safeCause(error, binaryPath),
    );
  }
  if (!exists) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_NOT_BUILT,
      `Watchbound native addon ${NATIVE_BASENAME} is not built`,
    );
  }

  const requireNative = injected(options, "requireNative", require);
  let binding;
  try {
    binding = requireNative(binaryPath);
  } catch (error) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_LOAD_FAILED,
      `Watchbound native addon ${NATIVE_BASENAME} could not be loaded`,
      safeCause(error, binaryPath),
    );
  }

  const expectedVersion = injected(options, "packageVersion", packageVersion);
  validateBinding(binding, expectedVersion, binaryPath);
  return binding;
}

function validateBinding(binding, expectedVersion, binaryPath) {
  if (binding === null || typeof binding !== "object" ||
      typeof binding.bindingMetadata !== "function") {
    throw apiMismatch("Watchbound native binding metadata is unavailable");
  }

  let metadata;
  try {
    metadata = binding.bindingMetadata();
  } catch (error) {
    throw apiMismatch(
      "Watchbound native binding metadata could not be read",
      safeCause(error, binaryPath),
    );
  }

  if (!validMetadataShape(metadata)) {
    throw apiMismatch("Watchbound native binding metadata is malformed");
  }
  if (metadata.schemaVersion !== REQUIRED_METADATA_SCHEMA_VERSION ||
      metadata.bindingApiVersion !== REQUIRED_BINDING_API_VERSION) {
    throw apiMismatch("Watchbound native binding API metadata does not match this loader");
  }
  if (metadata.nativeVersion !== expectedVersion ||
      metadata.engineVersion !== expectedVersion ||
      metadata.engineVersion !== metadata.nativeVersion) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_VERSION_MISMATCH,
      "Watchbound native, engine, and package versions do not match",
    );
  }
  if (metadata.nodeApiVersion !== REQUIRED_NODE_API_VERSION ||
      metadata.targetTriple !== REQUIRED_TARGET_TRIPLE ||
      metadata.buildProfile !== "release") {
    throw apiMismatch("Watchbound native build metadata does not match this loader");
  }
}

function validMetadataShape(metadata) {
  return metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    Number.isInteger(metadata.schemaVersion) &&
    Number.isInteger(metadata.bindingApiVersion) &&
    typeof metadata.nativeVersion === "string" &&
    typeof metadata.engineVersion === "string" &&
    Number.isInteger(metadata.nodeApiVersion) &&
    typeof metadata.targetTriple === "string" &&
    typeof metadata.buildProfile === "string";
}

function apiMismatch(message, cause) {
  return new WatchboundLoaderError(
    WatchboundLoaderErrorCode.NATIVE_API_MISMATCH,
    message,
    cause,
  );
}

function assertWrapperVersion(version) {
  if (typeof version !== "string" || version !== packageVersion) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_VERSION_MISMATCH,
      "Watchbound wrapper and native package versions do not match",
    );
  }
}

function detectLibc(report) {
  let value;
  try {
    if (!report || typeof report.getReport !== "function") return "unknown";
    value = report.getReport();
  } catch {
    return "unknown";
  }
  if (typeof value?.header?.glibcVersionRuntime === "string" &&
      value.header.glibcVersionRuntime.length > 0) {
    return "glibc";
  }
  if (Array.isArray(value?.sharedObjects) && value.sharedObjects.some((entry) =>
    typeof entry === "string" &&
    (entry.includes("libc.musl-") || entry.includes("ld-musl-")))) {
    return "musl";
  }
  return "unknown";
}

function supportsRequiredNodeApi(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[0-9]+$/.test(text)) return false;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= REQUIRED_NODE_API_VERSION;
}

function safeCause(error, binaryPath) {
  const name = sanitizedField(error?.name ?? "Error", binaryPath);
  const code = sanitizedField(error?.code ?? "UNKNOWN", binaryPath);
  const message = boundedUtf8(
    sanitizeBinaryPath(error?.message ?? "Native addon operation failed", binaryPath),
    MAX_CAUSE_MESSAGE_BYTES,
  );
  return Object.freeze({ name, code, message });
}

function sanitizedField(value, binaryPath) {
  return boundedUtf8(sanitizeBinaryPath(value, binaryPath), MAX_CAUSE_FIELD_BYTES);
}

function sanitizeBinaryPath(value, binaryPath) {
  const text = String(value);
  return binaryPath.length === 0
    ? text
    : text.split(binaryPath).join(NATIVE_BASENAME);
}

function boundedUtf8(value, maximumBytes) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maximumBytes) return text;
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function injected(options, key, fallback) {
  return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : fallback;
}

module.exports = {
  WatchboundLoaderError,
  WatchboundLoaderErrorCode,
  assertWrapperVersion,
  detectLibc,
  loadNative,
};
