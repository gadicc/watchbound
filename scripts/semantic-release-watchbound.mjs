import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { installExactJsrNative } from "./install-jsr-native.mjs";
import { loadNativeMatrix, targetForRuntime } from "./lib/native-matrix.mjs";
import {
  SOURCE_VERSION,
  assertWorkspaceVersion,
  verifyReleaseCandidate,
} from "./lib/release-version.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function prepare(_pluginConfig, { nextRelease }) {
  assertPlannedVersion(nextRelease.version);
  assertWorkspaceVersion(workspaceRoot, SOURCE_VERSION);
  assertReleaseTargetsQualified();
  run(process.execPath, ["scripts/set-release-version.mjs", nextRelease.version]);
  verifyCurrentCandidate(nextRelease.version);
  installCanonicalNativeMatrix();
  run("pnpm", ["check:reproducible"]);
  run("pnpm", ["test:packages"]);
}

export async function publish(_pluginConfig, { nextRelease }) {
  const { version } = nextRelease;
  verifyPublishPreconditions(version);
  const distTag = nextRelease.channel ?? "latest";
  const jsrPackage = `jsr:@gadicc/watchbound@${version}`;
  const packages = releasePackages(version);
  const targets = packages.filter(({ kind }) => kind === "target");
  const loader = packages.find(({ kind }) => kind === "loader");
  const wrapper = packages.find(({ kind }) => kind === "wrapper");
  const ledger = {
    schemaVersion: 2,
    kind: "watchbound-publication-ledger",
    version,
    sourceSha: capture("git", ["rev-parse", "HEAD"]),
    startedAt: new Date().toISOString(),
    operations: [],
  };
  writeLedger(ledger);

  try {
    const states = new Map();
    for (const descriptor of packages) {
      states.set(descriptor.name, await npmPackageState(`${descriptor.name}@${version}`));
    }
    const missingTargets = targets.filter(({ name }) => states.get(name) === null);
    if (states.get(wrapper.name) !== null && states.get(loader.name) === null) {
      throw new Error(`${wrapper.name}@${version} exists without its exact loader dependency`);
    }
    if (
      (states.get(wrapper.name) !== null || states.get(loader.name) !== null) &&
      missingTargets.length > 0
    ) {
      throw new Error(
        `loader or wrapper exists without exact native targets: ${missingTargets.map(({ name }) => name).join(", ")}`,
      );
    }

    for (const descriptor of packages) {
      const existing = states.get(descriptor.name);
      if (existing !== null) {
        verifyExistingNpmPackage(existing, descriptor, version);
      } else {
        publishNpm(descriptor, distTag);
        recordOperation(ledger, `npm:${descriptor.name}`, "published-verification-pending");
        verifyExistingNpmPackage(
          await waitForNpmPackage(`${descriptor.name}@${version}`),
          descriptor,
          version,
        );
      }
      recordOperation(
        ledger,
        `npm:${descriptor.name}`,
        existing === null ? "verified-published" : "verified-existing",
      );
    }

    if (!await jsrPackageExists(jsrPackage)) {
      const matrix = loadNativeMatrix(workspaceRoot);
      const currentTarget = targetForRuntime(matrix, process.platform, process.arch);
      const currentTargetPackage = targets.find(({ targetId }) =>
        targetId === currentTarget.id);
      installExactJsrNative(
        run,
        path.join(workspaceRoot, "dist/jsr"),
        [loader.tarball, currentTargetPackage.tarball],
      );
      run(
        "deno",
        ["publish", "--dry-run", "--allow-dirty", "--no-check"],
        path.join(workspaceRoot, "dist/jsr"),
      );
      run(
        "deno",
        ["publish", "--allow-dirty", "--no-check"],
        path.join(workspaceRoot, "dist/jsr"),
      );
      recordOperation(ledger, "jsr-wrapper", "published-verification-pending");
      if (!await waitForJsrPackage(jsrPackage)) {
        throw new Error(`${jsrPackage} was not visible after publication`);
      }
      recordOperation(ledger, "jsr-wrapper", "verified-published");
    } else {
      recordOperation(ledger, "jsr-wrapper", "verified-existing");
    }
    ledger.finishedAt = new Date().toISOString();
    ledger.status = "completed";
    writeLedger(ledger);
  } catch (error) {
    ledger.finishedAt = new Date().toISOString();
    ledger.status = "failed";
    ledger.error = { name: error?.name ?? null, message: error?.message ?? String(error) };
    writeLedger(ledger);
    throw error;
  }

  return {
    name: "watchbound",
    url: `https://www.npmjs.com/package/watchbound/v/${version}`,
  };
}

