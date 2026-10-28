import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cases as allCases, filesFor } from "./icu77-coupling-cases.mjs";
import { reference, sourcePins } from "./icu77-coupling-reference.mjs";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile && process.argv.length === 4);
const cases = process.env.DEMLIK_I_CASES
  ? allCases.filter((c) => process.env.DEMLIK_I_CASES.split(",").includes(c.id))
  : allCases;
assert.ok(cases.length);
const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(path.join(root, "verification/parity/package.json")),
  { z } = require("zod"),
  manifest = createRequire(
    path.join(root, "packages/code-graph/package.json"),
  ).resolve("@typescript/native-preview/package.json");
const responseSchema = z
  .strictObject({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.string().optional(),
    observedCalls: z.array(z.string()),
  })
  .superRefine((v, ctx) => {
    if (
      v.ok
        ? v.error !== undefined || !Object.hasOwn(v, "output")
        : v.error === undefined || Object.hasOwn(v, "output")
    )
      ctx.addIssue({
        code: "custom",
        message: "success/error envelope mismatch",
      });
  });
const hash = (b) => createHash("sha256").update(b).digest("hex"),
  pins = sourcePins(),
  binaryHash = hash(fs.readFileSync(binary)),
  frozen = process.env.DEMLIK_I_FROZEN_SOURCE_REPORT
    ? JSON.parse(
        fs.readFileSync(process.env.DEMLIK_I_FROZEN_SOURCE_REPORT, "utf8"),
      )
    : null;
if (frozen) assert.deepEqual(frozen.sourceHashes, pins);
const runtime = frozen
  ? null
  : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demlik-i-pairs-")));
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
      .map((f) => [f, path.join(dir, f)])
      .filter(([, f]) => fs.statSync(f).isFile())
      .map(([f, a]) => [
        f,
        {
          base64: fs.readFileSync(a).toString("base64"),
          mode: fs.statSync(a).mode & 0o777,
        },
      ]),
  );
const pureCalls = [
    "analyze_coupling",
    "value_edges",
    "find_cycles",
    "cross_boundary_edges",
    "rank_modules",
    "coupling_by_file",
  ].map((n) => `demlik_code_graph::smells::coupling::${n}`),
  smell = "demlik_code_graph::render::smells::render_smells",
  cycle = "demlik_code_graph::render::analysis::render_cycles";
function expectedCalls(item) {
  if (item.mode === "guards") return [smell, smell, cycle, cycle];
  return [
    ...(item.mode === "workflow"
      ? ["demlik_code_graph::extract::assemble::assemble_graph_with_reports"]
      : []),
    ...pureCalls,
    ...(item.mode ? [smell, smell, smell, cycle, cycle, cycle] : []),
  ];
}
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
try {
  for (const item of cases) {
    const saved = frozen?.rows.find((row) => row.id === item.id),
      fixture = saved?.root ?? path.join(runtime, item.id);
    if (saved) assert.deepEqual(saved.input, item);
    else {
      fs.mkdirSync(fixture);
      for (const [file, bytes] of Object.entries(filesFor(item))) {
        const f = path.join(fixture, file);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, bytes);
      }
    }
    const before = snapshot(fixture);
    if (saved) assert.deepEqual(before, saved.before);
    let output, error;
    try {
      output = reference(item, fixture);
    } catch (e) {
      error = { name: e.name, message: e.message };
    }
    const expected = error ? { error } : { output };
    if (saved)
      assert.deepEqual(
        expected,
        saved.error ? { error: saved.error } : { output: saved.output },
        "Source remains frozen",
      );
    const { files: _files, ...values } = item,
      request = { ...values, root: fixture },
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
      assert.deepEqual(snapshot(fixture), before);
      Object.assign(row, run(request));
      row.nativeTrace = { observedCalls: row.actual.observedCalls };
      assert.equal(row.actual.id, item.id);
      assert.equal(row.actual.ok, !error);
      assert.deepEqual(row.actual.observedCalls, expectedCalls(item));
      assert.equal(error, undefined, "Source18 is successful");
      assert.deepEqual(row.actual.output, output);
      row.after = snapshot(fixture);
      assert.deepEqual(row.after, before);
      row.passed = true;
      nativeEvidence[item.id] = row.nativeTrace;
    } catch (e) {
      row.failure = {
        message: e.message,
        actual: e.actual,
        expected: e.expected,
      };
      failures.push({ id: item.id, ...row.failure });
    }
    observed.push(row);
  }
  if (!process.env.DEMLIK_I_CASES) {
    assert.equal(observed.length, 18);
    const base = { id: "bad", root: frozen?.rows[0].root ?? runtime };
    for (const [id, request] of [
      ["invalid-json", "{"],
      ["missing-id", {}],
      ["unknown-field", { ...base, unknown: true }],
      ["numeric-root", { ...base, root: 1 }],
      ["numeric-module-file", { ...base, modules: [{ file: 1, edges: [] }] }],
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
      { ...valid, error: "bad" },
      { id: "bad", ok: true, observedCalls: [] },
    ]) {
      assert.throws(() => responseSchema.parse(bad));
      responseGuards++;
    }
  }
  assert.equal(hash(fs.readFileSync(binary)), binaryHash);
  const report = {
    attempted: cases.length,
    passed: observed.filter((r) => !r.protocol && r.passed).length,
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
    },
    rustBinarySha256: binaryHash,
    cases: observed,
    nativeEvidence,
    qualifiedNativeEvidence,
  };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({ passed: report.passed, failures: failures.length }),
  );
  if (!process.env.DEMLIK_MUTATION_ALLOW_FAILURES)
    assert.deepEqual(failures, []);
} finally {
  assert.deepEqual(sourcePins(), pins);
  assert.equal(hash(fs.readFileSync(binary)), binaryHash);
  if (runtime) fs.rmSync(runtime, { recursive: true, force: true });
}
