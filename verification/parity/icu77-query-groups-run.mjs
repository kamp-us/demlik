import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { cases } from "./icu77-query-cases.mjs";

const protocolIds = [
  "protocol.invalid-json",
  "protocol.missing-id",
  "protocol.unknown-field",
  "protocol.numeric-root",
  "protocol.numeric-node",
];
const partitionCall = "demlik_code_graph::query::louvain::louvain";
const clusterCall = "demlik_code_graph::query::clusters::build_cluster_report";
const widthCall =
  "demlik_code_graph::query::interface_width::find_interface_width";
const packageCall = "demlik_code_graph::query::interface_width::package_of";
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

export function sharedQueryGroups(report, rawFile, expectedBinarySha256) {
  assert.equal(report.attempted, 19);
  assert.equal(report.passed, 19);
  assert.equal(report.unqualifiedPairs, 19);
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
  assert.equal(
    report.reference.Source,
    "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
  );
  assert.equal(report.reference.node, "v22.21.1");
  assert.ok(report.reference.v8.startsWith("12.4."));
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
      assert.equal(row.actual.ok, false);
      assert.equal(row.actual.id, null);
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
      requestInput,
      `request input: ${row.id}`,
    );
    assert.equal(typeof fixtureRoot, "string");
    assert.ok(path.isAbsolute(fixtureRoot));
    assert.equal(path.basename(fixtureRoot), row.id);
    assert.deepEqual(row.before, row.after);
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
    const calls =
      item.operation === "partition"
        ? [partitionCall]
        : [
            clusterCall,
            widthCall,
            ...(item.lookupFiles ?? []).map(() => packageCall),
          ];
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
      "Finite ICU77 cluster/Louvain/interface queries, borrowed original graph facts and checked comparison operands. UTF16 ordinal orientation, numeric/NaN fallback, EPS/passes/levels/sums/membership order/toFixed6 are preserved. Protocol rows and response guards earn no comparison credit. Remaining legacy ordering, raw String/reflection/numeric/host/stdio profiles and all53 CLI gaps remain OPEN.",
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
        fileURLToPath(new URL("./icu77-query-groups.mjs", import.meta.url)),
        binary,
        rawFile,
      ],
      { encoding: "utf8", maxBuffer: 32 << 20 },
    );
    const normalized = sharedQueryGroups(
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
      "query worker/admission and binary identity checks failed",
    );
  if (identityError) throw identityError;
  if (operationError) throw operationError;
}
