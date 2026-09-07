import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadNativeMatrix } from "./native-matrix.mjs";

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function readQualifiedNativeStack(workspaceRoot) {
  const descriptor = JSON.parse(fs.readFileSync(
    path.join(workspaceRoot, "config", "qualified-native-stack.json"),
    "utf8",
  ));
  validateQualifiedNativeStackDescriptor(descriptor, loadNativeMatrix(workspaceRoot));
  return descriptor;
}

export function validateQualifiedNativeStackDescriptor(descriptor, matrix) {
  assert.equal(descriptor?.schemaVersion, 1, "qualified native stack schema");
  assert.equal(
    descriptor?.kind,
    "watchbound-qualified-native-stack",
    "qualified native stack kind",
  );
  assert.match(descriptor.version ?? "", SEMVER_PATTERN, "qualified native stack version");
  assert.match(descriptor.sourceSha ?? "", SOURCE_SHA_PATTERN, "qualified source SHA");
  assert.equal(descriptor.sourceTag, `v${descriptor.version}`, "qualified source tag");
  assert.equal(descriptor.qualification?.workflow, "Release", "qualification workflow");
  assert.equal(
    descriptor.qualification?.workflowPath,
    ".github/workflows/release.yml",
    "qualification workflow path",
  );
  assert.ok(Number.isSafeInteger(descriptor.qualification?.runId));
  assert.ok(descriptor.qualification.runId > 0, "qualification run ID");
  assert.equal(
    descriptor.qualification?.url,
    `https://github.com/gadicc/watchbound/actions/runs/${descriptor.qualification.runId}`,
    "qualification run URL",
  );
  assert.ok(Number.isSafeInteger(descriptor.qualification?.runAttempt));
  assert.ok(descriptor.qualification.runAttempt > 0, "qualification run attempt");
  assert.ok(Number.isSafeInteger(descriptor.qualification?.verifiedJob?.id));
  assert.equal(
    descriptor.qualification?.verifiedJob?.name,
    "Stable target matrix verified",
    "qualification terminal job",
  );

  for (const [name, evidence] of Object.entries(descriptor.evidence ?? {})) {
    assert.match(evidence?.sha256 ?? "", SHA256_PATTERN, `${name} evidence digest`);
    assert.match(
      evidence?.url ?? "",
      new RegExp(`^https://github\\.com/gadicc/watchbound/releases/download/v${escapeRegExp(descriptor.version)}/`, "u"),
      `${name} evidence URL`,
    );
  }
  assert.deepEqual(
    Object.keys(descriptor.evidence ?? {}).sort(),
    ["independentReproducibility", "publicationLedger", "releaseMetadata"],
    "qualified evidence set",
  );

  assert.equal(descriptor.loader?.name, "@gadicc/watchbound-node");
  assert.match(descriptor.loader?.integrity ?? "", /^sha512-[A-Za-z0-9+/=]+$/u);
  assert.match(descriptor.loader?.tarballSha256 ?? "", SHA256_PATTERN);
  assert.equal(descriptor.targets?.length, matrix.targets.length, "qualified target count");
  for (const target of matrix.targets) {
    const qualified = descriptor.targets.find(({ id }) => id === target.id);
    assert.ok(qualified, `qualified stack omits ${target.id}`);
    assert.equal(qualified.name, target.package, `${target.id} package`);
    assert.equal(typeof qualified.builderArchitecture, "string", `${target.id} builder architecture`);
    assert.ok(qualified.builderArchitecture.length > 0, `${target.id} builder architecture`);
    assert.equal(typeof qualified.cc, "string", `${target.id} C compiler`);
    assert.ok(qualified.cc.length > 0, `${target.id} C compiler`);
    assert.match(qualified.integrity ?? "", /^sha512-[A-Za-z0-9+/=]+$/u);
    assert.match(qualified.tarballSha256 ?? "", SHA256_PATTERN);
    assert.match(qualified.nativeSha256 ?? "", SHA256_PATTERN);
  }
  assert.equal(
    new Set(descriptor.targets.map(({ id }) => id)).size,
    descriptor.targets.length,
    "qualified target IDs must be unique",
  );
  for (const field of [
    "distribution",
    "kernel",
    "glibc",
    "node",
    "pnpm",
    "rustc",
    "cargo",
    "ld",
  ]) {
    assert.equal(typeof descriptor.buildIdentity?.[field], "string", `${field} build identity`);
    assert.ok(descriptor.buildIdentity[field].length > 0, `${field} build identity`);
  }
  return descriptor;
}

