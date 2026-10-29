import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedExecFileSync as execFileSync } from "./check-worktree.mjs";
import { pbtFoldParity } from "./pbt-fold-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const baseline = await pbtFoldParity(process.env.CARGO ?? "cargo");
assert.deepEqual(baseline.failures, []);
execFileSync(
  process.execPath,
  [
    "--import",
    createRequire(import.meta.url).resolve("tsx"),
    path.join(root, "verification/parity/pbt-fold-mutations.mjs"),
    "--native-bin",
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      "debug/examples/pbt_fold_driver",
    ),
  ],
  { cwd: root, stdio: "inherit" },
);
