import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspace = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roots = ["benches", "js", "node/test", "scripts"];
const extensions = new Set([".js", ".mjs", ".cjs"]);
const files = [];

for (const root of roots) collect(path.join(workspace, root));
files.sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exit(result.status || 1);
  }
}
process.stdout.write(`JavaScript syntax: ${files.length} files checked\n`);

function collect(candidate) {
  const stat = fs.statSync(candidate);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(candidate)) collect(path.join(candidate, entry));
  } else if (extensions.has(path.extname(candidate))) {
    files.push(candidate);
  }
}
