import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSnapshotMessagesLiterals,
  assertSnapshotViewsEqual,
  hostEnvelopeQualification,
} from "./agent-snapshot-grid-run.mjs";
import { snapshotMessagesAdmissionData } from "./agent-snapshot-messages-admission-data.mjs";
import {
  agentSnapshotMessagesCases,
  snapshotMessagesOpenId,
  snapshotMessagesQualification,
} from "./agent-snapshot-messages-cases.mjs";
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
  assert.equal(raw.suite, "agent-snapshot-messages");
  assert.equal(raw.sourceOnly, false);
  assert.equal(raw.sourceUnchanged, true);
  assert.equal(raw.cases, 10);
  assert.equal(raw.passed, 10);
  assert.equal(raw.qualifiedPassed, 10);
  assert.equal(raw.strictTypedParityCredit, 0);
  assert.equal(raw.openCases, 0);
  assert.deepEqual(raw.nativeEvidence, {});
  assert.deepEqual(raw.failures, []);
  assert.deepEqual(raw.literalFailures, []);
  const ids = agentSnapshotMessagesCases.map((row) => row.id);
  assert.deepEqual(
    raw.observations.map((row) => row.id),
    ids,
  );
  assert.deepEqual(Object.keys(raw.qualifiedNativeEvidence), ids);
  assert.match(raw.binary?.sha256, /^[a-f0-9]{64}$/);
  if (producer) assert.equal(raw.binary.sha256, producer.binarySha256);
  assert.ok(
    !raw.openGaps.some(
      (gap) => typeof gap === "object" && gap.id === snapshotMessagesOpenId,
    ),
  );
  assert.equal(raw.processes.length, 24);
  const processKeys = new Set();
  for (const record of raw.processes) {
    assert.ok(record.kind === "source" || record.kind === "native");
    const expected = agentSnapshotMessagesCases.find(
      (row) => row.id === record.input.id,
    );
    assert.ok(expected);
    assert.ok(
      (expected.cold ? ["writer", "reader"] : ["main"]).includes(record.phase),
    );
    const { path: ownedPath, ...input } = record.input;
    assert.equal(typeof ownedPath, "string");
    assert.ok(ownedPath.length);
    assert.deepEqual(input, {
      id: expected.id,
      ...expected.input,
      mode: expected.cold ? record.phase : expected.input.mode,
    });
    assert.equal(record.status, 0);
    assert.equal(record.signal, null);
    assert.equal(record.error, null);
    assert.equal(
      record.binarySha256,
      record.kind === "native" ? raw.binary.sha256 : null,
    );
    const key = [record.input.id, record.kind, record.phase].join("|");
    assert.equal(processKeys.has(key), false);
    processKeys.add(key);
  }
  for (const [index, row] of raw.observations.entries()) {
    const expected = agentSnapshotMessagesCases[index];
    assert.deepEqual(row.input, expected.input);
    assert.deepEqual(row.expected, expected.expected);
    assert.equal(row.equal, true);
    assert.equal(row.difference, null);
    assert.equal(row.open, false);
    assert.equal(
      row.qualification,
      [
        snapshotMessagesQualification,
        ...(expected.hostEnvelope ? [hostEnvelopeQualification] : []),
      ].join(" "),
    );
    assert.deepEqual(row.literals, {
      source: { passed: true },
      native: { passed: true },
    });
    assertSnapshotMessagesLiterals(row.source, expected, "source");
    assertSnapshotMessagesLiterals(row.native, expected, "native");
    assert.deepEqual(
      row.wireChecks,
      assertSnapshotViewsEqual(row.source, row.native, expected.cold),
    );
    assert.equal(row.source.id, row.id);
    assert.equal(row.native.id, row.id);
    const wire = (expected.cold ? ["writer", "reader"] : ["main"]).map(
      (phase) => {
        const frame = expected.cold ? row.source.raw[phase] : row.source;
        return {
          phase,
          storeBytes: frame.storeBytes,
          namedBytes: frame.namedBytes,
        };
      },
    );
    const digest = createHash("sha256")
      .update(JSON.stringify({ view: row.source.view, wire }))
      .digest("hex");
    const frozen = snapshotMessagesAdmissionData[row.id];
    assert.equal(
      digest,
      frozen.sourceViewSHA256,
      `${row.id}: frozen whole Source comparison view`,
    );
    assert.deepEqual(row.native.observedCalls, frozen.nativeCalls);
    assert.deepEqual(
      raw.qualifiedNativeEvidence[row.id],
      row.native.observedCalls,
    );
  }
  return {
    ...raw,
    cases: 10,
    observations: 10,
    // Every admitted runtime-only row is qualified.
    passed: 0,
    qualifiedPassed: 10,
    failures: [],
    creditedCaseIds: ids,
    openObservations: [],
    comparisonFailures: [],
    raw,
    producer,
  };
}
