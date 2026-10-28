import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cases as allCases, filesFor } from "./icu77-graph-cases.mjs";
import { reference, sourcePins } from "./icu77-graph-reference.mjs";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile && process.argv.length === 4);
const cases = process.env.DEMLIK_H_CASES
  ? allCases.filter((c) => process.env.DEMLIK_H_CASES.split(",").includes(c.id))
  : allCases;
assert.ok(cases.length > 0);
const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(
  path.join(root, "verification/parity/package.json"),
);
const { z } = require("zod");
const manifest = createRequire(
  path.join(root, "packages/code-graph/package.json"),
).resolve("@typescript/native-preview/package.json");
const responseSchema = z
  .strictObject({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.strictObject({ name: z.string(), message: z.string() }).optional(),
    observedCalls: z.array(z.string()),
  })
  .superRefine((value, ctx) => {
    if (
      value.ok
        ? value.error !== undefined || !Object.hasOwn(value, "output")
        : value.error === undefined || Object.hasOwn(value, "output")
    )
      ctx.addIssue({
        code: "custom",
        message: "success/error envelope mismatch",
      });
  });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  pins = sourcePins(),
  binaryHash = hash(fs.readFileSync(binary));
const frozen = process.env.DEMLIK_H_FROZEN_SOURCE_REPORT
  ? JSON.parse(
      fs.readFileSync(process.env.DEMLIK_H_FROZEN_SOURCE_REPORT, "utf8"),
    )
  : null;
if (frozen) assert.deepEqual(frozen.sourceHashes, pins);
const runtime = frozen
  ? null
  : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demlik-h-pairs-")));
const failures = [],
  observed = [],
  nativeEvidence = {},
  qualifiedNativeEvidence = {};
let rejectedInvalidInputs = 0,
  responseGuards = 0;
const snapshot = (dir) =>
  Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true })
      .map((file) => [file, path.join(dir, file)])
      .filter(([, file]) => fs.statSync(file).isFile())
      .map(([file, absolute]) => [
        file,
        {
          base64: fs.readFileSync(absolute).toString("base64"),
          mode: fs.statSync(absolute).mode & 0o777,
        },
      ]),
  );
