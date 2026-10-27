import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentSnapshotGridParity } from "./agent-snapshot-grid-run.mjs";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

export function agentSnapshotCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/agent-snapshot.json"),
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
    producer = buildTeaExample(cargo, "agent_snapshot_grid_driver", reportFile);
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assertCheckPath(
      producer.libraries.demlik_tea.path,
      path.join(root, "target"),
    );
    binary = producer.binary;
  }
  const raw = agentSnapshotGridParity({ binary, output: reportFile });
  assert.equal(raw.cases, 18);
  assert.equal(raw.passed, 18);
  assert.equal(raw.observations.length, raw.cases);
  assert.equal(new Set(raw.observations.map((row) => row.id)).size, raw.cases);
  const strict = raw.observations.filter((row) => !row.qualification);
  const qualified = raw.observations.filter((row) => row.qualification);
  assert.equal(strict.length, 14);
  assert.equal(qualified.length, 4);
  for (const [rows, evidence] of [
    [strict, raw.nativeEvidence],
    [qualified, raw.qualifiedNativeEvidence],
  ]) {
    assert.deepEqual(
      Object.keys(evidence),
      rows.map((row) => row.id),
    );
    for (const row of rows) {
      assert.equal(row.equal, true);
      assert.equal(row.native.id, row.id);
      assert.ok(row.native.observedCalls.length, `${row.id}: no native calls`);
      assert.deepEqual(evidence[row.id], row.native.observedCalls);
    }
  }
  const report = { ...raw, observations: raw.cases, raw, producer };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
