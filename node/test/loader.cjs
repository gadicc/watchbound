"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  WatchboundLoaderError,
  WatchboundLoaderErrorCode,
  assertWrapperVersion,
  detectLibc,
  loadNative,
} = require("../load-native.cjs");

const nodeRoot = path.resolve(__dirname, "..");
const packageManifest = require("../package.json");
const packageVersion = packageManifest.version;
const packageDelivery = packageManifest.watchbound.delivery;
const privateDirectory = "/private/watchbound/node";
const nativeBasename = "watchbound.linux-x64-gnu.node";
const nativePath = path.join(privateDirectory, nativeBasename);
const nativeMatrix = require("../../config/native-matrix.json");
const x64Target = nativeMatrix.targets.find((target) => target.architecture === "x64");
const arm64Target = nativeMatrix.targets.find((target) => target.architecture === "arm64");
const armv7Target = nativeMatrix.targets.find((target) => target.architecture === "arm");

const validMetadata = Object.freeze({
  schemaVersion: 1,
  bindingApiVersion: 5,
  nativeVersion: packageVersion,
  engineVersion: packageVersion,
  nodeApiVersion: 6,
  targetTriple: "x86_64-unknown-linux-gnu",
  buildProfile: "release",
});

function glibcReport() {
  return {
    getReport: () => ({
      header: { glibcVersionRuntime: "2.39" },
      sharedObjects: ["/lib64/ld-linux-x86-64.so.2"],
    }),
  };
}

function validBinding(metadata = validMetadata) {
  return {
    bindingMetadata: () => metadata,
    marker: "native-binding",
  };
}

function elfFor(target) {
  const contents = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(contents);
  contents[4] = target.elf.class;
  contents[5] = target.elf.endianness;
  contents.writeUInt16LE(target.elf.machine, 18);
  contents.writeUInt32LE(target.elf.flags, target.elf.class === 1 ? 36 : 48);
  return contents;
}

function loadOptions(overrides = {}) {
  return {
    platform: "linux",
    arch: "x64",
    nodeVersion: "24.15.0",
    napiVersion: "9",
    report: glibcReport(),
    processConfig: { variables: {} },
    endianness: "LE",
    matrix: nativeMatrix,
    directory: privateDirectory,
    packageVersion,
    packageDelivery: "controlled-source-build",
    existsSync: () => true,
    readdirSync: () => [nativeBasename],
    lstatSync: () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: elfFor(x64Target).length,
    }),
    readFileSync: () => elfFor(x64Target),
    requireNative: () => validBinding(),
    ...overrides,
  };
}

function expectLoaderError(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof WatchboundLoaderError);
    assert.equal(error.name, "WatchboundLoaderError");
    assert.equal(error.code, code);
    assert.ok(Buffer.byteLength(error.message, "utf8") <= 1_024);
    return true;
  });
}

test("loader accepts only configured Linux architectures", () => {
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["win32", "x64"],
    ["linux", "ia32"],
  ]) {
    let filesystemCalls = 0;
    expectLoaderError(
      () => loadNative(loadOptions({
        platform,
        arch,
        existsSync: () => {
          filesystemCalls += 1;
          return true;
        },
      })),
      WatchboundLoaderErrorCode.UNSUPPORTED_PLATFORM,
    );
    assert.equal(filesystemCalls, 0);
  }

  const armBinding = loadNative(loadOptions({
    arch: "arm64",
    readdirSync: () => [arm64Target.binary],
    lstatSync: () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: elfFor(arm64Target).length,
    }),
    readFileSync: () => elfFor(arm64Target),
    requireNative: () => validBinding({
      ...validMetadata,
      targetTriple: arm64Target.rustTarget,
    }),
  }));
  assert.equal(armBinding.marker, "native-binding");
  assert.equal(armBinding.nativeDeliveryMetadata().architecture, "arm64");
});

