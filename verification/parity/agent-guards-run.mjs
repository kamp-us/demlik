import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentGuardsCases } from "./agent-guards-cases.mjs";
import {
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const symbols = {
  usage: "demlik_tea::agent::types::is_turn_usage",
  turn: "demlik_tea::agent::types::is_agent_turn",
  summary: "demlik_tea::agent::compaction::is_compaction_summary",
  turnSchema: "demlik_tea::agent::types::AGENT_TURN_SCHEMA",
  summarySchema: "demlik_tea::agent::compaction::COMPACTION_SUMMARY_SCHEMA",
  parse: "demlik_tea::llm_call::Schema::parse",
  add: "demlik_tea::agent::conversation::add_usage",
  dedupe: "demlik_tea::agent::conversation::dedupe_by_call_id",
  fold: "demlik_tea::agent::conversation::fold_summary",
  fresh: "demlik_tea::agent::conversation::fresh_conversation",
  zero: "demlik_tea::agent::conversation::NO_USAGE",
  purpose: "demlik_tea::agent::compaction::COMPACTION_PURPOSE",
  key: "demlik_tea::llm_call::Purpose::key",
  plain: "demlik_tea::data::plain_data",
};
function callsFor(test) {
  if (test.operation === "guards")
    return [
      symbols.usage,
      symbols.turn,
      symbols.summary,
      symbols.turnSchema,
      symbols.parse,
      symbols.summarySchema,
      symbols.parse,
    ];
  if (test.operation === "fresh")
    return [symbols.fresh, symbols.fresh, symbols.zero];
  if (test.operation === "vocabulary")
    return [symbols.purpose, symbols.key, symbols.plain];
  return [symbols[test.operation]];
}
function literals(test, output) {
  switch (test.id) {
    case "agent-guards.usage-cached-exceeds-input":
      assert.equal(output.usage, true);
      break;
    case "agent-guards.count-inputTokens-max-safe":
      assert.equal(output.usage, true);
      break;
    case "agent-guards.count-inputTokens-unsafe":
      assert.equal(output.usage, false);
      break;
    case "agent-guards.count-inputTokens-fraction":
      assert.equal(output.usage, false);
      break;
    case "agent-guards.turn-late-tool-invalid":
      assert.equal(output.turn, false);
      break;
    case "agent-guards.turn-tool-array-args":
      assert.equal(output.turn, true);
      break;
    case "agent-guards.turn-provider-null":
      assert.equal(output.turn, true);
      break;
    case "agent-guards.turn-bare":
      assert.equal(output.turnParsed.sameOriginal, true);
      break;
    case "agent-guards.turn-extra-retained":
      assert.deepEqual(output.turnParsed.observation.value.extra.nested, [
        1,
        { $value: "undefined" },
        "\ud800",
      ]);
      break;
    case "agent-guards.summary-lone":
      assert.equal(output.summaryParsed.observation.value.summary, "\ud800");
      break;
    case "agent-guards.sum-absent":
      assert.deepEqual(output.sum.value, { inputTokens: 4, outputTokens: 6 });
      break;
    case "agent-guards.sum-explicit-undefined":
      assert.deepEqual(output.sum.value, { inputTokens: 4, outputTokens: 6 });
      assert.deepEqual(output.left.reasoningTokens, { $value: "undefined" });
      break;
    case "agent-guards.sum-negative-zero":
      assert.deepEqual(output.sum.value, {
        inputTokens: { $value: "-0" },
        outputTokens: 0,
        reasoningTokens: { $value: "-0" },
      });
      break;
    case "agent-guards.sum-infinite-overflow":
      assert.deepEqual(output.sum.value, {
        inputTokens: { $value: "Infinity" },
        outputTokens: { $value: "Infinity" },
      });
      break;
    case "agent-guards.dedupe-first-and-references":
      assert.deepEqual(output.indices, [0, 2]);
      assert.equal(output.calls.value[0].args.x, 42);
      assert.equal(output.calls.value[0].args.ignored, undefined);
      break;
    case "agent-guards.fold-valid-identities":
      assert.deepEqual(output.turnIndices, [-1, 2]);
      assert.deepEqual(output.recordIndices, [-1, -1]);
      assert.deepEqual(output.callIndices, [2, 2]);
      assert.deepEqual(output.outcomeIndices, [0, 1]);
      assert.equal(output.folded.value.turns[0].content, "summary changed");
      assert.equal(output.folded.value.turns[1].content, "changed");
      assert.equal(output.folded.value.toolRecords[0].outcome.result.count, 7);
      assert.equal(output.folded.value.toolRecords[1].outcome.detail.code, 8);
      assert.equal(output.folded.value.turnCount, 9);
      assert.equal(output.folded.value.contextTokens, null);
      assert.deepEqual(output.folded.value.awaiting, { kind: "llm" });
      break;
    case "agent-guards.fold-fraction":
      assert.deepEqual(
        output.folded.value.toolRecords.map((record) => record.turn),
        [1.5, 1.5],
      );
      assert.deepEqual(output.turnIndices, [-1, 1, 2]);
      break;
    case "agent-guards.fold-nan":
      assert.deepEqual(output.turnIndices, [-1, 0, 1, 2]);
      assert.deepEqual(output.folded.value.toolRecords, []);
      break;
    case "agent-guards.fold-negative-near-zero":
      assert.deepEqual(output.turnIndices, [-1, 0, 1, 2]);
      break;
    case "agent-guards.fresh":
      assert.equal(output.hasUsage, false);
      assert.equal(output.conversation.value.contextTokens, null);
      break;
  }
}
export async function agentGuardsParity(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const binary =
    options.binary ??
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      "debug/examples/agent_guards_driver",
    );
  if (!options.binary)
    execFileSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "-p",
        "demlik-tea",
        "--example",
        "agent_guards_driver",
      ],
      {
        cwd: root,
        stdio: "pipe",
        env: {
          ...process.env,
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      },
    );
  const available = agentGuardsCases();
  assert.equal(
    new Set(available.map((test) => test.id)).size,
    available.length,
  );
  if (options.caseIds) {
    assert.ok(options.caseIds.length > 0);
    for (const id of options.caseIds)
      assert.ok(
        available.some((test) => test.id === id),
        `unknown case ${id}`,
      );
  }
  const cases = options.caseIds
    ? available.filter((test) => options.caseIds.includes(test.id))
    : available;
  const text = `${cases.map((test) => JSON.stringify(test)).join("\n")}\n`;
  const run = (program, args, input = text) => {
    const result = spawnSync(program, args, {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  const source = run(process.execPath, [
      "--import",
      require.resolve("tsx"),
      path.join(root, "verification/parity/agent-guards-reference.mts"),
    ]),
    native = run(binary, []);
  assert.equal(source.length, cases.length);
  assert.equal(native.length, cases.length);
  const failures = [],
    nativeEvidence = {},
    nativeErrors = {};
  for (let index = 0; index < cases.length; index++) {
    const test = cases[index],
      left = source[index],
      right = native[index];
    try {
      assert.equal(left.id, test.id);
      assert.equal(right.id, test.id);
      assert.equal(left.ok, true);
      assert.equal(right.ok, true);
      assert.deepEqual(right.observedCalls, callsFor(test));
      assert.deepEqual(right.output, left.output);
      literals(test, right.output);
      const errors = right.nativeErrors ?? [];
      if (test.operation === "guards") {
        const expected = [
          left.output.turnParsed,
          left.output.summaryParsed,
        ].filter((value) => !value.ok);
        assert.equal(errors.length, expected.length);
        for (let error = 0; error < errors.length; error++) {
          assert.equal(errors[error].name, expected[error].error.name);
          assert.equal(errors[error].message, expected[error].error.message);
          assert.equal(errors[error].sameRejected, true);
          assert.deepEqual(
            errors[error].rejected,
            JSON.parse(JSON.stringify(test)).input.value,
          );
        }
      } else assert.equal(errors.length, 0);
      nativeEvidence[test.id] = [...new Set(right.observedCalls)];
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
  const fold = available.find((test) => test.operation === "fold");
  const invalid = [
    { id: 1, operation: "fresh", input: {} },
    { id: "extra", operation: "fresh", input: {}, extra: true },
    { id: "unknown", operation: "unknown", input: {} },
    { id: "missing", operation: "guards", input: {} },
    {
      id: "descriptor",
      operation: "guards",
      input: { value: { $value: "invalid" } },
    },
    {
      id: "optional-null",
      operation: "add",
      input: {
        left: { inputTokens: 0, outputTokens: 0, reasoningTokens: null },
        right: { inputTokens: 0, outputTokens: 0 },
      },
    },
    {
      id: "bad-index",
      operation: "dedupe",
      input: {
        calls: [],
        mutations: [{ target: "args", index: 0, key: "x", value: 1 }],
      },
    },
    {
      id: "bad-record",
      operation: "fold",
      input: { ...fold.input, records: [{ call: 100, outcome: 0, turn: 2 }] },
    },
  ];
  const invalidText = `${invalid.map((test) => JSON.stringify(test)).join("\n")}\n`,
    sourceInvalid = run(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(root, "verification/parity/agent-guards-reference.mts"),
      ],
      invalidText,
    ),
    nativeInvalid = run(binary, [], invalidText);
  assert.equal(sourceInvalid.length, invalid.length);
  assert.equal(nativeInvalid.length, invalid.length);
  assert.ok(sourceInvalid.every((row) => !row.ok));
  assert.ok(nativeInvalid.every((row) => !row.ok));
  assert.ok(nativeInvalid.every((row) => row.observedCalls.length === 0));
  const report = {
    reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
    node: process.version,
    v8: process.versions.v8,
    cases: cases.length,
    passed: cases.length - failures.length,
    protocolRefusals: invalid.length,
    failures,
    nativeEvidence,
    nativeErrors,
    caseIds: cases.map((test) => test.id),
    inputSha256: hash(text),
    baselineBinarySha256: hash(fs.readFileSync(binary)),
    sourceHashes: Object.fromEntries(
      ["types.ts", "schema.ts", "compaction.ts", "internal.ts"].map((file) => [
        file,
        hash(fs.readFileSync(path.join(root, "packages/tea/src/agent", file))),
      ]),
    ),
    nativeProfile:
      "Ordinary dense own-data values and typed conversation fields. Raw guard schemas retain their original Rc<PlainData>, not a rebuilt typed AgentTurn. Legacy/unknown Conversation spread fields, named/prototype/sparse arrays, getters/proxies and raw optional-null usage arithmetic are Source-only observations outside this native interface. No AgentState/factory/provider/schema-runtime claim.",
  };
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/agent-guards.json");
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify(
        {
          ...report,
          nativeEvidence: { cases: Object.keys(nativeEvidence).length },
          nativeErrors: { cases: Object.keys(nativeErrors).length },
          failures: failures.slice(0, 5),
          reportFile,
        },
        null,
        2,
      ),
    );
  if (!options.allowFailures) assert.deepEqual(failures, []);
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await agentGuardsParity();
