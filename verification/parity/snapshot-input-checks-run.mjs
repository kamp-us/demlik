import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotInputParity } from "./snapshot-input-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const baseline = await snapshotInputParity(process.env.CARGO ?? "cargo");
assert.deepEqual(baseline.failures, []);
execFileSync(
  process.execPath,
  [
    "--import",
    createRequire(import.meta.url).resolve("tsx"),
    path.join(root, "verification/parity/snapshot-input-mutation.mjs"),
  ],
  { cwd: root, stdio: "inherit" },
);