test("loader selects only a little-endian ARMv7 hard-float runtime", () => {
  assert.ok(armv7Target, "native matrix must configure ARMv7 hard-float");
  const contents = elfFor(armv7Target);
  const binding = loadNative(loadOptions({
    arch: "arm",
    processConfig: {
      variables: { arm_version: 7, arm_float_abi: "hard" },
    },
    readdirSync: () => [armv7Target.binary],
    lstatSync: () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: contents.length,
    }),
    readFileSync: () => contents,
    requireNative: () => validBinding({
      ...validMetadata,
      targetTriple: armv7Target.rustTarget,
    }),
  }));
  assert.equal(binding.marker, "native-binding");
  assert.deepEqual(binding.nativeDeliveryMetadata().armAbi, {
    version: 7,
    floatAbi: "hard",
    endianness: "little",
  });
  assert.deepEqual(binding.nativeDeliveryMetadata().runtimeArmAbi, {
    version: 7,
    floatAbi: "hard",
    endianness: "little",
  });
});

test("loader attests Electron-shaped ARM runtimes from the running ELF", () => {
  assert.ok(armv7Target, "native matrix must configure ARMv7 hard-float");
  const contents = elfFor(armv7Target);
  const binding = loadNative(loadOptions({
    arch: "arm",
    processConfig: { variables: {} },
    machine: "armv7l",
    readRuntimeElfHeader: () => contents,
    readdirSync: () => [armv7Target.binary],
    lstatSync: () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: contents.length,
    }),
    readFileSync: () => contents,
    requireNative: () => validBinding({
      ...validMetadata,
      targetTriple: armv7Target.rustTarget,
    }),
  }));
  assert.deepEqual(binding.nativeDeliveryMetadata().runtimeArmAbi, armv7Target.armAbi);
});

test("loader fails closed for unsupported or unknown 32-bit ARM ABIs", () => {
  assert.ok(armv7Target, "native matrix must configure ARMv7 hard-float");
  for (const runtime of [
    { variables: { arm_version: 6, arm_float_abi: "hard" }, endianness: "LE" },
    { variables: { arm_version: 7, arm_float_abi: "softfp" }, endianness: "LE" },
    { variables: { arm_version: 7, arm_float_abi: "hard" }, endianness: "BE" },
    { variables: {}, endianness: "LE" },
  ]) {
    let filesystemCalls = 0;
    assert.throws(
      () => loadNative(loadOptions({
        arch: "arm",
        processConfig: { variables: runtime.variables },
        endianness: runtime.endianness,
        existsSync: () => {
          filesystemCalls += 1;
          return true;
        },
      })),
      (error) => {
        assert.ok(error instanceof WatchboundLoaderError);
        assert.equal(error.code, WatchboundLoaderErrorCode.UNSUPPORTED_PLATFORM);
        assert.match(error.message, /ARMv7 hard-float little-endian/u);
        return true;
      },
    );
    assert.equal(filesystemCalls, 0);
  }
});

test("loader fallback rejects old machines, soft-float ELFs, and partial config", () => {
  assert.ok(armv7Target, "native matrix must configure ARMv7 hard-float");
  const hardFloat = elfFor(armv7Target);
  const softFloat = Buffer.from(hardFloat);
  softFloat.writeUInt32LE(0x05000200, 36);
  for (const runtime of [
    { variables: {}, machine: "armv6l", header: hardFloat },
    { variables: {}, machine: "armv7l", header: softFloat },
    {
      variables: { arm_version: 7 },
      machine: "armv7l",
      header: hardFloat,
    },
  ]) {
    expectLoaderError(
      () => loadNative(loadOptions({
        arch: "arm",
        processConfig: { variables: runtime.variables },
        machine: runtime.machine,
        readRuntimeElfHeader: () => runtime.header,
      })),
      WatchboundLoaderErrorCode.UNSUPPORTED_PLATFORM,
    );
  }
});

test("loader rejects musl on an otherwise compatible ARMv7 runtime", () => {
  assert.ok(armv7Target, "native matrix must configure ARMv7 hard-float");
  expectLoaderError(
    () => loadNative(loadOptions({
      arch: "arm",
      processConfig: {
        variables: { arm_version: 7, arm_float_abi: "hard" },
      },
      report: {
        getReport: () => ({
          header: {},
          sharedObjects: ["/lib/ld-musl-armhf.so.1"],
        }),
      },
    })),
    WatchboundLoaderErrorCode.UNSUPPORTED_LIBC,
  );
});

