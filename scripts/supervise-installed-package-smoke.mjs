import assert from "node:assert/strict";

import { runBoundedProcess } from "./kernel-baseline-qualification-helpers.mjs";

const options = parseOptions(process.argv.slice(2));
const result = await runBoundedProcess(options.command, options.commandArgs, {
  timeoutMs: options.timeoutMs,
});

if (result.error?.code === "ETIMEDOUT") {
  process.stderr.write(
    `WATCHBOUND_INSTALLED_SMOKE_PROCESS_DEADLINE=${JSON.stringify({
      timeoutMs: options.timeoutMs,
      route: options.route,
      command: options.command,
    })}\n`,
  );
  process.exitCode = 124;
} else if (result.error) {
  throw result.error;
} else if (result.status !== 0 || result.signal !== null) {
  process.stderr.write(
    `Installed package smoke did not exit cleanly (status=${result.status}, signal=${result.signal})\n`,
  );
  process.exitCode = result.status ?? 1;
}

function parseOptions(args) {
  const separator = args.indexOf("--");
  assert.ok(separator >= 0, "installed smoke supervisor requires -- before the command");
  const optionArgs = args.slice(0, separator);
  const commandArgs = args.slice(separator + 1);
  assert.ok(commandArgs.length > 0, "installed smoke supervisor command is required");

  const parsed = {};
  for (let index = 0; index < optionArgs.length; index += 2) {
    const flag = optionArgs[index];
    const value = optionArgs[index + 1];
    assert.ok(flag?.startsWith("--") && value !== undefined, "invalid supervisor option");
    parsed[flag.slice(2)] = value;
  }
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["route", "timeout-ms"],
    "installed smoke supervisor options",
  );
  assert.match(parsed["timeout-ms"], /^[1-9][0-9]*$/u);
  const timeoutMs = Number(parsed["timeout-ms"]);
  assert.ok(Number.isSafeInteger(timeoutMs));
  assert.ok(parsed.route.length > 0);

  return {
    command: commandArgs[0],
    commandArgs: commandArgs.slice(1),
    route: parsed.route,
    timeoutMs,
  };
}
