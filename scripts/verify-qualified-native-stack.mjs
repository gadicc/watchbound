import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readQualifiedNativeStack,
  verifyQualifiedNativeStack,
} from "./lib/qualified-native-stack.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.length === 2 && args[0] === "--target-sha256") {
  const stack = readQualifiedNativeStack(workspaceRoot);
  const target = stack.targets.find(({ id }) => id === args[1]);
  if (!target) throw new Error(`qualified native stack omits ${args[1]}`);
  process.stdout.write(`${target.nativeSha256}\n`);
} else if (args.length === 0) {
  const { descriptor } = await verifyQualifiedNativeStack(workspaceRoot);
  process.stdout.write(
    `Verified qualified native stack ${descriptor.version} from ${descriptor.sourceSha}\n`,
  );
} else {
  throw new Error(
    "usage: node scripts/verify-qualified-native-stack.mjs [--target-sha256 <target>]",
  );
}
