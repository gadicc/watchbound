import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const EXPECTED_VERSION = "2.5.6";

export const id = "parcel-watcher";

function findPackageJson(entryPath) {
  let current = path.dirname(entryPath);
  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (parsed.name === "@parcel/watcher") return { path: candidate, package: parsed };
      } catch {}
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function loadAdapter() {
  const requested = process.env.WATCHBOUND_PARCEL_WATCHER_PATH || "@parcel/watcher";
  let entryPath;
  let implementation;
  try {
    entryPath = require.resolve(requested);
    implementation = require(requested);
  } catch (error) {
    return {
      id,
      available: false,
      reason:
        `Could not load @parcel/watcher ${EXPECTED_VERSION}. Install the workspace dependencies` +
        " or set WATCHBOUND_PARCEL_WATCHER_PATH to that exact package.",
      requested,
      error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    };
  }

  const packageInfo = findPackageJson(entryPath);
  const version = packageInfo?.package?.version ?? null;
  if (version !== EXPECTED_VERSION) {
    return {
      id,
      available: false,
      reason: `Expected @parcel/watcher ${EXPECTED_VERSION}, found ${version ?? "an unknown version"}`,
      requested,
      entryPath,
      version,
    };
  }
  if (typeof implementation?.subscribe !== "function") {
    return {
      id,
      available: false,
      reason: "The resolved @parcel/watcher module does not export subscribe()",
      requested,
      entryPath,
      version,
    };
  }

  const metadata = {
    id,
    label: `@parcel/watcher ${EXPECTED_VERSION}`,
    version,
    entryPath,
    packagePath: packageInfo.path,
  };
  const capabilities = {
    platform: "cross-platform",
    recursiveDirectoryTree: true,
    directoryOnlyKernelWatches: true,
    publicWatchCount: false,
    nativeEventBatching: true,
    movedInSubtreeDiscovery: false,
    rootReplacementRecovery: false,
    staticExclusions: true,
    dynamicExclusions: {
      supported: false,
      atomic: false,
      reason: "The subscribe() ignore option cannot be updated on an active subscription",
    },
    explicitWatchLimits: false,
    explicitCoverage: false,
    overflowReporting: false,
    consumerBackpressureReporting: false,
  };

  return {
    id,
    available: true,
    metadata,
    capabilities,
    async subscribe({ root, onBatch }) {
      const asyncErrors = [];
      const subscription = await implementation.subscribe(root, (error, events) => {
        if (error) {
          asyncErrors.push({ code: error.code ?? null, message: error.message ?? String(error) });
          onBatch({ paths: [], details: [], invalidated: true, rawEventCount: 0, error });
          return;
        }
        const details = Array.isArray(events)
          ? events.map((event) => ({ path: event.path, type: event.type ?? null }))
          : [];
        onBatch({
          paths: details.map((event) => event.path),
          details,
          invalidated: false,
          rawEventCount: details.length,
        });
      }, { backend: "inotify" });

      let disposePromise = null;
      return {
        coverage: { recursive: true, typedPathChanges: true },
        async dispose() {
          disposePromise ??= Promise.resolve(subscription.unsubscribe());
          await disposePromise;
        },
        async stats() {
          return { directoryWatches: null, budget: null, asyncErrors: [...asyncErrors] };
        },
      };
    },
  };
}
