import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AUTOMATIC_RECONCILIATION_DEFAULTS,
  AUTOMATIC_RECONCILIATION_LIMITS,
} from "./automatic-reconciliation.js";

const wrapperPackage = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export const WRAPPER_VERSION = wrapperPackage.version;
export const WRAPPER_DELIVERY = packageDelivery(wrapperPackage);

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

const FILESYSTEM_MAGIC = Object.freeze({
  ordinaryLocal: new Set([
    0xef53n, // ext2/ext3/ext4
    0x58465342n, // XFS
    0x9123683en, // Btrfs
  ]),
  network: new Set([
    0x6969n, // NFS
    0xff534d42n, // CIFS
    0xfe534d42n, // SMB2
    0x5346414fn, // AFS
    0xf15fn, // Ceph
  ]),
  fuse: new Set([0x65735546n]),
  overlay: new Set([0x794c7630n]),
});

export function buildCapabilities(native, metadata, deliveryMetadata, matrix) {
  if (
    native?.schemaVersion !== 5 ||
    metadata?.schemaVersion !== 1 ||
    metadata?.bindingApiVersion !== 5 ||
    deliveryMetadata?.schemaVersion !== 1 ||
    matrix?.schemaVersion !== 1
  ) {
    throw new Error(
      "native capability, delivery, or target metadata uses an incompatible schema",
    );
  }
  if (
    native.cancellableEstablishment !== true ||
    native.sharedNodeDelivery !== true ||
    native.initialExclusions !== true ||
    native.directoryNameExclusions !== true ||
    native.observedExcludedPaths !== true ||
    native.physicalRootResolution !== true ||
    native.nativeCallbackQueueCapacity !== 1 ||
    native.deliveryDispatcherScope !== "node-environment" ||
    native.deliveryAdmission !== "single-credit" ||
    native.callbackCompletion !== "wrapper-acknowledged-promise-settlement" ||
    native.callbackMaxInFlight !== 1 ||
    native.callbackErrorPolicy !== "count-and-continue" ||
    native.callbackDisposalPolicy !== "join-pending-completion" ||
    native.callbackTeardownPolicy !== "abandon-pending-completion" ||
    native.deliveryDispatcherWorkQuantum !== 64 ||
    native.deliveryDispatcherPollMilliseconds !== 5
  ) {
    throw new Error("native cancellation and shared-delivery capabilities are incompatible");
  }

  const runtime = runtimeFacts(deliveryMetadata);
  const minimum = native.positiveIntegerMinimum;
  const maximum = native.positiveIntegerMaximum;
  const defaults = native.subscriptionDefaults;
  const prebuilt = WRAPPER_DELIVERY === "bundled-native-package";
  const supportTargets = matrix.targets.map((target) => ({
    id: target.id,
    status: target.qualification,
    package: target.package,
    targetTriple: target.rustTarget,
    operatingSystem: "linux",
    architecture: target.architecture,
    armAbi: target.armAbi ?? null,
    libc: {
      family: target.libc,
      maximumRequiredSymbolVersion: matrix.releaseBaseline.glibcMaximum,
    },
    kernelMinimum: matrix.releaseBaseline.kernelMinimum,
    nodeRange: matrix.nodeRange,
    qualificationLanes: matrix.qualificationLanes
      .filter((lane) => lane.architectures.includes(target.architecture))
      .map((lane) => lane.id),
  }));
  const runtimeMatchesPackagedTarget =
    runtime.platform === "linux" &&
    runtime.architecture === deliveryMetadata.architecture &&
    runtime.libc.family === deliveryMetadata.libc &&
    sameArmAbi(runtime.armAbi, deliveryMetadata.armAbi) &&
    metadata.targetTriple === deliveryMetadata.targetTriple;
  const currentTarget = supportTargets.find(
    (target) => target.id === deliveryMetadata.targetId,
  );
  if (currentTarget === undefined) {
    throw new Error("loaded native target is absent from the support matrix");
  }

  return deepFreeze({
    schemaVersion: 9,
    versions: {
      wrapper: WRAPPER_VERSION,
      native: metadata.nativeVersion,
      engine: metadata.engineVersion,
      bindingApi: metadata.bindingApiVersion,
    },
    build: {
      delivery: WRAPPER_DELIVERY,
      prebuilt,
      profile: metadata.buildProfile,
      targetTriple: metadata.targetTriple,
      nodeApi: metadata.nodeApiVersion,
      rustMinimum: "1.88",
      packagedTarget: {
        id: deliveryMetadata.targetId,
        package: deliveryMetadata.targetPackage,
        binary: deliveryMetadata.binary,
        sha256: deliveryMetadata.sha256,
        architecture: deliveryMetadata.architecture,
        armAbi: deliveryMetadata.armAbi,
        libc: deliveryMetadata.libc,
        qualification: deliveryMetadata.qualification,
      },
    },
    runtime,
    support: {
      scope: "legacy-primary-target",
      status: supportTargets.find((target) => target.architecture === "x64").status,
      operatingSystem: {
        family: "linux",
        distribution: "ubuntu",
        version: "24.04",
        kernelMinimum: "6.8",
      },
      architecture: "x64",
      libc: { family: "glibc", version: "2.39" },
      nodeRange: ">=24.15.0 <25",
      rustMinimum: "1.88",
      packageManager: "pnpm@10.33.2",
      delivery: WRAPPER_DELIVERY,
      rootThreatModel: "trusted-stable-local-roots",
      targets: supportTargets,
      qualificationLanes: matrix.qualificationLanes.map((lane) => ({
        id: lane.id,
        distribution: lane.distribution,
        version: lane.version,
        family: lane.family,
        architectures: lane.architectures,
        evidence: lane.evidence,
      })),
      recognizedCompatibilityFamilies: matrix.recognizedCompatibilityFamilies,
      currentRuntime: {
        scope: "packaged-target-compatibility",
        packagedTargetId: currentTarget.id,
        runtimeMatchesPackagedTarget,
        qualification: currentTarget.status,
        targetCompatible:
          runtimeMatchesPackagedTarget && currentTarget.status === "supported",
        fullQualification: "qualify-root-required",
      },
      intentionallyUnsupported: matrix.intentionallyUnsupported,
    },
    features: {
      recursive: native.recursive,
      movedInTreeDiscovery: native.movedInTreeDiscovery,
      explicitWatchLimits: native.explicitWatchLimits,
      processNativeWatchBudget: native.processNativeWatchBudget,
      sharedNativeWatches: native.sharedNativeWatches,
      overflowReporting: native.overflowReporting,
      initialExclusions: native.initialExclusions,
      dynamicExclusions: native.dynamicExclusions,
      directoryNameExclusions: native.directoryNameExclusions,
      observedExcludedPaths: native.observedExcludedPaths,
      reconciliation: native.reconciliation,
      automaticReconciliation: true,
      rootReplacementRecovery: native.rootReplacementRecovery,
      physicalRootResolution: native.physicalRootResolution,
      rootQualification: true,
      bytesOnlyInvalidations: true,
      exactPathBytes: native.exactPathBytes,
      orderedBatches: true,
      observedState: true,
      cancellableEstablishment: native.cancellableEstablishment,
      sharedNodeDelivery: native.sharedNodeDelivery,
    },
    options: {
      engine: {
        nativeWatchBudget: nullableIntegerOption(
          "process-runtime",
          "unique-native-watches",
          null,
          minimum,
          maximum,
        ),
      },
      subscription: {
        rootPathPolicy: {
          type: "enum",
          values: ["strict", "resolve-physical"],
          default: "strict",
          outputPaths: "physical",
          aliasTracking: "establishment-snapshot",
          nonUtf8PhysicalRoot: "bytes-only-invalidations",
        },
        initialExclusions: {
          type: "directory-prefix-array",
          default: [],
          scope: "subscription-establishment",
          matching: "exact-bytes",
          paths: "normalized-root-relative",
          exclusionGeneration: 0,
        },
        excludedDirectoryNames: {
          type: "directory-name-array",
          default: [],
          scope: "subscription-establishment",
          matching: "exact-component-bytes",
          depth: "every-directory-depth",
          exclusionGeneration: 0,
        },
        observedExcludedPaths: {
          type: "observed-excluded-path-array",
          default: [],
          scope: "subscription-establishment",
          matching: "exact-bytes",
          paths: "normalized-nonempty-root-relative",
          descendants: "excluded-and-unwatched",
          boundaryDelivery: "conservative-invalidation",
          exclusionGeneration: 0,
        },
        watchLimit: nullableIntegerOption(
          "subscription",
          "logical-directories",
          defaults.watchLimit ?? null,
          minimum,
          maximum,
        ),
        batchWindowMs: integerOption(
          "milliseconds",
          defaults.batchWindowMs,
          minimum,
          maximum,
        ),
        maxBatchPaths: integerOption(
          "paths",
          defaults.maxBatchPaths,
          minimum,
          maximum,
        ),
        outputQueueCapacity: integerOption(
          "batches",
          defaults.outputQueueCapacity,
          minimum,
          maximum,
        ),
        automaticReconciliation: {
          forms: ["boolean", "options"],
          default: false,
          maxAttempts: {
            default: AUTOMATIC_RECONCILIATION_DEFAULTS.maxAttempts,
            ...AUTOMATIC_RECONCILIATION_LIMITS.maxAttempts,
          },
          initialDelayMs: {
            default: AUTOMATIC_RECONCILIATION_DEFAULTS.initialDelayMs,
            ...AUTOMATIC_RECONCILIATION_LIMITS.delayMs,
          },
          maxDelayMs: {
            default: AUTOMATIC_RECONCILIATION_DEFAULTS.maxDelayMs,
            ...AUTOMATIC_RECONCILIATION_LIMITS.delayMs,
          },
          constraint: "maxDelayMs-gte-initialDelayMs",
        },
      },
    },
    observability: {
      authoritativeState: "ordered-batches",
      observedStateBoundary: "before-callback",
      operationResultsMayLeadObservedState: true,
      nativeGettersMayLeadObservedState: true,
      initialCoverage: true,
      initialRootState: true,
      subscriptionStats: true,
      runtimeStats: {
        scope: "process",
        nativeWatchAccounting: "unique-native-watches",
        deferredAccounting: "logical-interests",
        inactiveSnapshot: "zero",
      },
      counterEncoding: {
        sequences: "bigint",
        cumulativeCounters: "bigint",
        gauges: "number",
      },
      pathEncodingStates: ["complete", "root-collapsed", "bytes-only"],
      earlyDelivery: "buffered-until-resolved-root",
      nativeCallbackQueueCapacity: native.nativeCallbackQueueCapacity,
      deliveryDispatcherScope: native.deliveryDispatcherScope,
      deliveryAdmission: native.deliveryAdmission,
      callbackCompletion: "promise-aware-serialized",
      callbackMaxInFlight: native.callbackMaxInFlight,
      callbackErrorPolicy: native.callbackErrorPolicy,
      callbackDisposalPolicy: native.callbackDisposalPolicy,
      callbackTeardownPolicy: native.callbackTeardownPolicy,
      deliveryDispatcherWorkQuantum: native.deliveryDispatcherWorkQuantum,
      deliveryDispatcherPollMilliseconds:
        native.deliveryDispatcherPollMilliseconds,
    },
  });
}

