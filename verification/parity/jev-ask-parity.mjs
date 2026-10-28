import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCheckPath } from "./check-worktree.mjs";
import { cases, jevAskParity } from "./jev-ask-run.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const scope = JSON.parse(
  fs.readFileSync(new URL("./scope.json", import.meta.url)),
);
const expected = JSON.parse(
  fs.readFileSync(new URL("./jev-ask-admission.json", import.meta.url)),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const hashFile = (file) => hash(fs.readFileSync(file));
// Object storage order is immaterial; ordered arrays and exact wire strings remain values.
const ordered = (value) =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === "object"
      ? Object.keys(value)
          .sort()
          .map((key) => [key, ordered(value[key])])
      : value;
const digest = (value) => hash(JSON.stringify(ordered(value)));
const frames = (file) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

export function normalizeJevAskReport(raw, producer = null) {
  assert.deepEqual(
    { node: process.version, v8: process.versions.v8 },
    scope.referenceEngine,
  );
  assert.equal(raw.cases, 18);
  assert.equal(raw.passed, 18);
  assert.deepEqual(raw.failures, []);
  for (const key of [
    "qualified",
    "qualifiedPassed",
    "qualifiedEvidenceCases",
    "qualifiedNativeEvidence",
  ])
    assert.equal(Object.hasOwn(raw, key), false);
  assert.deepEqual(raw.sourcePins, expected.sourcePins);
  for (const [file, sha] of Object.entries(expected.sourcePins))
    assert.equal(hashFile(path.join(root, file)), sha);
  assert.equal(raw.fixtureHash, expected.fixtureHash);
  assert.equal(raw.inputsHash, expected.inputsHash);
  assert.equal(
    hashFile(path.join(root, "verification/parity/jev-ask-reference.mjs")),
    expected.fixtureHash,
  );
  assert.equal(
    hashFile(path.join(root, "verification/parity/jev-ask-cases.json.fixture")),
    expected.inputsHash,
  );
  assert.equal(
    hashFile(path.join(root, "crates/tea/examples/jev_ask_driver.rs")),
    expected.driverSha256,
  );
  assert.deepEqual(raw.qualifications, expected.qualifications);
  assert.deepEqual(raw.reference, {
    mode: "actual-Source",
    executionsThisRun: 1,
  });
  assert.match(raw.binary.sha256, /^[a-f0-9]{64}$/);
  assert.equal(hashFile(raw.binary.path), raw.binary.sha256);
  const ids = cases.map((row) => row.id);
  assert.equal(new Set(ids).size, 18);
  assert.deepEqual(
    expected.rows.map((row) => row.id),
    ids,
  );
  assert.deepEqual(
    raw.observations.map((row) => row.id),
    ids,
  );
  assert.deepEqual(Object.keys(raw.nativeEvidence), ids);
  assert.equal(raw.processes.length, 2);
  const [sourceProcess, nativeProcess] = raw.processes;
  for (const record of raw.processes) {
    assert.equal(record.exit, 0);
    assert.equal(record.signal, null);
    assert.equal(record.error, null);
    assert.equal(
      fs.readFileSync(record.stderr, "utf8"),
      "",
      "unexpected process diagnostics",
    );
  }
  assert.equal(path.basename(sourceProcess.command), "node");
  assert.equal(sourceProcess.args.length, 3);
  assert.equal(sourceProcess.args[0], "--import");
  assert.equal(path.basename(sourceProcess.args[2]), "jev-ask-reference.mjs");
  assert.equal(nativeProcess.command, raw.binary.path);
  assert.deepEqual(nativeProcess.args, []);
  const sourceFrames = frames(sourceProcess.stdout),
    nativeFrames = frames(nativeProcess.stdout);
  assert.equal(sourceFrames.length, 18);
  assert.equal(nativeFrames.length, 18);
  const evidence = {};
  for (const [index, row] of raw.observations.entries()) {
    const pin = expected.rows[index];
    assert.deepEqual(Object.keys(row).sort(), [
      "equal",
      "errors",
      "id",
      "native",
      "source",
    ]);
    assert.equal(row.equal, true);
    assert.deepEqual(row.errors, []);
    assert.deepEqual(cases[index], pin.input);
    assert.deepEqual(Object.keys(row.source).sort(), ["id", "ok", "output"]);
    assert.deepEqual(Object.keys(row.native).sort(), [
      "evidence",
      "id",
      "ok",
      "output",
    ]);
    assert.equal(row.source.id, row.id);
    assert.equal(row.source.ok, true);
    assert.equal(row.native.id, row.id);
    assert.equal(row.native.ok, true);
    assert.equal(
      digest(row.source.output),
      pin.viewSha256,
      `${row.id}: frozen Source view drift`,
    );
    assert.deepEqual(
      row.native.output,
      row.source.output,
      `${row.id}: whole wire/state view`,
    );
    assert.deepEqual(
      row.source,
      sourceFrames[index],
      `${row.id}: actual Source frame`,
    );
    assert.deepEqual(
      row.native,
      nativeFrames[index],
      `${row.id}: actual native frame`,
    );
    assert.equal(row.native.evidence.originalSame, true);
    const calls = row.native.evidence.nativeTrace;
    assert.ok(Array.isArray(calls) && calls.length > 0);
    assert.equal(
      digest(calls),
      pin.callsSha256,
      `${row.id}: actual compiled call drift`,
    );
    assert.deepEqual(raw.nativeEvidence[row.id], calls);
    for (const call of calls)
      assert.ok(typeof call === "string" && call.startsWith("demlik_tea::"));
    if (cases[index].kind === "factory") {
      assert.equal(row.native.evidence.stampChecks, pin.stampChecks);
      assert.equal(row.native.evidence.errorChecks, pin.errorChecks);
      assert.equal(
        row.native.evidence.stampChecks,
        row.native.output.settlements.length,
      );
      assert.ok(pin.stampChecks > 0);
      if (cases[index].scenario !== "named") assert.ok(pin.errorChecks > 0);
      assert.deepEqual(row.native.output.diagnostics, []);
    }
    evidence[`jev-ask.${row.id}`] = calls;
  }
  if (producer) {
    assert.equal(producer.binary, raw.binary.path);
    assert.equal(producer.binarySha256, raw.binary.sha256);
    if (producer.mode !== "external-binary") {
      assertCheckPath(producer.actualArtifact, path.join(root, "target"));
      assertCheckPath(
        producer.libraries.demlik_tea.path,
        path.join(root, "target"),
      );
      assertCheckPath(producer.source.path, root);
      assert.equal(hashFile(producer.source.path), expected.driverSha256);
      assert.equal(producer.source.sha256, expected.driverSha256);
      assert.equal(hashFile(producer.actualArtifact), producer.binarySha256);
      assert.equal(
        hashFile(producer.libraries.demlik_tea.path),
        producer.libraries.demlik_tea.sha256,
      );
      assert.equal(hashFile(producer.cargoJson), producer.cargoJsonSha256);
    }
  }
  return {
    cases: 18,
    observations: 18,
    passed: 18,
    qualifiedEvidenceCases: 0,
    qualifiedNativeEvidence: {},
    failures: [],
    nativeEvidence: evidence,
    binarySha256: raw.binary.sha256,
    sourcePins: raw.sourcePins,
    fixtureHash: raw.fixtureHash,
    inputsHash: raw.inputsHash,
    processes: raw.processes,
    qualifications: raw.qualifications,
    oracleLineage: expected.lineage,
    producer,
    raw,
  };
}

export function jevAskCheckpointParity(cargo, options = {}) {
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, `${key} must be unset`);
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/jev-ask.json"),
  );
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const producer = options.binary
    ? {
        mode: "external-binary",
        binary: path.resolve(options.binary),
        binarySha256: hashFile(path.resolve(options.binary)),
      }
    : buildTeaExample(cargo, "jev_ask_driver", reportFile);
  const before = hashFile(producer.binary);
  let raw, workerError, hashError;
  try {
    raw = jevAskParity(producer.binary, `${reportFile}.raw.json`);
  } catch (error) {
    workerError = error;
  }
  try {
    assert.equal(hashFile(producer.binary), before, "executed binary changed");
  } catch (error) {
    hashError = error;
  }
  if (workerError && hashError)
    throw new AggregateError(
      [workerError, hashError],
      "JevAsk worker and binary identity failed",
    );
  if (workerError || hashError) throw workerError ?? hashError;
  const result = normalizeJevAskReport(raw, producer);
  fs.writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
