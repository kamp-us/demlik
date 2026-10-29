import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { agentBaseCoverage } from "./agent-base-coverage.mjs";
import { agentBaseMutations } from "./agent-base-mutations.mjs";
import { agentBaseTypes } from "./agent-base-types.mjs";
import { agentBaseCheckpointParity } from "./agent-state-parity.mjs";
import { checkedExecFileSync as execFileSync } from "./check-worktree.mjs";

const baseline = await agentBaseCheckpointParity(process.env.CARGO ?? "cargo");
assert.equal(baseline.cases, 44);
assert.deepEqual(baseline.failures, []);
agentBaseTypes(baseline.cargoArtifacts.libraries.demlik_tea);
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
const controls = agentBaseMutations({
  binary: baseline.binary,
  libraries: Object.values(baseline.cargoArtifacts.libraries).map(
    (a) => a.path,
  ),
});
assert.equal(controls.detected, 24);
assert.equal(controls.escaped, 0);
agentBaseCoverage();
