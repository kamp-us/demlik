import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  prerequisiteCases,
  prerequisiteQualifiedCases,
} from "./agent-state-prerequisite-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url),
  hash = (x) => createHash("sha256").update(x).digest("hex");
const prefix = "demlik_tea::agent::";
const called = (t) =>
  t.operation === "defaults"
    ? [
        `${prefix}conversation::shared_no_usage`,
        `${prefix}conversation::shared_no_usage`,
      ]
    : t.operation === "copy"
      ? ["std::clone::Clone::clone"]
      : t.operation === "sum"
        ? [`${prefix}types::is_turn_usage`, `${prefix}conversation::add_usage`]
        : [`${prefix}conversation::fold_summary`];
export async function prerequisiteParity(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const binary =
    options.binary ??
    path.join(root, "target/debug/examples/agent_state_prerequisite_driver");
  const all = prerequisiteCases();
  assert.equal(new Set(all.map((x) => x.id)).size, all.length);
  const cases = options.caseIds
    ? all.filter((x) => options.caseIds.includes(x.id))
    : all;
  if (options.caseIds) assert.equal(cases.length, options.caseIds.length);
  const input = `${cases.map(({ id, operation, input }) => JSON.stringify({ id, operation, input })).join("\n")}\n`;
  const run = (program, args, data = input) => {
    const r = spawnSync(program, args, {
      cwd: root,
      input: data,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    return r.stdout
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
  };
  const source = run(process.execPath, [
      "--import",
      require.resolve("tsx"),
      path.join(
        root,
        "verification/parity/agent-state-prerequisite-reference.mts",
      ),
    ]),
    native = run(binary, []);
  assert.equal(source.length, cases.length);
  assert.equal(native.length, cases.length);
  const failures = [],
    nativeEvidence = {};
  for (let i = 0; i < cases.length; i++) {
    const t = cases[i],
      a = source[i],
      b = native[i];
    try {
      assert.equal(a.id, t.id);
      assert.equal(b.id, t.id);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      const project = (out) => {
        if (t.scope !== "wire-identity") return out;
        const { before, after, ...owners } = out;
        return {
          before: { json: before.json },
          after: { json: after.json },
          ...owners,
        };
      };
      assert.deepEqual(project(b.output), project(a.output));
      assert.deepEqual(b.observedCalls, called(t));
      if (t.id.endsWith("sum-null-required"))
        assert.equal(b.output.sum.json, '{"inputTokens":2,"outputTokens":3}');
      if (t.id.endsWith("sum-null-optional")) {
        assert.equal(
          b.output.sum.json,
          '{"inputTokens":0,"outputTokens":2,"reasoningTokens":0}',
        );
        assert.equal(b.output.leftGuard, false);
      }
      if (t.id.endsWith("fold-0-null")) {
        assert.deepEqual(b.output.originalIndices, [0, 1]);
        assert.deepEqual(
          b.output.after.value.toolRecords.map((x) => x.turn),
          [1, 3],
        );
        assert.equal(b.output.after.value.turnCount, null);
        assert.equal(b.output.legacyAfter, "null");
      }
      nativeEvidence[t.id] = [...new Set(b.observedCalls)];
    } catch (error) {
      failures.push({ id: t.id, message: error.message, source: a, native: b });
    }
  }
  const qualifiedObservations = [];
  if (!options.caseIds) {
    const rows = prerequisiteQualifiedCases(),
      data = `${rows.map((x) => JSON.stringify(x)).join("\n")}\n`,
      left = run(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          path.join(
            root,
            "verification/parity/agent-state-prerequisite-reference.mts",
          ),
        ],
        data,
      ),
      right = run(binary, [], data);
    assert.equal(left.length, 1);
    assert.equal(right.length, 1);
    assert.equal(left[0].id, rows[0].id);
    assert.equal(right[0].id, rows[0].id);
    assert.equal(left[0].ok, true);
    assert.equal(right[0].ok, true);
    assert.equal(left[0].output.before.json, right[0].output.before.json);
    assert.notDeepEqual(
      left[0].output.before.value,
      right[0].output.before.value,
    );
    assert.ok(!Object.hasOwn(nativeEvidence, rows[0].id));
    qualifiedObservations.push({
      id: rows[0].id,
      status: "QUALIFIED",
      strictParity: false,
      source: left[0].output,
      native: right[0].output,
      reason:
        "A missing undefined tool-result property is recovered as the typed Undefined value. JSON wire and original owners agree; raw own-result-property reflection is outside this native typed owner profile.",
    });
  }
  const report = {
    reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
    node: process.version,
    v8: process.versions.v8,
    cases: cases.length,
    passed: cases.length - failures.length,
    failures,
    nativeEvidence,
    qualifiedObservations,
    inputSha256: hash(input),
    binarySha256: hash(fs.readFileSync(binary)),
    sourceHashes: Object.fromEntries(
      [
        "packages/tea/src/agent/internal.ts",
        "packages/tea/src/agent/types.ts",
        "crates/tea/src/agent/types.rs",
        "crates/tea/src/agent/conversation.rs",
        "crates/tea/src/agent/wire.rs",
      ].map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
    ),
    profile:
      "Canonical known conversation fields and JSON-produced field order. The separate wire-identity companion compares exact JSON bytes and owner checks; the raw own-tool-result-property row remains qualified with both actual snapshots and is excluded from strict/nativeEvidence. Unknown own fields/prototypes/getters/sparse arrays/custom iterators remain Source-only; no object/array runtime. No AgentState/factory/provider claim in this prerequisite.",
  };
  const out =
    options.reportFile ??
    path.join(root, "target/parity/agent-state-prerequisite.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify({
        cases: report.cases,
        passed: report.passed,
        failures: failures
          .slice(0, 3)
          .map(({ id, message }) => ({ id, message: message.split("\n")[0] })),
        reportFile: out,
      }),
    );
  if (!options.allowFailures) assert.deepEqual(failures, []);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await prerequisiteParity();