test("loader distinguishes detected glibc from musl and unknown libc", () => {
  assert.equal(detectLibc(glibcReport()), "glibc");
  assert.equal(detectLibc({
    getReport: () => ({
      header: {},
      sharedObjects: ["/lib/ld-musl-x86_64.so.1"],
    }),
  }), "musl");
  assert.equal(detectLibc({
    getReport: () => ({ header: {}, sharedObjects: ["/lib/libc.so.6"] }),
  }), "unknown");
  assert.equal(detectLibc({ getReport: () => { throw new Error("report failed"); } }), "unknown");

  for (const report of [
    { getReport: () => ({ header: {}, sharedObjects: ["/lib/libc.musl-x86_64.so.1"] }) },
    { getReport: () => ({ header: {}, sharedObjects: [] }) },
  ]) {
    expectLoaderError(
      () => loadNative(loadOptions({ report })),
      WatchboundLoaderErrorCode.UNSUPPORTED_LIBC,
    );
  }
});

test("loader requires an integer process Node-API version of at least six", () => {
  for (const napiVersion of [undefined, null, "", "5", "5.9", "unknown"]) {
    expectLoaderError(
      () => loadNative(loadOptions({ napiVersion })),
      WatchboundLoaderErrorCode.UNSUPPORTED_NODE_API,
    );
  }
  assert.equal(loadNative(loadOptions({ napiVersion: "6" })).marker, "native-binding");
  assert.equal(loadNative(loadOptions({ napiVersion: "10" })).marker, "native-binding");
});

test("loader enforces the exact supported Node 24 range", () => {
  for (const nodeVersion of [undefined, null, "", "24.14.9", "24.15.0-rc.1", "23.9.0", "25.0.0"]) {
    expectLoaderError(
      () => loadNative(loadOptions({ nodeVersion })),
      WatchboundLoaderErrorCode.UNSUPPORTED_NODE,
    );
  }
  assert.equal(
    loadNative(loadOptions({ nodeVersion: "24.99.0" })).marker,
    "native-binding",
  );
});

test("loader reports a missing exact local addon without trying to require it", () => {
  let required = false;
  expectLoaderError(
    () => loadNative(loadOptions({
      existsSync: (candidate) => {
        assert.equal(candidate, nativePath);
        return false;
      },
      requireNative: () => {
        required = true;
      },
    })),
    WatchboundLoaderErrorCode.NATIVE_NOT_BUILT,
  );
  assert.equal(required, false);
});

test("loader bounds and sanitizes dlopen failures", () => {
  let caught;
  try {
    loadNative(loadOptions({
      requireNative: () => {
        const error = new Error(`${nativePath}: ${"é".repeat(4_096)}`);
        error.code = "ERR_DLOPEN_FAILED";
        throw error;
      },
    }));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof WatchboundLoaderError);
  assert.equal(caught.code, WatchboundLoaderErrorCode.NATIVE_LOAD_FAILED);
  assert.ok(!caught.message.includes(nativePath));
  assert.ok(!caught.cause.message.includes(nativePath));
  assert.ok(caught.cause.message.includes(nativeBasename));
  assert.ok(Buffer.byteLength(caught.message, "utf8") <= 1_024);
  assert.ok(Buffer.byteLength(caught.cause.message, "utf8") <= 512);
  assert.ok(Object.isFrozen(caught.cause));
});

test("loader rejects malformed or unreadable binding metadata as an API mismatch", () => {
  for (const binding of [
    {},
    { bindingMetadata: null },
    { bindingMetadata: () => null },
    { bindingMetadata: () => [] },
    { bindingMetadata: () => { throw new Error(`${nativePath}: metadata failed`); } },
    { bindingMetadata: () => ({ ...validMetadata, buildProfile: "" }) },
    { bindingMetadata: () => ({ ...validMetadata, targetTriple: null }) },
  ]) {
    expectLoaderError(
      () => loadNative(loadOptions({ requireNative: () => binding })),
      WatchboundLoaderErrorCode.NATIVE_API_MISMATCH,
    );
  }
});

