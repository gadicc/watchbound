"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageManifest = require("./package.json");
const packageVersion = packageManifest.version;
const packageDelivery = packageManifest.watchbound?.delivery;

const REQUIRED_METADATA_SCHEMA_VERSION = 1;
const REQUIRED_BINDING_API_VERSION = 5;
const MAX_NATIVE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 1_024;
const MAX_CAUSE_MESSAGE_BYTES = 512;
const MAX_CAUSE_FIELD_BYTES = 128;

const WatchboundLoaderErrorCode = Object.freeze({
  UNSUPPORTED_PLATFORM: "WATCHBOUND_UNSUPPORTED_PLATFORM",
  UNSUPPORTED_LIBC: "WATCHBOUND_UNSUPPORTED_LIBC",
  UNSUPPORTED_NODE: "WATCHBOUND_UNSUPPORTED_NODE",
  UNSUPPORTED_NODE_API: "WATCHBOUND_UNSUPPORTED_NODE_API",
  TARGET_PACKAGE_MISSING: "WATCHBOUND_TARGET_PACKAGE_MISSING",
  TARGET_PACKAGE_INVALID: "WATCHBOUND_TARGET_PACKAGE_INVALID",
  NATIVE_NOT_BUILT: "WATCHBOUND_NATIVE_NOT_BUILT",
  NATIVE_LOAD_FAILED: "WATCHBOUND_NATIVE_LOAD_FAILED",
  NATIVE_INTEGRITY_MISMATCH: "WATCHBOUND_NATIVE_INTEGRITY_MISMATCH",
  NATIVE_ELF_MISMATCH: "WATCHBOUND_NATIVE_ELF_MISMATCH",
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
  const matrix = injected(options, "matrix", loadNativeMatrix());
  validateNativeMatrix(matrix);
  const platform = injected(options, "platform", process.platform);
  const arch = injected(options, "arch", process.arch);
  const platformTargets = matrix.targets.filter((candidate) =>
    candidate.platform === platform && candidate.architecture === arch);
  if (platformTargets.length !== 1) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.UNSUPPORTED_PLATFORM,
      `Watchbound has no native target for ${boundedUtf8(`${platform}/${arch}`, 128)}`,
    );
  }

  const report = injected(options, "report", process.report);
  const libc = detectLibc(report);
  const target = platformTargets[0];
  const runtimeArmAbi = assertRuntimeAbi(options, target);
  if (libc !== target.libc) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.UNSUPPORTED_LIBC,
      `Watchbound target ${target.id} requires detected ${target.libc}`,
    );
  }

  const nodeVersion = injected(options, "nodeVersion", process.versions?.node);
  if (!supportsNodeRange(nodeVersion, matrix.nodeMinimum)) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.UNSUPPORTED_NODE,
      `Watchbound requires Node ${matrix.nodeRange}`,
    );
  }

  const napiVersion = injected(options, "napiVersion", process.versions?.napi);
  if (!supportsRequiredNodeApi(napiVersion, matrix.nodeApiMinimum)) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.UNSUPPORTED_NODE_API,
      `Watchbound requires process Node-API ${matrix.nodeApiMinimum} or newer`,
    );
  }

  const expectedVersion = injected(options, "packageVersion", packageVersion);
  const delivery = injected(options, "packageDelivery", packageDelivery);
  const location = delivery === "controlled-source-build"
    ? sourceLocation(options, target)
    : packagedLocation(options, target, expectedVersion);
  inspectExactNative(options, location, target);

  const requireNative = injected(options, "requireNative", require);
  let binding;
  try {
    binding = requireNative(location.binaryPath);
  } catch (error) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_LOAD_FAILED,
      `Watchbound native addon ${target.binary} could not be loaded`,
      safeCause(error, location.binaryPath, target.binary),
    );
  }

  validateBinding(binding, expectedVersion, location.binaryPath, target);
  const deliveryMetadata = deepFreeze({
    schemaVersion: 1,
    delivery,
    loaderPackage: packageManifest.name,
    targetPackage: location.targetPackage,
    targetId: target.id,
    targetTriple: target.rustTarget,
    architecture: target.architecture,
    armAbi: target.armAbi ?? null,
    runtimeArmAbi,
    libc: target.libc,
    binary: target.binary,
    sha256: location.observedSha256,
    qualification: target.qualification,
    glibcMaximum: matrix.releaseBaseline.glibcMaximum,
    kernelMinimum: matrix.releaseBaseline.kernelMinimum,
  });
  Object.defineProperty(binding, "nativeDeliveryMetadata", {
    value: () => deliveryMetadata,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(binding, "nativeTargetMatrix", {
    value: () => deepFreeze(matrix),
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return binding;
}

function sourceLocation(options, target) {
  const directory = injected(options, "directory", __dirname);
  return {
    binaryPath: path.join(directory, target.binary),
    packageRoot: directory,
    targetPackage: null,
    expectedSha256: null,
    missingCode: WatchboundLoaderErrorCode.NATIVE_NOT_BUILT,
  };
}

function packagedLocation(options, target, expectedVersion) {
  if (injected(options, "packageDelivery", packageDelivery) !== "bundled-native-package") {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.TARGET_PACKAGE_INVALID,
      "Watchbound native loader delivery metadata is invalid",
    );
  }
  const resolvePackageJson = injected(
    options,
    "resolvePackageJson",
    (specifier) => require.resolve(specifier),
  );
  let manifestPath;
  try {
    manifestPath = resolvePackageJson(`${target.package}/package.json`);
  } catch (error) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.TARGET_PACKAGE_MISSING,
      `Watchbound target package ${target.package} is not installed`,
      safeCause(error, "", target.binary),
    );
  }
  const readFileSync = injected(options, "readFileSync", fs.readFileSync);
  let targetManifest;
  try {
    targetManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.TARGET_PACKAGE_INVALID,
      `Watchbound target package ${target.package} has invalid metadata`,
      safeCause(error, manifestPath, "package.json"),
    );
  }
  const metadata = targetManifest?.watchbound;
  if (
    targetManifest?.name !== target.package ||
    targetManifest?.version !== expectedVersion ||
    metadata?.delivery !== "target-native-package" ||
    metadata?.target !== target.id ||
    metadata?.targetTriple !== target.rustTarget ||
    metadata?.architecture !== target.architecture ||
    !sameArmAbi(metadata?.armAbi, target.armAbi) ||
    metadata?.libc !== target.libc ||
    metadata?.binary !== target.binary ||
    typeof metadata?.nativeSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(metadata.nativeSha256)
  ) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.TARGET_PACKAGE_INVALID,
      `Watchbound target package ${target.package} does not match this loader`,
    );
  }
  const packageRoot = path.dirname(manifestPath);
  return {
    binaryPath: path.join(packageRoot, target.binary),
    packageRoot,
    targetPackage: target.package,
    expectedSha256: metadata.nativeSha256,
    missingCode: WatchboundLoaderErrorCode.TARGET_PACKAGE_INVALID,
  };
}

