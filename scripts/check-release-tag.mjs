import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const version = JSON.parse(
  fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
).version;
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const expected = `v${version}`;

if (tag !== expected) {
  throw new Error(
    `Release tag must exactly match the workspace version: expected ${expected}, got ${tag ?? "<unset>"}`,
  );
}

process.stdout.write(`Release tag ${tag} matches Watchbound ${version}\n`);
