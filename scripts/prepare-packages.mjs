import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeMatrix } from "./lib/native-matrix.mjs";
import { createReleasePackagePlan } from "./lib/release-package-plan.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputRoot = path.join(workspaceRoot, "dist");
const npmRoot = path.join(outputRoot, "npm");
const jsrRoot = path.join(outputRoot, "jsr");
const matrix = loadNativeMatrix(workspaceRoot);

const rootManifest = readJson("package.json");
const wrapperSourceManifest = readJson("js/package.json");
const nativeSourceManifest = readJson("node/package.json");
const wrapperVersion = rootManifest.version;
const releaseClass = process.env.WATCHBOUND_RELEASE_CLASS ?? "native";
const nativeStackVersion = process.env.WATCHBOUND_NATIVE_STACK_VERSION ??
  (releaseClass === "native" ? wrapperVersion : null);

assert(
  releaseClass === "native" || releaseClass === "wrapper",
  "release class must be native or wrapper",
);
assert(
  typeof nativeStackVersion === "string" &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(nativeStackVersion),
  "native stack version must be exact semver",
);
assert(wrapperSourceManifest.version === wrapperVersion, "wrapper version must match root");
if (releaseClass === "native") {
  assert(nativeStackVersion === wrapperVersion, "native releases must move in lockstep");
  assert(nativeSourceManifest.version === nativeStackVersion, "loader version must match");
  assert(
    wrapperSourceManifest.dependencies?.["@gadicc/watchbound-node"] ===
      `workspace:${nativeStackVersion}`,
    "native release workspace dependency must match the native stack",
  );
} else {
  assert(
    wrapperSourceManifest.dependencies?.["@gadicc/watchbound-node"] === nativeStackVersion,
    "wrapper release source dependency must exact-pin the qualified native stack",
  );
}
for (const manifest of [wrapperSourceManifest, nativeSourceManifest]) {
  assert(
    manifest.watchbound?.delivery === "controlled-source-build",
    "workspace packages must identify controlled source-build delivery",
  );
}
if (releaseClass === "native") {
  assert(
    fs.readFileSync(path.join(workspaceRoot, "Cargo.toml"), "utf8")
      .includes(`version = "${nativeStackVersion}"`),
    "Cargo workspace version must match the native stack",
  );
  const cargoLock = fs.readFileSync(path.join(workspaceRoot, "Cargo.lock"), "utf8");
  for (const crate of ["watchbound-engine", "watchbound-node"]) {
    assert(
      cargoLock.includes(`name = "${crate}"\nversion = "${nativeStackVersion}"`),
      `${crate} lockfile version must match the native stack`,
    );
  }
}

const artifactRoot = process.env.WATCHBOUND_NATIVE_ARTIFACTS_DIR
  ? path.resolve(process.env.WATCHBOUND_NATIVE_ARTIFACTS_DIR)
  : path.join(workspaceRoot, "node");
const availableTargets = releaseClass === "native" ? matrix.targets
  .map((target) => ({
    target,
    artifactPath: path.join(artifactRoot, target.binary),
  }))
  .filter(({ artifactPath }) => fs.existsSync(artifactPath)) : [];
if (releaseClass === "native") {
  assert(availableTargets.length > 0, "build at least one configured native artifact");
}
if (releaseClass === "native" && process.env.WATCHBOUND_REQUIRE_ALL_TARGETS === "1") {
  assert(
    availableTargets.length === matrix.targets.length,
    "release preparation requires every configured native target",
  );
}
const packagePlan = createReleasePackagePlan({
  releaseClass,
  wrapperVersion,
  nativeStackVersion,
  targets: matrix.targets,
});

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(npmRoot, { recursive: true });

const commonMetadata = {
  author: "Gadi Cohen <dragon@wastelands.net>",
  homepage: "https://github.com/gadicc/watchbound#readme",
  repository: {
    type: "git",
    url: "git+https://github.com/gadicc/watchbound.git",
  },
  bugs: {
    url: "https://github.com/gadicc/watchbound/issues",
  },
  license: "MIT",
  engines: {
    node: matrix.nodeRange,
  },
  os: ["linux"],
  publishConfig: {
    access: "public",
    provenance: true,
  },
};

const nativeManifest = {
  name: "@gadicc/watchbound-node",
  version: nativeStackVersion,
  ...commonMetadata,
  description: "Architecture-neutral native loader for Watchbound",
  keywords: ["filesystem", "inotify", "linux", "napi", "watcher"],
  main: "./index.js",
  types: "./index.d.ts",
  exports: nativeSourceManifest.exports,
  files: [
    "index.js",
    "index.d.ts",
    "load-native.cjs",
    "native-matrix.json",
    "README.md",
    "LICENSE.txt",
  ],
  optionalDependencies: Object.fromEntries(
    Object.entries(packagePlan.loader?.optionalDependencies ?? {}),
  ),
  watchbound: {
    delivery: "bundled-native-package",
    nativeMatrixSchema: matrix.schemaVersion,
    javascriptNodeMinimum: matrix.nodeMinimum,
    nodeApiMinimum: matrix.nodeApiMinimum,
  },
};

