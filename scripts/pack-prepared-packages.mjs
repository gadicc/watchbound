import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const manifest = readJson(path.join(workspaceRoot, "dist/native-package-manifest.json"));
const packages = [manifest.loader, manifest.wrapper, ...manifest.targets]
  .filter((descriptor) => !options.target || descriptor.id === undefined || descriptor.id === options.target);
const tarballRoot = path.join(workspaceRoot, "dist/tarballs");
fs.mkdirSync(tarballRoot, { recursive: true });
for (const descriptor of packages) {
  run("pnpm", ["pack", "--pack-destination", tarballRoot], path.join(workspaceRoot, "dist", descriptor.root));
}
process.stdout.write(`Packed ${packages.map(({ name }) => name).join(", ")}\n`);

function parseOptions(args) {
  if (args.length === 0) return {};
  assert.deepEqual(args.slice(0, 1), ["--target"]);
  assert.ok(args[1]);
  assert.equal(args.length, 2);
  return { target: args[1] };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}
