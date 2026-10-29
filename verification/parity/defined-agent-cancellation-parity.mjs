import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (p) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function compareCancellationRows(expected, actual) {
  assert.equal(expected.length, 9);
  assert.equal(actual.length, 9);
  let saveWires = 0,
    finalWires = 0;
  for (const [i, source] of expected.entries()) {
    const { nativeTrace, maxActive, ...native } = actual[i];
    assert.equal(native.id, source.id);
    assert.deepEqual(
      native,
      source,
      `${source.id}: complete actual workflow and exact wire bytes`,
    );
    assert.equal(
      maxActive,
      source.id.startsWith("concurrent")
        ? 3
        : ["serial-ok", "serial-typed", "omitted"].includes(source.id)
          ? 1
          : 0,
    );
    assert.deepEqual(nativeTrace, [
      "demlik_tea::agent::model::streaming_model",
      "demlik_tea::agent::DefineAgentConfig::new",
      "demlik_tea::agent::define_agent",
      ...(source.id === "omitted"
        ? []
        : ["demlik_tea::agent::DefinedAgentRunOptions::signal"]),
      "demlik_tea::agent::DefinedAgentRunOptions::store",
      "demlik_tea::agent::DefinedAgent::run",
      "demlik_tea::agent::DefinedAgent::run",
    ]);
    for (const wire of [...native.saveWires, ...native.resume.saveWires]) {
      JSON.parse(wire);
      saveWires++;
    }
    for (const wire of [native.finalWire, native.resume.finalWire]) {
      JSON.parse(wire);
      finalWires++;
    }
  }
  return { saveWires, finalWires, exact: true };
}
export function definedAgentCancellationParity(cargo, options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, key);
  assert.equal(
    options.binary,
    undefined,
    "execute actual Cargo-selected snapshot",
  );
  execFileSync(
    "git",
    [
      "diff",
      "--exit-code",
      "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      "--",
      "packages/tea/src",
      "packages/tea/package.json",
    ],
    { cwd: root },
  );
  assert.equal(
    execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", "packages/tea/src"],
      { cwd: root, encoding: "utf8" },
    ),
    "",
  );
  fs.mkdirSync(path.join(root, "target/parity"), { recursive: true });
  const proof = fs.mkdtempSync(
    path.join(root, "target/parity/defined-agent-cancellation-"),
  );
  function execute(name, command, args) {
    const r = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20000,
    });
    for (const stream of ["stdout", "stderr"])
      fs.writeFileSync(path.join(proof, `${name}.${stream}`), r[stream] ?? "");
    fs.writeFileSync(
      path.join(proof, `${name}.process.json`),
      JSON.stringify(
        {
          command: [command, ...args],
          status: r.status,
          signal: r.signal,
          error: r.error?.message ?? null,
        },
        null,
        2,
      ),
    );
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.signal, null);
    assert.equal(r.stderr, "");
    return r;
  }
  const source = execute("source", process.execPath, [
    "--import",
    path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
    path.join(
      root,
      "verification/parity/defined-agent-cancellation-source.mts",
    ),
  ]);
  const producer = buildTeaExample(
    cargo,
    "defined_agent_cancellation",
    path.join(proof, "producer"),
  );
  const native = execute("native", producer.binary, []);
  const rows = (s) => s.trim().split("\n").map(JSON.parse),
    expected = rows(source.stdout),
    actual = rows(native.stdout);
  const durableWireComparison = compareCancellationRows(expected, actual);
  const results = expected.map((r) => ({
    id: `defined-agent-cancellation/${r.id}`,
    passed: true,
  }));
  const libraryAfterSha256 = Object.fromEntries(
    Object.entries(producer.libraries).map(([name, library]) => {
      const after = hash(library.path);
      assert.equal(after, library.sha256);
      return [name, after];
    }),
  );
  const report = {
    suite: "defined-agent-cancellation",
    cases: 9,
    passed: 9,
    qualifiedPassed: 0,
    failures: [],
    results,
    rows: results,
    sourceSha256: hash(
      path.join(
        root,
        "verification/parity/defined-agent-cancellation-source.mts",
      ),
    ),
    nativeConsumerSha256: hash(
      path.join(root, "crates/tea/examples/defined_agent_cancellation.rs"),
    ),
    producer,
    proof,
    rawRecords: { proof },
    executionBinary: producer.binary,
    rustBinarySha256: producer.binarySha256,
    binaryAfterSha256: hash(producer.binary),
    libraryAfterSha256,
    durableWireComparison,
    nativeEvidence: Object.fromEntries(
      actual.map((r) => [`defined-agent-cancellation/${r.id}`, r]),
    ),
    qualifications: [
      "Abort request precedes its queued CANCELLED fold. Existing Source dispatch tail waits for held work; bare typed/thrown hooks run before cancellation folds. Queued settles then save unchanged cancelled states. All those wires are compared byte-exactly, not suppressed.",
      "The streaming callback remains owned by the original sink after abort/run resolution.",
    ],
    limitations: [
      "Native Agent.run only; Wasm compilation does not claim Wasm Agent.run.",
      "Retained-state in-process resume, not decoded cold Store replay.",
      "No generic cancellation of in-flight promises/futures or propagation into tool handlers.",
    ],
    globalParityCreditAdded: 0,
  };
  assert.equal(report.binaryAfterSha256, producer.binarySha256);
  fs.writeFileSync(
    path.join(proof, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (options.reportFile)
    fs.writeFileSync(
      options.reportFile,
      `${JSON.stringify(report, null, 2)}\n`,
    );
  return report;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    JSON.stringify(
      definedAgentCancellationParity(process.env.CARGO ?? "cargo"),
    ),
  );