export async function verifyQualifiedNativeStack(
  workspaceRoot,
  {
    fetchBytes = defaultFetchBytes,
    fetchJson = defaultFetchJson,
    jobState = defaultJobState,
    packageState = defaultPackageState,
    runState = defaultRunState,
  } = {},
) {
  const matrix = loadNativeMatrix(workspaceRoot);
  const descriptor = readQualifiedNativeStack(workspaceRoot);
  const run = await runState(descriptor.qualification.runId);
  assert.equal(run?.id, descriptor.qualification.runId, "qualification run identity");
  assert.equal(run?.name, descriptor.qualification.workflow, "qualification workflow name");
  assert.equal(run?.run_attempt, descriptor.qualification.runAttempt, "qualification run attempt");
  assert.equal(run?.head_sha, descriptor.sourceSha, "qualification run source SHA");
  assert.equal(run?.head_branch, "main", "qualification run branch");
  assert.equal(run?.event, "push", "qualification run event");
  assert.equal(run?.path, descriptor.qualification.workflowPath, "qualification workflow path");
  assert.equal(run?.html_url, descriptor.qualification.url, "qualification run URL");
  assert.equal(run?.status, "completed", "qualification run status");
  assert.equal(run?.conclusion, "success", "qualification run conclusion");
  const jobs = await jobState(descriptor.qualification.runId);
  const verifiedJob = jobs?.jobs?.find(
    ({ id }) => id === descriptor.qualification.verifiedJob.id,
  );
  assert.ok(verifiedJob, "qualification terminal job is not retained");
  assert.equal(verifiedJob.name, descriptor.qualification.verifiedJob.name);
  assert.equal(verifiedJob.status, "completed", "qualification terminal job status");
  assert.equal(verifiedJob.conclusion, "success", "qualification terminal job conclusion");

  const evidence = {};
  for (const [name, identity] of Object.entries(descriptor.evidence)) {
    const bytes = await fetchBytes(identity.url);
    assert.equal(sha256(bytes), identity.sha256, `${name} retained evidence digest`);
    evidence[name] = JSON.parse(Buffer.from(bytes).toString("utf8"));
  }
  verifyEvidence(descriptor, matrix, evidence);

  const loader = await packageState(descriptor.loader.name, descriptor.version);
  assert.ok(loader, `qualified loader ${descriptor.loader.name}@${descriptor.version} is unpublished`);
  assert.equal(loader.name, descriptor.loader.name, "qualified loader name");
  assert.equal(loader.version, descriptor.version, "qualified loader version");
  assert.equal(loader.dist?.integrity, descriptor.loader.integrity, "qualified loader integrity");
  assert.equal(
    loader.dist?.attestations?.provenance?.predicateType,
    "https://slsa.dev/provenance/v1",
    "qualified loader provenance",
  );
  assert.deepEqual(
    loader.optionalDependencies,
    Object.fromEntries(descriptor.targets.map(({ name }) => [name, descriptor.version])),
    "qualified loader target pins",
  );
  assert.deepEqual(loader.watchbound, {
    delivery: "bundled-native-package",
    nativeMatrixSchema: matrix.schemaVersion,
    javascriptNodeMinimum: matrix.nodeMinimum,
    nodeApiMinimum: matrix.nodeApiMinimum,
  }, "qualified loader delivery metadata");
  await verifyRegistryTarball(descriptor.loader, loader, fetchBytes);

  for (const qualified of descriptor.targets) {
    const target = matrix.targets.find(({ id }) => id === qualified.id);
    const state = await packageState(qualified.name, descriptor.version);
    assert.ok(state, `qualified target ${qualified.name}@${descriptor.version} is unpublished`);
    assert.equal(state.name, qualified.name, `${qualified.id} registry name`);
    assert.equal(state.version, descriptor.version, `${qualified.id} registry version`);
    assert.equal(state.dist?.integrity, qualified.integrity, `${qualified.id} registry integrity`);
    assert.equal(
      state.dist?.attestations?.provenance?.predicateType,
      "https://slsa.dev/provenance/v1",
      `${qualified.id} provenance`,
    );
    assert.deepEqual(state.watchbound, {
      delivery: "target-native-package",
      target: target.id,
      targetTriple: target.rustTarget,
      architecture: target.architecture,
      armAbi: target.armAbi ?? null,
      libc: target.libc,
      binary: target.binary,
      nodeApiMinimum: matrix.nodeApiMinimum,
      nativeSha256: qualified.nativeSha256,
    }, `${qualified.id} delivery metadata`);
    await verifyRegistryTarball(qualified, state, fetchBytes);
  }

  // Read the immutable release tag through GitHub as a final independent identity check.
  const tag = await fetchJson(
    `https://api.github.com/repos/gadicc/watchbound/git/ref/tags/${descriptor.sourceTag}`,
  );
  assert.equal(tag?.ref, `refs/tags/${descriptor.sourceTag}`, "qualified release tag");
  assert.equal(tag?.object?.sha, descriptor.sourceSha, "qualified release tag source");
  return Object.freeze({ descriptor, evidence, run, verifiedJob, tag });
}

