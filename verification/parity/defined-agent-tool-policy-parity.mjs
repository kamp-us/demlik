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
export function definedAgentToolPolicyParity(cargo, options = {}) {
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
    path.join(root, "target/parity/defined-agent-tool-policy-"),
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
    if (name === "source")
      assert.match(
        r.stderr,
        /^\(node:\d+\) ExperimentalWarning: The MockTimers API is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n$/,
      );
    else assert.equal(r.stderr, "");
    return r.stdout;
  }
  const source = execute("source", process.execPath, [
    "--import",
    path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
    path.join(root, "verification/parity/defined-agent-tool-policy-source.mts"),
  ]);
  const producer = buildTeaExample(
    cargo,
    "defined_agent_tool_policy",
    path.join(proof, "producer"),
  );
  const native = execute("native", producer.binary, []);
  const rows = (text) => text.trim().split("\n").map(JSON.parse),
    expected = rows(source),
    actual = rows(native);
  assert.equal(expected.length, 12);
  assert.equal(actual.length, 12);
  const results = [],
    nativeEvidence = {},
    qualifiedNativeEvidence = {},
    qualifications = [];
  const temporal =
    /(?:^|\.)(at|settledAt|clockMs|lastProgressAt|firstFailureAtMs|retryAtMs|chargingSinceMs|remainingMs|enqueuedAt|startedAt|lastRefillMs)$/;
  function compare(a, b, where, changes) {
    if (Object.is(a, b)) return;
    if (
      typeof a === "number" &&
      typeof b === "number" &&
      temporal.test(where)
    ) {
      assert(
        Math.abs(b - a) <= 5,
        `${where}: measured Tokio wake offset exceeds five accumulated waits`,
      );
      if (!where.endsWith("remainingMs")) assert(b >= a, where);
      changes.push({ path: where, source: a, native: b });
      return;
    }
    if (Array.isArray(a)) {
      assert(Array.isArray(b), where);
      assert.equal(b.length, a.length, where);
      a.forEach((v, i) => {
        compare(v, b[i], `${where}[${i}]`, changes);
      });
      return;
    }
    if (a && typeof a === "object") {
      assert(b && typeof b === "object", where);
      assert.deepEqual(Object.keys(b).sort(), Object.keys(a).sort(), where);
      for (const [k, v] of Object.entries(a))
        compare(v, b[k], `${where}.${k}`, changes);
      return;
    }
    assert.deepEqual(b, a, where);
  }
  for (const [i, row] of expected.entries()) {
    const candidate = actual[i];
    assert.equal(candidate.id, row.id);
    assert.equal(candidate.phases.length, row.phases.length);
    const changes = [];
    candidate.phases.forEach((phase, j) => {
      const { nativeTrace, ...values } = phase,
        source = row.phases[j];
      assert.deepEqual(nativeTrace, [
        "demlik_tea::agent::DefineAgentConfig::new",
        ...(["free-serial", "timeout-serial"].includes(row.id)
          ? []
          : ["demlik_tea::agent::DefineAgentConfig::tool_concurrency"]),
        "demlik_tea::agent::define_agent",
        "demlik_tea::agent::DefinedAgent::run",
      ]);
      assert.deepEqual(Object.keys(values).sort(), Object.keys(source).sort());
      for (const [key, value] of Object.entries(source)) {
        if (key === "saveWires") {
          assert.equal(values.saveWires.length, value.length);
          value.forEach((wire, k) => {
            assert.deepEqual(JSON.parse(wire), source.saves[k]);
            assert.deepEqual(JSON.parse(values.saveWires[k]), values.saves[k]);
            compare(
              JSON.parse(wire),
              JSON.parse(values.saveWires[k]),
              `phases[${j}].saveWires[${k}]`,
              changes,
            );
          });
        } else if (key === "finalWire") {
          assert.deepEqual(JSON.parse(values.finalWire), values.final);
          compare(
            JSON.parse(value),
            JSON.parse(values.finalWire),
            `phases[${j}].finalWire`,
            changes,
          );
        } else compare(value, values[key], `phases[${j}].${key}`, changes);
      }
      for (const candidate of [source, values]) {
        const targets = new Map();
        if (row.id.startsWith("timeout")) {
          for (const saved of candidate.saves) {
            for (const [key, call] of Object.entries(
              saved.toolResilience.policy?.calls ?? {},
            )) {
              if (!call.budget) continue;
              const target =
                call.budget.remainingMs + call.budget.chargingSinceMs;
              if (!targets.has(key)) targets.set(key, target);
              assert.equal(
                target,
                targets.get(key),
                `${row.id}: one overall timeout across retries`,
              );
            }
          }
          for (const event of candidate.events)
            if (event.type === "ToolFailed")
              assert.equal(
                event.at,
                targets.get(`$tool:policy#${event.callId}`),
                `${row.id}: failure uses original deadline target`,
              );
        }
      }
      if (changes.length === 0) {
        assert.deepEqual(values.saveWires, source.saveWires);
        assert.equal(values.finalWire, source.finalWire);
      }
    });
    const id = `tea.defined-agent-tool-policy.${row.id}`,
      qualified = changes.length > 0;
    (qualified ? qualifiedNativeEvidence : nativeEvidence)[id] =
      candidate.phases.flatMap((p) => p.nativeTrace);
    if (qualified)
      qualifications.push({
        id,
        temporalDifferences: changes,
        reason:
          "Raw full states and wire strings retained. Tokio paused-clock sleep/timer wakes add one logical tick per wait, accumulating through bounded waves; only enumerated numeric time and remaining-budget leaves differ.",
      });
    results.push({
      id,
      passed: !qualified,
      qualifiedPassed: qualified,
      phases: candidate.phases.length,
      attempts: candidate.phases.map((p) => p.attempts),
      hookPending: candidate.phases.map((p) => p.hookPending),
    });
  }
  const missing = rows(
    execute("missing-family", producer.binary, ["--missing-family"]),
  );
  assert.equal(missing.length, 1);
  assert.equal(missing[0].typedError, "MissingFailureFamily");
  assert.equal(missing[0].modelCalls, 1);
  assert.equal(missing[0].errorReports, 2);
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
      path.join(
        root,
        "verification/parity/defined-agent-tool-policy-source.mts",
      ),
    ),
    nativeOwnerSha256: hash(path.join(root, "crates/tea/src/agent/defined.rs")),
    nativeConsumerSha256: hash(
      path.join(root, "crates/tea/examples/defined_agent_tool_policy.rs"),
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
    libraryAfterSha256,
    rawRecords: { proof },
    proof,
    qualifications,
    limitations: [
      "In-process canonical state resume, no decoded cold replay claim.",
      "Generated Errors enum gains Resilience(ToolPolicyFailure); opaque declared payloads retain original owners without blanket traits.",
      "Source serial handler/tail ordering can delay timeout processing until pending work returns. Late work stays retained and is ignored by the ladder, never cancelled.",
      "Bare hooks are awaited; final ladder hooks start once after fold and may remain pending beyond run completion, as Source.",
      "Frozen Source recognizes ladder ownership at the interpret seam by command type: malformed calls use tool_rejected, so rejected attempts fire bare hooks and the final exhaustion also fires a ladder hook. The malformed-retry case preserves this six-hook behavior.",
    ],
    nativeLifecycle: { missingConstructorsTyped: true },
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
    JSON.stringify(definedAgentToolPolicyParity(process.env.CARGO ?? "cargo")),
  );
