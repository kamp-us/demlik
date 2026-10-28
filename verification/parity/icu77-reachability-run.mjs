import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases, filesFor } from "./icu77-reach-cases.mjs";

const { z } = createRequire(import.meta.url)("zod");
const scope = JSON.parse(
  fs.readFileSync(new URL("./scope.json", import.meta.url), "utf8"),
);
const protocolIds = [
  "protocol.invalid-json",
  "protocol.missing-id",
  "protocol.unknown-field",
  "protocol.numeric-root",
  "protocol.numeric-root-member",
];
const calls = [
  "demlik_code_graph::query::reach::invoked_adjacency",
  "demlik_code_graph::query::reach::full_adjacency",
  "demlik_code_graph::query::reach::reachable_from",
  "demlik_code_graph::query::surface::public_surface_files",
  "demlik_code_graph::query::unreachable::find_unreachable",
  "demlik_code_graph::query::unguarded::find_unguarded",
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
    error: z.string().min(1),
    observedCalls: z.array(z.string()),
  }),
]);

export function sharedReachability(report, rawFile, expectedBinarySha256) {
  assert.equal(report.attempted, 18);
  assert.equal(report.passed, 18);
  assert.equal(report.unqualifiedPairs, 18);
  assert.equal(report.qualifiedPairs, 0);
  assert.equal(report.rejectedInvalidInputs, 5);
  assert.equal(report.rejectedInvalidInputRows ?? 5, 5);
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
  assert.equal(report.reference.icu, "77.1");
  const ids = cases.map((item) => item.id);
  assert.deepEqual(
    report.cases.map((row) => row.id),
    [...ids, ...protocolIds],
    "exact case IDs",
  );
  assert.deepEqual(Object.keys(report.nativeEvidence), ids);
  assert.deepEqual(Object.keys(report.qualifiedNativeEvidence), []);
  for (const row of report.cases) {
    assert.equal(row.passed, true);
    assert.notEqual(row.nativeOnly, true);
    assert.equal(row.process.status, 0);
    assert.equal(row.process.signal, null);
    assert.equal(row.process.stderr, "");
    const decoded = response.safeParse(row.actual);
    assert.equal(decoded.success, true, `response envelope: ${row.id}`);
    assert.deepEqual(JSON.parse(row.process.stdout), row.actual);
    if (protocolIds.includes(row.id)) {
      assert.equal(row.protocol, true);
      assert.equal(row.actual.id, null);
      assert.equal(row.actual.ok, false);
      assert.deepEqual(row.actual.observedCalls, []);
      continue;
    }
    assert.notEqual(row.protocol, true);
    const item = cases.find((item) => item.id === row.id);
    assert.deepEqual(row.input, item, `exact input: ${row.id}`);
    const { files: _files, ...requestInput } = item;
    const { root: fixtureRoot, ...actualRequestInput } = row.request;
    assert.deepEqual(
      actualRequestInput,
      { ...requestInput, operation: item.operation ?? "reach" },
      `request input: ${row.id}`,
    );
    assert.equal(typeof fixtureRoot, "string");
    assert.ok(path.isAbsolute(fixtureRoot));
    assert.equal(path.basename(fixtureRoot), row.id);
    assert.deepEqual(row.before, row.after, `bytes and modes: ${row.id}`);
    const fixtureFiles = filesFor(item);
    assert.deepEqual(
      Object.keys(row.before).sort(),
      Object.keys(fixtureFiles).sort(),
      `fixture files: ${row.id}`,
    );
    for (const [file, bytes] of Object.entries(fixtureFiles)) {
      const recorded = row.before[file];
      assert.deepEqual(Object.keys(recorded).sort(), ["base64", "mode"]);
      assert.equal(
        recorded.base64,
        Buffer.from(bytes).toString("base64"),
        `fixture bytes: ${row.id}/${file}`,
      );
      assert.ok(
        Number.isInteger(recorded.mode) &&
          recorded.mode >= 0 &&
          recorded.mode <= 0o777,
        `fixture mode: ${row.id}/${file}`,
      );
    }
    assert.deepEqual(row.qualifications, [], `qualification: ${row.id}`);
    assert.equal(row.actual.id, row.id);
    assert.equal(row.actual.ok, true);
    assert.ok(Object.hasOwn(row.actual, "output"));
    assert.deepEqual(Object.keys(row.expected), ["output"]);
    assert.deepEqual(
      row.actual.output,
      row.expected.output,
      `whole view: ${row.id}`,
    );
    assert.deepEqual(
      row.actual.observedCalls,
      calls,
      `actual calls: ${row.id}`,
    );
    assert.deepEqual(row.nativeTrace, { observedCalls: calls });
    assert.deepEqual(report.nativeEvidence[row.id], { observedCalls: calls });
  }
  return {
    ...report,
    rejectedInvalidInputRows: 5,
    scope:
      "Finite ICU77 reach/full-adjacency, guarded BFS and unreachable queries with borrowed original graph/reference owners and explicit checked comparison operands. Source adjacency-before-root-sort, locale ties, membership/BFS order and category/reason priority are preserved. Protocol rows and response guards earn no comparison credit. Additional locale-ordering, raw/reflection/numeric/host profiles and all53 CLI gaps remain OPEN; see the current inventory for remaining comparisons.",
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
  const binarySha256 = hash(),
    rawFile = `${reportFile}.raw.json`;
  let operationError, identityError;
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(new URL("./icu77-reachability.mjs", import.meta.url)),
        binary,
        rawFile,
      ],
      { encoding: "utf8", maxBuffer: 32 << 20 },
    );
    const normalized = sharedReachability(
      JSON.parse(fs.readFileSync(rawFile, "utf8")),
      rawFile,
      binarySha256,
    );
    fs.writeFileSync(reportFile, `${JSON.stringify(normalized, null, 2)}\n`);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      assert.equal(
        hash(),
        binarySha256,
        "binary identity after worker/admission",
      );
    } catch (error) {
      identityError = error;
    }
  }
  if (operationError && identityError)
    throw new AggregateError(
      [operationError, identityError],
      "reachability worker/admission and binary identity checks failed",
    );
  if (identityError) throw identityError;
  if (operationError) throw operationError;
}