export function qualifyRootCapabilities(capabilities, root, injectedEvidence) {
  const currentTarget = capabilities.support.targets.find(
    (target) => target.id === capabilities.support.currentRuntime.packagedTargetId,
  );
  if (currentTarget === undefined) {
    throw new Error("current packaged target is absent from capabilities");
  }
  const evidence = injectedEvidence ?? collectQualificationEvidence(root);
  return deepFreeze(evaluateQualification({
    runtime: capabilities.runtime,
    currentRuntime: capabilities.support.currentRuntime,
    target: currentTarget,
    evidence,
  }));
}

export function evaluateQualification({ runtime, currentRuntime, target, evidence }) {
  const reasons = [];
  const targetReasons = [];
  if (!currentRuntime.runtimeMatchesPackagedTarget) {
    targetReasons.push("packaged-target-mismatch");
  }
  if (currentRuntime.qualification !== "supported") {
    targetReasons.push("packaged-target-unqualified");
  }
  const targetState = targetReasons.length === 0 ? "qualified" : "unqualified";
  reasons.push(...targetReasons);

  const kernelFloor = floorEvidence(runtime.kernel, target.kernelMinimum);
  if (kernelFloor.state === "below-floor") reasons.push("kernel-below-floor");
  if (kernelFloor.state === "unknown") reasons.push("kernel-unknown");

  const glibcFloor = runtime.libc.family === "glibc"
    ? floorEvidence(
        runtime.libc.version,
        target.libc.maximumRequiredSymbolVersion,
      )
    : {
        state: "unknown",
        observed: runtime.libc.version,
        minimum: target.libc.maximumRequiredSymbolVersion,
      };
  if (glibcFloor.state === "below-floor") reasons.push("glibc-below-floor");
  if (glibcFloor.state === "unknown") reasons.push("glibc-unknown");

  const wsl = environmentEvidence(evidence.wsl);
  if (wsl.state === "detected") reasons.push("wsl-detected");
  if (wsl.state === "unknown") reasons.push("wsl-unknown");
  const container = environmentEvidence(evidence.container);
  if (container.state === "detected") reasons.push("container-detected");
  if (container.state === "unknown") reasons.push("container-unknown");

  const hostReasons = reasons.filter((reason) =>
    reason.startsWith("kernel-") ||
    reason.startsWith("glibc-") ||
    reason.startsWith("wsl-") ||
    reason.startsWith("container-")
  );
  const hostState = qualificationState(hostReasons);

  const rootReasons = [];
  if (evidence.root.availability === "unavailable") {
    rootReasons.push("root-unavailable");
  } else if (evidence.root.directory === false) {
    rootReasons.push("root-not-directory");
  } else if (evidence.root.filesystem.kind === "network") {
    rootReasons.push("filesystem-network");
  } else if (evidence.root.filesystem.kind === "fuse") {
    rootReasons.push("filesystem-fuse");
  } else if (evidence.root.filesystem.kind === "overlay") {
    rootReasons.push("filesystem-overlay");
  } else if (evidence.root.filesystem.kind !== "ordinary-local") {
    rootReasons.push("filesystem-unknown");
  }
  reasons.push(...rootReasons);
  const rootState = qualificationState(rootReasons);

  return {
    schemaVersion: 1,
    state: qualificationState(reasons),
    reasons: [...new Set(reasons)],
    target: {
      state: targetState,
      packagedTargetId: currentRuntime.packagedTargetId,
      runtimeMatchesPackagedTarget: currentRuntime.runtimeMatchesPackagedTarget,
      qualification: currentRuntime.qualification,
    },
    host: {
      state: hostState,
      kernelFloor,
      glibcFloor,
      wsl,
      container,
    },
    root: {
      state: rootState,
      lexicalPath: evidence.root.lexicalPath,
      lexicalPathBytes: evidence.root.lexicalPathBytes,
      physicalPath: evidence.root.physicalPath,
      physicalPathBytes: evidence.root.physicalPathBytes,
      filesystem: evidence.root.filesystem,
    },
  };
}

