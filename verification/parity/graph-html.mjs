import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { htmlCases, sourceGraph } from "./html-cases.mjs";

const [binaryArg, reportFile] = process.argv.slice(2);
assert.ok(binaryArg && reportFile && process.argv.length === 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url));
const { buildHtmlModel, renderHtml } = await import(
  pathToFileURL(path.join(root, "packages/code-graph/src/render/html.ts"))
);
const { ThresholdsSchema } = await import(
  pathToFileURL(path.join(root, "packages/code-graph/src/schema.ts"))
);
const binary = fs.realpathSync(binaryArg),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const response = z.strictObject({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  observedCalls: z.array(z.string()),
});
const expectedCalls = [
  "demlik_code_graph::render::html::build_html_model",
  "demlik_code_graph::render::html::render_html",
];
const cases = [],
  failures = [],
  nativeEvidence = {};
function invoke(request) {
  const result = spawnSync(binary, [], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    maxBuffer: 32 << 20,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trimEnd().split("\n").length, 1);
  return {
    process: {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    actual: response.parse(JSON.parse(result.stdout)),
  };
}
for (const [id, input] of htmlCases) {
  const graph = sourceGraph(input, ThresholdsSchema.parse({})),
    model = buildHtmlModel(graph);
  const expected = JSON.parse(
    JSON.stringify({
      model,
      html: renderHtml(graph),
      summaryOwner: model.summary === graph.summary,
    }),
  );
  const row = { id, input, expected, passed: false, qualifications: [] };
  try {
    const observed = invoke({ id, input });
    Object.assign(row, observed);
    row.nativeTrace = { observedCalls: row.actual.observedCalls };
    assert.equal(row.actual.id, id);
    assert.equal(row.actual.ok, true);
    assert.deepEqual(row.actual.observedCalls, expectedCalls);
    assert.deepEqual(row.actual.output, expected);
    row.passed = true;
    nativeEvidence[id] = row.actual.observedCalls;
  } catch (error) {
    row.failure = {
      message: error.message,
      actual: error.actual,
      expected: error.expected,
    };
    failures.push({ id, ...row.failure });
  }
  cases.push(row);
}
let rejectedInvalidInputs = 0;
for (const [id, request] of [
  ["missing-input", { id: "invalid" }],
  ["unknown-field", { id: "invalid", input: htmlCases[0][1], extra: true }],
  ["numeric-root", { id: "invalid", input: { ...htmlCases[0][1], root: 7 } }],
  [
    "bad-health",
    {
      id: "invalid",
      input: { ...htmlCases[0][1], summary: { health: "bad" } },
    },
  ],
  [
    "unknown-node-field",
    {
      id: "invalid",
      input: {
        ...htmlCases[0][1],
        nodes: [{ fact: { id: "a", name: "a", file: "a.ts", invented: true } }],
      },
    },
  ],
]) {
  const row = { id: `protocol.${id}`, protocol: true, passed: false };
  try {
    Object.assign(row, invoke(request));
    assert.equal(row.actual.ok, false);
    assert.equal(row.actual.id, null);
    assert.ok(row.actual.error);
    assert.deepEqual(row.actual.observedCalls, []);
    rejectedInvalidInputs++;
    row.passed = true;
  } catch (error) {
    row.failure = String(error);
    failures.push({ id: row.id, failure: row.failure });
  }
  cases.push(row);
}
const report = {
  passed: cases.filter((row) => row.passed && !row.protocol).length,
  attempted: htmlCases.length,
  unqualifiedPairs: cases.filter((row) => row.passed && !row.protocol).length,
  qualifiedPairs: 0,
  rejectedInvalidInputs,
  failures,
  reference: {
    node: process.version,
    v8: process.versions.v8,
    icu: process.versions.icu,
  },
  rustBinarySha256: hash(fs.readFileSync(binary)),
  cases,
  nativeEvidence,
  qualifiedNativeEvidence: {},
};
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({ passed: report.passed, rejectedInvalidInputs, failures }),
);
assert.deepEqual(failures, []);
