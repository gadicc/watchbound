import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

export const SANITIZER_VERSION = "1.0.0";
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 250_000;
const MAX_ARRAY_LENGTH = 100_000;
const MAX_OBJECT_KEYS = 2_048;
const MAX_STRING_BYTES = 64 * 1024;
const PUBLIC_SCHEMA = "urn:watchbound:schema:public-conformance-evidence:1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

const REPORT_FIELDS = new Set([
  "schemaVersion",
  "suite",
  "startedAt",
  "finishedAt",
  "durationMs",
  "system",
  "methodology",
  "config",
  "sourceIdentity",
  "adapterProbes",
  "excludedRuns",
  "results",
  "aggregates",
  "summary",
]);

const REQUIRED_REPORT_FIELDS = [
  "schemaVersion",
  "suite",
  "system",
  "methodology",
  "config",
  "sourceIdentity",
  "adapterProbes",
  "excludedRuns",
  "results",
  "aggregates",
  "summary",
];

const SYSTEM_FIELDS = new Set([
  "platform",
  "architecture",
  "node",
  "kernel",
  "cpuModel",
  "logicalCpuCount",
  "totalMemoryBytes",
  "loadAverageAtStart",
  "loadAverageAtFinish",
  "cpuGovernor",
  "tempFilesystem",
  "inotifyLimits",
]);

const PUBLIC_SYSTEM_FIELDS = new Set([
  "platform",
  "architecture",
  "node",
  "kernelMajorMinor",
  "cpuGovernor",
  "tempFilesystem",
  "inotifyLimits",
]);

const TEMP_FILESYSTEM_FIELDS = new Set([
  "path",
  "device",
  "filesystemType",
  "blockSize",
  "blocks",
  "blocksAvailable",
  "error",
]);

const CONFIG_FIELDS = new Set([
  "adapters",
  "scenarios",
  "runs",
  "directoryCounts",
  "burstCount",
  "maxWatches",
  "timeoutMs",
  "childTimeoutMs",
  "settleMs",
  "topologyDelayMs",
  "exclusionObservationMs",
  "disposalObservationMs",
  "tempDir",
  "trialOrder",
  "quick",
  "allowForcedOverflow",
  "codexWatcherPath",
  "parcelWatcherPath",
]);

const SOURCE_IDENTITY_FIELDS = new Set([
  "workspaceRoot",
  "gitHead",
  "gitHeadError",
  "gitDirty",
  "gitStatusEntryCount",
  "sourceSha256",
  "sourceFileCount",
  "expectedBuildProfile",
  "expectedBuildCommand",
]);

const KNOWN_PATH_FIELDS = new Set([
  "codexWatcherPath",
  "cwd",
  "directory",
  "dirtyPaths",
  "filename",
  "missedPaths",
  "nativeLibraryOverride",
  "parcelWatcherPath",
  "path",
  "paths",
  "root",
  "runDirectory",
  "stack",
  "tempDir",
  "workspaceRoot",
]);

const OMITTED_FINGERPRINT_FIELDS = new Set([
  "cpuModel",
  "device",
  "fd",
  "fds",
  "gitStatus",
  "gitStatusEntries",
  "dirtyPaths",
  "loadAverageAtFinish",
  "loadAverageAtStart",
  "logicalCpuCount",
  "modifiedAt",
  "pid",
  "processId",
  "threadId",
  "totalMemoryBytes",
]);

const FORBIDDEN_HOST_IDENTITY_FIELDS = new Set([
  "argv",
  "bootId",
  "containerId",
  "env",
  "environment",
  "environmentVariables",
  "hostName",
  "hostname",
  "machineId",
  "userName",
  "username",
]);

const OMITTED_HOST_FIELDS = Object.freeze([
  "system.cpuModel",
  "system.logicalCpuCount",
  "system.totalMemoryBytes",
  "system.loadAverageAtStart",
  "system.loadAverageAtFinish",
  "system.tempFilesystem.device",
  "system.tempFilesystem.blockSize",
  "system.tempFilesystem.blocks",
  "system.tempFilesystem.blocksAvailable",
  "*.pid",
  "*.threadId",
  "*.fd",
  "*.fds",
  "*.modifiedAt",
  "sourceIdentity.gitStatus",
  "sourceIdentity.gitStatusEntries",
  "sourceIdentity.dirtyPaths",
]);

const PLACEHOLDER_DESCRIPTIONS = Object.freeze({
  "$HOME": "home directory containing the source workspace",
  "$TEMP_ROOT": "configured temporary-filesystem root",
  "$TRIAL_ROOT": "per-trial watchbound-bench-* directory",
  "$WORKSPACE": "source workspace root",
});

