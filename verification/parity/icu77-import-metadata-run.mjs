import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { cases } from "./icu77-metadata-cases.mjs";

const protocolIds = [
  "protocol.missing-id",
  "protocol.unknown-field",
  "protocol.numeric-root",
  "protocol.bad-group",
  "protocol.bad-names",
];
const regexId = "rule-regex-error-retained";
const regexQualification = ["regex-backend-diagnostic-qualified"];
const snapshotCalls = [
  "demlik_code_graph::declarations::discover::discover_declarations",
  "demlik_code_graph::syntax::imports::resolve_imports",
];
const importCall =
  "demlik_code_graph::syntax::imports::import_declaration_specifiers";
const exportCall =
  "demlik_code_graph::extract::conventions::export_names_by_id";
const usesCall =
  "demlik_code_graph::declarations::uses::resolve_declaration_uses";
const callsByOperation = {
  rules: "demlik_code_graph::kinds::rules::compile_group",
  catalog: "demlik_code_graph::extract::wrangler_config::load_binding_catalog",
  entry: "demlik_code_graph::extract::package_exports::package_source_entry",
  presets: "demlik_code_graph::config::with_entry_presets",
};
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
    error: z.strictObject({
      stage: z.string(),
      name: z.string(),
      message: z.string().min(1),
    }),
    observedCalls: z.array(z.string()),
  }),
]);

export function sharedImportMetadata(report, rawFile, expectedBinarySha256) {
  assert.equal(report.passed, 24);
  assert.equal(report.attempted, 24);
  assert.equal(report.unqualifiedPairs, 23);
  assert.equal(report.qualifiedPairs, 1);
  assert.equal(report.rejectedInvalidInputs, 5);
  assert.deepEqual(report.failures, []);
  assert.match(expectedBinarySha256, /^[0-9a-f]{64}$/);
  assert.equal(
    report.rustBinarySha256,
    expectedBinarySha256,
    "binary identity",
  );
  const ids = cases.map((item) => item.id);
  assert.deepEqual(
    report.cases.map((row) => row.id),
    [...ids, ...protocolIds],
    "exact case IDs",
  );
  assert.deepEqual(
    Object.keys(report.nativeEvidence),
    ids.filter((id) => id !== regexId),
  );
  assert.deepEqual(Object.keys(report.qualifiedNativeEvidence), [regexId]);
  for (const row of report.cases) {
    assert.equal(row.passed, true);
    assert.notEqual(row.nativeOnly, true);
    assert.equal(row.process.status, 0);
    assert.equal(row.process.signal ?? null, null);
    assert.equal(row.process.stderr, "");
    const decoded = response.safeParse(row.actual);
    assert.equal(decoded.success, true, `response envelope: ${row.id}`);
    assert.deepEqual(JSON.parse(row.process.stdout), row.actual);
    if (protocolIds.includes(row.id)) {
      assert.equal(row.protocol, true, `protocol row: ${row.id}`);
      assert.equal(row.actual.ok, false, `protocol refusal: ${row.id}`);
      assert.equal(row.actual.id, null);
      assert.equal(row.actual.error.stage, "protocol", "protocol stage");
      assert.equal(row.actual.error.name, "Error");
      assert.deepEqual(row.actual.observedCalls, []);
      continue;
    }
    assert.notEqual(row.protocol, true);
    const item = cases.find((item) => item.id === row.id);
    assert.deepEqual(row.input, item);
    assert.deepEqual(row.before, row.after);
    assert.equal(row.process.signal, null);
    assert.equal(row.actual.id, row.id);
    const qualified = row.id === regexId;
    assert.deepEqual(
      row.qualifications,
      qualified ? regexQualification : [],
      `qualification: ${row.id}`,
    );
    let calls;
    if (item.operation === "snapshot") {
      calls = [
        ...snapshotCalls,
        ...Array(
          Object.keys(row.expected.output.declarationSpecifiers).length,
        ).fill(importCall),
        exportCall,
        ...(item.go ? [usesCall] : []),
      ];
    } else {
      calls = Array(item.operation === "entry" ? item.dirs.length : 1).fill(
        callsByOperation[item.operation],
      );
    }
    assert.deepEqual(
      row.actual.observedCalls,
      calls,
      `actual calls: ${row.id}`,
    );
    assert.deepEqual(row.nativeTrace, { observedCalls: calls });
    const evidence = qualified
      ? report.qualifiedNativeEvidence
      : report.nativeEvidence;
    assert.deepEqual(evidence[row.id], { observedCalls: calls });
    if (row.expected.error) {
      assert.equal(row.actual.ok, false);
      assert.equal(row.actual.error.stage, row.expected.error.stage);
      assert.equal(row.actual.error.name, row.expected.error.name);
      if (qualified) {
        assert.notEqual(row.actual.error.message, row.expected.error.message);
      } else assert.deepEqual(row.actual.error, row.expected.error);
    } else {
      assert.equal(row.actual.ok, true);
      assert.equal(Object.hasOwn(row.actual, "output"), true);
      assert.deepEqual(row.actual.output, row.expected.output);
    }
  }
  return {
    ...report,
    scope:
      "Finite ICU77 import/declaration/catalog/rule/export/preset metadata, original borrowed owners and checked UTF16 operands. The existing regex-backend diagnostic row is qualified; protocol rows earn no comparison credit.107 legacy helpers+2 direct sorts, raw/reflection/platform profiles and all53 CLI gaps remain OPEN.",
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
  execFileSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      fileURLToPath(new URL("./icu77-import-metadata.mjs", import.meta.url)),
      binary,
      rawFile,
    ],
    { encoding: "utf8", maxBuffer: 32 << 20 },
  );
  assert.equal(hash(), binarySha256);
  const normalized = sharedImportMetadata(
    JSON.parse(fs.readFileSync(rawFile, "utf8")),
    rawFile,
    binarySha256,
  );
  fs.writeFileSync(reportFile, `${JSON.stringify(normalized, null, 2)}\n`);
}
