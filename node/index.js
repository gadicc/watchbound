"use strict";

const {
  assertWrapperVersion,
  loadNative,
} = require("./load-native.cjs");

const nativeBinding = loadNative();
Object.defineProperty(nativeBinding, "assertWrapperVersion", {
  value: assertWrapperVersion,
  enumerable: true,
  configurable: false,
  writable: false,
});

module.exports = nativeBinding;
