import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { baseCases } from "./agent-base-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  sha = (v) => createHash("sha256").update(v).digest("hex");
const prefix = "demlik_tea::agent::",
  getters = [
    `${prefix}Agent::current_stage`,
    `${prefix}Agent::is_settled`,
    `${prefix}Agent::subs`,
    `${prefix}status`,
  ];
function expected(test) {
  const calls = [
    `${prefix}AgentConfig::new`,
    `${prefix}create_agent`,
    `${prefix}Agent::init`,
    ...getters,
  ];
  for (const a of test.script.actions) {
    const method = {
      start: "start",
      turn: "turn",
      succeed: "succeed",
      fail: "fail",
      toolOk: "tool_ok",
      toolErr: a.error ? "tool_err" : "tool_err_reason",
      boot: "boot",
      cancel: "cancel",
      timer: "on_timer",
    }[a.op];
    if (method) calls.push(`${prefix}Agent::${method}`);
    calls.push(...getters);
  }
  return calls;
}
export function agentBaseParity(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const all = baseCases();
  assert.equal(new Set(all.map((c) => c.id)).size, all.length);
  const cases = options.caseIds
    ? all.filter((c) => options.caseIds.includes(c.id))
    : all;
  if (options.caseIds) assert.equal(cases.length, options.caseIds.length);
  const input = `${cases
      .map((c) => JSON.stringify({ id: c.id, script: c.script }))
      .join("\n")}\n`,
    binary =
      options.binary ??
      path.join(root, "target/debug/examples/agent_base_driver");
  function run(program, args, data = input) {
    const r = spawnSync(program, args, {
      cwd: root,
      input: data,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    return r.stdout
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
  }
  const source = run(process.execPath, [
      "--import",
      path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
      path.join(root, "verification/parity/agent-base-reference.mjs"),
    ]),
    native = run(binary, []);
  assert.equal(source.length, cases.length);
  assert.equal(native.length, cases.length);
  const failures = [],
    qualifiedObservations = [],
    nativeEvidence = {},
    nativeErrors = {};
  for (let i = 0; i < cases.length; i++) {
    const test = cases[i],
      left = source[i],
      right = native[i];
    try {
      assert.equal(left.id, test.id);
      assert.equal(right.id, test.id);
      assert.equal(left.ok, true);
      assert.equal(right.ok, true);
      const { observedCalls, ...actual } = right.output;
      if (test.qualification) {
        assert.ok(
          actual.snapshots.some(
            (s) => s.error?.name === "UnsupportedRestoredAgentProfile",
          ),
        );
        assert.notDeepEqual(actual, left.output);
        qualifiedObservations.push({
          id: test.id,
          status: "OPEN",
          strictParity: false,
          reason: test.qualification,
          source: left.output,
          native: actual,
          observedCalls,
        });
        continue;
      }
      assert.deepEqual(actual, left.output);
      assert.deepEqual(observedCalls, expected(test));
      if (test.id === "agent-base.three-stage-audit") {
        const snaps = actual.snapshots;
        assert.deepEqual(snaps[2].toolSources, [2]);
        assert.deepEqual(snaps[3].toolSources, [4]);
        assert.equal(snaps[9].state.run.phase, "done");
        assert.equal(snaps[9].outputRef, 3);
        assert.equal(snaps[10].state.run.runId, "restart");
      }
      if (test.id === "agent-base.cancel-late-retry")
        assert.equal(actual.snapshots[4].commands[0].type, "resilient_run");
      if (test.id === "agent-base.cancel-late-fail") {
        assert.equal(actual.snapshots[3].state.run.phase, "cancelled");
        assert.equal(actual.snapshots[3].state.failure.reason, "llm");
      }
      if (test.id.startsWith("agent-base.note-retention-")) {
        assert.equal(actual.snapshots[3].lifecycleRefs[0], 0);
        assert.equal(actual.snapshots[3].owners.lifecycle, false);
      }
      nativeEvidence[test.id] = observedCalls;
      const errors = actual.snapshots.filter(
        (s) => s.state.failure || s.state.run.phase === "failed",
      );
      if (errors.length) nativeErrors[test.id] = errors;
    } catch (error) {
      failures.push({
        id: test.id,
        message: error.message,
        source: left,
        native: right,
      });
    }
  }
  const invalid = [
    { id: "unknown", script: { config: {}, actions: [{ op: "unknown" }] } },
    { id: "time", script: { config: {}, actions: [{ op: "start" }] } },
    {
      id: "result",
      script: { config: {}, actions: [{ op: "toolOk", id: "a", at: 0 }] },
    },
    { id: "config", script: { config: { snapshotEvery: 1 }, actions: [] } },
    { id: "null-config", script: { config: null, actions: [] } },
    { id: "null-stage", script: { config: { stages: null }, actions: [] } },
    {
      id: "turn",
      script: {
        config: {},
        actions: [
          {
            op: "turn",
            at: 0,
            turn: { content: "x", toolCalls: [], unknown: true },
          },
        ],
      },
    },
    { id: 7, script: { config: {}, actions: [] } },
  ];
  const invalidInput = `${invalid.map((v) => JSON.stringify(v)).join("\n")}\n`;
  const rejectedSource = run(
      process.execPath,
      [
        "--import",
        path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
        path.join(root, "verification/parity/agent-base-reference.mjs"),
      ],
      invalidInput,
    ),
    rejectedNative = run(binary, [], invalidInput);
  assert.ok(rejectedSource.every((v) => !v.ok));
  assert.ok(rejectedNative.every((v) => !v.ok && v.observedCalls.length === 0));
  const strict = cases.filter((c) => !c.qualification),
    report = {
      reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      node: process.version,
      v8: process.versions.v8,
      cases: strict.length,
      protocolRefusals: invalid.length,
      passed:
        strict.length -
        failures.filter((f) => !cases.find((c) => c.id === f.id).qualification)
          .length,
      actions: strict.reduce((n, c) => n + c.script.actions.length, 0),
      failures,
      qualifiedObservations,
      nativeEvidence,
      nativeErrors,
      inputSha256: sha(input),
      binarySha256: sha(fs.readFileSync(binary)),
      sourceHashes: Object.fromEntries(
        [
          "packages/tea/src/agent/index.ts",
          "packages/tea/src/agent/machine.ts",
          "packages/tea/src/agent/types.ts",
          "packages/tea/src/agent/internal.ts",
          "packages/tea/src/agent/tool-resilience.ts",
          "crates/tea/src/agent/types.rs",
          "crates/tea/src/agent/knob.rs",
          "crates/tea/src/agent/knob/command.rs",
          "crates/tea/src/agent/knob/error.rs",
        ].map((f) => [f, sha(fs.readFileSync(path.join(root, f)))]),
      ),
      profile:
        "Base pure knob only: trusted typed Rc output with borrowed turn projection, bare tools/concurrency, retry/watchdog/usage/guards/notes/boot/restart/cancel. Actual replay constructors, no interpreter/Runtime/SDK. Wire snapshots compare JSON values with separate original-owner observations, not generic JS object behavior. Raw builtin schema, optional restored profiles, default-null convenience, native panic-vs-JS throws, and brainInterpret/toMachine/router/optional features remain OPEN/outside this checkpoint.",
    };
  const out =
    options.reportFile ?? path.join(root, "target/parity/agent-base.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify(
        {
          cases: report.cases,
          passed: report.passed,
          actions: report.actions,
          qualified: qualifiedObservations.length,
          failures: failures
            .slice(0, 6)
            .map(({ id, message }) => ({ id, message: message.slice(0, 600) })),
          report: out,
        },
        null,
        2,
      ),
    );
  if (!options.allowFailures) assert.deepEqual(failures, []);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  agentBaseParity();