test("loader distinguishes metadata API and version mismatches", () => {
  for (const metadata of [
    { ...validMetadata, schemaVersion: 2 },
    { ...validMetadata, bindingApiVersion: 3 },
    { ...validMetadata, bindingApiVersion: 6 },
    { ...validMetadata, nodeApiVersion: 5 },
    { ...validMetadata, targetTriple: "aarch64-unknown-linux-gnu" },
    { ...validMetadata, buildProfile: "debug" },
  ]) {
    expectLoaderError(
      () => loadNative(loadOptions({ requireNative: () => validBinding(metadata) })),
      WatchboundLoaderErrorCode.NATIVE_API_MISMATCH,
    );
  }

  for (const metadata of [
    { ...validMetadata, nativeVersion: "0.1.1" },
    { ...validMetadata, engineVersion: "0.1.1" },
  ]) {
    expectLoaderError(
      () => loadNative(loadOptions({ requireNative: () => validBinding(metadata) })),
      WatchboundLoaderErrorCode.NATIVE_VERSION_MISMATCH,
    );
  }
});

test("loader uses exactly one local basename and ignores napi-rs environment overrides", () => {
  const previous = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = "/untrusted/override.node";
  const calls = [];
  try {
    const binding = loadNative(loadOptions({
      existsSync: (candidate) => {
        calls.push(["exists", candidate]);
        return true;
      },
      requireNative: (candidate) => {
        calls.push(["require", candidate]);
        return validBinding();
      },
    }));
    assert.equal(binding.marker, "native-binding");
  } finally {
    if (previous === undefined) delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
    else process.env.NAPI_RS_NATIVE_LIBRARY_PATH = previous;
  }
  assert.deepEqual(calls, [
    ["exists", nativePath],
    ["require", nativePath],
  ]);
});

test("bundled loader resolves one exact target package and verifies its digest", () => {
  const contents = elfFor(x64Target);
  const sha256 = require("node:crypto")
    .createHash("sha256")
    .update(contents)
    .digest("hex");
  const packageRoot = "/private/watchbound/target-x64";
  const manifestPath = path.join(packageRoot, "package.json");
  const manifest = {
    name: x64Target.package,
    version: packageVersion,
    watchbound: {
      delivery: "target-native-package",
      target: x64Target.id,
    targetTriple: x64Target.rustTarget,
    architecture: x64Target.architecture,
      armAbi: null,
    libc: x64Target.libc,
      binary: x64Target.binary,
      nativeSha256: sha256,
    },
  };
  const calls = [];
  const binding = loadNative(loadOptions({
    packageDelivery: "bundled-native-package",
    resolvePackageJson(specifier) {
      calls.push(["resolve", specifier]);
      return manifestPath;
    },
    existsSync(candidate) {
      calls.push(["exists", candidate]);
      return true;
    },
    readdirSync(candidate) {
      assert.equal(candidate, packageRoot);
      return [x64Target.binary];
    },
    lstatSync(candidate) {
      assert.equal(candidate, path.join(packageRoot, x64Target.binary));
      return {
        isFile: () => true,
        isSymbolicLink: () => false,
        size: contents.length,
      };
    },
    readFileSync(candidate, encoding) {
      if (candidate === manifestPath) {
        assert.equal(encoding, "utf8");
        return JSON.stringify(manifest);
      }
      assert.equal(candidate, path.join(packageRoot, x64Target.binary));
      return contents;
    },
    requireNative(candidate) {
      calls.push(["require", candidate]);
      return validBinding();
    },
  }));
  assert.equal(binding.marker, "native-binding");
  assert.deepEqual(binding.nativeDeliveryMetadata(), {
    schemaVersion: 1,
    delivery: "bundled-native-package",
    loaderPackage: "@gadicc/watchbound-node",
    targetPackage: x64Target.package,
    targetId: x64Target.id,
    targetTriple: x64Target.rustTarget,
    architecture: "x64",
    armAbi: null,
    runtimeArmAbi: null,
    libc: "glibc",
    binary: x64Target.binary,
    sha256,
    qualification: "supported",
    glibcMaximum: "2.35",
    kernelMinimum: "5.15",
  });
  assert.deepEqual(calls, [
    ["resolve", `${x64Target.package}/package.json`],
    ["exists", path.join(packageRoot, x64Target.binary)],
    ["require", path.join(packageRoot, x64Target.binary)],
  ]);
});

