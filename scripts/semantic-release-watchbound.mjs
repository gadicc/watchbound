import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { installExactJsrNative } from "./install-jsr-native.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function prepare(_pluginConfig, { nextRelease }) {
  const committedVersion = readJson("package.json").version;
  assertReleaseIdentity(nextRelease.version, committedVersion);
  run(process.execPath, [
    "scripts/set-release-version.mjs",
    nextRelease.version,
  ]);
  run("git", [
    "diff",
    "--exit-code",
    "--",
    "package.json",
    "js/package.json",
    "node/package.json",
    "Cargo.toml",
    "Cargo.lock",
    "pnpm-lock.yaml",
  ]);
  run("pnpm", ["check:reproducible"]);
  installCanonicalNative();
  run("pnpm", ["test:packages"]);
}

export async function publish(_pluginConfig, { nextRelease }) {
  const { version } = nextRelease;
  assertReleaseIdentity(version, readJson("package.json").version);
  const distTag = nextRelease.channel ?? "latest";
  const nativePackage = `@gadicc/watchbound-node@${version}`;
  const wrapperPackage = `watchbound@${version}`;
  const jsrPackage = `jsr:@gadicc/watchbound@${version}`;
  const nativeTarball = tarballPath("node", version);
  const wrapperTarball = tarballPath("wrapper", version);
  const ledger = {
    schemaVersion: 1,
    kind: "watchbound-publication-ledger",
    version,
    sourceSha: capture("git", ["rev-parse", "HEAD"]),
    startedAt: new Date().toISOString(),
    operations: [],
  };
  writeLedger(ledger);

  try {
    const nativeState = await npmPackageState(nativePackage);
    const wrapperState = await npmPackageState(wrapperPackage);
    const nativeExists = nativeState !== null;
    const wrapperExists = wrapperState !== null;
    if (wrapperExists && !nativeExists) {
      throw new Error(
        `${wrapperPackage} exists without its exact native dependency`,
      );
    }

    if (nativeState !== null) {
      verifyExistingNpmPackage(nativeState, "node", version, nativeTarball);
    }
    if (!nativeExists) {
      publishNpm("node", version, distTag);
      recordOperation(ledger, "npm-native", "published-verification-pending");
      verifyExistingNpmPackage(
        await waitForNpmPackage(nativePackage),
        "node",
        version,
        nativeTarball,
      );
    }
    recordOperation(
      ledger,
      "npm-native",
      nativeExists ? "verified-existing" : "verified-published",
    );

    if (wrapperState !== null) {
      verifyExistingNpmPackage(wrapperState, "wrapper", version, wrapperTarball);
    }
    if (!wrapperExists) {
      publishNpm("wrapper", version, distTag);
      recordOperation(ledger, "npm-wrapper", "published-verification-pending");
      verifyExistingNpmPackage(
        await waitForNpmPackage(wrapperPackage),
        "wrapper",
        version,
        wrapperTarball,
      );
    }
    recordOperation(
      ledger,
      "npm-wrapper",
      wrapperExists ? "verified-existing" : "verified-published",
    );

    if (!await jsrPackageExists(jsrPackage)) {
      installExactJsrNative(
        run,
        path.join(workspaceRoot, "dist/jsr"),
        nativeTarball,
      );
      run(
        "deno",
        ["publish", "--dry-run", "--allow-dirty", "--no-check"],
        path.join(workspaceRoot, "dist/jsr"),
      );
      run("deno", ["publish", "--no-check"], path.join(workspaceRoot, "dist/jsr"));
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
    ledger.error = {
      name: error?.name ?? null,
      message: error?.message ?? String(error),
    };
    writeLedger(ledger);
    throw error;
  }

  return {
    name: "watchbound",
    url: `https://www.npmjs.com/package/watchbound/v/${version}`,
  };
}

function publishNpm(kind, version, distTag) {
  run("npm", [
    "publish",
    tarballPath(kind, version),
    "--access",
    "public",
    "--provenance",
    "--tag",
    distTag,
  ]);
}

function installCanonicalNative() {
  const canonicalPath = process.env.WATCHBOUND_CANONICAL_NATIVE_PATH;
  const expectedSha256 = process.env.WATCHBOUND_EXPECTED_NATIVE_SHA256;
  if (!canonicalPath || !expectedSha256) {
    throw new Error(
      "stable release requires WATCHBOUND_CANONICAL_NATIVE_PATH and WATCHBOUND_EXPECTED_NATIVE_SHA256",
    );
  }
  const resolvedCanonical = path.resolve(canonicalPath);
  const nativePath = path.join(
    workspaceRoot,
    "node",
    "watchbound.linux-x64-gnu.node",
  );
  if (sha256(resolvedCanonical) !== expectedSha256) {
    throw new Error("canonical independent native artifact has the wrong digest");
  }
  fs.copyFileSync(resolvedCanonical, nativePath);
  if (sha256(nativePath) !== expectedSha256) {
    throw new Error("canonical native artifact changed while installing it");
  }
}

function assertReleaseIdentity(version, committedVersion) {
  if (process.env.WATCHBOUND_PLANNED_VERSION !== version) {
    throw new Error(
      `semantic-release version ${version} differs from the planned version`,
    );
  }
  if (committedVersion !== version) {
    throw new Error(
      `semantic-release version ${version} differs from committed ${committedVersion}`,
    );
  }
}

async function npmPackageState(specifier) {
  const result = spawnSync(
    "npm",
    ["view", specifier, "--json"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return JSON.parse(result.stdout);
  if (isMissing("npm", `${result.stdout}\n${result.stderr}`)) return null;
  throw new Error(
    `could not determine whether ${specifier} exists:\n` +
      `${result.stdout}\n${result.stderr}`.trim(),
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

function verifyExistingNpmPackage(state, kind, version, tarball) {
  const expectedManifest = readJson(
    path.join("dist", "npm", kind === "node" ? "node" : "wrapper", "package.json"),
  );
  const expectedIntegrity = sha512Integrity(tarball);
  if (state.name !== expectedManifest.name || state.version !== version) {
    throw new Error(`registry identity mismatch for ${expectedManifest.name}@${version}`);
  }
  if (state.dist?.integrity !== expectedIntegrity) {
    throw new Error(
      `registry integrity mismatch for ${expectedManifest.name}@${version}`,
    );
  }
  if (
    JSON.stringify(state.dependencies ?? {}) !==
      JSON.stringify(expectedManifest.dependencies ?? {})
  ) {
    throw new Error(
      `registry dependency mismatch for ${expectedManifest.name}@${version}`,
    );
  }
}

async function waitForJsrPackage(specifier) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if (await jsrPackageExists(specifier)) return true;
    await delay(3_000);
  }
  return false;
}

export async function jsrPackageExists(
  specifier,
  fetchImplementation = globalThis.fetch,
) {
  const match =
    /^jsr:@(?<scope>[a-z0-9-]+)\/(?<packageName>[a-z0-9-]+)@(?<version>[^/]+)$/u
      .exec(specifier);
  if (!match?.groups) {
    throw new Error(`invalid exact JSR package specifier: ${specifier}`);
  }
  const { scope, packageName, version } = match.groups;
  const metadataUrl =
    `https://jsr.io/@${scope}/${packageName}/meta.json`;
  const response = await fetchImplementation(metadataUrl, {
    cache: "no-store",
    headers: {
      accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `could not determine whether ${specifier} exists: ` +
        `${metadataUrl} returned HTTP ${response.status}`,
    );
  }
  const metadata = await response.json();
  if (
    metadata?.scope !== scope ||
    metadata?.name !== packageName ||
    !metadata.versions ||
    typeof metadata.versions !== "object"
  ) {
    throw new Error(`invalid JSR package metadata for ${specifier}`);
  }
  return Object.hasOwn(metadata.versions, version);
}

function isMissing(registry, output) {
  return registry === "npm"
    ? /\bE404\b|is not in this registry|no match found/iu.test(output)
    : /\b404\b|not found|could not find|does not exist/iu.test(output);
}

function tarballPath(kind, version) {
  return path.join(
    workspaceRoot,
    "dist",
    "tarballs",
    kind === "node"
      ? `gadicc-watchbound-node-${version}.tgz`
      : `watchbound-${version}.tgz`,
  );
}

function recordOperation(ledger, operation, status) {
  ledger.operations.push({
    operation,
    status,
    at: new Date().toISOString(),
  });
  writeLedger(ledger);
}

function writeLedger(ledger) {
  const destination = path.join(
    workspaceRoot,
    "dist",
    "evidence",
    "publication-ledger.json",
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(ledger, null, 2)}\n`);
}

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8"),
  );
}

function sha256(source) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex");
}

function sha512Integrity(source) {
  return `sha512-${crypto
    .createHash("sha512")
    .update(fs.readFileSync(source))
    .digest("base64")}`;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

function run(command, args, cwd = workspaceRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}