function assertRuntimeAbi(options, target) {
  if (target.armAbi === undefined) return null;
  const processConfig = injected(options, "processConfig", process.config);
  const variables = processConfig?.variables;
  const version = numericArmVersion(variables?.arm_version);
  const floatAbi = variables?.arm_float_abi;
  const runtimeEndianness = injected(options, "endianness", os.endianness());
  const configReportsArmAbi = variables?.arm_version !== undefined ||
    variables?.arm_float_abi !== undefined;
  const configMatches = version === target.armAbi.version &&
    floatAbi === target.armAbi.floatAbi;
  const executableMatches = !configReportsArmAbi &&
    runtimeExecutableMatchesArmv7HardFloat(options);
  if (
    (!configMatches && !executableMatches) ||
    runtimeEndianness !== "LE" ||
    target.armAbi.endianness !== "little"
  ) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.UNSUPPORTED_PLATFORM,
      "Watchbound ARM support requires an ARMv7 hard-float little-endian runtime",
    );
  }
  return {
    version: target.armAbi.version,
    floatAbi: target.armAbi.floatAbi,
    endianness: target.armAbi.endianness,
  };
}

function runtimeExecutableMatchesArmv7HardFloat(options) {
  const machine = injected(options, "machine", os.machine());
  if (machine !== "aarch64" && !/^armv[78]l$/u.test(machine)) return false;
  const readRuntimeElfHeader = injected(
    options,
    "readRuntimeElfHeader",
    readCurrentExecutableElfHeader,
  );
  let contents;
  try {
    contents = readRuntimeElfHeader();
  } catch {
    return false;
  }
  if (
    !Buffer.isBuffer(contents) ||
    contents.length < 52 ||
    !contents.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    contents[4] !== 1 ||
    contents[5] !== 1 ||
    contents.readUInt16LE(18) !== 40
  ) {
    return false;
  }
  const flags = contents.readUInt32LE(36);
  const eabiVersion = flags & 0xff000000;
  const softFloat = flags & 0x00000200;
  const hardFloat = flags & 0x00000400;
  return eabiVersion === 0x05000000 && softFloat === 0 && hardFloat !== 0;
}

