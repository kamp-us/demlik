import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
export function definedAgentGuardsParity(cargo, options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, key);
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
  assert.equal(
    options.binary,
    undefined,
    "this component always executes its Cargo-selected snapshot",
  );
  fs.mkdirSync(path.join(root, "target/parity"), { recursive: true });
  const proof = fs.mkdtempSync(
    path.join(root, "target/parity/defined-agent-guards-"),
  );
  function execute(name, command, args) {
    const result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    });
    fs.writeFileSync(path.join(proof, `${name}.stdout`), result.stdout ?? "");
    fs.writeFileSync(path.join(proof, `${name}.stderr`), result.stderr ?? "");
    fs.writeFileSync(
      path.join(proof, `${name}.process.json`),
      JSON.stringify(
        {
          command: [command, ...args],
          status: result.status,
          exit: result.status,
          signal: result.signal,
          error: result.error?.message ?? null,
        },
        null,
        2,
      ),
    );
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    return result.stdout;
  }
  const source = execute("source", process.execPath, [
    "--import",
    path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
    path.join(root, "verification/parity/defined-agent-guards-source.mts"),
  ]);
  const producer = buildTeaExample(
    cargo,
    "defined_agent_guards",
    path.join(proof, "producer"),
  );
  const native = execute("native", producer.binary, []);
  const rows = (text) => text.trim().split("\n").map(JSON.parse);
  const expected = rows(source),
    actual = rows(native);
  assert.equal(expected.length, 14);
  assert.equal(actual.length, 14);
  const nativeEvidence = {};
  for (const [index, expectedRow] of expected.entries()) {
    const candidate = actual[index];
    assert.equal(candidate.id, expectedRow.id);
    assert.deepEqual(
      Object.keys(candidate.phase).sort(),
      [...Object.keys(expectedRow.phase), "nativeTrace"].sort(),
    );
    for (const [key, value] of Object.entries(expectedRow.phase))
      assert.deepEqual(
        candidate.phase[key],
        value,
        `${candidate.id}: complete ${key}`,
      );
    const trace = candidate.phase.nativeTrace;
    assert.deepEqual(trace, [
      "demlik_tea::agent::DefineAgentConfig::new",
      "demlik_tea::agent::define_agent",
      `demlik_tea::agent::DefinedAgent::${
        candidate.id === "raw" ? "machine" : "run"
      }`,
    ]);
    nativeEvidence[`tea.defined-agent-guards.${candidate.id}`] = trace;
  }
  const results = [];
  for (const { id, phase: p } of actual) {
    const fails = !["unset", "nan", "stop", "resume-stop"].includes(id);
    assert.equal(p.outcome, fails ? "failed" : "resolved", id);
    if (fails)
      assert.equal(
        p.final.failure.reason,
        id.startsWith("elapsed") || id === "resume-elapsed"
          ? "elapsed_limit"
          : "turn_limit",
        id,
      );
    if (id === "zero" || id === "one") assert.equal(p.calls, 1, id);
    if (id.startsWith("resume-")) {
      assert.equal(p.calls, 0, id);
      assert.equal(p.final.run.startedAt, 50, id);
    }
    if (id.endsWith("before-stop")) assert.equal(p.predicates, 0, id);
    if (id === "stop" || id === "resume-stop") {
      assert.equal(p.final.run.phase, "cancelled");
      assert.equal(p.final.failure, null);
    }
    results.push({
      id: `tea.defined-agent-guards.${id}`,
      passed: true,
      calls: p.calls,
      saves: p.saves.length,
      outcome: p.outcome,
    });
  }
  const hash = (file) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  assert.equal(hash(producer.binary), producer.binarySha256);
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
      path.join(root, "verification/parity/defined-agent-guards-source.mts"),
    ),
    nativeOwnerSha256: hash(path.join(root, "crates/tea/src/agent/defined.rs")),
    nativeConsumerSha256: hash(
      path.join(root, "crates/tea/examples/defined_agent_guards.rs"),
    ),
    cases: 14,
    passed: 14,
    qualifiedPassed: 0,
    failures: [],
    nativeEvidence,
    qualifiedNativeEvidence: {},
    rows: results,
    results,
    producer,
    executionBinary: producer.binary,
    rustBinarySha256: producer.binarySha256,
    binaryAfterSha256: hash(producer.binary),
    rawRecords: { proof },
    proof,
    limitations: [
      "In-process canonical Store checkpoints; no decoded cold restart claim.",
      "Three unknown-tool rejections exercise tools versus model rounds; application tool host identity is covered by the existing six-job consumer.",
      "Guard policies only; deadline watchdog and other options are outside this slice.",
    ],
    qualifications: [],
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
    JSON.stringify(definedAgentGuardsParity(process.env.CARGO ?? "cargo")),
  );
