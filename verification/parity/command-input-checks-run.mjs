import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedExecFileSync as execFileSync } from "./check-worktree.mjs";
import { commandInputParity } from "./command-input-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const baseline = await commandInputParity(process.env.CARGO ?? "cargo");
assert.deepEqual(baseline.failures, []);
execFileSync(
  process.execPath,
  [
    "--import",
    createRequire(import.meta.url).resolve("tsx"),
    path.join(root, "verification/parity/command-input-mutations.mjs"),
    "--native-bin",
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      "debug/examples/command_input_driver",
    ),
  ],
  { cwd: root, stdio: "inherit" },
);