test("bundled loader never falls back when the exact target package is missing", () => {
  const resolved = [];
  expectLoaderError(
    () => loadNative(loadOptions({
      packageDelivery: "bundled-native-package",
      resolvePackageJson(specifier) {
        resolved.push(specifier);
        const error = new Error("package missing");
        error.code = "MODULE_NOT_FOUND";
        throw error;
      },
    })),
    WatchboundLoaderErrorCode.TARGET_PACKAGE_MISSING,
  );
  assert.deepEqual(resolved, [`${x64Target.package}/package.json`]);
});

test("loader rejects wrong ELF identity and extra nearby addons", () => {
  const wrongElf = elfFor(arm64Target);
  expectLoaderError(
    () => loadNative(loadOptions({
      lstatSync: () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        size: wrongElf.length,
      }),
      readFileSync: () => wrongElf,
    })),
    WatchboundLoaderErrorCode.NATIVE_ELF_MISMATCH,
  );
  expectLoaderError(
    () => loadNative(loadOptions({
      readdirSync: () => [nativeBasename, arm64Target.binary],
    })),
    WatchboundLoaderErrorCode.TARGET_PACKAGE_INVALID,
  );
});

test("loader rejects a soft-float ARM ELF mislabeled as ARMv7 hard-float", () => {
  assert.ok(armv7Target, "native matrix must configure ARMv7 hard-float");
  const softFloat = elfFor(armv7Target);
  softFloat.writeUInt32LE(0x05000200, 36);
  expectLoaderError(
    () => loadNative(loadOptions({
      arch: "arm",
      processConfig: {
        variables: { arm_version: 7, arm_float_abi: "hard" },
      },
      readdirSync: () => [armv7Target.binary],
      lstatSync: () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        size: softFloat.length,
      }),
      readFileSync: () => softFloat,
    })),
    WatchboundLoaderErrorCode.NATIVE_ELF_MISMATCH,
  );
});

test("wrapper assertion uses the native package version and delivery mode", () => {
  assert.doesNotThrow(() =>
    assertWrapperVersion(packageVersion, packageDelivery));
  expectLoaderError(
    () => assertWrapperVersion("0.1.1", packageDelivery),
    WatchboundLoaderErrorCode.NATIVE_VERSION_MISMATCH,
  );
  expectLoaderError(
    () => assertWrapperVersion(packageVersion, "bundled-native-package"),
    WatchboundLoaderErrorCode.NATIVE_VERSION_MISMATCH,
  );
});

test("hand-owned index loads once and exports the wrapper-version assertion", () => {
  const source = fs.readFileSync(path.join(nodeRoot, "index.js"), "utf8");
  const binding = { marker: "binding" };
  let loads = 0;
  const assertion = () => {};
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module,
    exports: module.exports,
    require(specifier) {
      assert.equal(specifier, "./load-native.cjs");
      return {
        assertWrapperVersion: assertion,
        loadNative() {
          loads += 1;
          return binding;
        },
      };
    },
    Object,
  }, { filename: "node/index.js" });
  assert.equal(loads, 1);
  assert.equal(module.exports, binding);
  assert.equal(module.exports.assertWrapperVersion, assertion);
});

test("native build cannot overwrite the tracked loader or public declarations", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(nodeRoot, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts.build,
    "napi build --platform --release --output-dir . --no-js --dts native.generated.d.ts",
  );
  assert.equal(packageJson.main, "index.js");
  assert.equal(packageJson.types, "index.d.ts");

  const indexSource = fs.readFileSync(path.join(nodeRoot, "index.js"), "utf8");
  const declarations = fs.readFileSync(path.join(nodeRoot, "index.d.ts"), "utf8");
  const ignore = fs.readFileSync(path.resolve(nodeRoot, "..", ".gitignore"), "utf8");
  const loaderSource = fs.readFileSync(path.join(nodeRoot, "load-native.cjs"), "utf8");
  assert.doesNotMatch(indexSource, /auto-generated by NAPI-RS/i);
  assert.match(declarations, /Hand-owned public declarations/);
  assert.match(ignore, /^\/node\/native\.generated\.d\.ts$/m);
  assert.doesNotMatch(loaderSource, /child_process|execSync|NAPI_RS_|FORCE_WASI/);
});
