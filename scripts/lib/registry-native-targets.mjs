import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const nativeLoaderPackage = "@gadicc/watchbound-node";

export function resolveInstalledNativeTargetIds({
  projectRoot,
  wrapperPackage,
  targets,
}) {
  const wrapperEntry = fs.realpathSync(path.join(
    projectRoot,
    "node_modules",
    ...wrapperPackage.split("/"),
    "index.js",
  ));
  const wrapperRequire = createRequire(wrapperEntry);
  const loaderEntry = fs.realpathSync(wrapperRequire.resolve(nativeLoaderPackage));
  const loaderRequire = createRequire(loaderEntry);

  // Native targets are transitive optional dependencies of the loader. npm may
  // flatten them to the project root, while pnpm keeps them in its strict
  // dependency graph. Resolve from the loader just as production does instead
  // of assuming either package manager's physical node_modules layout.
  return targets
    .filter((target) => packageManifestResolves(loaderRequire, target.package))
    .map(({ id }) => id);
}

function packageManifestResolves(requireFromLoader, packageName) {
  try {
    requireFromLoader.resolve(`${packageName}/package.json`);
    return true;
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND") return false;
    throw error;
  }
}