function verifyEvidence(descriptor, matrix, evidence) {
  const metadata = evidence.releaseMetadata;
  assert.equal(metadata?.schemaVersion, 2, "release metadata schema");
  assert.equal(metadata?.version, descriptor.version, "release metadata version");
  assert.equal(metadata?.commit, descriptor.sourceSha, "release metadata source");
  if (Object.hasOwn(metadata ?? {}, "releaseClass")) {
    assert.equal(metadata.releaseClass, "native", "qualified release class");
    assert.equal(metadata.wrapperVersion, descriptor.version, "qualified wrapper version");
    assert.equal(metadata.nativeStackVersion, descriptor.version, "qualified native version");
  }
  assert.equal(
    metadata?.reproducibility?.level,
    "two-independent-materialized-builders-per-target",
    "native reproducibility qualification",
  );
  for (const published of [descriptor.loader, ...descriptor.targets]) {
    const filename = npmTarballName(published.name, descriptor.version);
    const artifact = metadata?.artifacts?.find(({ path: artifactPath }) =>
      path.basename(artifactPath) === filename);
    assert.ok(artifact, `release metadata omits ${filename}`);
    assert.equal(artifact.mediaType, "application/gzip", `${filename} media type`);
    assert.equal(artifact.sha256, published.tarballSha256, `${filename} SHA-256`);
  }

  const reproducibility = evidence.independentReproducibility;
  assert.equal(reproducibility?.schemaVersion, 2, "reproducibility schema");
  assert.equal(
    reproducibility?.kind,
    "watchbound-independent-native-matrix-comparison",
    "reproducibility kind",
  );
  assert.equal(reproducibility?.version, descriptor.version, "reproducibility version");
  assert.equal(reproducibility?.sourceSha, descriptor.sourceSha, "reproducibility source");
  for (const target of matrix.targets) {
    const qualified = descriptor.targets.find(({ id }) => id === target.id);
    const compared = reproducibility.targets?.find(({ target: id }) => id === target.id);
    assert.ok(compared, `reproducibility evidence omits ${target.id}`);
    assert.equal(compared.sha256, qualified.nativeSha256, `${target.id} native digest`);
    assert.equal(compared.byteIdentical, true, `${target.id} independent byte identity`);
    assert.equal(compared.builders?.length, 2, `${target.id} independent builder count`);
    for (const builder of compared.builders) {
      assert.equal(builder.source?.gitHead, descriptor.sourceSha);
      assert.equal(builder.release?.version, descriptor.version);
      assert.equal(builder.artifact?.sha256, qualified.nativeSha256);
      assert.equal(builder.host?.distribution, descriptor.buildIdentity.distribution);
      assert.equal(builder.host?.kernel, descriptor.buildIdentity.kernel);
      assert.equal(builder.host?.architecture, qualified.builderArchitecture);
      assert.equal(builder.host?.glibc, descriptor.buildIdentity.glibc);
      assert.equal(builder.tools?.node, descriptor.buildIdentity.node);
      assert.equal(builder.tools?.pnpm, descriptor.buildIdentity.pnpm);
      assert.match(builder.tools?.rustc ?? "", new RegExp(`^rustc ${escapeRegExp(descriptor.buildIdentity.rustc)}\\b`, "u"));
      assert.match(builder.tools?.cargo ?? "", new RegExp(`^cargo ${escapeRegExp(descriptor.buildIdentity.cargo)}\\b`, "u"));
      assert.match(builder.tools?.cc ?? "", new RegExp(`^${escapeRegExp(qualified.cc)}\\b`, "u"));
      assert.match(builder.tools?.ld ?? "", new RegExp(`^${escapeRegExp(descriptor.buildIdentity.ld)}\\b`, "u"));
    }
  }

  const ledger = evidence.publicationLedger;
  assert.equal(ledger?.schemaVersion, 2, "publication ledger schema");
  assert.equal(ledger?.kind, "watchbound-publication-ledger", "publication ledger kind");
  assert.equal(ledger?.version, descriptor.version, "publication ledger version");
  assert.equal(ledger?.sourceSha, descriptor.sourceSha, "publication ledger source");
  assert.equal(ledger?.status, "completed", "publication ledger completion");
  if (Object.hasOwn(ledger ?? {}, "releaseClass")) {
    assert.equal(ledger.releaseClass, "native", "qualified ledger release class");
    assert.equal(ledger.wrapperVersion, descriptor.version, "qualified ledger wrapper version");
    assert.equal(ledger.nativeStackVersion, descriptor.version, "qualified ledger native version");
  }
  const completed = new Set(
    (ledger.operations ?? [])
      .filter(({ status }) => status === "verified-published" || status === "verified-existing")
      .map(({ operation }) => operation),
  );
  for (const name of [
    ...descriptor.targets.map(({ name }) => `npm:${name}`),
    `npm:${descriptor.loader.name}`,
    "npm:watchbound",
    "jsr-wrapper",
  ]) {
    assert.ok(completed.has(name), `publication ledger did not verify ${name}`);
  }
}

