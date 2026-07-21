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
const packageVersion = require("../package.json").version;
const privateDirectory = "/private/watchbound/node";
const nativeBasename = "watchbound.linux-x64-gnu.node";
const nativePath = path.join(privateDirectory, nativeBasename);

const validMetadata = Object.freeze({
  schemaVersion: 1,
  bindingApiVersion: 1,
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

function loadOptions(overrides = {}) {
  return {
    platform: "linux",
    arch: "x64",
    napiVersion: "9",
    report: glibcReport(),
    directory: privateDirectory,
    packageVersion,
    existsSync: () => true,
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

test("loader accepts only Linux x64", () => {
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["win32", "x64"],
    ["linux", "arm64"],
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
    { ...validMetadata, bindingApiVersion: 2 },
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
    { ...validMetadata, nativeVersion: "0.0.1" },
    { ...validMetadata, engineVersion: "0.0.1" },
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

test("wrapper version assertion uses the native package version", () => {
  assert.doesNotThrow(() => assertWrapperVersion(packageVersion));
  expectLoaderError(
    () => assertWrapperVersion("0.0.1"),
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
