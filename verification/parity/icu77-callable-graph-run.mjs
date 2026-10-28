import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { cases } from "./icu77-callable-cases.mjs";

const scope = JSON.parse(
  fs.readFileSync(new URL("./scope.json", import.meta.url), "utf8"),
);
const protocolIds = [
  "protocol.invalid-json",
  "protocol.missing-id",
  "protocol.unknown-field",
  "protocol.numeric-root",
  "protocol.wrong-map-value",
];
const discover = "demlik_code_graph::extract::functions::discover_functions";
const kinds = "demlik_code_graph::kinds::classify::compile_kind_rules";
const classify = "demlik_code_graph::kinds::classify::classify_function";
const merge = "demlik_code_graph::kinds::declarations::merge_rule_maps";
const compile = "demlik_code_graph::kinds::conventions::compile_conventions";
const match = "demlik_code_graph::kinds::conventions::matching_conventions";
const graphCalls = [
  discover,
  kinds,
  "demlik_code_graph::extract::edges::resolve_edges",
  "demlik_code_graph::extract::references::resolve_references",
  "demlik_code_graph::kinds::declarations::sibling_property_rules",
  "demlik_code_graph::kinds::declarations::type_scope_rules",
  merge,
  "demlik_code_graph::extract::conventions::convention_entries",
];
const response = z.discriminatedUnion("ok", [
  z.strictObject({
    id: z.string(),
    ok: z.literal(true),
    output: z.unknown(),
    observedCalls: z.array(z.string()),
  }),
  z.strictObject({
    id: z.string().nullable(),
    ok: z.literal(false),
    error: z.strictObject({ name: z.string(), message: z.string().min(1) }),
    observedCalls: z.array(z.string()),
  }),
]);

function expectedCalls(item, expected) {
  if (["merge", "merge-entries"].includes(item.operation)) return [merge];
  if (item.operation === "conventions")
    return expected.error ? [compile] : [compile, match];
  if (item.operation === "syntax") return [discover];
  if (item.operation === "classify") return [discover, kinds, classify];
  assert.equal(item.operation, "graph");
  return [...graphCalls, ...expected.output.functions.map(() => classify)];
}

export function sharedCallableGraph(report, rawFile, expectedBinarySha256) {
  assert.equal(report.attempted, 19);
  assert.equal(report.passed, 19);
  assert.equal(report.unqualifiedPairs, 19);
  assert.equal(report.qualifiedPairs, 0);
  assert.equal(report.rejectedInvalidInputs, 5);
  assert.equal(report.responseGuards, 3);
  assert.deepEqual(report.failures, []);
  assert.match(expectedBinarySha256, /^[0-9a-f]{64}$/);
  assert.equal(
    report.rustBinarySha256,
    expectedBinarySha256,
    "binary identity",
  );
  assert.equal(report.reference.Source, scope.reference);
  assert.equal(report.reference.node, scope.referenceEngine.node);
  assert.equal(report.reference.v8, scope.referenceEngine.v8);
  const ids = cases.map((item) => item.id);
  assert.deepEqual(
    report.cases.map((row) => row.id),
    [...ids, ...protocolIds],
    "exact case IDs",
  );
  assert.deepEqual(Object.keys(report.nativeEvidence), ids);
  assert.deepEqual(report.qualifiedNativeEvidence, {});
  for (const row of report.cases) {
    assert.equal(row.passed, true);
    assert.notEqual(row.nativeOnly, true);
    assert.equal(row.process.status, 0, `driver exit: ${row.id}`);
    assert.equal(row.process.signal, null);
    assert.equal(row.process.stderr, "");
    assert.equal(
      response.safeParse(row.actual).success,
      true,
      `response envelope: ${row.id}`,
    );
    assert.deepEqual(JSON.parse(row.process.stdout), row.actual);
    if (protocolIds.includes(row.id)) {
      assert.equal(row.protocol, true, `protocol row: ${row.id}`);
      assert.equal(row.actual.ok, false, `protocol refusal: ${row.id}`);
      assert.equal(row.actual.id, null);
      assert.equal(row.actual.error.name, "Error");
      assert.deepEqual(row.actual.observedCalls, []);
      continue;
    }
    assert.notEqual(row.protocol, true);
    const item = cases.find((item) => item.id === row.id);
    assert.deepEqual(row.input, item);
    assert.deepEqual(row.before, row.after);
    assert.equal(row.actual.id, row.id);
    assert.deepEqual(row.qualifications, [], `qualification: ${row.id}`);
    const calls = expectedCalls(item, row.expected);
    assert.ok(calls.length > 0);
    assert.deepEqual(
      row.actual.observedCalls,
      calls,
      `actual calls: ${row.id}`,
    );
    assert.deepEqual(row.nativeTrace, { observedCalls: calls });
    assert.deepEqual(report.nativeEvidence[row.id], row.nativeTrace);
    if (row.expected.error) {
      assert.deepEqual(Object.keys(row.expected), ["error"]);
      assert.equal(row.actual.ok, false);
      assert.deepEqual(
        row.actual.error,
        row.expected.error,
        `whole Source error: ${row.id}`,
      );
    } else {
      assert.deepEqual(Object.keys(row.expected), ["output"]);
      assert.equal(row.actual.ok, true);
      assert.equal(Object.hasOwn(row.actual, "output"), true);
      assert.deepEqual(
        row.actual.output,
        row.expected.output,
        `whole Source view: ${row.id}`,
      );
      if (item.operation === "graph") {
        for (const key of [
          "calls",
          "callers",
          "depths",
          "base",
          "siblings",
          "types",
          "guards",
          "conventions",
        ])
          assert.deepEqual(
            Object.keys(row.actual.output[key]),
            Object.keys(row.expected.output[key]),
            `${key} insertion order: ${row.id}`,
          );
        for (const key of ["referencesById", "identifierFiles"])
          assert.deepEqual(
            Object.keys(row.actual.output.references[key]),
            Object.keys(row.expected.output.references[key]),
            `${key} insertion order: ${row.id}`,
          );
      }
    }
  }
  return {
    ...report,
    scope:
      "Finite ICU77 callable graph metadata with original borrowed owners and checked UTF16 ordering.19 strict Source/native rows; five inline protocol refusals and three response guards earn no comparison credit.91 legacy helpers+2 direct sorts, existing raw/backend/host/stdio profiles and all53 CLI gaps remain OPEN.",
    nativeOnlyRecording: {
      rawReport: rawFile,
      ids: [],
      nativeExecutions: 0,
      comparisonCredit: 0,
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [binary, reportFile] = process.argv.slice(2);
  assert.ok(binary && reportFile && process.argv.length === 4);
  const hash = () =>
    createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  const binarySha256 = hash();
  const rawFile = `${reportFile}.raw.json`;
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(new URL("./icu77-callable-graph.mjs", import.meta.url)),
        binary,
        rawFile,
      ],
      { encoding: "utf8", maxBuffer: 32 << 20 },
    );
  } finally {
    assert.equal(hash(), binarySha256, "binary stayed unchanged");
  }
  const normalized = sharedCallableGraph(
    JSON.parse(fs.readFileSync(rawFile, "utf8")),
    rawFile,
    binarySha256,
  );
  fs.writeFileSync(reportFile, `${JSON.stringify(normalized, null, 2)}\n`);
}
