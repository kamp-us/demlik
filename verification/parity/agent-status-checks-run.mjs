import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { agentStatusCheckpointParity } from "./agent-state-parity.mjs";
import { agentStatusCoverage } from "./agent-status-coverage.mjs";
import { agentStatusMutations } from "./agent-status-mutations.mjs";
import { agentStatusTypes } from "./agent-status-types.mjs";
import { checkedExecFileSync as execFileSync } from "./check-worktree.mjs";

const baseline = await agentStatusCheckpointParity(
  process.env.CARGO ?? "cargo",
);
assert.equal(baseline.cases, 64);
assert.deepEqual(baseline.failures, []);
agentStatusTypes(baseline.cargoArtifacts.libraries);
execFileSync(
  process.execPath,
  [
    "--import",
    createRequire(import.meta.url).resolve("tsx"),
    fileURLToPath(new URL("./inventory.mts", import.meta.url)),
    fileURLToPath(
      new URL("../../target/parity/inventory.json", import.meta.url),
    ),
  ],
  { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: "inherit" },
);
const controls = agentStatusMutations({
  binary: baseline.binary,
  libraries: Object.values(baseline.cargoArtifacts.libraries).map(
    (a) => a.path,
  ),
});
assert.equal(controls.detected, 18);
assert.equal(controls.escaped, 0);
agentStatusCoverage();