function qualificationState(reasons) {
  if (reasons.some((reason) => reason.endsWith("-unknown") || reason === "root-unavailable")) {
    return reasons.some((reason) =>
      reason === "packaged-target-mismatch" ||
      reason === "packaged-target-unqualified" ||
      reason.endsWith("-below-floor") ||
      reason.endsWith("-detected") ||
      reason === "root-not-directory" ||
      reason === "filesystem-network" ||
      reason === "filesystem-fuse" ||
      reason === "filesystem-overlay"
    ) ? "unqualified" : "unknown";
  }
  return reasons.length === 0 ? "qualified" : "unqualified";
}

function floorEvidence(observed, minimum) {
  const observedParts = versionParts(observed);
  const minimumParts = versionParts(minimum);
  if (observedParts === null || minimumParts === null) {
    return { state: "unknown", observed: observed ?? null, minimum };
  }
  return {
    state: compareVersions(observedParts, minimumParts) >= 0
      ? "satisfied"
      : "below-floor",
    observed,
    minimum,
  };
}

function versionParts(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:\.\d+)+)(?:[-+][0-9A-Za-z._+-]+)?$/u.exec(value);
  return match === null ? null : match[1].split(".").map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function environmentEvidence(value) {
  return {
    state: value === true ? "detected" : value === false ? "not-detected" : "unknown",
  };
}

