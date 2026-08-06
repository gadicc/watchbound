import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeMatrix } from "./lib/native-matrix.mjs";

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
const version = rootManifest.version;

assert(
  wrapperSourceManifest.version === version &&
    nativeSourceManifest.version === version,
  "workspace package versions must move in lockstep",
);
assert(
  wrapperSourceManifest.dependencies?.["@gadicc/watchbound-node"] ===
    `workspace:${version}`,
  "wrapper workspace dependency must match the release version",
);
for (const manifest of [wrapperSourceManifest, nativeSourceManifest]) {
  assert(
    manifest.watchbound?.delivery === "controlled-source-build",
    "workspace packages must identify controlled source-build delivery",
  );
}
assert(
  fs.readFileSync(path.join(workspaceRoot, "Cargo.toml"), "utf8")
    .includes(`version = "${version}"`),
  "Cargo workspace version must match the release version",
);
const cargoLock = fs.readFileSync(path.join(workspaceRoot, "Cargo.lock"), "utf8");
for (const crate of ["watchbound-engine", "watchbound-node"]) {
  assert(
    cargoLock.includes(`name = "${crate}"\nversion = "${version}"`),
    `${crate} lockfile version must match the release version`,
  );
}

const artifactRoot = process.env.WATCHBOUND_NATIVE_ARTIFACTS_DIR
  ? path.resolve(process.env.WATCHBOUND_NATIVE_ARTIFACTS_DIR)
  : path.join(workspaceRoot, "node");
const availableTargets = matrix.targets
  .map((target) => ({
    target,
    artifactPath: path.join(artifactRoot, target.binary),
  }))
  .filter(({ artifactPath }) => fs.existsSync(artifactPath));
assert(availableTargets.length > 0, "build at least one configured native artifact");
if (process.env.WATCHBOUND_REQUIRE_ALL_TARGETS === "1") {
  assert(
    availableTargets.length === matrix.targets.length,
    "release preparation requires every configured native target",
  );
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(npmRoot, { recursive: true });

const commonMetadata = {
  version,
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
    matrix.targets.map((target) => [target.package, version]),
  ),
  watchbound: {
    delivery: "bundled-native-package",
    nativeMatrixSchema: matrix.schemaVersion,
  },
};

const wrapperManifest = {
  name: "watchbound",
  ...commonMetadata,
  description: "Conservative, resource-aware recursive directory watching for Linux",
  keywords: ["filesystem", "inotify", "linux", "recursive", "watcher"],
  type: "module",
  main: "./index.js",
  types: "./index.d.ts",
  exports: wrapperSourceManifest.exports,
  files: ["*.js", "*.d.ts", "README.md", "LICENSE.txt"],
  dependencies: {
    "@gadicc/watchbound-node": version,
  },
  watchbound: {
    delivery: "bundled-native-package",
  },
};

const nativeRoot = path.join(npmRoot, "node");
const wrapperRoot = path.join(npmRoot, "wrapper");
const targetsRoot = path.join(npmRoot, "targets");
fs.mkdirSync(nativeRoot, { recursive: true });
fs.mkdirSync(wrapperRoot, { recursive: true });
fs.mkdirSync(targetsRoot, { recursive: true });

for (const file of ["index.js", "index.d.ts", "load-native.cjs"]) {
  copy(path.join("node", file), path.join(nativeRoot, file));
}
copy("config/native-matrix.json", path.join(nativeRoot, "native-matrix.json"));
for (const file of runtimeWrapperFiles()) {
  copy(path.join("js", file), path.join(wrapperRoot, file));
}
for (const destination of [nativeRoot, wrapperRoot]) {
  copy("README.md", path.join(destination, "README.md"));
  copy("LICENSE.txt", path.join(destination, "LICENSE.txt"));
}
writeJson(path.join(nativeRoot, "package.json"), nativeManifest);
writeJson(path.join(wrapperRoot, "package.json"), wrapperManifest);

const targetPackages = [];
for (const { target, artifactPath } of availableTargets) {
  const targetRoot = path.join(targetsRoot, target.id);
  fs.mkdirSync(targetRoot, { recursive: true });
  const nativeSha256 = sha256(artifactPath);
  const targetManifest = {
    name: target.package,
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
  version,
  exports: { ".": "./index.js" },
  publish: {
    include: ["*.js", "*.d.ts", "package.json", "README.md", "LICENSE.txt"],
  },
});
writeJson(path.join(outputRoot, "native-package-manifest.json"), {
  schemaVersion: 1,
  version,
  loader: {
    name: nativeManifest.name,
    root: path.relative(outputRoot, nativeRoot),
  },
  wrapper: {
    name: wrapperManifest.name,
    root: path.relative(outputRoot, wrapperRoot),
  },
  targets: targetPackages,
});

process.stdout.write(
  `Prepared Watchbound ${version} packages for ${targetPackages.map(({ id }) => id).join(", ")}\n`,
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
