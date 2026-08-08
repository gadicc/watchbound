import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveInstalledNativeTargetIds } from "../../scripts/lib/registry-native-targets.mjs";

const targets = [
  {
    id: "linux-x64-gnu",
    package: "@gadicc/watchbound-node-linux-x64-gnu",
  },
  {
    id: "linux-arm64-gnu",
    package: "@gadicc/watchbound-node-linux-arm64-gnu",
  },
  {
    id: "linux-arm-gnueabihf",
    package: "@gadicc/watchbound-node-linux-arm-gnueabihf",
  },
];

test("registry target discovery follows the loader across npm and pnpm layouts", () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-registry-target-layouts-"),
  );
  try {
    const npmProject = path.join(fixtureRoot, "npm");
    writeModule(path.join(npmProject, "node_modules/watchbound/index.js"));
    writeModule(path.join(
      npmProject,
      "node_modules/@gadicc/watchbound-node/index.js",
    ));
    writePackage(path.join(
      npmProject,
      "node_modules/@gadicc/watchbound-node-linux-arm-gnueabihf/package.json",
    ), "@gadicc/watchbound-node-linux-arm-gnueabihf");
    assert.deepEqual(
      resolveInstalledNativeTargetIds({
        projectRoot: npmProject,
        wrapperPackage: "watchbound",
        targets,
      }),
      ["linux-arm-gnueabihf"],
    );

    const pnpmProject = path.join(fixtureRoot, "pnpm");
    const virtualStore = path.join(pnpmProject, "node_modules/.pnpm");
    const wrapperRoot = path.join(
      virtualStore,
      "@jsr+gadicc__watchbound@2.1.0/node_modules/@jsr/gadicc__watchbound",
    );
    const wrapperDependencies = path.join(
      virtualStore,
      "@jsr+gadicc__watchbound@2.1.0/node_modules/@gadicc",
    );
    const loaderRoot = path.join(
      virtualStore,
      "@gadicc+watchbound-node@2.1.0/node_modules/@gadicc/watchbound-node",
    );
    const loaderDependencies = path.join(
      virtualStore,
      "@gadicc+watchbound-node@2.1.0/node_modules/@gadicc",
    );
    const targetRoot = path.join(
      virtualStore,
      "@gadicc+watchbound-node-linux-arm-gnueabihf@2.1.0/node_modules/@gadicc/watchbound-node-linux-arm-gnueabihf",
    );
    writeModule(path.join(wrapperRoot, "index.js"));
    writeModule(path.join(loaderRoot, "index.js"));
    writePackage(
      path.join(targetRoot, "package.json"),
      "@gadicc/watchbound-node-linux-arm-gnueabihf",
    );
    symlinkDirectory(
      wrapperRoot,
      path.join(pnpmProject, "node_modules/@gadicc/watchbound"),
    );
    symlinkDirectory(
      loaderRoot,
      path.join(wrapperDependencies, "watchbound-node"),
    );
    symlinkDirectory(
      targetRoot,
      path.join(loaderDependencies, "watchbound-node-linux-arm-gnueabihf"),
    );
    assert.equal(
      fs.existsSync(path.join(
        pnpmProject,
        "node_modules/@gadicc/watchbound-node-linux-arm-gnueabihf",
      )),
      false,
      "the pnpm fixture must not expose the transitive target at project root",
    );
    assert.deepEqual(
      resolveInstalledNativeTargetIds({
        projectRoot: pnpmProject,
        wrapperPackage: "@gadicc/watchbound",
        targets,
      }),
      ["linux-arm-gnueabihf"],
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function writeModule(destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, "export {};\n");
}

function writePackage(destination, name) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify({ name, version: "2.1.0" })}\n`);
}

function symlinkDirectory(target, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(target, destination, "dir");
}
