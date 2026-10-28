import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";
import { toolRouterCases } from "./tool-router-cases.mjs";
import { toolRouterEmptyCases } from "./tool-router-empty-cases.mjs";
import { toolRouterParity } from "./tool-router-run.mjs";
import { toolRouterSameNameCases } from "./tool-router-same-name-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = [
  ...toolRouterCases,
  ...toolRouterEmptyCases,
  ...toolRouterSameNameCases,
];
const groups = [
  ["source34", toolRouterCases, "tool-router-reference.mts"],
  ["source-empty3", toolRouterEmptyCases, "tool-router-empty-reference.mts"],
  [
    "source-same-name2",
    toolRouterSameNameCases,
    "tool-router-same-name-reference.mts",
  ],
];
const sourceFiles = [
  "packages/tea/src/agent/tool.ts",
  "packages/tea/src/agent/tool-cell.ts",
  "packages/tea/src/pure/core.ts",
  "packages/tea/src/describe-error.ts",
  "packages/tea/src/agent/content.ts",
];
const digest = /^[a-f0-9]{64}$/;
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function toolRouterCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/tool-router.json"),
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
    producer = buildTeaExample(cargo, "tool_router_driver", reportFile);
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assertCheckPath(
      producer.libraries.demlik_tea.path,
      path.join(root, "target"),
    );
    binary = producer.binary;
  }
  const raw = toolRouterParity({ binary, output: `${reportFile}.raw.json` });
  const report = normalizeToolRouterReport(raw, producer);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function observedPaths() {
  const source = fs.readFileSync(
    path.join(root, "crates/tea/examples/tool_router_driver.rs"),
    "utf8",
  );
  const calls = new Set(
    [...source.matchAll(/observe!\(\s*([A-Za-z_][A-Za-z0-9_:]+)\s*[,)]/g)].map(
      (match) => match[1],
    ),
  );
  assert.ok(calls.size, "tool driver has no actual observed public callsites");
  return calls;
}

function metadataRoot(raw) {
  if (!raw.metadataAssemblyOnly) return null;
  const retained = raw.actualProducer?.retained;
  assert.ok(typeof retained === "string" && !path.isAbsolute(retained));
  assert.ok(!retained.split(path.sep).includes(".."));
  assert.ok(raw.binary.endsWith(`${path.sep}${retained}`));
  const owner = raw.binary.slice(0, -retained.length);
  assert.equal(path.resolve(owner, retained), raw.binary);
  const binding = JSON.parse(
    fs.readFileSync(path.resolve(owner, raw.producerBinding), "utf8"),
  );
  assert.equal(binding.sameExecutedBytes, true);
  assert.equal(binding.productSourceUnchanged, true);
  assert.equal(binding.behaviorRerun, false);
  assert.equal(binding.passingProducerOverallExit, 0);
  assert.equal(binding.originalProducerOverallExit, 101);
  assert.equal(binding.binaryBefore.sha256, raw.binaryHash);
  assert.deepEqual(binding.binaryAfter, raw.actualProducer);
  assert.equal(binding.binaryAfter.sha256, raw.binaryHash);
  assert.equal(
    raw.actualNativeProcess.command[0],
    path.resolve(owner, binding.binaryBefore.retained),
  );
  return owner;
}

function logPath(file, owner) {
  assert.ok(typeof file === "string" && file.length);
  if (path.isAbsolute(file)) return file;
  assert.ok(owner, "relative logs require the recorded metadata owner");
  const resolved = path.resolve(owner, file);
  assertCheckPath(resolved, owner);
  return resolved;
}