const ALLOWED_PUBLIC_ABSOLUTE_PATHS = [
  /^\/proc\/self\/(?:fd|fdinfo|task)(?:\/[^\s]*)?$/u,
  /^\/proc\/sys\/fs\/inotify(?:\/[^\s]*)?$/u,
  /^\/sys\/devices\/system\/cpu(?:\/[^\s]*)?$/u,
];

const ABSOLUTE_PATH_TOKEN = /(?:^|[\s"'`([{=:])\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*/gu;
const WINDOWS_PATH = /(?:^|[\s"'`([{=:])[A-Za-z]:\\[^\s"'`\])}]+/gu;
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;
const TRIAL_ROOT_PATTERN = /\/(?:[^/\s"'`\\]+\/)*watchbound-bench-[^/\s"'`\\:]+/gu;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const IPV4_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b/u;
const MAC_ADDRESS = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/iu;

export function createSanitizedDerivative({
  inputBytes,
  manifest,
  logicalFilename,
  publicLogicalPath = null,
}) {
  const sourceBytes = checkedBytes(inputBytes, "input");
  const sourceSha256 = sha256Hex(sourceBytes);
  const sourceReport = parseJson(sourceBytes, "input");
  assertBoundedJson(sourceReport, "input");
  validateSourceReport(sourceReport);
  const { collection, entry } = verifiedManifestEntry({
    manifest,
    logicalFilename,
    sourceBytes,
    sourceSha256,
    sourceReport,
  });
  const context = createRedactionContext(sourceReport);
  const report = sanitizeSourceReport(sourceReport, context);
  const performanceSamplePolicies = [
    ...new Set(
      report.aggregates
        .map((aggregate) => aggregate?.performanceSamplePolicy)
        .filter((value) => typeof value === "string"),
    ),
  ].sort();

  const document = {
    schema: PUBLIC_SCHEMA,
    schemaVersion: 1,
    kind: "watchbound-public-conformance-evidence",
    sanitizer: {
      name: "watchbound-conformance-report-sanitizer",
      version: SANITIZER_VERSION,
      sourceReportSchemaVersion: 2,
      bounds: {
        maxInputBytes: MAX_INPUT_BYTES,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        maxDepth: MAX_DEPTH,
        maxNodes: MAX_NODES,
        maxArrayLength: MAX_ARRAY_LENGTH,
        maxObjectKeys: MAX_OBJECT_KEYS,
        maxStringBytes: MAX_STRING_BYTES,
      },
    },
    resultClassification: {
      evidence: entry.classification,
      reportStatus: entry.reportStatus,
      outcome: entry.outcome,
      performanceSamplePolicies,
    },
    privateOriginal: {
      manifestCollection: collection,
      logicalFilename: entry.logicalFilename,
      sha256: entry.sha256,
      byteSize: entry.byteSize,
    },
    provenance: {
      source: {
        commit: entry.sourceCommit,
        dirty: entry.sourceDirty,
        statusEntryCount: entry.sourceStatusEntryCount ?? null,
        sha256: entry.sourceDigest,
      },
      nativeArtifact: {
        sha256: entry.nativeArtifactSha256,
      },
    },
    disclosure: {
      pathPlaceholders: PLACEHOLDER_DESCRIPTIONS,
      exactTimestamps: "replaced with $TIMESTAMP",
      kernelVersion: "major.minor only",
      omittedHostFields: OMITTED_HOST_FIELDS,
    },
    report,
  };
  validatePublicDocument(document);
  assertNoPrivateMaterial(document, context);
  const bytes = canonicalJsonBytes(document);
  if (bytes.length > MAX_OUTPUT_BYTES) {
    throw new Error("Sanitized output exceeds the configured byte bound");
  }
  const publicSha256 = sha256Hex(bytes);

  return {
    document,
    bytes,
    publicSha256,
    manifestLinkage: {
      privateOriginalSha256: entry.sha256,
      sanitizerVersion: SANITIZER_VERSION,
      publicSchemaVersion: 1,
      publicLogicalPath,
      publicSha256,
    },
  };
}

export function reviewSanitizedDerivative({
  inputBytes,
  manifest,
  logicalFilename,
  document,
  bytes,
  publicSha256,
}) {
  const checks = [];
  let expected;
  let sourceReport;
  let context;

  try {
    const sourceBytes = checkedBytes(inputBytes, "input");
    sourceReport = parseJson(sourceBytes, "input");
    context = createRedactionContext(sourceReport);
    expected = createSanitizedDerivative({
      inputBytes: sourceBytes,
      manifest,
      logicalFilename,
    });
    checks.push(check("input-and-manifest-linkage", true));
  } catch {
    checks.push(check("input-and-manifest-linkage", false));
    return { approved: false, checks };
  }

  const derivativeBytes = checkedBytes(bytes, "derivative");
  checks.push(check("derivative-sha256", sha256Hex(derivativeBytes) === publicSha256));
  checks.push(
    check(
      "canonical-derivative-bytes",
      derivativeBytes.equals(canonicalJsonBytes(document)),
    ),
  );
  checks.push(
    check(
      "retained-report-byte-equivalence",
      equalCanonical(document?.report, expected.document.report),
    ),
  );
  checks.push(
    check(
      "private-original-linkage",
      equalCanonical(document?.privateOriginal, expected.document.privateOriginal),
    ),
  );
  checks.push(
    check(
      "source-and-native-identity",
      equalCanonical(document?.provenance, expected.document.provenance),
    ),
  );
  checks.push(
    check(
      "outcome-and-classification-visible",
      equalCanonical(
        document?.resultClassification,
        expected.document.resultClassification,
      ) && reportContainsOutcome(document?.report, expected.document.resultClassification.outcome),
    ),
  );
  checks.push(
    check(
      "all-check-results-preserved",
      equalCanonical(
        collectCheckResults(document?.report),
        collectCheckResults(expected.document.report),
      ),
    ),
  );

  for (const [name, matcher] of [
    ["counters-preserved", /count|runs|passed|failed|errors|skips|executed|planned/iu],
    ["ordering-preserved", /sequence|ordering|monotonic/iu],
    ["coverage-transitions-preserved", /coverage|uncertain/iu],
    ["generation-evidence-preserved", /generation/iu],
    ["resource-restoration-preserved", /inotify|watches|instances|cleanup|disposal|restor/iu],
  ]) {
    checks.push(
      check(
        name,
        equalCanonical(
          collectNamedEvidence(document?.report, matcher),
          collectNamedEvidence(expected.document.report, matcher),
        ),
      ),
    );
  }

  checks.push(
    check(
      "failed-trials-excluded-from-performance",
      passOnlyAggregatesAreTruthful(document?.report),
    ),
  );
  let publicShapeValid = true;
  try {
    validatePublicDocument(document);
  } catch {
    publicShapeValid = false;
  }
  checks.push(check("public-schema-shape", publicShapeValid));
  let leakFree = true;
  try {
    assertNoPrivateMaterial(document, context);
  } catch {
    leakFree = false;
  }
  checks.push(check("no-private-or-unapproved-path-material", leakFree));

  return {
    approved: checks.every(({ passed }) => passed),
    checks,
  };
}

function validateSourceReport(report) {
  assertPlainObject(report, "Report must be a JSON object");
  if (report.schemaVersion !== 2) {
    throw new Error("Unsupported report schema; only schemaVersion 2 is accepted");
  }
  for (const field of REQUIRED_REPORT_FIELDS) {
    if (!Object.hasOwn(report, field)) {
      throw new Error(`Report schema 2 is missing required field ${field}`);
    }
  }
  rejectUnknownFields(report, REPORT_FIELDS, "report");
  assertPlainObject(report.system, "Report system must be an object");
  assertPlainObject(report.methodology, "Report methodology must be an object");
  assertPlainObject(report.config, "Report config must be an object");
  assertPlainObject(report.sourceIdentity, "Report sourceIdentity must be an object");
  if (!Array.isArray(report.excludedRuns) || !Array.isArray(report.results)) {
    throw new Error("Report excludedRuns and results must be arrays");
  }
  if (!Array.isArray(report.aggregates)) {
    throw new Error("Report aggregates must be an array");
  }
  assertPlainObject(report.summary, "Report summary must be an object");
  rejectUnknownFields(report.system, SYSTEM_FIELDS, "system");
  rejectUnknownFields(report.config, CONFIG_FIELDS, "config");
  rejectUnknownFields(report.sourceIdentity, SOURCE_IDENTITY_FIELDS, "sourceIdentity");
  if (report.system.tempFilesystem != null) {
    assertPlainObject(report.system.tempFilesystem, "system.tempFilesystem must be an object");
    rejectUnknownFields(
      report.system.tempFilesystem,
      TEMP_FILESYSTEM_FIELDS,
      "system.tempFilesystem",
    );
  }
  if (typeof report.sourceIdentity.workspaceRoot !== "string") {
    throw new Error("Report sourceIdentity.workspaceRoot must be a string");
  }
  if (typeof report.config.tempDir !== "string") {
    throw new Error("Report config.tempDir must be a string");
  }
}

function verifiedManifestEntry({
  manifest,
  logicalFilename,
  sourceBytes,
  sourceSha256,
  sourceReport,
}) {
  assertBoundedJson(manifest, "manifest");
  assertPlainObject(manifest, "Manifest must be a JSON object");
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) {
    throw new Error("Unsupported private-artifact manifest schema");
  }
  if (
    typeof logicalFilename !== "string" ||
    !SAFE_IDENTIFIER_PATTERN.test(logicalFilename) ||
    path.basename(logicalFilename) !== logicalFilename
  ) {
    throw new Error("Logical filename must be a safe basename");
  }
  if (
    typeof manifest.collection !== "string" ||
    !SAFE_IDENTIFIER_PATTERN.test(manifest.collection)
  ) {
    throw new Error("Manifest collection must be a safe identifier");
  }
  const matches = manifest.artifacts.filter(
    (candidate) => candidate?.logicalFilename === logicalFilename,
  );
  if (matches.length !== 1) {
    throw new Error("Manifest must contain exactly one matching private artifact");
  }
  const [entry] = matches;
  assertPlainObject(entry, "Manifest artifact entry must be an object");
  if (!SHA256_PATTERN.test(entry.sha256 ?? "") || entry.sha256 !== sourceSha256) {
    throw new Error("Input SHA-256 does not match the private-artifact manifest");
  }
  if (entry.byteSize !== sourceBytes.length) {
    throw new Error("Input byte size does not match the private-artifact manifest");
  }
  if (entry.reportSchemaVersion !== sourceReport.schemaVersion) {
    throw new Error("Input report schema does not match the private-artifact manifest");
  }
  const identity = sourceReport.sourceIdentity;
  if (
    !COMMIT_PATTERN.test(entry.sourceCommit ?? "") ||
    entry.sourceCommit !== identity.gitHead ||
    entry.sourceDirty !== identity.gitDirty ||
    entry.sourceDigest !== identity.sourceSha256 ||
    (entry.sourceStatusEntryCount != null &&
      entry.sourceStatusEntryCount !== identity.gitStatusEntryCount)
  ) {
    throw new Error("Source identity does not match the private-artifact manifest");
  }
  if (!SHA256_PATTERN.test(entry.sourceDigest ?? "")) {
    throw new Error("Manifest source digest is not a SHA-256 value");
  }
  if (!SHA256_PATTERN.test(entry.nativeArtifactSha256 ?? "")) {
    throw new Error("Manifest native artifact identity is not a SHA-256 value");
  }
  const nativeHashes = collectNativeArtifactHashes(sourceReport);
  if (
    nativeHashes.length === 0 ||
    nativeHashes.some((hash) => hash !== entry.nativeArtifactSha256)
  ) {
    throw new Error("Native artifact identity does not match the private-artifact manifest");
  }
  if (!reportContainsOutcome(sourceReport, entry.outcome)) {
    throw new Error("Report outcome does not match the private-artifact manifest");
  }
  if (
    typeof entry.reportStatus !== "string" ||
    typeof entry.outcome !== "string" ||
    typeof entry.classification !== "string"
  ) {
    throw new Error("Manifest classification fields must be strings");
  }
  return { collection: manifest.collection, entry };
}

function createRedactionContext(report) {
  const workspaceRoot = checkedAbsolutePath(
    report.sourceIdentity.workspaceRoot,
    "source workspace root",
  );
  const tempRoot = checkedAbsolutePath(report.config.tempDir, "temporary root");
  const trialRoots = discoverTrialRoots(report);
  const homeRoot = homeRootFor(workspaceRoot);
  const roots = [
    ...trialRoots.map((value) => ({ value, token: "$TRIAL_ROOT" })),
    { value: workspaceRoot, token: "$WORKSPACE" },
    ...(homeRoot == null ? [] : [{ value: homeRoot, token: "$HOME" }]),
    { value: tempRoot, token: "$TEMP_ROOT" },
  ]
    .filter(({ value }, index, values) =>
      values.findIndex((candidate) => candidate.value === value) === index
    )
    .sort((left, right) => right.value.length - left.value.length);
  const forbiddenLiterals = new Set([workspaceRoot]);
  if (homeRoot != null) {
    forbiddenLiterals.add(homeRoot);
    forbiddenLiterals.add(path.basename(homeRoot));
  }
  for (const trialRoot of trialRoots) {
    forbiddenLiterals.add(trialRoot);
    forbiddenLiterals.add(path.basename(trialRoot));
  }
  return { roots, forbiddenLiterals };
}

function sanitizeSourceReport(report, context) {
  const sanitized = {
    schemaVersion: report.schemaVersion,
    suite: sanitizeValue(report.suite, context, ["suite"]),
  };
  if (Object.hasOwn(report, "startedAt")) sanitized.startedAt = "$TIMESTAMP";
  if (Object.hasOwn(report, "finishedAt")) sanitized.finishedAt = "$TIMESTAMP";
  if (Object.hasOwn(report, "durationMs")) sanitized.durationMs = report.durationMs;
  sanitized.system = sanitizeSystem(report.system, context);
  sanitized.methodology = sanitizeValue(report.methodology, context, ["methodology"]);
  sanitized.config = sanitizeValue(report.config, context, ["config"]);
  sanitized.sourceIdentity = sanitizeValue(
    report.sourceIdentity,
    context,
    ["sourceIdentity"],
  );
  sanitized.adapterProbes = sanitizeValue(
    report.adapterProbes,
    context,
    ["adapterProbes"],
  );
  sanitized.excludedRuns = sanitizeValue(
    report.excludedRuns,
    context,
    ["excludedRuns"],
  );
  sanitized.results = sanitizeValue(report.results, context, ["results"]);
  sanitized.aggregates = sanitizeValue(report.aggregates, context, ["aggregates"]);
  sanitized.summary = sanitizeValue(report.summary, context, ["summary"]);
  return sanitized;
}

function sanitizeSystem(system, context) {
  const kernelMatch = /^(\d+)\.(\d+)/u.exec(system.kernel ?? "");
  if (kernelMatch == null) {
    throw new Error("System kernel must begin with a major.minor version");
  }
  const sanitized = {
    platform: sanitizeValue(system.platform, context, ["system", "platform"]),
    architecture: sanitizeValue(
      system.architecture,
      context,
      ["system", "architecture"],
    ),
    node: sanitizeValue(system.node, context, ["system", "node"]),
    kernelMajorMinor: `${kernelMatch[1]}.${kernelMatch[2]}`,
  };
  if (system.cpuGovernor != null) {
    sanitized.cpuGovernor = sanitizeValue(
      system.cpuGovernor,
      context,
      ["system", "cpuGovernor"],
    );
  }
  if (system.tempFilesystem != null) {
    const filesystem = system.tempFilesystem;
    sanitized.tempFilesystem = {
      path: sanitizeString(filesystem.path, context),
    };
    if (filesystem.filesystemType != null) {
      sanitized.tempFilesystem.filesystemType = filesystem.filesystemType;
    }
    if (filesystem.error != null) {
      sanitized.tempFilesystem.error = sanitizeValue(
        filesystem.error,
        context,
        ["system", "tempFilesystem", "error"],
      );
    }
  }
  if (system.inotifyLimits != null) {
    sanitized.inotifyLimits = sanitizeValue(
      system.inotifyLimits,
      context,
      ["system", "inotifyLimits"],
    );
  }
  return sanitized;
}

function sanitizeValue(value, context, location) {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return sanitizeString(value, context);
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, context, [...location, index]));
  }
  assertPlainObject(value, "Sanitizer only accepts plain JSON objects");
  const entries = [];
  const seenKeys = new Set();
  for (const [key, child] of Object.entries(value)) {
    if (OMITTED_FINGERPRINT_FIELDS.has(key)) continue;
    if (FORBIDDEN_HOST_IDENTITY_FIELDS.has(key)) {
      throw new Error(`Host-identifying field is not public at ${publicLocation(location)}`);
    }
    if (looksPathBearingField(key) && !KNOWN_PATH_FIELDS.has(key)) {
      throw new Error(`Unknown path-bearing field at ${publicLocation(location)}`);
    }
    const sanitizedKey = sanitizeString(key, context);
    if (seenKeys.has(sanitizedKey)) {
      throw new Error(`Redaction creates an object-key collision at ${publicLocation(location)}`);
    }
    seenKeys.add(sanitizedKey);
    entries.push([
      sanitizedKey,
      sanitizeValue(child, context, [...location, sanitizedKey]),
    ]);
  }
  return Object.fromEntries(entries);
}

function sanitizeString(value, context) {
  if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
    throw new Error("String exceeds the configured sanitizer bound");
  }
  let sanitized = value.replace(ISO_TIMESTAMP, "$TIMESTAMP");
  for (const { value: root, token } of context.roots) {
    sanitized = replacePathRoot(sanitized, root, token);
  }
  assertSafeString(sanitized, context);
  return sanitized;
}

function replacePathRoot(value, root, token) {
  let cursor = 0;
  let output = "";
  while (cursor < value.length) {
    const index = value.indexOf(root, cursor);
    if (index < 0) return output + value.slice(cursor);
    const after = value[index + root.length];
    if (after != null && after !== "/" && !/[\s"'`\])},:]/u.test(after)) {
      output += value.slice(cursor, index + root.length);
      cursor = index + root.length;
      continue;
    }
    output += value.slice(cursor, index) + token;
    cursor = index + root.length;
  }
  return output;
}

function assertSafeString(value, context) {
  for (const literal of context.forbiddenLiterals) {
    if (literal.length > 0 && value.includes(literal)) {
      throw new Error("Sanitized value retains a private source literal");
    }
  }
  const masked = maskApprovedPaths(value);
  if (EMAIL_ADDRESS.test(masked) || IPV4_ADDRESS.test(masked) || MAC_ADDRESS.test(masked)) {
    throw new Error("Sanitized value retains a host-identifying address");
  }
  if (WINDOWS_PATH.test(masked)) {
    WINDOWS_PATH.lastIndex = 0;
    throw new Error("Sanitized value retains an unapproved Windows absolute path");
  }
  WINDOWS_PATH.lastIndex = 0;
  for (const match of masked.matchAll(ABSOLUTE_PATH_TOKEN)) {
    const token = match[0].trim().replace(/^["'`([{=:]+/u, "");
    if (!ALLOWED_PUBLIC_ABSOLUTE_PATHS.some((pattern) => pattern.test(token))) {
      throw new Error("Sanitized value retains an unapproved absolute path");
    }
  }
}

function maskApprovedPaths(value) {
  return value
    .replace(
      /\$(?:HOME|TEMP_ROOT|TRIAL_ROOT|WORKSPACE)(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*/gu,
      "<PATH_TOKEN>",
    )
    .replace(/(?:https?|file):\/\/[^\s"'`\])}]+/gu, "<URL>")
    .replace(/\/proc\/self\/(?:fd|fdinfo|task)(?:\/[^\s]*)?/gu, "<PROC_PATH>")
    .replace(/\/proc\/sys\/fs\/inotify(?:\/[^\s]*)?/gu, "<PROC_PATH>")
    .replace(/\/sys\/devices\/system\/cpu(?:\/[^\s]*)?/gu, "<SYS_PATH>");
}

function assertNoPrivateMaterial(document, context) {
  const text = canonicalJsonBytes(document).toString("utf8");
  assertSafeString(text, context);
}

function discoverTrialRoots(value) {
  const roots = new Set();
  walkJson(value, ({ key, value: string }) => {
    for (const candidate of [key, string]) {
      if (typeof candidate !== "string") continue;
      for (const match of candidate.matchAll(TRIAL_ROOT_PATTERN)) roots.add(match[0]);
    }
  });
  return [...roots].sort();
}

function homeRootFor(workspaceRoot) {
  const match = /^(\/(?:home|Users)\/[^/]+)(?:\/|$)/u.exec(workspaceRoot);
  return match?.[1] ?? null;
}

function checkedAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.posix.isAbsolute(value)) {
    throw new Error(`Report ${label} must be an absolute POSIX path`);
  }
  return path.posix.normalize(value);
}

function collectNativeArtifactHashes(report) {
  const hashes = [];
  walkJson(report, ({ key, value }) => {
    if (key === "nativeArtifact" && isPlainObject(value)) {
      if (typeof value.sha256 === "string") hashes.push(value.sha256);
    }
  });
  return hashes;
}

function reportContainsOutcome(report, outcome) {
  return (
    typeof outcome === "string" &&
    Array.isArray(report?.results) &&
    report.results.some((result) => result?.outcome === outcome)
  );
}

function passOnlyAggregatesAreTruthful(report) {
  if (!Array.isArray(report?.aggregates) || !Array.isArray(report?.results)) return false;
  if (report.aggregates.length === 0) return true;
  return report.aggregates.every((aggregate) => {
    if (aggregate?.performanceSamplePolicy !== "pass-only") return false;
    if (
      !Number.isSafeInteger(aggregate.performanceRuns) ||
      !Number.isSafeInteger(aggregate.passed) ||
      !Number.isSafeInteger(aggregate.failed)
    ) {
      return false;
    }
    return aggregate.performanceRuns === aggregate.passed;
  });
}

function collectCheckResults(value) {
  const results = [];
  walkJson(value, ({ value: candidate }) => {
    if (
      isPlainObject(candidate) &&
      typeof candidate.name === "string" &&
      typeof candidate.passed === "boolean"
    ) {
      results.push({ name: candidate.name, passed: candidate.passed });
    }
  });
  return results;
}

function collectNamedEvidence(value, matcher) {
  const evidence = [];
  walkJson(value, ({ key, value: candidate, location }) => {
    if (key != null && matcher.test(key)) {
      matcher.lastIndex = 0;
      evidence.push({ location, key, value: candidate });
    }
    matcher.lastIndex = 0;
  });
  return evidence;
}

function validatePublicDocument(document) {
  assertPlainObject(document, "Public derivative must be an object");
  const expectedKeys = [
    "schema",
    "schemaVersion",
    "kind",
    "sanitizer",
    "resultClassification",
    "privateOriginal",
    "provenance",
    "disclosure",
    "report",
  ];
  if (
    document.schema !== PUBLIC_SCHEMA ||
    document.schemaVersion !== 1 ||
    document.kind !== "watchbound-public-conformance-evidence"
  ) {
    throw new Error("Public derivative schema identity is invalid");
  }
  rejectUnknownFields(document, new Set(expectedKeys), "public derivative");
  for (const key of expectedKeys) {
    if (!Object.hasOwn(document, key)) {
      throw new Error(`Public derivative is missing ${key}`);
    }
  }
  if (
    document.sanitizer?.version !== SANITIZER_VERSION ||
    document.sanitizer?.sourceReportSchemaVersion !== 2
  ) {
    throw new Error("Public derivative sanitizer identity is invalid");
  }
  if (!SHA256_PATTERN.test(document.privateOriginal?.sha256 ?? "")) {
    throw new Error("Public derivative private linkage is invalid");
  }
  if (
    !COMMIT_PATTERN.test(document.provenance?.source?.commit ?? "") ||
    !SHA256_PATTERN.test(document.provenance?.source?.sha256 ?? "") ||
    !SHA256_PATTERN.test(document.provenance?.nativeArtifact?.sha256 ?? "")
  ) {
    throw new Error("Public derivative provenance is invalid");
  }
  validateSanitizedReport(document.report);
  assertBoundedJson(document, "public derivative");
}

function validateSanitizedReport(report) {
  assertPlainObject(report, "Sanitized report must be a JSON object");
  if (report.schemaVersion !== 2) {
    throw new Error("Sanitized report must retain source schemaVersion 2");
  }
  for (const field of REQUIRED_REPORT_FIELDS) {
    if (!Object.hasOwn(report, field)) {
      throw new Error(`Sanitized report is missing required field ${field}`);
    }
  }
  rejectUnknownFields(report, REPORT_FIELDS, "sanitized report");
  assertPlainObject(report.system, "Sanitized report system must be an object");
  rejectUnknownFields(report.system, PUBLIC_SYSTEM_FIELDS, "sanitized system");
  if (!/^\d+\.\d+$/u.test(report.system.kernelMajorMinor ?? "")) {
    throw new Error("Sanitized kernel identity must contain major.minor only");
  }
  if (report.system.tempFilesystem != null) {
    assertPlainObject(
      report.system.tempFilesystem,
      "Sanitized temp filesystem must be an object",
    );
    rejectUnknownFields(
      report.system.tempFilesystem,
      new Set(["path", "filesystemType", "error"]),
      "sanitized temp filesystem",
    );
  }
  assertPlainObject(report.methodology, "Sanitized methodology must be an object");
  assertPlainObject(report.config, "Sanitized config must be an object");
  assertPlainObject(report.sourceIdentity, "Sanitized source identity must be an object");
  rejectUnknownFields(report.config, CONFIG_FIELDS, "sanitized config");
  rejectUnknownFields(
    report.sourceIdentity,
    SOURCE_IDENTITY_FIELDS,
    "sanitized sourceIdentity",
  );
  if (!Array.isArray(report.excludedRuns) || !Array.isArray(report.results)) {
    throw new Error("Sanitized excludedRuns and results must be arrays");
  }
  if (!Array.isArray(report.aggregates)) {
    throw new Error("Sanitized aggregates must be an array");
  }
  assertPlainObject(report.summary, "Sanitized summary must be an object");
}

function assertBoundedJson(root, label) {
  let nodes = 0;
  walkJson(root, ({ value, depth }) => {
    nodes += 1;
    if (nodes > MAX_NODES) throw new Error(`${label} exceeds the node bound`);
    if (depth > MAX_DEPTH) throw new Error(`${label} exceeds the depth bound`);
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
      throw new Error(`${label} contains a string that exceeds the byte bound`);
    }
    if (Array.isArray(value) && value.length > MAX_ARRAY_LENGTH) {
      throw new Error(`${label} contains an array that exceeds the length bound`);
    }
    if (isPlainObject(value) && Object.keys(value).length > MAX_OBJECT_KEYS) {
      throw new Error(`${label} contains an object that exceeds the key bound`);
    }
  });
}

function walkJson(root, visitor) {
  const stack = [{ value: root, key: null, location: "$", depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    visitor(current);
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: current.value[index],
          key: null,
          location: `${current.location}[${index}]`,
          depth: current.depth + 1,
        });
      }
    } else if (isPlainObject(current.value)) {
      const entries = Object.entries(current.value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, value] = entries[index];
        stack.push({
          value,
          key,
          location: `${current.location}.${key}`,
          depth: current.depth + 1,
        });
      }
    } else if (
      current.value != null &&
      typeof current.value !== "string" &&
      typeof current.value !== "number" &&
      typeof current.value !== "boolean"
    ) {
      throw new Error("Only JSON values are accepted");
    }
  }
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value))}\n`, "utf8");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function equalCanonical(left, right) {
  try {
    return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
  } catch {
    return false;
  }
}

function checkedBytes(value, label) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
  const limit = label === "input" ? MAX_INPUT_BYTES : MAX_OUTPUT_BYTES;
  if (bytes.length > limit) throw new Error(`${label} exceeds the configured byte bound`);
  return bytes;
}

function parseJson(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8 JSON`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function check(name, passed) {
  return { name, passed: passed === true };
}