function readCurrentExecutableElfHeader() {
  const descriptor = fs.openSync("/proc/self/exe", "r");
  try {
    const contents = Buffer.alloc(52);
    const bytesRead = fs.readSync(descriptor, contents, 0, contents.length, 0);
    return contents.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function numericArmVersion(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) return Number(value);
  return null;
}

function sameArmAbi(metadata, expected) {
  if (expected === undefined) return metadata === undefined || metadata === null;
  return metadata !== null &&
    typeof metadata === "object" &&
    metadata.version === expected.version &&
    metadata.floatAbi === expected.floatAbi &&
    metadata.endianness === expected.endianness;
}

function inspectExactNative(options, location, target) {
  const existsSync = injected(options, "existsSync", fs.existsSync);
  let exists;
  try {
    exists = existsSync(location.binaryPath);
  } catch (error) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_LOAD_FAILED,
      "Watchbound could not inspect its exact native addon",
      safeCause(error, location.binaryPath, target.binary),
    );
  }
  if (!exists) {
    throw new WatchboundLoaderError(
      location.missingCode,
      `Watchbound native addon ${target.binary} is not available`,
    );
  }

  const readdirSync = injected(options, "readdirSync", fs.readdirSync);
  const lstatSync = injected(options, "lstatSync", fs.lstatSync);
  const readFileSync = injected(options, "readFileSync", fs.readFileSync);
  let nativeEntries;
  let stat;
  let contents;
  try {
    nativeEntries = readdirSync(location.packageRoot)
      .filter((entry) => typeof entry === "string" && entry.endsWith(".node"))
      .sort();
    stat = lstatSync(location.binaryPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size <= 0 ||
      stat.size > MAX_NATIVE_BYTES
    ) {
      throw new Error("native addon is not a bounded regular file");
    }
    contents = readFileSync(location.binaryPath);
  } catch (error) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_LOAD_FAILED,
      "Watchbound could not inspect its exact native addon",
      safeCause(error, location.binaryPath, target.binary),
    );
  }
  if (nativeEntries.length !== 1 || nativeEntries[0] !== target.binary) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.TARGET_PACKAGE_INVALID,
      `Watchbound target location must contain exactly ${target.binary}`,
    );
  }
  if (!Buffer.isBuffer(contents) || contents.length !== stat.size) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_LOAD_FAILED,
      "Watchbound native addon could not be read exactly",
    );
  }
  inspectElf(contents, target);
  location.observedSha256 = crypto
    .createHash("sha256")
    .update(contents)
    .digest("hex");
  if (
    location.expectedSha256 !== null &&
    location.observedSha256 !== location.expectedSha256
  ) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_INTEGRITY_MISMATCH,
      `Watchbound native addon ${target.binary} does not match its package digest`,
    );
  }
}

function inspectElf(contents, target) {
  if (
    contents.length < 20 ||
    !contents.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    contents[4] !== target.elf.class ||
    contents[5] !== target.elf.endianness ||
    contents.readUInt16LE(18) !== target.elf.machine ||
    elfFlags(contents, target.elf.class) !== target.elf.flags
  ) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_ELF_MISMATCH,
      `Watchbound native addon ${target.binary} has the wrong ELF identity`,
    );
  }
}