function responses(record, owner) {
  assert.equal(record.status, 0, `${record.label}: failed process`);
  assert.ok(record.signal === undefined || record.signal === null);
  assert.ok(record.error === undefined || record.error === null);
  assert.equal(fs.readFileSync(logPath(record.stderr, owner), "utf8"), "");
  return fs
    .readFileSync(logPath(record.stdout, owner), "utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

export function normalizeToolRouterReport(raw, producer = null) {
  assert.equal(fixtures.length, 39);
  assert.equal(raw.cases, 39);
  assert.equal(raw.strictCases, 39);
  if (Object.hasOwn(raw, "passed")) assert.equal(raw.passed, 39);
  if (Object.hasOwn(raw, "qualifiedPassed"))
    assert.equal(raw.qualifiedPassed, 0);
  assert.deepEqual(raw.qualifiedCases, []);
  assert.deepEqual(raw.qualifiedNativeEvidence, {});
  assert.deepEqual(raw.failures, []);
  const scope = JSON.parse(
    fs.readFileSync(path.join(root, "verification/parity/scope.json"), "utf8"),
  );
  assert.deepEqual(raw.engine, scope.referenceEngine);
  assert.deepEqual(
    raw.sourceHashes,
    Object.fromEntries(
      sourceFiles.map((file) => [file, hash(path.join(root, file))]),
    ),
  );
  assert.ok(path.isAbsolute(raw.binary));
  assert.match(raw.binaryHash, digest);
  assert.equal(
    hash(raw.binary),
    raw.binaryHash,
    "native binary digest changed",
  );
  if (producer) {
    assert.equal(producer.binary, raw.binary);
    assert.equal(producer.binarySha256, raw.binaryHash);
    assert.equal(hash(producer.actualArtifact), raw.binaryHash);
    assert.match(producer.libraries.demlik_tea.sha256, digest);
    assert.equal(
      hash(producer.libraries.demlik_tea.path),
      producer.libraries.demlik_tea.sha256,
    );
    assert.equal(hash(producer.cargoJson), producer.cargoJsonSha256);
  }
  assert.deepEqual(
    raw.rows.map((row) => row.id),
    fixtures.map((row) => row.id),
  );
  assert.deepEqual(
    Object.keys(raw.nativeEvidence),
    fixtures.map((row) => row.id),
  );
  assert.deepEqual(
    raw.sourceOnlyObservations.ids,
    toolRouterSameNameCases.map((row) => row.id),
  );
  assert.equal(typeof raw.sourceOnlyObservations.profile, "string");
  assert.ok(raw.sourceOnlyObservations.profile.length);
  assert.equal(raw.sourceOnlyObservations.nativeCredit, 0);
  if (raw.metadataAssemblyOnly)
    assert.equal(raw.nativeOnlyChecks.sharedCredit, 0);
  else assert.equal(raw.newNativeOnlyCredit, 0);
  const allowed = observedPaths();
  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index],
      row = raw.rows[index];
    assert.deepEqual(
      row.input,
      fixture.input,
      `${fixture.id}: wrong fixture input`,
    );
    assert.equal(row.reference.id, fixture.id);
    assert.equal(row.native.id, fixture.id);
    assert.deepEqual(
      row.native.view,
      row.reference.view,
      `${fixture.id}: whole view differs`,
    );
    assert.ok(
      Array.isArray(row.native.nativeTrace) && row.native.nativeTrace.length,
    );
    for (const call of row.native.nativeTrace)
      assert.ok(
        allowed.has(call),
        `${fixture.id}: unobserved public call ${call}`,
      );
    assert.deepEqual(raw.nativeEvidence[fixture.id], row.native.nativeTrace);
    assert.equal(Object.hasOwn(row.native, "sourceOnly"), false);
    if (fixture.input.mode === "same-name")
      assert.deepEqual(row.reference.sourceOnly, { commandObjectSame: true });
  }
  const owner = metadataRoot(raw);
  assert.equal(raw.processRecords.length, 4);
  const processes = new Map();
  for (const record of raw.processRecords) {
    assert.ok(
      !processes.has(record.label),
      `duplicate process ${record.label}`,
    );
    processes.set(record.label, record);
  }
  for (const [label, cases, file] of groups) {
    const record = processes.get(label);
    assert.ok(record, `missing process ${label}`);
    processes.delete(label);
    assert.equal(record.command.length, 4);
    assert.equal(path.basename(record.command[0]), "node");
    assert.equal(record.command[1], "--import");
    assert.equal(path.basename(record.command[3]), file);
    assert.deepEqual(
      responses(record, owner),
      cases.map(
        (fixture) => raw.rows.find((row) => row.id === fixture.id).reference,
      ),
      `${label}: Source response/log mismatch`,
    );
  }
  const native = processes.get("native39");
  assert.ok(native, "missing native39 process");
  processes.delete("native39");
  assert.equal(processes.size, 0);
  assert.equal(native.command.length, 1);
  assert.equal(hash(native.command[0]), raw.binaryHash);
  assert.deepEqual(
    responses(native, owner),
    raw.rows.map((row) => row.native),
  );
  return {
    ...raw,
    passed: 39,
    qualifiedPassed: 0,
    failures: [],
    qualifiedNativeEvidence: {},
    sourceOnlyNativeCredit: 0,
    nativeOnlySharedCredit: 0,
    producer,
    raw,
  };
}