function collectQualificationEvidence(root) {
  const lexicalPath = path.isAbsolute(root)
    ? root
    : `${process.cwd()}${path.sep}${root}`;
  const lexicalPathBytes = Uint8Array.from(Buffer.from(lexicalPath));
  const rootEvidence = {
    availability: "unavailable",
    directory: null,
    lexicalPath,
    lexicalPathBytes,
    physicalPath: null,
    physicalPathBytes: null,
    filesystem: { kind: "unknown", magic: null },
  };
  try {
    const resolved = fs.realpathSync.native(Buffer.from(lexicalPath), {
      encoding: "buffer",
    });
    const physicalBuffer = Buffer.isBuffer(resolved) ? resolved : Buffer.from(resolved);
    const physicalPathBytes = Uint8Array.from(physicalBuffer);
    let physicalPath = null;
    try {
      physicalPath = fatalUtf8Decoder.decode(physicalPathBytes);
    } catch {
      // Exact bytes remain available below.
    }
    const metadata = fs.statSync(physicalBuffer);
    const filesystem = fs.statfsSync(physicalBuffer, { bigint: true });
    rootEvidence.availability = "available";
    rootEvidence.directory = metadata.isDirectory();
    rootEvidence.physicalPath = physicalPath;
    rootEvidence.physicalPathBytes = physicalPathBytes;
    rootEvidence.filesystem = classifyFilesystem(filesystem.type);
  } catch {
    // Unavailable evidence is an unknown result, never a qualification.
  }
  return {
    wsl: detectWsl(),
    container: detectContainer(),
    root: rootEvidence,
  };
}

