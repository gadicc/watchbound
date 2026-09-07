import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateQualifiedNativeStackDescriptor,
  verifyQualifiedNativeStack,
} from "../../scripts/lib/qualified-native-stack.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDescriptor = readJson(path.join(workspaceRoot, "config/qualified-native-stack.json"));
const matrix = readJson(path.join(workspaceRoot, "config/native-matrix.json"));

test("qualified native baseline verifies evidence, loader pins, target pins, and registry identity", async () => {
  const fixture = createFixture();
  try {
    const result = await verifyQualifiedNativeStack(fixture.root, fixture.implementations);
    assert.equal(result.descriptor.version, "2.1.2");
    assert.deepEqual(
      result.descriptor.targets.map(({ nativeSha256 }) => nativeSha256),
      sourceDescriptor.targets.map(({ nativeSha256 }) => nativeSha256),
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("qualified native baseline rejects missing targets", () => {
  const descriptor = structuredClone(sourceDescriptor);
  descriptor.targets.pop();
  assert.throws(
    () => validateQualifiedNativeStackDescriptor(descriptor, matrix),
    /qualified target count/u,
  );
});

test("qualified native baseline rejects unpublished packages", async () => {
  const fixture = createFixture({ packageMutation: (_name, state) =>
    state.name === "@gadicc/watchbound-node" ? null : state });
  try {
    await assert.rejects(
      verifyQualifiedNativeStack(fixture.root, fixture.implementations),
      /qualified loader .* is unpublished/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("qualified native baseline rejects mismatched loader-to-target pins", async () => {
  const fixture = createFixture({ packageMutation: (_name, state) => {
    if (state.name !== "@gadicc/watchbound-node") return state;
    return {
      ...state,
      optionalDependencies: {
        ...state.optionalDependencies,
        "@gadicc/watchbound-node-linux-x64-gnu": "9.9.9",
      },
    };
  } });
  try {
    await assert.rejects(
      verifyQualifiedNativeStack(fixture.root, fixture.implementations),
      /qualified loader target pins/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("qualified native baseline rejects registry artifacts without provenance", async () => {
  const fixture = createFixture({ packageMutation: (_name, state) => {
    if (state.name !== "@gadicc/watchbound-node-linux-x64-gnu") return state;
    return { ...state, dist: { ...state.dist, attestations: undefined } };
  } });
  try {
    await assert.rejects(
      verifyQualifiedNativeStack(fixture.root, fixture.implementations),
      /linux-x64-gnu provenance/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("qualified native baseline rejects a registry tarball digest mismatch", async () => {
  const fixture = createFixture({ tarballMutation: (tarballs) => {
    const [url] = tarballs.keys();
    tarballs.set(url, Buffer.from("mutated registry tarball"));
  } });
  try {
    await assert.rejects(
      verifyQualifiedNativeStack(fixture.root, fixture.implementations),
      /tarball SHA-256/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("qualified native baseline rejects unqualified native evidence", async () => {
  const fixture = createFixture({ evidenceMutation: (evidence) => {
    evidence.independentReproducibility.targets[0].byteIdentical = false;
  } });
  try {
    await assert.rejects(
      verifyQualifiedNativeStack(fixture.root, fixture.implementations),
      /independent byte identity/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture({ evidenceMutation, packageMutation, tarballMutation } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-qualified-stack-"));
  fs.mkdirSync(path.join(root, "config"));
  fs.copyFileSync(
    path.join(workspaceRoot, "config/native-matrix.json"),
    path.join(root, "config/native-matrix.json"),
  );
  const descriptor = structuredClone(sourceDescriptor);
  const tarballBytes = new Map();
  for (const identity of [descriptor.loader, ...descriptor.targets]) {
    const bytes = Buffer.from(`synthetic tarball for ${identity.name}\n`);
    identity.tarballSha256 = sha256(bytes);
    identity.integrity = sha512Integrity(bytes);
    tarballBytes.set(tarballUrl(identity), bytes);
  }
  const evidence = syntheticEvidence(descriptor);
  evidenceMutation?.(evidence);
  const evidenceBytes = new Map();
  for (const [name, value] of Object.entries(evidence)) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    evidenceBytes.set(descriptor.evidence[name].url, bytes);
    descriptor.evidence[name].sha256 = sha256(bytes);
  }
  tarballMutation?.(tarballBytes, descriptor);
  fs.writeFileSync(
    path.join(root, "config/qualified-native-stack.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );

  const packageStates = new Map();
  packageStates.set(descriptor.loader.name, {
    name: descriptor.loader.name,
    version: descriptor.version,
    dist: {
      integrity: descriptor.loader.integrity,
      tarball: tarballUrl(descriptor.loader),
      attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
    },
    optionalDependencies: Object.fromEntries(
      descriptor.targets.map(({ name }) => [name, descriptor.version]),
    ),
    watchbound: {
      delivery: "bundled-native-package",
      nativeMatrixSchema: matrix.schemaVersion,
      javascriptNodeMinimum: matrix.nodeMinimum,
      nodeApiMinimum: matrix.nodeApiMinimum,
    },
  });
  for (const target of descriptor.targets) {
    const matrixTarget = matrix.targets.find(({ id }) => id === target.id);
    packageStates.set(target.name, {
      name: target.name,
      version: descriptor.version,
      dist: {
        integrity: target.integrity,
        tarball: tarballUrl(target),
        attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
      },
      watchbound: {
        delivery: "target-native-package",
        target: target.id,
        targetTriple: matrixTarget.rustTarget,
        architecture: matrixTarget.architecture,
        armAbi: matrixTarget.armAbi ?? null,
        libc: matrixTarget.libc,
        binary: matrixTarget.binary,
        nodeApiMinimum: matrix.nodeApiMinimum,
        nativeSha256: target.nativeSha256,
      },
    });
  }

  return {
    root,
    implementations: {
      fetchBytes: async (url) => {
        const bytes = evidenceBytes.get(url) ?? tarballBytes.get(url);
        assert.ok(bytes, `unexpected evidence or tarball URL ${url}`);
        return bytes;
      },
      fetchJson: async () => ({
        ref: `refs/tags/${descriptor.sourceTag}`,
        object: { sha: descriptor.sourceSha },
      }),
      runState: async () => ({
        id: descriptor.qualification.runId,
        name: descriptor.qualification.workflow,
        run_attempt: descriptor.qualification.runAttempt,
        head_sha: descriptor.sourceSha,
        head_branch: "main",
        event: "push",
        path: descriptor.qualification.workflowPath,
        html_url: descriptor.qualification.url,
        status: "completed",
        conclusion: "success",
      }),
      jobState: async () => ({
        jobs: [{
          id: descriptor.qualification.verifiedJob.id,
          name: descriptor.qualification.verifiedJob.name,
          status: "completed",
          conclusion: "success",
        }],
      }),
      packageState: async (name) => {
        const state = structuredClone(packageStates.get(name));
        return packageMutation ? packageMutation(name, state) : state;
      },
    },
  };
}

function syntheticEvidence(descriptor) {
  const builders = (target) => ["builder-a", "builder-b"].map((builder) => ({
    builder,
    source: { gitHead: descriptor.sourceSha },
    release: { version: descriptor.version },
    artifact: { sha256: target.nativeSha256 },
    host: {
      distribution: descriptor.buildIdentity.distribution,
      kernel: descriptor.buildIdentity.kernel,
      architecture: target.builderArchitecture,
      glibc: descriptor.buildIdentity.glibc,
    },
    tools: {
      node: descriptor.buildIdentity.node,
      pnpm: descriptor.buildIdentity.pnpm,
      rustc: `rustc ${descriptor.buildIdentity.rustc} (synthetic)`,
      cargo: `cargo ${descriptor.buildIdentity.cargo} (synthetic)`,
      cc: `${target.cc}\nsynthetic details`,
      ld: `${descriptor.buildIdentity.ld}\nsynthetic details`,
    },
  }));
  const independentReproducibility = {
    schemaVersion: 2,
    kind: "watchbound-independent-native-matrix-comparison",
    sourceSha: descriptor.sourceSha,
    version: descriptor.version,
    targets: descriptor.targets.map((target) => ({
      target: target.id,
      sha256: target.nativeSha256,
      byteIdentical: true,
      builders: builders(target),
    })),
  };
  return {
    releaseMetadata: {
      schemaVersion: 2,
      version: descriptor.version,
      commit: descriptor.sourceSha,
      artifacts: [descriptor.loader, ...descriptor.targets].map((identity) => ({
        path: `dist/tarballs/${npmTarballName(identity.name, descriptor.version)}`,
        mediaType: "application/gzip",
        sha256: identity.tarballSha256,
      })),
      reproducibility: {
        level: "two-independent-materialized-builders-per-target",
      },
    },
    independentReproducibility,
    publicationLedger: {
      schemaVersion: 2,
      kind: "watchbound-publication-ledger",
      version: descriptor.version,
      sourceSha: descriptor.sourceSha,
      status: "completed",
      operations: [
        ...descriptor.targets.map(({ name }) => ({
          operation: `npm:${name}`,
          status: "verified-published",
        })),
        { operation: `npm:${descriptor.loader.name}`, status: "verified-published" },
        { operation: "npm:watchbound", status: "verified-published" },
        { operation: "jsr-wrapper", status: "verified-published" },
      ],
    },
  };
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha512Integrity(bytes) {
  return `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
}

function tarballUrl(identity) {
  return new URL(
    `https://registry.npmjs.org/${encodeURIComponent(identity.name)}/-/${encodeURIComponent(identity.name)}.tgz`,
  ).href;
}

function npmTarballName(name, version) {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}
