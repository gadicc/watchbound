import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function prepare(_pluginConfig, { nextRelease }) {
  run(process.execPath, [
    "scripts/set-release-version.mjs",
    nextRelease.version,
  ]);
  run("pnpm", ["check:reproducible"]);
  run("pnpm", ["test:packages"]);
}

export function publish(_pluginConfig, { nextRelease }) {
  const { version } = nextRelease;
  const distTag = nextRelease.channel ?? "latest";
  const nativePackage = `@gadicc/watchbound-node@${version}`;
  const wrapperPackage = `@gadicc/watchbound@${version}`;
  const jsrPackage = `jsr:@gadicc/watchbound@${version}`;

  const nativeExists = packageExists("npm", nativePackage);
  const wrapperExists = packageExists("npm", wrapperPackage);
  if (wrapperExists && !nativeExists) {
    throw new Error(
      `${wrapperPackage} exists without its exact native dependency`,
    );
  }

  if (!nativeExists) {
    publishNpm("node", version, distTag);
  }
  if (!wrapperExists) {
    publishNpm("wrapper", version, distTag);
  }
  if (!packageExists("jsr", jsrPackage)) {
    run("deno", ["publish", "--no-check"], path.join(workspaceRoot, "dist/jsr"));
  }

  return {
    name: "@gadicc/watchbound",
    url: `https://www.npmjs.com/package/@gadicc/watchbound/v/${version}`,
  };
}

function publishNpm(kind, version, distTag) {
  const filename = kind === "node"
    ? `gadicc-watchbound-node-${version}.tgz`
    : `gadicc-watchbound-${version}.tgz`;
  run("npm", [
    "publish",
    path.join("dist", "tarballs", filename),
    "--access",
    "public",
    "--provenance",
    "--tag",
    distTag,
  ]);
}

function packageExists(registry, specifier) {
  const [command, args] = registry === "npm"
    ? ["npm", ["view", specifier, "version"]]
    : ["deno", ["info", specifier]];
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;

  const output = `${result.stdout}\n${result.stderr}`;
  const missing = registry === "npm"
    ? /\bE404\b|is not in this registry|no match found/iu.test(output)
    : /\b404\b|not found|could not find|does not exist/iu.test(output);
  if (missing) return false;

  throw new Error(
    `could not determine whether ${specifier} exists:\n${output.trim()}`,
  );
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