function classifyFilesystem(value) {
  const type = BigInt.asUintN(64, BigInt(value));
  const magic = `0x${type.toString(16)}`;
  if (FILESYSTEM_MAGIC.ordinaryLocal.has(type)) return { kind: "ordinary-local", magic };
  if (FILESYSTEM_MAGIC.network.has(type)) return { kind: "network", magic };
  if (FILESYSTEM_MAGIC.fuse.has(type)) return { kind: "fuse", magic };
  if (FILESYSTEM_MAGIC.overlay.has(type)) return { kind: "overlay", magic };
  return { kind: "unknown", magic };
}

function detectWsl() {
  if (process.platform !== "linux") return null;
  return /microsoft/iu.test(os.release()) || /microsoft/iu.test(readText("/proc/version") ?? "");
}

function detectContainer() {
  return classifyContainerEvidence({
    markerFiles: [
      probeMarkerFile("/.dockerenv"),
      probeMarkerFile("/run/.containerenv"),
    ],
    systemdContainer: probeOptionalTextFile("/run/systemd/container"),
    cgroup: probeRequiredTextFile("/proc/1/cgroup", CGROUP_PROBE_MAX_BYTES),
    mountinfo: probeRequiredTextFile(
      "/proc/self/mountinfo",
      MOUNTINFO_PROBE_MAX_BYTES,
    ),
    environmentContainer:
      typeof process.env.container === "string" ? process.env.container : null,
  });
}

