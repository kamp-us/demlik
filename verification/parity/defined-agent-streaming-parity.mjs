import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export function definedAgentStreamingParity(cargo, options = {}) {
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
    path.join(root, "target/parity/defined-agent-streaming-"),
  );
  function execute(name, command, args) {
    const r = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
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
    if (name === "source") assert.equal(r.stderr, "");
    return r;
  }
  const source = execute("source", process.execPath, [
    "--import",
    path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
    path.join(root, "verification/parity/defined-agent-streaming-source.mts"),
  ]);
  const producer = buildTeaExample(
    cargo,
    "defined_agent_streaming",
    path.join(proof, "producer"),
  );
  const native = execute("native", producer.binary, []);
  const noticeLines = native.stderr.split("\n").filter(Boolean);
  for (const line of noticeLines)
    assert.match(
      line,
      /^(thread 'main' \(\d+\) panicked at crates\/tea\/examples\/defined_agent_streaming.rs:\d+:\d+:|progress defect|demlik: on_chunk listener panicked: progress defect|note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace)$/,
    );
  assert.equal(
    noticeLines.filter((line) => line.startsWith("thread 'main'")).length,
    6,
  );
  assert.equal(
    noticeLines.filter((line) => line === "progress defect").length,
    6,
  );
  assert.equal(
    noticeLines.filter(
      (line) => line === "demlik: on_chunk listener panicked: progress defect",
    ).length,
    6,
  );
  const rows = (text) => text.trim().split("\n").map(JSON.parse),
    expected = rows(source.stdout),
    actual = rows(native.stdout);
  assert.equal(expected.length, 9);
  assert.equal(actual.length, 9);
  const results = [],
    nativeEvidence = {},
    qualifiedNativeEvidence = {},
    qualifications = [];
  let saveWires = 0,
    finalWires = 0;
  for (const [i, row] of expected.entries()) {
    const candidate = actual[i];
    assert.equal(candidate.id, row.id);
    assert.deepEqual(
      Object.keys(candidate).sort(),
      [...Object.keys(row), "nativeTrace", "baselineTrace"].sort(),
    );
    for (const group of ["phases", "baseline"]) {
      assert.equal(candidate[group].length, row[group].length);
      for (const [j, phase] of row[group].entries()) {
        const value = candidate[group][j];
        assert.deepEqual(Object.keys(value).sort(), Object.keys(phase).sort());
        for (const [key, want] of Object.entries(phase)) {
          if (
            row.id === "throwing" &&
            group === "phases" &&
            key === "warnings"
          ) {
            assert.equal(want.length, 6);
            for (const warning of want)
              assert.deepEqual(warning, {
                message: "@demlik/tea: a run's onChunk listener threw",
                error: { name: "Error", message: "progress defect" },
              });
            assert.deepEqual(value.warnings, []);
          } else
            assert.deepEqual(
              value[key],
              want,
              `${row.id}.${group}[${j}].${key}: full raw view`,
            );
        }
        for (const [k, wire] of value.saveWires.entries()) {
          assert.deepEqual(JSON.parse(wire), value.saves[k]);
          saveWires++;
        }
        assert.deepEqual(JSON.parse(value.finalWire), value.final);
        finalWires++;
        assert.deepEqual(
          value.saveWires,
          candidate.baseline[j].saveWires,
          `${row.id}: streaming and plain durable bytes`,
        );
        assert.equal(value.finalWire, candidate.baseline[j].finalWire);
      }
    }
    for (const group of ["nativeTrace", "baselineTrace"]) {
      const baseline = group === "baselineTrace",
        trace = [
          baseline || row.id === "plain-sink"
            ? "demlik_tea::agent::model::plain_model"
            : "demlik_tea::agent::model::streaming_model",
          "demlik_tea::agent::DefineAgentConfig::new",
          "demlik_tea::agent::define_agent",
        ];
      for (let j = 0; j < row.phases.length; j++) {
        if (row.id === "raw" && !baseline)
          trace.push("demlik_tea::agent::DefinedAgent::machine");
        else {
          if (!baseline && row.id !== "omitted")
            trace.push("demlik_tea::agent::DefinedAgentRunOptions::on_chunk");
          trace.push("demlik_tea::agent::DefinedAgent::run");
        }
      }
      assert.deepEqual(candidate[group], trace);
    }
    const id = `tea.defined-agent-streaming.${row.id}`,
      qualified = row.id === "throwing";
    (qualified ? qualifiedNativeEvidence : nativeEvidence)[id] =
      candidate.nativeTrace;
    if (qualified)
      qualifications.push({
        id,
        paths: ["phases[0].warnings", "native.stderr"],
        sourceWarnings: row.phases[0].warnings,
        nativeWarnings: candidate.phases[0].warnings,
        nativeNoticeCounts: { defaultPanicHook: 6, containedNotice: 6 },
        reason:
          "Source console.warn receives six caught Error objects. Native catch_unwind contains six listener panics, whose standard panic hook and explicit containment notice are retained in raw stderr. Every other field and every durable wire matches exactly.",
      });
    results.push({
      id,
      passed: !qualified,
      qualifiedPassed: qualified,
      phases: row.phases.length,
      chunks: candidate.phases.map((p) => p.chunks.length),
      streamCalls: candidate.phases.map((p) => p.streamCalls),
    });
  }
  assert.equal(hash(producer.binary), producer.binarySha256);
  const libraryAfterSha256 = Object.fromEntries(
    Object.entries(producer.libraries).map(([name, library]) => {
      const after = hash(library.path);
      assert.equal(after, library.sha256);
      return [name, after];
    }),
  );
  const report = {
    status: "passed",
    reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
    engine: { node: process.version, v8: process.versions.v8 },
    sourceProductTree: execFileSync(
      "git",
      [
        "rev-parse",
        "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d:packages/tea/src",
      ],
      { cwd: root, encoding: "utf8" },
    ).trim(),
    authoredSourceSha256: hash(
      path.join(root, "verification/parity/defined-agent-streaming-source.mts"),
    ),
    nativeOwners: Object.fromEntries(
      ["model.rs", "defined.rs"].map((file) => [
        file,
        hash(path.join(root, "crates/tea/src/agent", file)),
      ]),
    ),
    nativeConsumerSha256: hash(
      path.join(root, "crates/tea/examples/defined_agent_streaming.rs"),
    ),
    cases: 9,
    passed: 8,
    qualifiedPassed: 1,
    failures: [],
    nativeEvidence,
    qualifiedNativeEvidence,
    rows: results,
    results,
    producer,
    executionBinary: producer.binary,
    rustBinarySha256: producer.binarySha256,
    binaryAfterSha256: hash(producer.binary),
    libraryAfterSha256,
    rawRecords: { proof },
    proof,
    qualifications,
    durableWireComparison: { saveWires, finalWires, exact: true },
    limitations: [
      "Contained listener panic diagnostics retain the actual Rust panic hook plus explicit notice; no global panic hook is changed.",
      "Retained-state resume is in-process canonical ownership, not decoded cold replay.",
      "Streaming is explicitly wrapped in Rust; no JavaScript arity/reflection equivalence claim.",
      "ModelKind remains Plain for the adapted callback, with no new enum variant.",
      "High-level run remains native-only at this base; Wasm checks portable machine/model compilation, not runtime panic unwinding.",
    ],
    globalParityCreditAdded: 0,
  };
  fs.writeFileSync(
    path.join(proof, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (options.reportFile)
    fs.writeFileSync(
      path.resolve(options.reportFile),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  return report;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(
    JSON.stringify(definedAgentStreamingParity(process.env.CARGO ?? "cargo")),
  );
