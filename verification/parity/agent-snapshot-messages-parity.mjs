import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotMessagesOpenId } from "./agent-snapshot-messages-cases.mjs";
import { agentSnapshotMessagesParity } from "./agent-snapshot-messages-run.mjs";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

export function agentSnapshotMessagesCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ??
      path.join(root, "target/parity/agent-snapshot-messages.json"),
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
    producer = buildTeaExample(
      cargo,
      "agent_snapshot_messages_driver",
      reportFile,
    );
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assertCheckPath(
      producer.libraries.demlik_tea.path,
      path.join(root, "target"),
    );
    binary = producer.binary;
  }
  const raw = agentSnapshotMessagesParity({ binary, output: reportFile });
  const report = normalizeAgentSnapshotMessagesReport(raw, producer);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function normalizeAgentSnapshotMessagesReport(raw, producer = null) {
  assert.equal(raw.cases, 10);
  assert.equal(raw.passed, 9);
  assert.equal(raw.strictTypedParityCredit, 0);
  assert.equal(raw.openCases, 1);
  assert.equal(raw.observations.length, 10);
  assert.equal(new Set(raw.observations.map((row) => row.id)).size, 10);
  assert.deepEqual(raw.nativeEvidence, {});
  assert.deepEqual(raw.literalFailures, []);
  const credited = raw.observations.filter((row) => row.equal === true);
  const open = raw.observations.filter((row) => row.equal === false);
  assert.equal(credited.length, 9);
  assert.equal(open.length, 1);
  assert.equal(open[0].id, snapshotMessagesOpenId);
  assert.equal(open[0].open, true);
  assert.deepEqual(
    raw.failures.map((row) => row.id),
    [snapshotMessagesOpenId],
  );
  assert.deepEqual(
    Object.keys(raw.qualifiedNativeEvidence),
    credited.map((row) => row.id),
  );
  for (const row of credited) {
    assert.equal(row.open, false);
    assert.ok(row.qualification.includes("TS2322"));
    assert.ok(row.qualification.includes("Reflect"));
    assert.equal(row.literals.source.passed, true);
    assert.equal(row.literals.native.passed, true);
    assert.equal(row.native.id, row.id);
    assert.ok(row.native.observedCalls.length);
    assert.deepEqual(
      raw.qualifiedNativeEvidence[row.id],
      row.native.observedCalls,
    );
  }
  return {
    ...raw,
    cases: credited.length,
    observations: credited.length,
    // run.mjs adds these two fields. Every admitted row is qualified.
    passed: 0,
    qualifiedPassed: credited.length,
    failures: [],
    creditedCaseIds: credited.map((row) => row.id),
    openObservations: open,
    comparisonFailures: raw.failures,
    raw,
    producer,
  };
}
