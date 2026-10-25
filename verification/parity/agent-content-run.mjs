import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentContentCases } from "./agent-content-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fn = {
  content: "demlik_tea::agent::content::content_parts",
  turn: "demlik_tea::agent::types::AgentTurn::new",
  omit: "demlik_tea::agent::content::omit_media",
  fresh: "demlik_tea::agent::transcript::Transcript::new",
  seed: "demlik_tea::agent::transcript::Transcript::from_seed",
  raw: "demlik_tea::agent::transcript::Transcript::from_plain_seed",
  read: "demlik_tea::agent::transcript::Transcript::read",
  event: "demlik_tea::agent::transcript::Transcript::on_event",
  tag: "demlik_tea::Tagged::tag",
};
function callsFor(test, output) {
  if (test.operation === "canonical-turn")
    return [fn.turn, fn.fresh, fn.event, fn.read];
  if (test.operation === "content")
    return [fn.content, fn.content, fn.content, fn.content, fn.omit, fn.omit];
  if (test.operation === "raw-seed")
    return output.error ? [fn.raw] : [fn.raw, fn.read];
  return [
    test.input.seed ? fn.seed : fn.fresh,
    fn.read,
    ...test.input.events.flatMap(() => [fn.tag, fn.event, fn.read]),
    fn.read,
  ];
}
function literals(test, row) {
  const o = row.output;
  switch (test.id) {
    case "agent-content.alias-and-media":
      assert.deepEqual(o.mediaAfter.backing, [10, 21, 32, 40]);
      assert.deepEqual(o.mediaAfter.copy, [99, 30]);
      assert.deepEqual(o.omittedRetained, [
        true,
        false,
        false,
        false,
        false,
        true,
        false,
      ]);
      assert.equal(o.passedSameArray, true);
      assert.equal(o.omitFreshArray, true);
      assert.ok(o.byteSourceViews.every(Boolean));
      break;
    case "agent-transcript.live-seeded":
      assert.equal(o.current.turns.length, 3);
      assert.equal(o.current.tools.length, 5);
      assert.equal(o.current.outcome.kind, "cancelled");
      assert.equal(o.current.outcome.at, 3.5);
      assert.equal(o.snapshots[0].turns[0].content, "seed changed");
      assert.equal(o.snapshots[0].tools[0].result.count, 42);
      assert.equal(o.toolSame[0][1], false);
      assert.equal(o.resultSame[0][1], true);
      break;
    case "agent-transcript.repeated-status":
      assert.equal(o.outcomeSame[1][2], true);
      assert.equal(o.outcomeSame[2][3], false);
      break;
    case "agent-transcript.ending-0":
      assert.equal(o.current.outcome.kind, "done");
      assert.equal(o.current.outcome.output, null);
      break;
    case "agent-transcript.ignored-started-failed":
      assert.equal(o.current.turns.length, 0);
      assert.equal(o.current.tools.length, 0);
      assert.equal(o.current.outcome.kind, "running");
      break;
    case "agent-transcript.seed-order-not-numeric-keys":
      assert.deepEqual(
        o.current.tools.map((t) => t.callId),
        ["10", "2", "1"],
      );
      break;
    case "agent-seed.string-turns":
      assert.deepEqual(o.value.turns, ["a", "😀", "\ud800"]);
      break;
    case "agent-seed.done-model-is-running":
      assert.equal(o.value.outcome.kind, "running");
      assert.deepEqual(o.value.turns, []);
      break;
  }
}
export async function agentContentParity(options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const binary =
    options.binary ??
    path.join(
      process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
      "debug/examples/agent_content_driver",
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
        "agent_content_driver",
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
  const available = agentContentCases();
  assert.equal(new Set(available.map((t) => t.id)).size, available.length);
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
  const text = `${cases.map(({ qualification, ...test }) => JSON.stringify(test)).join("\n")}\n`;
  const run = (program, args, input = text) => {
    const result = spawnSync(program, args, {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
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
    path.join(root, "verification/parity/agent-content-reference.mts"),
  ]);
  const native = run(binary, []);
  assert.equal(source.length, cases.length);
  assert.equal(native.length, cases.length);
  const failures = [],
    nativeEvidence = {},
    nativeErrors = {},
    profiles = [];
  for (let i = 0; i < cases.length; i++)
    try {
      const test = cases[i],
        left = source[i],
        right = native[i];
      assert.equal(left.id, test.id);
      assert.equal(right.id, test.id);
      assert.equal(left.ok, true);
      assert.equal(right.ok, true);
      assert.deepEqual(right.observedCalls, callsFor(test, right.output));
      if (test.qualification) {
        assert.equal(test.qualification, "typed-call-id-boundary");
        assert.ok(left.output.value);
        const original = test.input.conversation.toolRecords[0].call;
        const expectedTool = {
          ...(Object.hasOwn(original, "callId")
            ? { callId: original.callId }
            : {}),
          result: 1,
        };
        assert.deepEqual(left.output.value, {
          turns: [],
          tools: [expectedTool],
          outcome: { kind: "running" },
        });
        const kind = Object.hasOwn(original, "callId")
          ? original.callId === null
            ? "null"
            : typeof original.callId
          : "undefined";
        assert.equal(right.nativeError.valueKind, kind);
        if (kind !== "undefined")
          assert.deepEqual(right.nativeError.value, original.callId);

        assert.equal(right.output.error.name, "TypeError");
        assert.equal(
          right.output.error.message,
          "transcript tool callId must be a string",
        );
        assert.equal(right.nativeError.name, "TypeError");
        profiles.push({
          id: test.id,
          qualification: test.qualification,
          strictParity: false,
          source: left.output,
          native: right.output,
          nativeError: right.nativeError,
          observedCalls: right.observedCalls,
        });
        continue;
      }
      assert.deepEqual(right.output, left.output);
      literals(test, right);
      nativeEvidence[test.id] = right.observedCalls;
      if (right.nativeError) nativeErrors[test.id] = right.nativeError;
    } catch (error) {
      failures.push({
        id: cases[i].id,
        qualification: cases[i].qualification ?? null,
        message: error.message,
        source: source[i],
        native: native[i],
      });
    }
  const invalid = [
    null,
    {},
    { id: "bad", operation: "other", input: {} },
    { id: "null-content", operation: "content", input: null },
    { id: "missing-raw", operation: "raw-seed" },
    {
      id: "bad-byte",
      operation: "content",
      input: {
        text: "x",
        parts: [],
        media: { bytes: [256], range: [0, 1] },
        appendText: "a",
      },
    },
    { id: "extra", operation: "raw-seed", input: {}, extra: 1 },
  ];
  const invalidText = `${invalid.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const left = run(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(root, "verification/parity/agent-content-reference.mts"),
      ],
      invalidText,
    ),
    right = run(binary, [], invalidText);
  assert.ok(left.every((row) => !row.ok));
  assert.ok(right.every((row) => !row.ok));
  assert.ok(right.every((row) => row.observedCalls.length === 0));
  const strict = cases.filter((test) => !test.qualification),
    report = {
      reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      node: process.version,
      v8: process.versions.v8,
      cases: strict.length,
      passed:
        strict.length -
        failures.filter((failure) => !failure.qualification).length,
      profileObservations: profiles.length,
      protocolRefusals: invalid.length,
      failures,
      nativeEvidence,
      nativeErrors,
      profiles,
      caseIds: cases.map((test) => test.id),
      inputSha256: hash(text),
      baselineBinarySha256: hash(fs.readFileSync(binary)),
      sourceHashes: Object.fromEntries(
        ["content.ts", "transcript.ts", "types.ts", "machine.ts"].map(
          (file) => [
            file,
            hash(
              fs.readFileSync(path.join(root, "packages/tea/src/agent", file)),
            ),
          ],
        ),
      ),
      scope:
        "Content helpers and retained live/seeded transcript only. Dense ordered native sequences; sparse/prototype/custom iterator JavaScript arrays are a measured manual profile, not a runtime reimplementation. Malformed raw non-string callIds are known typed-boundary differences, never parity-passed or strict evidence. No agent factory/provider/SDK/schema/lifecycle projector claim.",
    };
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/agent-content.json");
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify(
        {
          ...report,
          nativeEvidence: { cases: Object.keys(nativeEvidence).length },
          nativeErrors: { cases: Object.keys(nativeErrors).length },
          profiles: profiles.map(({ id, qualification, strictParity }) => ({
            id,
            qualification,
            strictParity,
          })),
          failures: failures.slice(0, 6),
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
  await agentContentParity();
