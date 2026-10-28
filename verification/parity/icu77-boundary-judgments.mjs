import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cases as allCases, filesFor } from "./icu77-boundary-cases.mjs";
import {
  reference,
  restore,
  snapshot,
  sourcePins,
} from "./icu77-boundary-reference.mjs";

assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
assert.equal(process.versions.icu, "77.1");
const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile && process.argv.length === 4);
const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(path.join(root, "verification/parity/package.json")),
  { z } = require("zod");
const cases = process.env.DEMLIK_J_CASES
  ? allCases.filter((c) => process.env.DEMLIK_J_CASES.split(",").includes(c.id))
  : allCases;
assert.ok(cases.length);
const responseSchema = z
  .strictObject({
    id: z.string().nullable(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z.strictObject({ name: z.string(), message: z.string() }).optional(),
    observedCalls: z.array(z.string()),
  })
  .superRefine((v, c) => {
    if (
      v.ok
        ? v.error !== undefined || !Object.hasOwn(v, "output")
        : v.error === undefined || Object.hasOwn(v, "output")
    )
      c.addIssue({
        code: "custom",
        message: "success/error envelope mismatch",
      });
  });
const hash = (b) => createHash("sha256").update(b).digest("hex"),
  pins = sourcePins(),
  binaryHash = hash(fs.readFileSync(binary));
const frozen = process.env.DEMLIK_J_FROZEN_SOURCE_REPORT
  ? JSON.parse(
      fs.readFileSync(process.env.DEMLIK_J_FROZEN_SOURCE_REPORT, "utf8"),
    )
  : null;
if (frozen) assert.deepEqual(frozen.sourceHashes, pins);
const runtime = frozen
  ? null
  : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "demlik-j-pairs-")));
const prefix = "demlik_code_graph::",
  catalog = `${prefix}extract::wrangler_config::load_binding_catalog`,
  parsed = `${prefix}boundaries::rules::BoundaryRules::parse`,
  gate = `${prefix}boundaries::gate::run_boundary_gate`;