const CGROUP_PROBE_MAX_BYTES = 64 * 1024;
const MOUNTINFO_PROBE_MAX_BYTES = 16 * 1024 * 1024;
const PROC_READ_CHUNK_BYTES = 64 * 1024;
const CONTAINER_PATH_INDICATOR =
  /(?:^|[/:.@_-])(?:docker|podman|libpod|kubepods|containerd|systemd-nspawn|machine\.slice|lxc)(?=$|[/:.@_-])/iu;
const AMBIGUOUS_CONTAINER_ROOT_FILESYSTEMS = new Set([
  "overlay",
  "fuse.overlayfs",
  "fuse-overlayfs",
  "fuse.fuse-overlayfs",
]);
const CGROUP_CONTROLLER_PATTERN = /^(?:name=)?[0-9A-Za-z_.-]+$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/u;
const DEVICE_PATTERN = /^(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/u;
const MOUNT_OPTIONS_PATTERN = /^(?:ro|rw)(?:,[^,]+)*$/u;
const MOUNTINFO_OPTIONAL_FIELD_PATTERN = /^[^:]+(?::[^:]+)?$/u;
const MOUNTINFO_ESCAPE_BYTES = new Set(["011", "012", "040", "043", "134"]);

function classifyCgroupProbe(probe) {
  if (probe.availability !== "present" || typeof probe.content !== "string") {
    return null;
  }
  const paths = parseCgroupPaths(probe.content);
  if (paths === null) return null;
  return paths.some((pathValue) => CONTAINER_PATH_INDICATOR.test(pathValue));
}

function parseCgroupPaths(content) {
  if (
    Buffer.byteLength(content, "utf8") > CGROUP_PROBE_MAX_BYTES ||
    content.includes("\0") ||
    !content.endsWith("\n")
  ) {
    return null;
  }
  const body = content.slice(0, -1);
  if (body.length === 0) return null;
  const paths = [];
  const hierarchyIds = new Set();
  for (const line of body.split("\n")) {
    const firstSeparator = line.indexOf(":");
    const secondSeparator = line.indexOf(":", firstSeparator + 1);
    if (firstSeparator <= 0 || secondSeparator < firstSeparator + 1) return null;
    const hierarchyId = line.slice(0, firstSeparator);
    const controllers = line.slice(firstSeparator + 1, secondSeparator);
    const pathValue = line.slice(secondSeparator + 1);
    if (
      !DECIMAL_PATTERN.test(hierarchyId) ||
      hierarchyIds.has(hierarchyId) ||
      !pathValue.startsWith("/")
    ) {
      return null;
    }
    hierarchyIds.add(hierarchyId);
    if (hierarchyId === "0") {
      if (controllers.length !== 0) return null;
    } else if (!validCgroupControllers(controllers)) {
      return null;
    }
    paths.push(pathValue);
  }
  return paths;
}

function validCgroupControllers(controllers) {
  if (controllers.length === 0) return false;
  const tokens = controllers.split(",");
  return tokens.every((token) => CGROUP_CONTROLLER_PATTERN.test(token)) &&
    new Set(tokens).size === tokens.length;
}

function parseRootMount(content) {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > MOUNTINFO_PROBE_MAX_BYTES ||
    content.includes("\0") ||
    !content.endsWith("\n")
  ) {
    return null;
  }
  let rootMount = null;
  let lineStart = 0;
  while (lineStart < content.length) {
    const lineEnd = content.indexOf("\n", lineStart);
    const line = content.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    if (line.length === 0) return null;
    if (mountinfoFieldAt(line, 4) !== "/") continue;
    const candidate = parseRootMountLine(line);
    if (candidate === null || rootMount !== null) return null;
    rootMount = candidate;
  }
  return rootMount;
}

