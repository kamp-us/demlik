import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentContentMutations } from "./agent-content-mutations.mjs";
import { agentGuardsMutations } from "./agent-guards-mutations.mjs";
import { agentModelMutations } from "./agent-model-mutations.mjs";
import { agentModelTypes } from "./agent-model-types.mjs";

const suites = {
  content: { driver: "agent_content_driver", check: agentContentMutations },
  guards: { driver: "agent_guards_driver", check: agentGuardsMutations },
  model: {
    driver: "agent_model_driver",
    check: async () => {
      agentModelTypes();
      await agentModelMutations();
    },
  },
};
assert.equal(process.argv.length, 3);
assert.ok(Object.hasOwn(suites, process.argv[2]), "unknown agent check suite");
const suite = suites[process.argv[2]];
execFileSync(
  process.env.CARGO ?? "cargo",
  ["build", "--locked", "-p", "demlik-tea", "--example", suite.driver],
  { cwd: fileURLToPath(new URL("../..", import.meta.url)), stdio: "inherit" },
);
await suite.check();
