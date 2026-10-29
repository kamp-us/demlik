import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
export function definedAgentResilienceParity(cargo, options = {}) {
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
    path.join(root, "target/parity/defined-agent-resilience-"),
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
    if (name === "source")
      assert.match(
        result.stderr,
        /^\(node:\d+\) ExperimentalWarning: The MockTimers API is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n$/,
      );
    else assert.equal(result.stderr, "");
    return result.stdout;
  }
  const source = execute("source", process.execPath, [
    "--import",
    path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
    path.join(root, "verification/parity/defined-agent-resilience-source.mts"),
  ]);
  const producer = buildTeaExample(
    cargo,
    "defined_agent_resilience",
    path.join(proof, "producer"),
  );
  const native = execute("native", producer.binary, []);
  const rows = (text) => text.trim().split("\n").map(JSON.parse);
  const expected = rows(source),
    actual = rows(native);
  assert.equal(expected.length, 12);
  assert.equal(actual.length, 12);
  const nativeEvidence = {},
    qualifiedNativeEvidence = {},
    results = [],
    qualifications = [];
  const temporal =
    /(?:^|\.)(at|clockMs|retryAtMs|chargingSinceMs|lastProgressAt|settledAt)$/;
  function compare(a, b, where, changes) {
    if (Object.is(a, b)) return;
    if (
      typeof a === "number" &&
      typeof b === "number" &&
      temporal.test(where)
    ) {
      assert(
        b >= a && b - a <= 3,
        `${where}: bounded measured Tokio scheduling difference`,
      );
      changes.push({ path: where, source: a, native: b });
      return;
    }
    if (Array.isArray(a)) {
      assert(Array.isArray(b), where);
      assert.equal(b.length, a.length, where);
      a.forEach((value, index) => {
        compare(value, b[index], `${where}[${index}]`, changes);
      });
      return;
    }
    if (a && typeof a === "object") {
      assert(b && typeof b === "object", where);
      assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), where);
      for (const [key, value] of Object.entries(a))
        compare(value, b[key], `${where}.${key}`, changes);
      return;
    }
    assert.deepEqual(b, a, where);
  }
  for (const [index, row] of expected.entries()) {
    const candidate = actual[index];
    assert.equal(candidate.id, row.id);
    const p = candidate.phase;
    const changes = [];
    assert.deepEqual(p.nativeTrace, [
      "demlik_tea::agent::DefineAgentConfig::new",
      ...(candidate.id === "unset"
        ? []
        : [
            candidate.id.startsWith("watchdog")
              ? "demlik_tea::agent::DefineAgentConfig::deadline_ms"
              : "demlik_tea::agent::DefineAgentConfig::retry",
          ]),
      "demlik_tea::agent::define_agent",
      "demlik_tea::agent::DefinedAgent::run",
    ]);
    assert.deepEqual(
      Object.keys(p).sort(),
      [...Object.keys(row.phase), "nativeTrace"].sort(),
    );
    for (const [key, value] of Object.entries(row.phase)) {
      if (key === "saveWires") {
        assert.equal(p.saveWires.length, value.length);
        value.forEach((wire, i) => {
          assert.deepEqual(JSON.parse(p.saveWires[i]), p.saves[i]);
          assert.deepEqual(JSON.parse(wire), row.phase.saves[i]);
          compare(
            JSON.parse(wire),
            JSON.parse(p.saveWires[i]),
            `saveWires[${i}]`,
            changes,
          );
        });
      } else if (key === "finalWire") {
        assert.deepEqual(JSON.parse(p.finalWire), p.final);
        compare(JSON.parse(value), JSON.parse(p.finalWire), key, changes);
      } else compare(value, p[key], key, changes);
    }
    if (changes.length === 0) {
      assert.deepEqual(p.saveWires, row.phase.saveWires);
      assert.equal(p.finalWire, row.phase.finalWire);
    }
    for (const saved of p.saves) {
      const call = saved.resilience.calls.act;
      if (call?.phase === "waiting_retry") {
        const attempt = saved.resilience.retry.act.attempt;
        assert.equal(
          call.retryAtMs,
          saved.resilience.clockMs + Math.min(20, 5 * 2 ** attempt),
          `${candidate.id}: durable backoff target`,
        );
      }
    }
    if (candidate.id === "watchdog-stall") {
      assert.deepEqual(p.final.run.failure, { reason: "deadline", at: 60 });
      assert.equal(p.final.failure, null);
      assert(p.settledAt > p.final.run.failure.at);
      assert.notEqual(p.finalWire, p.saveWires.at(-1));
    }
    const runtimeBudget =
      candidate.id.includes("duration") || candidate.id.startsWith("unbounded");
    const qualified = changes.length > 0 || runtimeBudget;
    const id = `tea.defined-agent-resilience.${candidate.id}`;
    (qualified ? qualifiedNativeEvidence : nativeEvidence)[id] = p.nativeTrace;
    if (qualified)
      qualifications.push({
        id,
        temporalDifferences: changes,
        untypedSourceBudget: runtimeBudget,
        reason:
          "Raw full states and wire strings retained. Only enumerated temporal numeric leaves differ under Node MockTimers versus Tokio paused-clock wake scheduling; duration/unbounded are runtime-only Source lid profiles.",
      });
    results.push({
      id,
      passed: !qualified,
      qualifiedPassed: qualified,
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
      path.join(
        root,
        "verification/parity/defined-agent-resilience-source.mts",
      ),
    ),
    nativeOwnerSha256: hash(path.join(root, "crates/tea/src/agent/defined.rs")),
    nativeConsumerSha256: hash(
      path.join(root, "crates/tea/examples/defined_agent_resilience.rs"),
    ),
    cases: 12,
    passed: results.filter((r) => r.passed).length,
    qualifiedPassed: results.filter((r) => r.qualifiedPassed).length,
    failures: [],
    nativeEvidence,
    qualifiedNativeEvidence,
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
      "Progress watchdog uses three model rounds and two unknown-tool rejections; stalled in-flight work finishes before the waiter resolves.",
      "Source lid retry type declares count-only policies; duration/unbounded fixtures explicitly exercise untyped JavaScript runtime forwarding.",
      "Native Tokio timer wakeups are measured separately from durable timer target timestamps; exact temporal parity is not claimed.",
    ],
    qualifications,
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
    JSON.stringify(definedAgentResilienceParity(process.env.CARGO ?? "cargo")),
  );