function mountinfoFieldAt(line, targetIndex) {
  let fieldStart = 0;
  for (let index = 0; index <= targetIndex; index += 1) {
    const fieldEnd = line.indexOf(" ", fieldStart);
    if (fieldEnd <= fieldStart) return null;
    if (index === targetIndex) return line.slice(fieldStart, fieldEnd);
    fieldStart = fieldEnd + 1;
  }
  return null;
}

function parseRootMountLine(line) {
  const fields = line.split(" ");
  const separator = fields.indexOf("-", 6);
  if (
    separator < 6 ||
    fields.length !== separator + 4 ||
    fields.some((field) => field.length === 0) ||
    !DECIMAL_PATTERN.test(fields[0] ?? "") ||
    !DECIMAL_PATTERN.test(fields[1] ?? "") ||
    !DEVICE_PATTERN.test(fields[2] ?? "") ||
    fields[4] !== "/"
  ) {
    return null;
  }
  const root = decodeMountinfoField(fields[3]);
  const mountOptions = decodeMountinfoField(fields[5]);
  const filesystemType = decodeMountinfoField(fields[separator + 1]);
  const mountSource = decodeMountinfoField(fields[separator + 2]);
  const superOptions = decodeMountinfoField(fields[separator + 3]);
  if (
    root === null ||
    !root.startsWith("/") ||
    mountOptions === null ||
    !MOUNT_OPTIONS_PATTERN.test(mountOptions) ||
    filesystemType === null ||
    mountSource === null ||
    superOptions === null ||
    !MOUNT_OPTIONS_PATTERN.test(superOptions) ||
    fields.slice(6, separator).some((field) => {
      const decoded = decodeMountinfoField(field);
      return decoded === null || !MOUNTINFO_OPTIONAL_FIELD_PATTERN.test(decoded);
    })
  ) {
    return null;
  }
  return { root, filesystemType, mountSource, superOptions };
}

function decodeMountinfoField(value) {
  if (typeof value !== "string" || value.length === 0 || /[ \t\n\0]/u.test(value)) {
    return null;
  }
  let decoded = "";
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") continue;
    const escapedByte = value.slice(index + 1, index + 4);
    if (!MOUNTINFO_ESCAPE_BYTES.has(escapedByte)) return null;
    decoded += value.slice(segmentStart, index);
    decoded += String.fromCharCode(Number.parseInt(escapedByte, 8));
    index += 3;
    segmentStart = index + 1;
  }
  return decoded + value.slice(segmentStart);
}

function classifyMountinfoProbe(probe) {
  if (probe.availability !== "present") return null;
  const rootMount = parseRootMount(probe.content);
  if (rootMount === null) return null;
  if (
    AMBIGUOUS_CONTAINER_ROOT_FILESYSTEMS.has(
      rootMount.filesystemType.toLowerCase(),
    )
  ) {
    return null;
  }
  return [
    rootMount.root,
    rootMount.filesystemType,
    rootMount.mountSource,
    rootMount.superOptions,
  ].some((field) => CONTAINER_PATH_INDICATOR.test(field)) ? null : false;
}

export function classifyContainerEvidence(evidence) {
  if (evidence.markerFiles.some((probe) => probe.availability === "present")) {
    return true;
  }
  if (evidence.systemdContainer.availability === "present") return true;
  if (
    typeof evidence.environmentContainer === "string" &&
    evidence.environmentContainer.length > 0
  ) {
    return true;
  }

  const cgroup = classifyCgroupProbe(evidence.cgroup);
  const mountinfo = classifyMountinfoProbe(evidence.mountinfo);
  if (cgroup === true || mountinfo === true) return true;

  const optionalProbesComplete = evidence.markerFiles.every((probe) =>
    probe.availability === "present" || probe.availability === "missing"
  ) && (
    evidence.systemdContainer.availability === "present" ||
    evidence.systemdContainer.availability === "missing"
  );
  const requiredProbesComplete = cgroup === false && mountinfo === false;
  return optionalProbesComplete && requiredProbesComplete ? false : null;
}

