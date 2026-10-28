import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url),
  root = fileURLToPath(new URL("../..", import.meta.url));
const node22 = "/Users/cansirin/.volta/tools/image/node/22.21.1/bin/node";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceFiles = [
  "packages/tea/src/internal/jev/protocol/index.ts",
  "packages/tea/src/internal/jev/ask/index.ts",
  "verification/parity/jev-protocol-cases.json.fixture",
  "verification/parity/jev-protocol-reference.mjs",
];
function calls(input) {
  const p = "demlik_tea::jev::protocol::",
    r = "demlik_tea::jev::reply::",
    reply = [`${p}parse_answers`, `${r}decode_reply`];
  if (input.op === "statuses")
    return input.statuses.flatMap(() => [`${p}classify_status`, ...reply]);
  if (input.op === "bodies") return input.bodies.flatMap(() => reply);
  if (input.op === "fresh") return [`${p}parse_answers`];
  if (input.op === "guards")
    return [
      ...Array(9).fill(`${p}is_jev_err`),
      ...Array(5).fill(`${r}is_transient_ask_err`),
      `${p}is_jev_err`,
    ];
  return reply;
}
export function jevProtocolParity(binary, output) {
  const sourceBefore = Object.fromEntries(
    sourceFiles.map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
  );
  const before = hash(fs.readFileSync(binary));
  const sourceFile = `${output}.source.json`;
  const command = [
    node22,
    "--import",
    require.resolve("tsx"),
    path.join(root, "verification/parity/jev-protocol-reference.mjs"),
    sourceFile,
  ];
  const env = {
    ...process.env,
    PATH: `${path.dirname(node22)}:${process.env.PATH}`,
    TMPDIR: "/private/tmp",
  };
  const source = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 32 << 20,
    timeout: 30000,
  });
  fs.writeFileSync(`${output}.source.stdout`, source.stdout ?? "");
  fs.writeFileSync(`${output}.source.stderr`, source.stderr ?? "");
  assert.ifError(source.error);
  assert.equal(source.status, 0);
  assert.equal(source.stderr, "");
  const ref = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  assert.equal(ref.node, "v22.21.1");
  assert.equal(ref.v8, "12.4.254.21-node.33");
  assert.equal(ref.cases, 24);
  const input = `${ref.rows.map((r) => JSON.stringify(r.input)).join("\n")}\n`;
  const native = spawnSync(binary, [], {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 32 << 20,
    timeout: 30000,
  });
  fs.writeFileSync(`${output}.native.stdout`, native.stdout ?? "");
  fs.writeFileSync(`${output}.native.stderr`, native.stderr ?? "");
  assert.ifError(native.error);
  assert.equal(native.status, 0);
  assert.equal(native.signal, null);
  assert.equal(native.stderr, "");
  const frames = native.stdout.trimEnd().split("\n").map(JSON.parse);
  assert.equal(frames.length, 24);
  const failures = [],
    nativeEvidence = {},
    rows = ref.rows.map((source, index) => {
      const answer = frames[index];
      assert.equal(answer.id, source.id);
      assert.deepEqual(answer.observedCalls, calls(source.input));
      let equal = true;
      try {
        assert.deepEqual(answer.output, source.view);
      } catch {
        equal = false;
        failures.push({
          id: source.id,
          reference: source.view,
          native: answer.output,
        });
      }
      if (equal) nativeEvidence[source.id] = answer.observedCalls;
      return {
        id: source.id,
        input: source.input,
        reference: source.view,
        native: answer,
        equal,
      };
    });
  assert.equal(hash(fs.readFileSync(binary)), before);
  assert.deepEqual(
    Object.fromEntries(
      sourceFiles.map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
    ),
    sourceBefore,
  );
  const report = {
    reference: { Source: ref.reference, node: ref.node, v8: ref.v8 },
    cases: 24,
    passed: 24 - failures.length,
    qualified: 0,
    failures,
    rows,
    nativeEvidence,
    qualifiedNativeEvidence: {},
    binarySha256: before,
    sourceHashes: sourceBefore,
    sourceProcess: {
      command,
      status: source.status,
      signal: source.signal,
      stdout: `${output}.source.stdout`,
      stderr: `${output}.source.stderr`,
      report: sourceFile,
    },
    nativeProcess: {
      command: [binary],
      status: native.status,
      signal: native.signal,
      stdout: `${output}.native.stdout`,
      stderr: `${output}.native.stderr`,
      responses: 24,
    },
    limits: [
      "PlainData wire values and valid typed dense question maps; raw getters/prototypes/own __proto__/non-wire values unproved.",
      "Literal-key TypeScript mapped typing remains open; native answers are checked enums/maps.",
      "No HTTP, ask/retry/batching, fallback/foreign-unwrapping, actor/scheduler or full-state codec proof.",
    ],
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [binary, output] = process.argv.slice(2);
  assert.ok(binary && output);
  const report = jevProtocolParity(binary, output);
  console.log(
    JSON.stringify({
      cases: 24,
      passed: report.passed,
      failures: report.failures.map((x) => x.id),
    }),
  );
}
