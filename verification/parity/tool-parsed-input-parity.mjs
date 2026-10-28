import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";
import { toolParsedInputCases as fixtures } from "./tool-parsed-input-cases.mjs";
import { toolParsedInputParity } from "./tool-parsed-input-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sourceFiles = [
  "packages/tea/src/agent/tool.ts",
  "packages/tea/src/agent/tool-cell.ts",
  "packages/tea/src/pure/core.ts",
];
const viewDigests = [
  "d5ceaa9da9474dae68a355d6d9b34c852a445811255527de7377297473213073",
  "8aa6428ee23f970b4c0e7182b3bd67bd0e856fde0eb4fd8cfbf95445879a7b4c",
  "16157ed8887f032c09af9ab9ba05e1deffc0a55831713be801a1b9aac59658e7",
  "ab73766434ade291393987e2f8ebf588fdc4a212acfae818752d01e43058c6e4",
  "16157ed8887f032c09af9ab9ba05e1deffc0a55831713be801a1b9aac59658e7",
  "ab73766434ade291393987e2f8ebf588fdc4a212acfae818752d01e43058c6e4",
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = (file) => sha(fs.readFileSync(file));
const expectedCalls = (fixture) => [
  ...Array(3).fill("demlik_tea::agent::tool::tool"),
  "invoices::Router::new",
  "demlik_tea::agent::tool::ToolDefinition::from_input",
  ...(fixture.input.mode === "edge"
    ? [
        "invoices::Router::interpret",
        "demlik_tea::command::CommandFamily::settle_in",
      ]
    : [
        "invoices::Router::update",
        "invoices::Router::interpreter",
        "demlik_tea::runtime::launch",
      ]),
  "invoices::Router::outcome_of",
];

export function toolParsedInputCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ??
      path.join(root, "target/parity/tool-parsed-input.json"),
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
    producer = buildTeaExample(cargo, "tool_parsed_input_driver", reportFile);
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assertCheckPath(
      producer.libraries.demlik_tea.path,
      path.join(root, "target"),
    );
    binary = producer.binary;
  }
  const before = hash(binary);
  let report, operationError, identityError;
  try {
    const raw = toolParsedInputParity({
      binary,
      output: `${reportFile}.raw.json`,
    });
    report = normalizeToolParsedInputReport(raw, producer);
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      assert.equal(
        hash(binary),
        before,
        "native binary changed during checkpoint",
      );
    } catch (error) {
      identityError = error;
    }
  }
  if (operationError && identityError)
    throw new AggregateError(
      [operationError, identityError],
      "parsed-input checkpoint failed",
    );
  if (operationError) throw operationError;
  if (identityError) throw identityError;
  return report;
}

function actualCalls() {
  const driver = fs.readFileSync(
    path.join(root, "crates/tea/examples/tool_parsed_input_driver.rs"),
    "utf8",
  );
  return new Set(
    [...driver.matchAll(/observe!\(\s*([A-Za-z_][A-Za-z0-9_:]+)\s*[,)]/g)].map(
      (match) => match[1],
    ),
  );
}

function responses(record) {
  assert.deepEqual(Object.keys(record).sort(), [
    "command",
    "error",
    "label",
    "signal",
    "status",
    "stderr",
    "stdout",
  ]);
  assert.equal(record.status, 0, `${record.label}: failed process`);
  assert.equal(record.signal, null);
  assert.equal(record.error, null);
  for (const name of ["stdout", "stderr"])
    assert.ok(
      typeof record[name] === "string" && path.isAbsolute(record[name]),
    );
  assert.equal(fs.readFileSync(record.stderr, "utf8"), "");
  return fs
    .readFileSync(record.stdout, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

export function normalizeToolParsedInputReport(raw, producer = null) {
  assert.equal(fixtures.length, 6);
  assert.equal(raw.sourceOnly, false);
  assert.equal(raw.sourceObservations, 6);
  assert.equal(raw.cases, 6);
  assert.equal(raw.strictCases, 6);
  assert.deepEqual(raw.failures, []);
  assert.deepEqual(raw.qualifiedCases, []);
  assert.deepEqual(raw.qualifiedNativeEvidence, {});
  assert.equal(raw.sourceOnlyCommandIdentityNativeCredit, 0);
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
  assert.ok(typeof raw.binary === "string" && path.isAbsolute(raw.binary));
  assert.match(raw.binaryHash, /^[a-f0-9]{64}$/);
  assert.equal(
    hash(raw.binary),
    raw.binaryHash,
    "native binary digest changed",
  );
  if (producer) {
    assert.equal(producer.binary, raw.binary);
    assert.equal(producer.binarySha256, raw.binaryHash);
    assert.equal(hash(producer.actualArtifact), raw.binaryHash);
    assert.match(producer.libraries.demlik_tea.sha256, /^[a-f0-9]{64}$/);
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
  const calls = actualCalls();
  for (const [index, fixture] of fixtures.entries()) {
    const row = raw.rows[index];
    assert.deepEqual(Object.keys(row).sort(), [
      "id",
      "input",
      "native",
      "reference",
    ]);
    assert.deepEqual(
      row.input,
      fixture.input,
      `${fixture.id}: fixture input changed`,
    );
    assert.deepEqual(Object.keys(row.reference).sort(), [
      "id",
      "sourceOnly",
      "view",
    ]);
    assert.deepEqual(Object.keys(row.native).sort(), [
      "id",
      "nativeTrace",
      "view",
    ]);
    assert.equal(row.reference.id, fixture.id);
    assert.equal(row.native.id, fixture.id);
    assert.deepEqual(row.reference.sourceOnly, { commandObjectSame: true });
    assert.equal(
      sha(JSON.stringify(row.reference.view)),
      viewDigests[index],
      `${fixture.id}: frozen Source wholeview changed`,
    );
    assert.deepEqual(
      row.native.view,
      row.reference.view,
      `${fixture.id}: wholeview differs`,
    );
    assert.deepEqual(row.native.nativeTrace, expectedCalls(fixture));
    for (const call of row.native.nativeTrace)
      assert.ok(
        calls.has(call),
        `${fixture.id}: unobserved public call ${call}`,
      );
    assert.deepEqual(raw.nativeEvidence[fixture.id], row.native.nativeTrace);
  }
  assert.equal(raw.processRecords.length, 2);
  const processes = new Map();
  for (const record of raw.processRecords) {
    assert.ok(
      !processes.has(record.label),
      `duplicate process ${record.label}`,
    );
    processes.set(record.label, record);
  }
  const source = processes.get("source6"),
    native = processes.get("native6");
  assert.ok(source && native);
  assert.equal(source.command.length, 4);
  assert.equal(path.basename(source.command[0]), "node");
  assert.equal(source.command[1], "--import");
  assert.equal(
    path.basename(source.command[3]),
    "tool-parsed-input-reference.mts",
  );
  assert.deepEqual(
    responses(source),
    raw.rows.map((row) => row.reference),
    "Source response/log mismatch",
  );
  assert.equal(native.command.length, 1);
  assert.equal(native.command[0], raw.binary);
  assert.equal(hash(native.command[0]), raw.binaryHash);
  assert.deepEqual(
    responses(native),
    raw.rows.map((row) => row.native),
    "native response/log mismatch",
  );
  return {
    ...raw,
    passed: 6,
    qualifiedPassed: 0,
    sourceOnlyNativeCredit: 0,
    nativeOnlySharedCredit: 0,
    runtimeRowsIncludedInSix: 2,
    producer,
    raw,
  };
}
