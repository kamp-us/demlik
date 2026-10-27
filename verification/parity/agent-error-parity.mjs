import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentErrorParity } from "./agent-error-run.mjs";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

function buildDriver(cargo, example, reportFile) {
  const producer = buildTeaExample(cargo, example, reportFile);
  assertCheckPath(producer.actualArtifact, path.join(root, "target"));
  assertCheckPath(
    producer.libraries.demlik_tea.path,
    path.join(root, "target"),
  );
  return producer;
}

export function agentErrorCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/agent-error.json"),
  );
  let binary = options.binary;
  let coldBinary = options.coldBinary;
  const producers = { pure: null, cold: null };
  if (!binary || !coldBinary) {
    for (const key of [
      "CARGO_TARGET_DIR",
      "DEMLIK_MUTATION_TARGET_DIR",
      "CARGO_BUILD_TARGET_DIR",
      "CARGO_BUILD_BUILD_DIR",
    ])
      assert.equal(process.env[key], undefined, `${key} must be unset`);
  }
  if (!binary) {
    producers.pure = buildDriver(
      cargo,
      "agent_error_driver",
      `${reportFile}.pure`,
    );
    binary = producers.pure.binary;
  }
  if (!coldBinary) {
    producers.cold = buildDriver(
      cargo,
      "agent_default_state_json_driver",
      `${reportFile}.cold`,
    );
    coldBinary = producers.cold.binary;
  }
  const report = {
    ...agentErrorParity({ binary, coldBinary, output: reportFile }),
    producers,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