function run(request) {
  const p = spawnSync(binary, [manifest], {
    input: `${typeof request === "string" ? request : JSON.stringify(request)}\n`,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  assert.ifError(p.error);
  assert.equal(p.status, 0);
  assert.equal(p.signal, null);
  assert.equal(p.stderr, "");
  return {
    process: {
      status: p.status,
      signal: p.signal,
      stdout: p.stdout,
      stderr: p.stderr,
    },
    actual: responseSchema.parse(JSON.parse(p.stdout)),
  };
}
const assembly = "demlik_code_graph::extract::assemble::assemble_graph";
function callsFor(item) {
  switch (item.mode) {
    case "workflow":
      return [
        "demlik_code_graph::extract::assemble::assemble_graph_with_reports",
      ];
    case "inputs":
      return ["demlik_code_graph::extract::analysis::analysis_inputs"];
    case "data":
      return item.id === "data-catalog-refusal"
        ? ["demlik_code_graph::extract::wrangler_config::load_binding_catalog"]
        : [
            "demlik_code_graph::extract::wrangler_config::load_binding_catalog",
            "demlik_code_graph::data::extract::scan_data_sites",
            "demlik_code_graph::data::extract::load_data_report",
          ];
    case "directories":
      return [
        assembly,
        "demlik_code_graph::extract::directories::build_directories",
      ];
    default:
      return [assembly];
  }
}
try {
  for (const item of cases) {
    const saved = frozen?.rows.find((row) => row.id === item.id),
      fixture = saved?.root ?? path.join(runtime, item.id);
    if (saved) assert.deepEqual(saved.input, item);
    else {
      fs.mkdirSync(fixture);
      for (const [name, bytes] of Object.entries(filesFor(item))) {
        const f = path.join(fixture, name);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, bytes);
      }
    }
    const before = snapshot(fixture);
    if (saved) assert.deepEqual(before, saved.before);
    let output, error;
    try {
      output = reference(item, fixture);
    } catch (caught) {
      error = { name: caught.name, message: caught.message };
    }
    const expected = error ? { error } : { output };
    if (saved)
      assert.deepEqual(
        expected,
        saved.error ? { error: saved.error } : { output: saved.output },
        "Source remains frozen",
      );
    const { files: _files, ...values } = item;
    const request = { ...values, root: fixture },
      row = {
        id: item.id,
        input: item,
        root: fixture,
        request,
        before,
        expected,
        qualifications: [],
        passed: false,
      };
    try {
      assert.deepEqual(snapshot(fixture), before, "Source bytes and modes");
      Object.assign(row, run(request));
      row.nativeTrace = { observedCalls: row.actual.observedCalls };
      assert.equal(row.actual.id, item.id);
      assert.equal(row.actual.ok, !error);
      assert.deepEqual(row.actual.observedCalls, callsFor(item));
      if (error) assert.deepEqual(row.actual.error, error);
      else assert.deepEqual(row.actual.output, output);
      row.after = snapshot(fixture);
      assert.deepEqual(row.after, before, "native bytes and modes");
      row.passed = true;
      nativeEvidence[item.id] = row.nativeTrace;
    } catch (caught) {
      row.failure = {
        message: caught.message,
        actual: caught.actual,
        expected: caught.expected,
      };
      failures.push({ id: item.id, ...row.failure });
    }
    observed.push(row);
  }
  if (!process.env.DEMLIK_H_CASES) {
    assert.equal(observed.length, 18);
    const base = {
      id: "bad",
      mode: "graph",
      root: frozen?.rows[0].root ?? runtime,
    };
    for (const [id, request] of [
      ["invalid-json", "{"],
      ["missing-id", {}],
      ["unknown-field", { ...base, unknown: true }],
      ["numeric-root", { ...base, root: 1 }],
      ["numeric-order-member", { ...base, moduleOrder: [1] }],
    ]) {
      const result = run(request);
      assert.equal(result.actual.id, null);
      assert.equal(result.actual.ok, false);
      assert.deepEqual(result.actual.observedCalls, []);
      observed.push({
        id: `protocol.${id}`,
        protocol: true,
        passed: true,
        ...result,
      });
      rejectedInvalidInputs++;
    }
    const valid = observed.find((row) => row.actual?.ok).actual;
    for (const bad of [
      { ...valid, ignored: true },
      { ...valid, error: { name: "Error", message: "bad" } },
      { id: "bad", ok: true, observedCalls: [] },
    ]) {
      assert.throws(() => responseSchema.parse(bad));
      responseGuards++;
    }
  }
  assert.equal(hash(fs.readFileSync(binary)), binaryHash);
  const record = {
    attempted: cases.length,
    passed: observed.filter((row) => !row.protocol && row.passed).length,
    unqualifiedPairs: Object.keys(nativeEvidence).length,
    qualifiedPairs: 0,
    rejectedInvalidInputs,
    responseGuards,
    failures,
    reference: {
      Source: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
      node: process.version,
      v8: process.versions.v8,
      icu: process.versions.icu,
      sourceHashes: pins,
      frozenSourceReport: frozen
        ? {
            path: process.env.DEMLIK_H_FROZEN_SOURCE_REPORT,
            sha256: hash(
              fs.readFileSync(process.env.DEMLIK_H_FROZEN_SOURCE_REPORT),
            ),
          }
        : null,
    },
    rustBinarySha256: binaryHash,
    cases: observed,
    nativeEvidence,
    qualifiedNativeEvidence,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    JSON.stringify({
      passed: record.passed,
      qualified: 0,
      failures: failures.length,
    }),
  );
  if (!process.env.DEMLIK_MUTATION_ALLOW_FAILURES)
    assert.deepEqual(failures, []);
} finally {
  assert.deepEqual(sourcePins(), pins, "Source files immutable");
  assert.equal(hash(fs.readFileSync(binary)), binaryHash);
  if (runtime) fs.rmSync(runtime, { recursive: true, force: true });
}