function calls(item) {
  switch (item.mode) {
    case "gate":
      return [gate];
    case "impure":
      return [`${prefix}boundaries::impure_uses::detect_impure_uses`];
    case "bindings":
      return [`${prefix}boundaries::deployables::bindings::binding_violations`];
    case "worker":
      return [
        catalog,
        ...["worker_graph", "worker_cycles"].map(
          (n) => `${prefix}boundaries::deployables::cycles::${n}`,
        ),
      ];
    case "read":
      return [
        catalog,
        parsed,
        `${prefix}boundaries::deployables::read_deployables`,
      ];
    case "libraries":
      return [
        catalog,
        parsed,
        `${prefix}boundaries::libraries::read_libraries`,
        ...item.roots.flatMap(() => [
          `${prefix}boundaries::libraries::undeclared_under`,
          `${prefix}boundaries::libraries::violations::undeclared_libraries`,
        ]),
      ];
    case "analyze":
      return [
        catalog,
        parsed,
        `${prefix}boundaries::libraries::read_libraries`,
        `${prefix}boundaries::deployables::read_deployables`,
        `${prefix}boundaries::shape::read_shape`,
        `${prefix}boundaries::analyze::analyze_boundaries`,
      ];
    default:
      throw new Error("unknown case mode");
  }
}
function run(request) {
  const p = spawnSync(binary, [], {
    input: `${typeof request === "string" ? request : JSON.stringify(request)}\n`,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  assert.ifError(p.error);
  assert.equal(p.status, 0);
  assert.equal(p.signal, null);
  assert.equal(p.stderr, "");
  const actual = responseSchema.parse(JSON.parse(p.stdout));
  return {
    process: {
      status: p.status,
      signal: p.signal,
      stdout: p.stdout,
      stderr: p.stderr,
    },
    actual,
  };
}
const stamp = (ledger) =>
  fs.existsSync(ledger) ? fs.statSync(ledger, { bigint: true }) : null;
function gateRun(request) {
  const ledger = path.join(request.root, "boundary-ledger.json"),
    before = stamp(ledger),
    r = run(request),
    after = stamp(ledger);
  if (r.actual.ok)
    r.actual.output.ledgerWritten =
      before === null
        ? after !== null
        : after === null ||
          before.mtimeNs !== after.mtimeNs ||
          before.ino !== after.ino;
  return r;
}
function nativeWorkflow(fixture) {
  const actions = [
      { name: "report", under: "." },
      {
        name: "record",
        under: ".",
        flags: { acceptCrossings: true, reason: "initial architecture" },
      },
      { name: "repeat-ci", under: ".", flags: { ci: true } },
      {
        name: "repeat-record-no-write",
        under: ".",
        flags: { acceptCrossings: true, reason: "ignored second reason" },
      },
      { name: "add-drift", under: ".", flags: { ci: true }, add: true },
      {
        name: "record-api-scope",
        under: "services/api",
        flags: { acceptCrossings: true, reason: "new API use" },
      },
      {
        name: "remove-and-prune",
        under: ".",
        flags: { ci: true },
        remove: true,
      },
      { name: "other-scope", under: "services/other", flags: { ci: true } },
      { name: "final-report", under: ".", pretty: true },
    ],
    steps = [],
    frames = [],
    observedCalls = [];
  for (const a of actions) {
    const at = path.join(fixture, "services/api/src/orders/application/new.ts");
    if (a.add) fs.writeFileSync(at, "export const newer=()=>process.env.X;");
    if (a.remove) fs.unlinkSync(at);
    const before = snapshot(fixture),
      r = gateRun({
        id: `two-scope-real-workflow.${a.name}`,
        mode: "gate",
        root: fixture,
        under: a.under,
        flags: a.flags ?? {},
        pretty: a.pretty ?? false,
      });
    frames.push(r);
    assert.equal(r.actual.ok, true);
    assert.deepEqual(r.actual.observedCalls, [gate]);
    observedCalls.push(...r.actual.observedCalls);
    steps.push({
      name: a.name,
      before,
      result: r.actual.output,
      after: snapshot(fixture),
    });
  }
  return {
    actual: {
      id: "two-scope-real-workflow",
      ok: true,
      output: { steps },
      observedCalls,
    },
    processes: frames.map((r) => r.process),
    responses: frames.map((r) => r.actual),
  };
}
const observed = [],
  failures = [],
  nativeEvidence = {},
  qualifiedNativeEvidence = {};
let rejectedInvalidInputs = 0,
  responseGuards = 0;
try {
  for (const item of cases) {
    const saved = frozen?.rows.find((r) => r.id === item.id),
      fixture = saved?.root ?? path.join(runtime, item.id);
    if (saved) assert.deepEqual(saved.input, item);
    restore(fixture, filesFor(item));
    const before = snapshot(fixture);
    if (saved) assert.deepEqual(before, saved.before);
    let output, error;
    try {
      output = reference(item, fixture);
    } catch (e) {
      error = { name: e.name, message: e.message };
    }
    const expected = error ? { error } : { output },
      sourceAfter = snapshot(fixture);
    if (saved) {
      assert.deepEqual(
        expected,
        saved.error ? { error: saved.error } : { output: saved.output },
        "Source20 stays frozen",
      );
      assert.deepEqual(sourceAfter, saved.after);
    }
    const { files: _files, ...values } = item,
      request = { ...values, root: fixture };
    const row = {
      id: item.id,
      input: item,
      root: fixture,
      request,
      before,
      expected,
      sourceAfter,
      qualifications: [],
      passed: false,
    };
    try {
      restore(fixture, filesFor(item));
      assert.deepEqual(snapshot(fixture), before);
      Object.assign(
        row,
        item.mode === "workflow"
          ? nativeWorkflow(fixture)
          : item.mode === "gate"
            ? gateRun(request)
            : run(request),
      );
      row.nativeTrace = { observedCalls: row.actual.observedCalls };
      assert.equal(row.actual.id, item.id);
      assert.equal(row.actual.ok, !error);
      if (item.mode !== "workflow")
        assert.deepEqual(row.actual.observedCalls, calls(item));
      if (error) assert.deepEqual(row.actual.error, error);
      else assert.deepEqual(row.actual.output, output);
      row.after = snapshot(fixture);
      assert.deepEqual(row.after, sourceAfter);
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
  if (!process.env.DEMLIK_J_CASES) {
    assert.equal(observed.length, 20);
    const base = {
      id: "bad",
      root: frozen?.rows[0].root ?? runtime,
      mode: "impure",
      source: "",
    };
    for (const [id, request] of [
      ["invalid-json", "{"],
      ["missing-id", {}],
      ["unknown-field", { ...base, unknown: true }],
      ["numeric-root", { ...base, root: 1 }],
      ["numeric-binding", { ...base, mode: "bindings", bindingNames: [1] }],
    ]) {
      const result = run(request);
      assert.equal(result.actual.id, null);
      assert.equal(result.actual.ok, false);
      assert.equal(result.actual.error.name, "ProtocolError");
      assert.deepEqual(result.actual.observedCalls, []);
      observed.push({
        id: `protocol.${id}`,
        protocol: true,
        passed: true,
        ...result,
      });
      rejectedInvalidInputs++;
    }
    const valid = observed.find((r) => r.actual?.ok).actual;
    for (const bad of [
      { ...valid, ignored: true },
      { ...valid, error: { name: "bad", message: "bad" } },
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
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
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
