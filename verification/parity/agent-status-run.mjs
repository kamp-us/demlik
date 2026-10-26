import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { statusCases } from "./agent-status-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  sha = (v) => createHash("sha256").update(v).digest("hex");
export function agentStatusParity(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const all = statusCases();
  assert.equal(new Set(all.map((c) => c.id)).size, all.length);
  const cases = options.caseIds
    ? all.filter((c) => options.caseIds.includes(c.id))
    : all;
  if (options.caseIds) assert.equal(cases.length, options.caseIds.length);
  const binary =
      options.binary ??
      path.join(root, "target/debug/examples/agent_status_driver"),
    input = `${cases
      .map((c) => JSON.stringify({ id: c.id, input: c.input }))
      .join("\n")}\n`;
  const run = (p, args, data = input) => {
    const r = spawnSync(p, args, {
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
      .map((v) => JSON.parse(v));
  };
  const oracleArgs = [
      "--import",
      path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
      path.join(root, "verification/parity/agent-status-reference.mjs"),
    ],
    source = run(process.execPath, oracleArgs),
    native = run(binary, []);
  assert.equal(source.length, cases.length);
  assert.equal(native.length, cases.length);
  const failures = [],
    qualifiedObservations = [],
    nativeEvidence = {},
    nativeErrors = {};
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i],
      s = source[i],
      n = native[i];
    try {
      assert.equal(s.id, c.id);
      assert.equal(n.id, c.id);
      assert.equal(s.ok, true);
      if (c.qualification) {
        if (c.id === "agent-status.raw-usage-extra") {
          assert.equal(n.ok, true);
          const { observedCalls, ...actual } = n.output;
          assert.deepEqual(observedCalls, ["demlik_tea::agent::status"]);
          assert.notDeepEqual(actual, s.output);
          assert.ok(s.output.wire.includes('"extra"'));
          assert.ok(!actual.wire.includes('"extra"'));
        } else {
          assert.equal(n.ok, false);
          assert.deepEqual(n.observedCalls, []);
          assert.equal(typeof n.error, "string");
          assert.equal(s.output.kind, "failed");
        }
        qualifiedObservations.push({
          id: c.id,
          status: "OPEN",
          strictParity: false,
          reason: c.qualification,
          source: s,
          native: n,
        });
        continue;
      }
      assert.equal(n.ok, true);
      const { observedCalls, ...actual } = n.output;
      assert.deepEqual(actual, s.output);
      assert.deepEqual(observedCalls, ["demlik_tea::agent::status"]);
      if (c.id === "agent-status.precedence-done-absent") {
        assert.equal(actual.wire, '{"kind":"failed"}');
        assert.equal(actual.failureOwn, true);
        assert.equal(actual.failurePresence, "undefined");
      }
      if (c.id === "agent-status.cancel-null-cold")
        assert.equal(actual.wire, '{"kind":"cancelled","at":null}');
      if (c.id === "agent-status.suspended-empty-running") {
        assert.equal(actual.kind, "suspended");
        assert.equal(actual.pendingSame, true);
      }
      nativeEvidence[c.id] = observedCalls;
      if (actual.kind === "failed") nativeErrors[c.id] = actual;
    } catch (error) {
      failures.push({ id: c.id, message: error.message, source: s, native: n });
    }
  }
  const invalid = [
      { id: "missing-input" },
      { id: 1, input: { state: {} } },
      { id: "unknown", input: { state: {}, foreign: true } },
    ],
    bad = `${invalid.map((v) => JSON.stringify(v)).join("\n")}\n`,
    badSource = run(process.execPath, oracleArgs, bad),
    badNative = run(binary, [], bad);
  assert.ok(badSource.every((r) => !r.ok));
  assert.ok(badNative.every((r) => !r.ok && r.observedCalls.length === 0));
  const strict = cases.filter((c) => !c.qualification),
    report = {
      reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      node: process.version,
      v8: process.versions.v8,
      cases: strict.length,
      passed:
        strict.length -
        failures.filter((f) => !cases.find((c) => c.id === f.id).qualification)
          .length,
      protocolRefusals: invalid.length,
      failures,
      qualifiedObservations,
      nativeEvidence,
      nativeErrors,
      binarySha256: sha(fs.readFileSync(binary)),
      inputSha256: sha(input),
      sourceHashes: Object.fromEntries(
        [
          "packages/tea/src/agent/types.ts",
          "packages/tea/src/agent/internal.ts",
          "crates/tea/src/agent/status.rs",
          "crates/tea/src/agent/types.rs",
        ].map((f) => [f, sha(fs.readFileSync(path.join(root, f)))]),
      ),
      profile:
        "Pure canonical typed/known legacy-state projection. Suspended borrows the original Vec owner, including empty collections; its state snapshot must stay alive. Extracted terminal facts retain original Rc records independently. Source raw primitive/getter/prototype/extra-DTO profiles and all execution/optional construction remain qualified or outside this checkpoint.",
    };
  const out =
    options.reportFile ?? path.join(root, "target/parity/agent-status.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify(
        {
          cases: report.cases,
          passed: report.passed,
          qualified: qualifiedObservations.length,
          protocolRefusals: invalid.length,
          failures: failures
            .slice(0, 3)
            .map((f) => ({ id: f.id, message: f.message })),
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
  agentStatusParity();
