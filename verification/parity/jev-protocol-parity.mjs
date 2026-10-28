import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCheckPath } from "./check-worktree.mjs";
import { jevProtocolParity } from "./jev-protocol-run.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const scope = JSON.parse(
  fs.readFileSync(new URL("./scope.json", import.meta.url)),
);
const expected = JSON.parse(
  fs.readFileSync(new URL("./jev-protocol-admission.json", import.meta.url)),
);
const cases = JSON.parse(
  fs.readFileSync(
    new URL("./jev-protocol-cases.json.fixture", import.meta.url),
  ),
);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const hashFile = (file) => hash(fs.readFileSync(file));
// Ignore ordinary object storage order; exact JSON wire strings remain values.
const ordered = (value) =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === "object"
      ? Object.keys(value)
          .sort()
          .map((key) => [key, ordered(value[key])])
      : value;
const digest = (value) => hash(JSON.stringify(ordered(value)));
const sha256 = /^[a-f0-9]{64}$/;

export function normalizeJevProtocolReport(raw, producer = null) {
  assert.deepEqual(
    { node: process.version, v8: process.versions.v8 },
    scope.referenceEngine,
  );
  assert.equal(raw.cases, 24);
  assert.equal(raw.passed, 24);
  assert.equal(raw.qualified, 0);
  assert.deepEqual(raw.failures, []);
  assert.deepEqual(raw.qualifiedNativeEvidence, {});
  assert.deepEqual(raw.reference, {
    Source: scope.reference,
    ...scope.referenceEngine,
  });
  assert.deepEqual(raw.sourceHashes, expected.sourceHashes);
  for (const [file, pin] of Object.entries(expected.sourceHashes))
    assert.equal(
      hashFile(path.join(root, file)),
      pin,
      `Source/fixture bytes: ${file}`,
    );
  assert.equal(
    hashFile(path.join(root, "crates/tea/examples/jev_protocol_driver.rs")),
    expected.driverSha256,
  );
  assert.match(raw.binarySha256, sha256);
  const ids = cases.map((row) => row.id);
  assert.equal(ids.length, 24);
  assert.deepEqual(
    expected.rows.map((row) => row.id),
    ids,
  );
  assert.deepEqual(
    raw.rows.map((row) => row.id),
    ids,
  );
  assert.deepEqual(Object.keys(raw.nativeEvidence), ids);
  for (const [index, row] of raw.rows.entries()) {
    const pin = expected.rows[index];
    assert.equal(row.equal, true);
    assert.equal(
      hash(JSON.stringify(row.input)),
      pin.inputSha256,
      `${row.id}: input drift`,
    );
    assert.equal(
      digest(row.reference),
      pin.viewSha256,
      `${row.id}: frozen Source view drift`,
    );
    assert.deepEqual(
      row.native.output,
      row.reference,
      `${row.id}: whole output/wire/numeric view`,
    );
    assert.equal(row.native.id, row.id);
    assert.ok(
      Array.isArray(row.native.observedCalls) &&
        row.native.observedCalls.length,
    );
    assert.equal(
      digest(row.native.observedCalls),
      pin.callsSha256,
      `${row.id}: actual call drift`,
    );
    for (const call of row.native.observedCalls)
      assert.match(call, /^demlik_tea::jev::(?:protocol|reply)::[a-z_]+$/);
    assert.deepEqual(raw.nativeEvidence[row.id], row.native.observedCalls);
  }
  for (const process of [raw.sourceProcess, raw.nativeProcess]) {
    assert.equal(process.status, 0);
    assert.equal(process.signal, null);
    assert.ok(Array.isArray(process.command) && process.command.length);
    assert.equal(
      fs.readFileSync(process.stderr, "utf8"),
      "",
      "unexpected process diagnostics",
    );
  }
  assert.equal(
    fs.readFileSync(raw.sourceProcess.stdout, "utf8"),
    "",
    "unexpected Source launcher stdout",
  );
  assert.equal(raw.nativeProcess.responses, 24);
  assert.equal(raw.nativeProcess.command.length, 1);
  assert.equal(raw.sourceProcess.command.length, 5);
  assert.equal(raw.sourceProcess.command[1], "--import");
  assert.equal(
    path.basename(raw.sourceProcess.command[3]),
    "jev-protocol-reference.mjs",
  );
  assert.equal(raw.sourceProcess.command[4], raw.sourceProcess.report);
  const source = JSON.parse(fs.readFileSync(raw.sourceProcess.report, "utf8"));
  assert.equal(source.reference, scope.reference);
  assert.deepEqual({ node: source.node, v8: source.v8 }, scope.referenceEngine);
  assert.equal(source.cases, 24);
  assert.deepEqual(
    source.sourceHashes,
    Object.fromEntries(
      Object.entries(expected.sourceHashes).filter(([file]) =>
        file.startsWith("packages/"),
      ),
    ),
  );
  assert.deepEqual(
    source.rows.map((row) => row.id),
    ids,
  );
  const frames = fs
    .readFileSync(raw.nativeProcess.stdout, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.equal(frames.length, 24);
  for (const [index, row] of raw.rows.entries()) {
    assert.deepEqual(source.rows[index].input, row.input);
    assert.deepEqual(source.rows[index].view, row.reference);
    assert.deepEqual(
      frames[index],
      row.native,
      `${row.id}: actual stdout frame`,
    );
  }
  assert.deepEqual(raw.limits, expected.limits);
  if (producer) {
    assert.equal(producer.binarySha256, raw.binarySha256);
    assert.equal(producer.binary, raw.nativeProcess.command[0]);
    assert.equal(hashFile(producer.binary), producer.binarySha256);
    if (producer.mode !== "external-binary") {
      assertCheckPath(producer.actualArtifact, path.join(root, "target"));
      assertCheckPath(
        producer.libraries.demlik_tea.path,
        path.join(root, "target"),
      );
      assertCheckPath(producer.source.path, root);
      assert.equal(producer.source.sha256, expected.driverSha256);
      assert.equal(
        hashFile(producer.libraries.demlik_tea.path),
        producer.libraries.demlik_tea.sha256,
      );
    }
  }
  return {
    cases: 24,
    observations: 24,
    passed: 24,
    qualifiedEvidenceCases: 0,
    qualifiedNativeEvidence: {},
    failures: [],
    nativeEvidence: raw.nativeEvidence,
    reference: raw.reference,
    binarySha256: raw.binarySha256,
    processes: [raw.sourceProcess, raw.nativeProcess],
    qualifications: raw.limits,
    oracleLineage: expected.lineage,
    producer,
    raw,
  };
}

export function jevProtocolCheckpointParity(cargo, options = {}) {
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, `${key} must be unset`);
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/jev-protocol.json"),
  );
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  let producer;
  if (options.binary) {
    const binary = path.resolve(options.binary);
    producer = {
      mode: "external-binary",
      binary,
      binarySha256: hashFile(binary),
    };
  } else {
    producer = buildTeaExample(cargo, "jev_protocol_driver", reportFile);
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assertCheckPath(
      producer.libraries.demlik_tea.path,
      path.join(root, "target"),
    );
  }
  const before = hashFile(producer.binary);
  let result;
  let workerError;
  try {
    result = jevProtocolParity(producer.binary, `${reportFile}.raw.json`);
  } catch (error) {
    workerError = error;
  }
  let hashError;
  try {
    assert.equal(hashFile(producer.binary), before, "executed binary changed");
  } catch (error) {
    hashError = error;
  }
  if (workerError && hashError)
    throw new AggregateError(
      [workerError, hashError],
      "Jev worker and binary identity failed",
    );
  if (workerError) throw workerError;
  if (hashError) throw hashError;
  const report = normalizeJevProtocolReport(result, producer);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
