import path from "node:path";

export function installExactJsrNative(runCommand, packageRoot, nativeTarball) {
  runCommand(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      "--offline",
      path.resolve(nativeTarball),
    ],
    path.resolve(packageRoot),
  );
}
