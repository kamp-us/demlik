import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentCompactionParity } from "./agent-compaction-run.mjs";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

export function agentCompactionCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ??
      path.join(root, "target/parity/agent-compaction.json"),
  );
  let binary = options.binary;
  let producer = null;
  if (!binary) {
    for (const key of [
      "CARGO_TARGET_DIR",
      "DEMLIK_MUTATION_TARGET_DIR",
      "CARGO_BUILD_TARGET_DIR",
      "CARGO_BUILD_BUILD_DIR",
    ])
      assert.equal(process.env[key], undefined, `${key} must be unset`);
    producer = buildTeaExample(cargo, "agent_compaction_driver", reportFile);
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assertCheckPath(
      producer.libraries.demlik_tea.path,
      path.join(root, "target"),
    );
    binary = producer.binary;
  }
  const raw = agentCompactionParity({ binary, output: reportFile });
  assert.equal(raw.cases, raw.observations.length);
  assert.equal(new Set(raw.observations.map((row) => row.id)).size, raw.cases);
  const successful = raw.observations.filter((row) => row.equal === true);
  assert.equal(raw.passed, successful.length);
  assert.deepEqual(
    raw.nativeEvidence,
    successful.map((row) => row.id),
  );
  assert.deepEqual(raw.qualifiedNativeEvidence, []);
  const report = {
    ...raw,
    nativeEvidenceIds: raw.nativeEvidence,
    nativeEvidence: Object.fromEntries(
      successful.map((row) => {
        assert.equal(row.native.id, row.id);
        assert.ok(
          row.native.observedCalls.length,
          `${row.id}: no native calls`,
        );
        return [row.id, row.native.observedCalls];
      }),
    ),
    qualifiedNativeEvidence: {},
    producer,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