function probeMarkerFile(file) {
  try {
    fs.lstatSync(file);
    return { availability: "present", content: null };
  } catch (error) {
    return {
      availability: error?.code === "ENOENT" ? "missing" : "unavailable",
      content: null,
    };
  }
}

function probeOptionalTextFile(file) {
  try {
    return { availability: "present", content: fs.readFileSync(file, "utf8") };
  } catch (error) {
    return {
      availability: error?.code === "ENOENT" ? "missing" : "unavailable",
      content: null,
    };
  }
}

function probeRequiredTextFile(file, maximumBytes) {
  try {
    const descriptor = fs.openSync(file, "r");
    try {
      const chunks = [];
      let length = 0;
      while (length <= maximumBytes) {
        const chunk = Buffer.allocUnsafe(
          Math.min(PROC_READ_CHUNK_BYTES, maximumBytes + 1 - length),
        );
        const bytesRead = fs.readSync(
          descriptor,
          chunk,
          0,
          chunk.length,
          null,
        );
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > maximumBytes) {
          return { availability: "unavailable", content: null };
        }
        chunks.push(chunk.subarray(0, bytesRead));
      }
      return {
        availability: "present",
        content: Buffer.concat(chunks, length).toString("utf8"),
      };
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    return {
      availability: error?.code === "ENOENT" ? "missing" : "unavailable",
      content: null,
    };
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function packageDelivery(manifest) {
  const delivery = manifest?.watchbound?.delivery;
  if (
    delivery === undefined &&
    manifest?.name === "@jsr/gadicc__watchbound" &&
    manifest?.dependencies?.["@gadicc/watchbound-node"] === manifest.version
  ) {
    return "bundled-native-package";
  }
  if (
    delivery !== "controlled-source-build" &&
    delivery !== "bundled-native-package"
  ) {
    throw new Error("wrapper package delivery metadata is invalid");
  }
  return delivery;
}

export function normalizeRuntimeStats(stats) {
  return Object.freeze({
    active: stats.active,
    inotifyInstances: stats.inotifyInstances,
    workerThreads: stats.workerThreads,
    nativeWatches: stats.nativeWatches,
    nativeWatchBudget: stats.nativeWatchBudget ?? null,
    deferredInterests: stats.deferredInterests,
    subscriptions: stats.subscriptions,
  });
}

function nullableIntegerOption(scope, accounting, defaultValue, minimum, maximum) {
  return {
    type: "integer-or-null",
    scope,
    accounting,
    default: defaultValue,
    minimum,
    maximum,
    nullMeaning: "no-watchbound-limit",
  };
}

function integerOption(unit, defaultValue, minimum, maximum) {
  return {
    type: "integer",
    unit,
    default: defaultValue,
    minimum,
    maximum,
  };
}

function runtimeFacts(deliveryMetadata) {
  let report;
  try {
    report = process.report?.getReport?.();
  } catch {
    report = undefined;
  }
  const glibcVersion = report?.header?.glibcVersionRuntime;
  const musl = report?.sharedObjects?.some((value) =>
    /(?:^|\/)(?:ld-musl|libc\.musl)/u.test(value),
  );
  return {
    platform: process.platform,
    architecture: process.arch,
    armAbi: process.arch === "arm" ? deliveryMetadata.runtimeArmAbi : null,
    kernel: os.release(),
    libc: {
      family: typeof glibcVersion === "string" ? "glibc" : musl ? "musl" : "unknown",
      version: typeof glibcVersion === "string" ? glibcVersion : null,
    },
    node: {
      version: process.versions.node,
      api: process.versions.napi === undefined ? null : Number(process.versions.napi),
    },
  };
}

function sameArmAbi(runtime, packaged) {
  if (packaged === null || packaged === undefined) return runtime === null;
  return runtime !== null &&
    runtime.version === packaged.version &&
    runtime.floatAbi === packaged.floatAbi &&
    runtime.endianness === packaged.endianness;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