const wrapperManifest = {
  name: "watchbound",
  version: wrapperVersion,
  ...commonMetadata,
  description: wrapperSourceManifest.description,
  keywords: wrapperSourceManifest.keywords,
  type: "module",
  main: "./index.js",
  types: "./index.d.ts",
  exports: wrapperSourceManifest.exports,
  files: ["*.js", "*.d.ts", "README.md", "LICENSE.txt"],
  dependencies: {
    ...packagePlan.wrapper.dependencies,
  },
  watchbound: {
    delivery: "bundled-native-package",
    javascriptNodeMinimum: matrix.nodeMinimum,
  },
};

const nativeRoot = path.join(npmRoot, "node");
const wrapperRoot = path.join(npmRoot, "wrapper");
const targetsRoot = path.join(npmRoot, "targets");
fs.mkdirSync(wrapperRoot, { recursive: true });
if (releaseClass === "native") {
  fs.mkdirSync(nativeRoot, { recursive: true });
  fs.mkdirSync(targetsRoot, { recursive: true });
}

if (releaseClass === "native") {
  for (const file of ["index.js", "index.d.ts", "load-native.cjs"]) {
    copy(path.join("node", file), path.join(nativeRoot, file));
  }
  copy("config/native-matrix.json", path.join(nativeRoot, "native-matrix.json"));
}
for (const file of runtimeWrapperFiles()) {
  copy(path.join("js", file), path.join(wrapperRoot, file));
}
for (const destination of releaseClass === "native"
  ? [nativeRoot, wrapperRoot]
  : [wrapperRoot]) {
  copy("README.md", path.join(destination, "README.md"));
  copy("LICENSE.txt", path.join(destination, "LICENSE.txt"));
}
if (releaseClass === "native") {
  writeJson(path.join(nativeRoot, "package.json"), nativeManifest);
}
writeJson(path.join(wrapperRoot, "package.json"), wrapperManifest);

const targetPackages = [];
for (const { target, artifactPath } of availableTargets) {
  const targetRoot = path.join(targetsRoot, target.id);
  fs.mkdirSync(targetRoot, { recursive: true });
  const nativeSha256 = sha256(artifactPath);
  const targetManifest = {
    name: target.package,
    version: nativeStackVersion,
    ...commonMetadata,
    description: `${target.rustTarget} Node-API binding for Watchbound`,
    cpu: [target.architecture],
    libc: [target.libc],
    main: `./${target.binary}`,
    exports: {
      ".": `./${target.binary}`,
      "./package.json": "./package.json",
    },
    files: [target.binary, "README.md", "LICENSE.txt"],
    watchbound: {
      delivery: "target-native-package",
      target: target.id,
      targetTriple: target.rustTarget,
      architecture: target.architecture,
      armAbi: target.armAbi ?? null,
      libc: target.libc,
      binary: target.binary,
      nodeApiMinimum: matrix.nodeApiMinimum,
      nativeSha256,
    },
  };
  fs.copyFileSync(artifactPath, path.join(targetRoot, target.binary));
  copy("README.md", path.join(targetRoot, "README.md"));
  copy("LICENSE.txt", path.join(targetRoot, "LICENSE.txt"));
  writeJson(path.join(targetRoot, "package.json"), targetManifest);
  targetPackages.push({
    id: target.id,
    name: target.package,
    version: nativeStackVersion,
    root: path.relative(outputRoot, targetRoot),
    binary: target.binary,
    sha256: nativeSha256,
  });
}

fs.cpSync(wrapperRoot, jsrRoot, { recursive: true });
writeJson(path.join(jsrRoot, "package.json"), {
  ...wrapperManifest,
  name: "@gadicc/watchbound",
});
writeJson(path.join(jsrRoot, "jsr.json"), {
  name: "@gadicc/watchbound",
  version: wrapperVersion,
  exports: { ".": "./index.js" },
  publish: {
    include: ["*.js", "*.d.ts", "package.json", "README.md", "LICENSE.txt"],
  },
});
writeJson(path.join(outputRoot, "native-package-manifest.json"), {
  schemaVersion: 2,
  releaseClass,
  version: wrapperVersion,
  wrapperVersion,
  nativeStackVersion,
  loader: releaseClass === "native" ? {
    name: nativeManifest.name,
    version: nativeStackVersion,
    root: path.relative(outputRoot, nativeRoot),
  } : null,
  wrapper: {
    name: wrapperManifest.name,
    version: wrapperVersion,
    root: path.relative(outputRoot, wrapperRoot),
  },
  targets: targetPackages,
});

process.stdout.write(
  `Prepared Watchbound ${releaseClass} packages wrapper=${wrapperVersion} native=${nativeStackVersion}${targetPackages.length > 0 ? ` for ${targetPackages.map(({ id }) => id).join(", ")}` : ""}\n`,
);

function runtimeWrapperFiles() {
  return fs.readdirSync(path.join(workspaceRoot, "js"))
    .filter((file) => /\.(?:js|d\.ts)$/u.test(file))
    .sort();
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8"));
}

function writeJson(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function copy(source, destination) {
  fs.copyFileSync(path.join(workspaceRoot, source), destination);
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(`Package preparation: ${message}`);
}
