import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cases as allCases, filesFor } from "./icu77-query-cases.mjs";
import { reference, sourcePins } from "./icu77-query-reference.mjs";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile && process.argv.length === 4);
const cases = process.env.DEMLIK_F_CASES
  ? allCases.filter((c) => process.env.DEMLIK_F_CASES.split(",").includes(c.id))
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
    error: z.string().optional(),
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
const partitionCall = "demlik_code_graph::query::louvain::louvain";
const clusterCall = "demlik_code_graph::query::clusters::build_cluster_report";
const widthCall =
  "demlik_code_graph::query::interface_width::find_interface_width";
const packageCall = "demlik_code_graph::query::interface_width::package_of";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pins = sourcePins();
assert.equal(process.version, "v22.21.1");
assert.ok(process.versions.v8.startsWith("12.4."));
const runtime = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "demlik-f-pairs-")),
);
const failures = [],
  observed = [],
  nativeEvidence = {},
  qualifiedNativeEvidence = {};
let rejectedInvalidInputs = 0,
  responseGuards = 0;
function filesAt(dir) {
  return Object.fromEntries(
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
}
function run(request) {
  const process = spawnSync(binary, [manifest], {
    input: `${typeof request === "string" ? request : JSON.stringify(request)}\n`,
    encoding: "utf8",
    maxBuffer: 32 << 20,
  });
  assert.ifError(process.error);
  assert.equal(process.signal, null);
  assert.equal(process.status, 0);
  assert.equal(process.stderr, "");
  return {
    process: {
      status: process.status,
      signal: process.signal,
      stdout: process.stdout,
      stderr: process.stderr,
    },
    actual: responseSchema.parse(JSON.parse(process.stdout)),
  };
}
function expectedCalls(item) {
  return item.operation === "partition"
    ? [partitionCall]
    : [
        clusterCall,
        widthCall,
        ...(item.lookupFiles ?? []).map(() => packageCall),
      ];
}

try {
  for (const item of cases) {
    const fixture = path.join(runtime, item.id);
    fs.mkdirSync(fixture);
    for (const [name, bytes] of Object.entries(filesFor(item))) {
      const destination = path.join(fixture, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
    }
    const before = filesAt(fixture);
    let output, error;
    try {
      output = reference(item, fixture);
    } catch (caught) {
      error = { name: caught.name, message: caught.message };
    }
    const row = {
      id: item.id,
      input: item,
      before,
      expected: error ? { error } : { output },
      qualifications: [],
      passed: false,
    };
    try {
      assert.deepEqual(filesAt(fixture), before, "Source file bytes and modes");
      const { files: _files, ...values } = item;
      const request = { ...values, root: fixture };
      row.request = request;
      Object.assign(row, run(request));
      row.nativeTrace = { observedCalls: row.actual.observedCalls };
      assert.equal(row.actual.id, item.id);
      assert.equal(row.actual.ok, !error);
      assert.deepEqual(
        row.actual.observedCalls,
        expectedCalls(item, output, error),
      );
      if (error) assert.deepEqual(row.actual.error, error);
      else {
        assert.deepEqual(row.actual.output, output);
      }
      row.after = filesAt(fixture);
      assert.deepEqual(row.after, before, "native file bytes and modes");
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
  if (!process.env.DEMLIK_F_CASES) {
    assert.equal(observed.length, 19);
    const base = { id: "bad", operation: "partition", root: runtime };
    for (const [id, request] of [
      ["invalid-json", "{"],
      ["missing-id", {}],
      ["unknown-field", { ...base, unknown: true }],
      ["numeric-root", { ...base, root: 1 }],
      ["numeric-node", { ...base, nodes: [1] }],
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
    },
    rustBinarySha256: hash(fs.readFileSync(binary)),
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
  assert.deepEqual(sourcePins(), pins, "Source files stayed immutable");
  fs.rmSync(runtime, { recursive: true, force: true });
}