function elfFlags(contents, elfClass) {
  const offset = elfClass === 1 ? 36 : 48;
  if (contents.length < offset + 4) return null;
  return contents.readUInt32LE(offset);
}

function validateBinding(binding, expectedVersion, binaryPath, target) {
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
      safeCause(error, binaryPath, target.binary),
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
  if (metadata.nodeApiVersion !== 6 ||
      metadata.targetTriple !== target.rustTarget ||
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

function assertWrapperVersion(version, delivery) {
  if (
    typeof version !== "string" ||
    version !== packageVersion ||
    delivery !== packageDelivery ||
    (
      delivery !== "controlled-source-build" &&
      delivery !== "bundled-native-package"
    )
  ) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_VERSION_MISMATCH,
      "Watchbound wrapper and native package versions or delivery modes do not match",
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

function supportsNodeRange(value, minimum) {
  const parsed = parseVersion(value);
  const floor = parseVersion(minimum);
  if (parsed === null || floor === null || parsed[0] !== 24) return false;
  return compareVersions(parsed, floor) >= 0;
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  if (match === null) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function supportsRequiredNodeApi(value, minimum) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[0-9]+$/u.test(text)) return false;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= minimum;
}

function loadNativeMatrix() {
  const packagedPath = path.join(__dirname, "native-matrix.json");
  const sourcePath = path.join(__dirname, "..", "config", "native-matrix.json");
  const selected = fs.existsSync(packagedPath) ? packagedPath : sourcePath;
  return JSON.parse(fs.readFileSync(selected, "utf8"));
}

function validateNativeMatrix(matrix) {
  if (
    matrix?.schemaVersion !== 1 ||
    typeof matrix.nodeRange !== "string" ||
    typeof matrix.nodeMinimum !== "string" ||
    !Number.isInteger(matrix.nodeApiMinimum) ||
    !Array.isArray(matrix.targets) ||
    matrix.targets.length === 0 ||
    new Set(matrix.targets.map((target) => target.id)).size !== matrix.targets.length
  ) {
    throw new WatchboundLoaderError(
      WatchboundLoaderErrorCode.NATIVE_API_MISMATCH,
      "Watchbound native target matrix is invalid",
    );
  }
  for (const target of matrix.targets) {
    if (
      typeof target.id !== "string" ||
      typeof target.platform !== "string" ||
      typeof target.architecture !== "string" ||
      typeof target.rustTarget !== "string" ||
      typeof target.libc !== "string" ||
      (
        target.architecture === "arm" &&
        (
          target.armAbi?.version !== 7 ||
          target.armAbi?.floatAbi !== "hard" ||
          target.armAbi?.endianness !== "little"
        )
      ) ||
      typeof target.binary !== "string" ||
      !/^watchbound\.[a-z0-9-]+\.node$/u.test(target.binary) ||
      typeof target.package !== "string" ||
      !Number.isInteger(target.elf?.class) ||
      !Number.isInteger(target.elf?.endianness) ||
      !Number.isInteger(target.elf?.machine)
      || !Number.isInteger(target.elf?.flags)
    ) {
      throw new WatchboundLoaderError(
        WatchboundLoaderErrorCode.NATIVE_API_MISMATCH,
        "Watchbound native target matrix entry is invalid",
      );
    }
  }
}

function safeCause(error, binaryPath, replacementBasename) {
  const name = sanitizedField(error?.name ?? "Error", binaryPath, replacementBasename);
  const code = sanitizedField(error?.code ?? "UNKNOWN", binaryPath, replacementBasename);
  const message = boundedUtf8(
    sanitizeBinaryPath(
      error?.message ?? "Native addon operation failed",
      binaryPath,
      replacementBasename,
    ),
    MAX_CAUSE_MESSAGE_BYTES,
  );
  return Object.freeze({ name, code, message });
}

function sanitizedField(value, binaryPath, replacementBasename) {
  return boundedUtf8(
    sanitizeBinaryPath(value, binaryPath, replacementBasename),
    MAX_CAUSE_FIELD_BYTES,
  );
}

function sanitizeBinaryPath(value, binaryPath, replacementBasename) {
  const text = String(value);
  return binaryPath.length === 0
    ? text
    : text.split(binaryPath).join(replacementBasename);
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

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
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