function assertPlainObject(value, message) {
  if (!isPlainObject(value)) throw new Error(message);
}

function isPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownFields(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown ${location} field ${key}`);
  }
}

function looksPathBearingField(key) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
  return /(?:^|_)(?:cwd|file|filename|path|paths|root|roots|stack)$/u.test(normalized);
}

function publicLocation(location) {
  return location
    .map((part) => (typeof part === "number" ? "[]" : part))
    .join(".");
}

function cliHelp() {
  return `Usage:
  node scripts/sanitize-conformance-report.mjs \\
    --input <private-report.json> \\
    --manifest <committed-manifest.json> \\
    --logical-filename <manifest-basename> \\
    --output <benches/evidence/...json> \\
    --approved-private-sha256 <sha256> \\
    --reviewed-by <name>

The approval hash and reviewer are mandatory. The private input is not read
until the approval hash matches its committed manifest entry. Output is created
without overwrite and must remain under benches/evidence/.
`;
}

export function parseSanitizerCliArguments(arguments_) {
  if (arguments_.includes("--help")) return { help: true };
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (typeof flag !== "string" || !flag.startsWith("--") || value == null) {
      throw new Error("Every sanitizer option requires a value");
    }
    if (Object.hasOwn(options, flag)) throw new Error(`Duplicate option ${flag}`);
    options[flag] = value;
  }
  for (const required of [
    "--input",
    "--manifest",
    "--logical-filename",
    "--output",
    "--approved-private-sha256",
    "--reviewed-by",
  ]) {
    if (!Object.hasOwn(options, required)) throw new Error(`Missing required option ${required}`);
  }
  if (!SHA256_PATTERN.test(options["--approved-private-sha256"])) {
    throw new Error("The approval value must be an exact lowercase SHA-256");
  }
  if (options["--reviewed-by"].trim().length === 0) {
    throw new Error("The reviewer must be named explicitly");
  }
  return options;
}

function runCli(arguments_) {
  const options = parseSanitizerCliArguments(arguments_);
  if (options.help) {
    process.stdout.write(cliHelp());
    return;
  }
  const workspace = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const output = path.resolve(options["--output"]);
  const evidenceRoot = path.join(workspace, "benches", "evidence");
  if (output !== evidenceRoot && !output.startsWith(`${evidenceRoot}${path.sep}`)) {
    throw new Error("Public derivative output must be under benches/evidence/");
  }

  const manifestBytes = fs.readFileSync(options["--manifest"]);
  if (manifestBytes.length > MAX_INPUT_BYTES) {
    throw new Error("manifest exceeds the configured byte bound");
  }
  const manifest = parseJson(manifestBytes, "manifest");
  const entry = manifest?.artifacts?.find(
    (candidate) => candidate?.logicalFilename === options["--logical-filename"],
  );
  if (entry?.sha256 !== options["--approved-private-sha256"]) {
    throw new Error("Explicit approval hash does not match the committed manifest entry");
  }

  const inputBytes = fs.readFileSync(options["--input"]);
  const publicLogicalPath = path.relative(workspace, output).split(path.sep).join("/");
  const derivative = createSanitizedDerivative({
    inputBytes,
    manifest,
    logicalFilename: options["--logical-filename"],
    publicLogicalPath,
  });
  const review = reviewSanitizedDerivative({
    inputBytes,
    manifest,
    logicalFilename: options["--logical-filename"],
    document: derivative.document,
    bytes: derivative.bytes,
    publicSha256: derivative.publicSha256,
  });
  if (!review.approved) throw new Error("Sanitized derivative did not pass review checks");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, derivative.bytes, { flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({
      written: publicLogicalPath,
      reviewedBy: options["--reviewed-by"],
      manifestLinkage: derivative.manifestLinkage,
      reviewChecks: review.checks,
      nextAction:
        "Manually inspect the derivative, then record this linkage in the committed manifest before considering it publishable.",
    }, null, 2)}\n`,
  );
}

const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
