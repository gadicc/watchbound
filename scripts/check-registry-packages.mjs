import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
const projectRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), `watchbound-registry-${options.route}-`),
);

try {
  writeJson(path.join(projectRoot, "package.json"), {
    private: true,
    type: "module",
  });
  if (options.route === "npm") {
    await installWithRetry("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      `watchbound@${options.version}`,
    ]);
  } else {
    await installWithRetry("pnpm", [
      "add",
      "--ignore-scripts",
      "--save-exact",
      `jsr:@gadicc/watchbound@${options.version}`,
    ]);
  }

  run(process.execPath, [
    path.join(workspaceRoot, "scripts/check-installed-package.mjs"),
    "--project",
    projectRoot,
    "--wrapper",
    options.route === "npm" ? "watchbound" : "@gadicc/watchbound",
    "--version",
    options.version,
    "--native-sha256",
    options["native-sha256"],
    "--route",
    options.route,
    "--evidence",
    options.evidence,
  ]);
  augmentEvidenceWithInstallLock();
} catch (error) {
  retainFailureEvidence(error);
  throw error;
} finally {
  fs.rmSync(projectRoot, { recursive: true, force: true });
}

async function installWithRetry(command, args) {
  let lastResult;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    lastResult = spawnSync(command, args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        npm_config_cache: path.join(projectRoot, ".npm-cache"),
        PNPM_HOME: path.join(projectRoot, ".pnpm-home"),
      },
    });
    if (lastResult.error) throw lastResult.error;
    if (lastResult.status === 0) {
      process.stdout.write(lastResult.stdout);
      return;
    }
    const output = `${lastResult.stdout}\n${lastResult.stderr}`;
    const propagationFailure =
      /\bE404\b|not found|no matching version|could not find/iu.test(output);
    if (!propagationFailure || attempt === options.attempts) {
      process.stderr.write(output);
      throw new Error(
        `${command} registry install failed with status ${lastResult.status}`,
      );
    }
    process.stderr.write(
      `Exact ${options.route} version is not visible yet; retry ${attempt}/${options.attempts}\n`,
    );
    await delay(options["retry-delay-ms"]);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} installed-package smoke failed with status ${result.status}`,
    );
  }
}

function parseOptions(args) {
  const parsed = {
    attempts: 10,
    "retry-delay-ms": 30_000,
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: check-registry-packages.mjs --route <npm|jsr-node> --version <version> --native-sha256 <digest> --evidence <path>",
      );
    }
    const name = flag.slice(2);
    parsed[name] = name === "attempts" || name === "retry-delay-ms"
      ? Number(value)
      : value;
  }
  assert.ok(
    parsed.route === "npm" || parsed.route === "jsr-node",
    "--route must be npm or jsr-node",
  );
  for (const required of ["version", "native-sha256", "evidence"]) {
    assert.ok(parsed[required], `--${required} is required`);
  }
  assert.match(parsed["native-sha256"], /^[0-9a-f]{64}$/u);
  assert.ok(Number.isSafeInteger(parsed.attempts) && parsed.attempts > 0);
  assert.ok(
    Number.isSafeInteger(parsed["retry-delay-ms"]) &&
      parsed["retry-delay-ms"] > 0,
  );
  return parsed;
}

function writeJson(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function augmentEvidenceWithInstallLock() {
  const evidencePath = path.resolve(options.evidence);
  const lockPath = path.join(
    projectRoot,
    options.route === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
  );
  assert.ok(fs.existsSync(evidencePath), "installed smoke did not write evidence");
  assert.ok(fs.existsSync(lockPath), "registry install did not write a lockfile");
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  evidence.installLock = {
    filename: path.basename(lockPath),
    sha256: sha256(lockPath),
    contents: fs.readFileSync(lockPath, "utf8"),
  };
  writeJson(evidencePath, evidence);
}

function retainFailureEvidence(error) {
  const evidencePath = path.resolve(options.evidence);
  if (fs.existsSync(evidencePath)) return;
  const lockPath = path.join(
    projectRoot,
    options.route === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
  );
  writeJson(evidencePath, {
    schemaVersion: 1,
    kind: "watchbound-registry-install-smoke",
    route: options.route,
    expectedVersion: options.version,
    expectedNativeSha256: options["native-sha256"],
    status: "failed",
    error: {
      name: error?.name ?? null,
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    },
    installLock: fs.existsSync(lockPath)
      ? {
          filename: path.basename(lockPath),
          sha256: sha256(lockPath),
          contents: fs.readFileSync(lockPath, "utf8"),
        }
      : null,
  });
}

function sha256(source) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex");
}
