import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputRoot = path.join(workspaceRoot, "dist");
const npmRoot = path.join(outputRoot, "npm");
const jsrRoot = path.join(outputRoot, "jsr");
const nativeBasename = "watchbound.linux-x64-gnu.node";

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
const cargoLock = fs.readFileSync(
  path.join(workspaceRoot, "Cargo.lock"),
  "utf8",
);
for (const crate of ["watchbound-engine", "watchbound-node"]) {
  assert(
    cargoLock.includes(`name = "${crate}"\nversion = "${version}"`),
    `${crate} lockfile version must match the release version`,
  );
}
assert(
  fs.existsSync(path.join(workspaceRoot, "node", nativeBasename)),
  `build ${nativeBasename} before preparing packages`,
);

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
    node: ">=24.15.0 <25",
  },
  os: ["linux"],
  cpu: ["x64"],
  libc: ["glibc"],
  publishConfig: {
    access: "public",
    provenance: true,
  },
};

const nativeManifest = {
  name: "@gadicc/watchbound-node",
  ...commonMetadata,
  description: "Linux x64/glibc Node-API binding for Watchbound",
  keywords: [
    "filesystem",
    "inotify",
    "linux",
    "napi",
    "watcher",
  ],
  main: "./index.js",
  types: "./index.d.ts",
  exports: nativeSourceManifest.exports,
  files: [
    "index.js",
    "index.d.ts",
    "load-native.cjs",
    nativeBasename,
    "README.md",
    "LICENSE.txt",
  ],
  watchbound: {
    delivery: "bundled-native-package",
  },
};

const wrapperManifest = {
  name: "watchbound",
  ...commonMetadata,
  description:
    "Conservative, resource-aware recursive directory watching for Linux",
  keywords: [
    "filesystem",
    "inotify",
    "linux",
    "recursive",
    "watcher",
  ],
  type: "module",
  main: "./index.js",
  types: "./index.d.ts",
  exports: wrapperSourceManifest.exports,
  files: [
    "*.js",
    "*.d.ts",
    "README.md",
    "LICENSE.txt",
  ],
  dependencies: {
    "@gadicc/watchbound-node": version,
  },
  watchbound: {
    delivery: "bundled-native-package",
  },
};

const nativeRoot = path.join(npmRoot, "node");
const wrapperRoot = path.join(npmRoot, "wrapper");
fs.mkdirSync(nativeRoot, { recursive: true });
fs.mkdirSync(wrapperRoot, { recursive: true });

for (const file of ["index.js", "index.d.ts", "load-native.cjs", nativeBasename]) {
  copy(path.join("node", file), path.join(nativeRoot, file));
}
for (const file of runtimeWrapperFiles()) {
  copy(path.join("js", file), path.join(wrapperRoot, file));
}
for (const destination of [nativeRoot, wrapperRoot]) {
  copy("README.md", path.join(destination, "README.md"));
  copy("LICENSE.txt", path.join(destination, "LICENSE.txt"));
}
writeJson(path.join(nativeRoot, "package.json"), nativeManifest);
writeJson(path.join(wrapperRoot, "package.json"), wrapperManifest);

fs.cpSync(wrapperRoot, jsrRoot, { recursive: true });
writeJson(path.join(jsrRoot, "package.json"), {
  ...wrapperManifest,
  name: "@gadicc/watchbound",
});
writeJson(path.join(jsrRoot, "jsr.json"), {
  name: "@gadicc/watchbound",
  version,
  exports: {
    ".": "./index.js",
  },
  publish: {
    include: [
      "*.js",
      "*.d.ts",
      "package.json",
      "README.md",
      "LICENSE.txt",
    ],
  },
});

process.stdout.write(
  `Prepared npm and JSR package trees for Watchbound ${version}\n`,
);

function runtimeWrapperFiles() {
  return fs.readdirSync(path.join(workspaceRoot, "js"))
    .filter((file) => /\.(?:js|d\.ts)$/u.test(file))
    .sort();
}

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8"),
  );
}

function writeJson(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function copy(source, destination) {
  fs.copyFileSync(path.join(workspaceRoot, source), destination);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Package preparation: ${message}`);
}
