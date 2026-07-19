import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const id = "codex-js";
export const DEFAULT_WATCHER_PATH =
  "/home/dragon/src/codex-desktop-linux/linux-features/directory-only-working-tree-watch/patch.js";

function unavailable(reason, details = {}) {
  return {
    id,
    available: false,
    reason,
    ...details,
  };
}

export async function loadAdapter() {
  const configuredPath = process.env.WATCHBOUND_CODEX_WATCHER_PATH || DEFAULT_WATCHER_PATH;
  const watcherPath = path.resolve(configuredPath);
  let source;
  try {
    source = fs.readFileSync(watcherPath);
  } catch (error) {
    return unavailable(`Could not read the Codex watcher helper at ${watcherPath}`, {
      watcherPath,
      error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    });
  }

  let implementation;
  try {
    implementation = require(watcherPath);
  } catch (error) {
    return unavailable(`Could not load the Codex watcher helper at ${watcherPath}`, {
      watcherPath,
      error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    });
  }

  const start = implementation?.codexLinuxStartDirectoryOnlyWorkingTreeWatch;
  if (typeof start !== "function") {
    return unavailable(
      `The module at ${watcherPath} does not export codexLinuxStartDirectoryOnlyWorkingTreeWatch`,
      { watcherPath },
    );
  }

  const stat = fs.statSync(watcherPath);
  const metadata = {
    id,
    label: "Current Codex Linux JavaScript helper",
    watcherPath,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
    bytes: source.byteLength,
    modifiedAt: stat.mtime.toISOString(),
  };
  const capabilities = {
    platform: "linux",
    recursiveDirectoryTree: true,
    directoryOnlyKernelWatches: true,
    publicWatchCount: true,
    nativeEventBatching: false,
    movedInSubtreeDiscovery: true,
    rootReplacementRecovery: true,
    staticExclusions: true,
    dynamicExclusions: {
      supported: true,
      atomic: false,
      mechanism: "Git-ignore-derived refresh through watched metadata",
    },
    explicitWatchLimits: true,
    explicitCoverage: false,
    overflowReporting: false,
    supervisedOverflow: process.platform === "linux",
    consumerBackpressureReporting: false,
  };

  return {
    id,
    available: true,
    metadata,
    capabilities,
    async subscribe({ root, onBatch, maxWatches = 65_536, honorGitIgnore = false }) {
      const host = {
        getFileSystemPath(value) {
          return value;
        },
        async platformPath() {
          return path.posix;
        },
      };
      const session = await start(
        host,
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange(event) {
            const changedPaths = Array.isArray(event?.changedPaths) ? event.changedPaths : [];
            onBatch({
              paths: changedPaths,
              details: changedPaths.map((changedPath) => ({ path: changedPath, type: null })),
              invalidated: changedPaths.length === 0,
              rawEventCount: changedPaths.length,
            });
          },
        },
        {
          maxWatches,
          honorGitIgnore,
          ignoredDirectoryNames: [],
        },
      );

      let disposePromise = null;
      return {
        coverage: session.coverage ?? null,
        async dispose() {
          disposePromise ??= Promise.resolve(session.dispose());
          await disposePromise;
        },
        async stats() {
          return {
            directoryWatches:
              typeof session.codexLinuxDirectoryWatchCount === "function"
                ? session.codexLinuxDirectoryWatchCount()
                : null,
            budget:
              typeof session.codexLinuxDirectoryWatchBudget === "function"
                ? session.codexLinuxDirectoryWatchBudget()
                : null,
            directorySyncFlushes:
              typeof session.codexLinuxDirectorySyncFlushCount === "function"
                ? session.codexLinuxDirectorySyncFlushCount()
                : null,
          };
        },
        async updateExclusions(relativeDirectories) {
          const patterns = relativeDirectories.map((relativeDirectory) => {
            const normalized = relativeDirectory.split(path.sep).join("/").replace(/^\/+|\/+$/gu, "");
            if (!normalized || normalized.includes("\n") || normalized.includes("\0")) {
              throw new Error(`Invalid benchmark exclusion path: ${relativeDirectory}`);
            }
            return `/${normalized}/`;
          });
          fs.writeFileSync(path.join(root, ".gitignore"), `${patterns.join("\n")}${patterns.length ? "\n" : ""}`);
        },
      };
    },
  };
}
