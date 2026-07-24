import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error("usage: node scripts/set-release-version.mjs <semver>");
}

for (const relativePath of ["package.json", "js/package.json", "node/package.json"]) {
  const file = path.join(workspaceRoot, relativePath);
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.version = version;
  if (relativePath === "js/package.json") {
    manifest.dependencies["@gadicc/watchbound-node"] = `workspace:${version}`;
  }
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

replaceExactly(
  "Cargo.toml",
  /^version = ".*"$/mu,
  `version = "${version}"`,
);
for (const crate of ["watchbound-engine", "watchbound-node"]) {
  replaceExactly(
    "Cargo.lock",
    new RegExp(`(name = "${crate}"\\nversion = ")[^"]+(")`, "u"),
    `$1${version}$2`,
  );
}
replaceExactly(
  "pnpm-lock.yaml",
  /specifier: workspace:.*$/mu,
  `specifier: workspace:${version}`,
);

process.stdout.write(`Stamped Watchbound release version ${version}\n`);

function replaceExactly(relativePath, pattern, replacement) {
  const file = path.join(workspaceRoot, relativePath);
  const source = fs.readFileSync(file, "utf8");
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one version field in ${relativePath}, found ${matches.length}`,
    );
  }
  fs.writeFileSync(file, source.replace(pattern, replacement));
}