async function defaultPackageState(name, version) {
  const encodedName = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1).split("/")[0])}%2F${encodeURIComponent(name.split("/")[1])}`
    : encodeURIComponent(name);
  try {
    return await defaultFetchJson(
      `https://registry.npmjs.org/${encodedName}/${encodeURIComponent(version)}`,
    );
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function defaultRunState(runId) {
  return defaultFetchJson(
    `https://api.github.com/repos/gadicc/watchbound/actions/runs/${runId}`,
  );
}

async function verifyRegistryTarball(identity, state, fetchBytes) {
  const tarballUrl = new URL(state.dist?.tarball ?? "https://invalid.invalid/");
  assert.equal(tarballUrl.protocol, "https:", `${identity.name} tarball protocol`);
  assert.equal(tarballUrl.hostname, "registry.npmjs.org", `${identity.name} tarball host`);
  const bytes = await fetchBytes(tarballUrl.href);
  assert.equal(sha256(bytes), identity.tarballSha256, `${identity.name} tarball SHA-256`);
  assert.equal(
    `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`,
    identity.integrity,
    `${identity.name} tarball integrity`,
  );
}

function defaultJobState(runId) {
  return defaultFetchJson(
    `https://api.github.com/repos/gadicc/watchbound/actions/runs/${runId}/jobs?filter=all&per_page=100`,
  );
}

async function defaultFetchJson(url) {
  const bytes = await defaultFetchBytes(url);
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

async function defaultFetchBytes(url) {
  const parsedUrl = new URL(url);
  const githubToken = process.env.GITHUB_TOKEN;
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      accept: "application/vnd.github+json, application/json",
      "user-agent": "watchbound-release-verifier",
      ...(githubToken && parsedUrl.hostname === "api.github.com"
        ? { authorization: `Bearer ${githubToken}` }
        : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const error = new Error(`${url} returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return new Uint8Array(await response.arrayBuffer());
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function npmTarballName(name, version) {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