export function verifyPublishPreconditions(version, root = workspaceRoot) {
  assertPlannedVersion(version);
  const candidate = verifyCurrentCandidate(version, root);
  assertReleaseTargetsQualified(root);
  return candidate;
}

function assertReleaseTargetsQualified(root = workspaceRoot) {
  const matrix = loadNativeMatrix(root);
  const pending = matrix.targets.filter(({ qualification }) => qualification !== "supported");
  if (pending.length > 0) {
    throw new Error(
      `release targets lack exact-commit qualification: ${pending.map(({ id }) => id).join(", ")}`,
    );
  }
}

function installCanonicalNativeMatrix() {
  const canonicalRootValue = process.env.WATCHBOUND_CANONICAL_NATIVE_DIR;
  if (!canonicalRootValue) {
    throw new Error("stable release requires WATCHBOUND_CANONICAL_NATIVE_DIR");
  }
  const canonicalRoot = path.resolve(canonicalRootValue);
  const comparisonPath = path.join(canonicalRoot, "independent-reproducibility.json");
  const comparison = readJsonAbsolute(comparisonPath);
  const matrix = loadNativeMatrix(workspaceRoot);
  const candidate = verifyCurrentCandidate(readJson("package.json").version);
  if (
    comparison.schemaVersion !== 2 ||
    comparison.kind !== "watchbound-independent-native-matrix-comparison" ||
    comparison.sourceSha !== capture("git", ["rev-parse", "HEAD"]) ||
    comparison.version !== readJson("package.json").version ||
    JSON.stringify(comparison.candidate) !== JSON.stringify(candidate)
  ) {
    throw new Error("canonical independent native matrix has the wrong identity");
  }
  for (const target of matrix.targets) {
    const source = path.join(canonicalRoot, target.binary);
    const compared = comparison.targets.find(({ target: id }) => id === target.id);
    if (
      !compared ||
      compared.targetTriple !== target.rustTarget ||
      compared.architecture !== target.architecture ||
      compared.filename !== target.binary ||
      compared.sha256 !== sha256(source) ||
      !Number.isSafeInteger(compared.bytes) ||
      compared.bytes !== fs.statSync(source).size ||
      compared.byteIdentical !== true ||
      !Array.isArray(compared.builders) ||
      compared.builders.length !== 2
    ) {
      throw new Error(`canonical independent native artifact has the wrong identity: ${target.id}`);
    }
  }
  const currentTarget = targetForRuntime(matrix, process.platform, process.arch);
  const currentSource = path.join(canonicalRoot, currentTarget.binary);
  const currentDestination = path.join(workspaceRoot, "node", currentTarget.binary);
  fs.copyFileSync(currentSource, currentDestination);
  if (sha256(currentDestination) !== sha256(currentSource)) {
    throw new Error("canonical native artifact changed while installing it");
  }
  process.env.WATCHBOUND_NATIVE_ARTIFACTS_DIR = canonicalRoot;
  process.env.WATCHBOUND_REQUIRE_ALL_TARGETS = "1";
  process.env.WATCHBOUND_INDEPENDENT_REPRODUCIBILITY = comparisonPath;
  process.env.WATCHBOUND_EXPECTED_NATIVE_SHA256 = sha256(currentSource);
}

function releasePackages(version) {
  const manifest = readJson("dist/native-package-manifest.json");
  const targets = manifest.targets.map((target) => ({
    kind: "target",
    targetId: target.id,
    name: target.name,
    root: target.root,
    tarball: genericTarballPath(target.name, version),
  }));
  return [
    ...targets,
    {
      kind: "loader",
      name: manifest.loader.name,
      root: manifest.loader.root,
      tarball: genericTarballPath(manifest.loader.name, version),
    },
    {
      kind: "wrapper",
      name: manifest.wrapper.name,
      root: manifest.wrapper.root,
      tarball: genericTarballPath(manifest.wrapper.name, version),
    },
  ];
}

