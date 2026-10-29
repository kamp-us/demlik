import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { stateMutations } from "./agent-state-mutations.mjs";
import {
  agentStateFanoutParity,
  agentStateParity,
  agentStatePrerequisiteParity,
} from "./agent-state-parity.mjs";
import { prerequisiteMutations } from "./agent-state-prerequisite-mutations.mjs";
import { checkedExecFileSync as execFileSync } from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cargo = process.env.CARGO ?? "cargo";
for (const check of [
  agentStatePrerequisiteParity,
  agentStateParity,
  agentStateFanoutParity,
]) {
  const result = await check(cargo);
  assert.deepEqual(result.failures, []);
}
execFileSync(
  cargo,
  [
    "build",
    "--locked",
    "--offline",
    "-p",
    "demlik-parity",
    "--bin",
    "flow_driver",
  ],
  { cwd: root, stdio: "inherit" },
);
await prerequisiteMutations();
await stateMutations();
