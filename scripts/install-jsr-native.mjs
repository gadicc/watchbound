import path from "node:path";

export function installExactJsrNative(runCommand, packageRoot, nativeTarballs) {
  const tarballs = Array.isArray(nativeTarballs) ? nativeTarballs : [nativeTarballs];
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
      ...tarballs.map((tarball) => path.resolve(tarball)),
    ],
    path.resolve(packageRoot),
  );
}