function publishNpm(descriptor, distTag) {
  run("npm", [
    "publish",
    descriptor.tarball,
    "--access",
    "public",
    "--provenance",
    "--tag",
    distTag,
  ]);
}

function assertPlannedVersion(version) {
  if (process.env.WATCHBOUND_PLANNED_VERSION !== version) {
    throw new Error(`semantic-release version ${version} differs from the planned version`);
  }
}

function verifyCurrentCandidate(version, root = workspaceRoot) {
  return verifyReleaseCandidate(root, {
    sourceSha: capture("git", ["rev-parse", "HEAD"], root),
    version,
  });
}

async function npmPackageState(specifier) {
  const result = spawnSync("npm", ["view", specifier, "--json"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return JSON.parse(result.stdout);
  if (isMissing(`${result.stdout}\n${result.stderr}`)) return null;
  throw new Error(
    `could not determine whether ${specifier} exists:\n${result.stdout}\n${result.stderr}`.trim(),
  );
}

async function waitForNpmPackage(specifier) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const state = await npmPackageState(specifier);
    if (state !== null) return state;
    await delay(3_000);
  }
  throw new Error(`${specifier} was not visible after publication`);
}

function verifyExistingNpmPackage(state, descriptor, version) {
  const expectedManifest = readJson(path.join("dist", descriptor.root, "package.json"));
  const expectedIntegrity = sha512Integrity(descriptor.tarball);
  if (state.name !== expectedManifest.name || state.version !== version) {
    throw new Error(`registry identity mismatch for ${expectedManifest.name}@${version}`);
  }
  if (state.dist?.integrity !== expectedIntegrity) {
    throw new Error(`registry integrity mismatch for ${expectedManifest.name}@${version}`);
  }
  for (const field of ["dependencies", "optionalDependencies", "os", "cpu", "libc"]) {
    if (JSON.stringify(state[field] ?? null) !== JSON.stringify(expectedManifest[field] ?? null)) {
      throw new Error(`registry ${field} mismatch for ${expectedManifest.name}@${version}`);
    }
  }
}

export async function waitForJsrPackage(specifier, {
  attempts = 60,
  pollIntervalMs = 5_000,
  packageExists = jsrPackageExists,
  sleep = delay,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await packageExists(specifier)) return true;
    if (attempt < attempts) await sleep(pollIntervalMs);
  }
  return false;
}

export async function jsrPackageExists(specifier, fetchImplementation = globalThis.fetch) {
  const match =
    /^jsr:@(?<scope>[a-z0-9-]+)\/(?<packageName>[a-z0-9-]+)@(?<version>[^/]+)$/u
      .exec(specifier);
  if (!match?.groups) throw new Error(`invalid exact JSR package specifier: ${specifier}`);
  const { scope, packageName, version } = match.groups;
  const metadataUrl = `https://jsr.io/@${scope}/${packageName}/${version}_meta.json`;
  const response = await fetchImplementation(metadataUrl, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `could not determine whether ${specifier} exists: ${metadataUrl} returned HTTP ${response.status}`,
    );
  }
  const metadata = await response.json();
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !metadata.manifest ||
    typeof metadata.manifest !== "object" ||
    !metadata.exports ||
    typeof metadata.exports !== "object"
  ) {
    throw new Error(`invalid JSR version metadata for ${specifier}`);
  }
  return true;
}

function isMissing(output) {
  return /\bE404\b|is not in this registry|no match found/iu.test(output);
}

function genericTarballPath(name, version) {
  const filename = `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
  return path.join(workspaceRoot, "dist", "tarballs", filename);
}

function recordOperation(ledger, operation, status) {
  ledger.operations.push({ operation, status, at: new Date().toISOString() });
  writeLedger(ledger);
}

function writeLedger(ledger) {
  const destination = path.join(workspaceRoot, "dist", "evidence", "publication-ledger.json");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(ledger, null, 2)}\n`);
}

function readJson(relativePath) {
  return readJsonAbsolute(path.join(workspaceRoot, relativePath));
}

function readJsonAbsolute(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}

function sha512Integrity(source) {
  return `sha512-${crypto.createHash("sha512").update(fs.readFileSync(source)).digest("base64")}`;
}

function capture(command, args, cwd = workspaceRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
  return result.stdout.trim();
}

function run(command, args, cwd = workspaceRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}
