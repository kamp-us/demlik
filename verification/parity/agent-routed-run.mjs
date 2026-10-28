import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentRoutedCases } from "./agent-routed-cases.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);
const hash = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const qualifiedScenarios = new Set(["cold-pending", "map-refusal"]);
const mapText =
  'tool: "map_fault" is reserved — it is an agent-owned Msg prefix';
export function compareRoutedView(input, source, native) {
  if (!qualifiedScenarios.has(input.scenario)) {
    assert.deepEqual(native, source, "whole routed Agent view");
    return null;
  }
  const left = structuredClone(source),
    right = structuredClone(native);
  const a = input.scenario === "cold-pending" ? left.writer : left;
  const b = input.scenario === "cold-pending" ? right.writer : right;
  const count = input.scenario === "cold-pending" ? 1 : 2;
  assert.equal(a.diagnostics.length, count);
  assert.equal(b.diagnostics.length, count);
  assert.equal(a.reports.length, count);
  assert.equal(b.reports.length, count);
  const errors = [];
  for (let i = 0; i < count; i++) {
    const x = a.diagnostics[i].error,
      y = b.diagnostics[i].error;
    const text =
      input.scenario === "cold-pending" ? "persisted-before-tool" : mapText;
    assert.deepEqual(Object.keys(x).sort(), ["message", "name", "stack"]);
    assert.deepEqual(Object.keys(y).sort(), ["message", "name"]);
    assert.equal(x.name, "Error");
    assert.equal(x.message, text);
    assert.equal(typeof x.stack, "string");
    assert.ok(x.stack.startsWith(`Error: ${text}\n`));
    assert.deepEqual(
      y,
      input.scenario === "cold-pending"
        ? {
            name: "StoreFailed",
            message: "StoreFailed: Save(Crash(Cell { value: 0 }))",
          }
        : {
            name: "ReduceError",
            message:
              'ReduceError: Reduce(Agent(ToolMapping(Reserved { name: "map_fault" })))',
          },
    );
    assert.equal(a.reports[i].mapCauseSame, input.scenario === "map-refusal");
    assert.equal(b.reports[i].mapCauseSame, input.scenario === "map-refusal");
    assert.equal(a.reports[i].saveCauseSame, input.scenario === "cold-pending");
    assert.equal(b.reports[i].saveCauseSame, input.scenario === "cold-pending");
    errors.push({ source: x, native: y });
    delete a.diagnostics[i].error;
    delete b.diagnostics[i].error;
  }
  assert.deepEqual(
    right,
    left,
    "whole routed view including phases/cause receipts, apart from declared reporter error fields",
  );
  return {
    reason: "typed-runtime-reporter-envelope",
    fields: [
      "diagnostics[*].error.name",
      "diagnostics[*].error.message",
      "diagnostics[*].error.stack (Source only)",
    ],
    errors,
  };
}
export function agentRoutedParity({
  binary,
  output,
  sourceReport,
  onlyId,
  allowFailures = false,
}) {
  assert.deepEqual(
    { node: process.version, v8: process.versions.v8 },
    JSON.parse(
      fs.readFileSync(path.join(root, "verification/parity/scope.json")),
    ).referenceEngine,
  );
  binary = path.resolve(binary);
  output = path.resolve(output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const selected = onlyId
    ? agentRoutedCases.filter((x) => x.id === onlyId)
    : agentRoutedCases;
  assert.ok(selected.length);
  const before = hash(binary);
  const sourceFiles = [
    "packages/tea/src/agent/index.ts",
    "packages/tea/src/agent/tool.ts",
    "packages/tea/src/agent/tool-cell.ts",
  ];
  const pins = () =>
    Object.fromEntries(sourceFiles.map((f) => [f, hash(path.join(root, f))]));
  const sourceBefore = pins(),
    saved = sourceReport ? JSON.parse(fs.readFileSync(sourceReport)) : null;
  if (saved) {
    assert.equal(saved.complete, true);
    assert.deepEqual(saved.engine, {
      node: process.version,
      v8: process.versions.v8,
    });
  }
  const report = {
    cases: selected.length,
    observations: [],
    processes: [],
    passed: 0,
    qualifiedPassed: 0,
    failures: [],
    nativeEvidence: {},
    qualifiedNativeEvidence: {},
    binaryHash: before,
    Source: sourceBefore,
    sourceReport: sourceReport
      ? { path: sourceReport, sha256: hash(sourceReport) }
      : null,
    qualifications: [
      "Serial no-policy NativeCalls only. Promise/Effect caller queue order is explicit; arbitrary executors/Promise eagerness remain OPEN.",
      "Missing/null/manual timestamps, raw child-args ownership, optional Agent grids and full routed-state JSON codecs remain OPEN.",
      "Cold reload decodes pending-only State; generated settled result/error decoder intentionally refuses, commandless ready then explicit Boot.",
      "Four failure rows preserve original causes/phases/cardinality/state and qualify only exact typed reporter name/message/Source stack fields.",
    ],
  };
  const save = () =>
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  const run = (label, command, args, input) => {
    const r = spawnSync(command, args, {
      cwd: root,
      input: `${JSON.stringify(input)}\n`,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const stdout = `${output}.${label}.stdout`,
      stderr = `${output}.${label}.stderr`;
    fs.writeFileSync(stdout, r.stdout ?? "");
    fs.writeFileSync(stderr, r.stderr ?? "");
    report.processes.push({
      label,
      command: [command, ...args],
      input,
      status: r.status,
      signal: r.signal,
      error: r.error
        ? { name: r.error.name, message: r.error.message, code: r.error.code }
        : null,
      stdout,
      stderr,
    });
    save();
    assert.equal(r.error, undefined, label);
    assert.equal(r.status, 0, label);
    assert.equal(r.stderr, "", label);
    const rows = r.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(rows.length, 1, label);
    assert.equal(rows[0].id, input.id);
    assert.equal(rows[0].ok, true);
    return rows[0];
  };
  try {
    for (const input of selected) {
      const phases =
        input.scenario === "cold-pending" ? ["writer", "reader"] : ["run"];
      const views = { source: {}, native: {} };
      const savedRow = saved?.rows.find((x) => x.id === input.id);
      if (saved) assert.deepEqual(savedRow.input, input);
      for (const side of ["source", "native"]) {
        const directory = fs.mkdtempSync(
          `${output}.${side}-${input.profile}-${input.scenario}-`,
        );
        for (const phase of phases) {
          const spec = {
            ...input,
            id: input.id + (phase === "run" ? "" : `.${phase}`),
            directory,
            ...(phase === "run" ? {} : { mode: phase }),
          };
          views[side][phase] =
            side === "source" && saved
              ? phase === "run"
                ? savedRow.source
                : savedRow.source[phase]
              : run(
                  `${side}.${spec.id}`,
                  side === "source" ? process.execPath : binary,
                  side === "source"
                    ? [
                        "--import",
                        require.resolve("tsx"),
                        "verification/parity/agent-routed-reference.mts",
                      ]
                    : [],
                  spec,
                );
        }
      }
      const source =
        input.scenario === "cold-pending"
          ? Object.fromEntries(phases.map((p) => [p, views.source[p].view]))
          : views.source.run.view;
      const native =
        input.scenario === "cold-pending"
          ? Object.fromEntries(phases.map((p) => [p, views.native[p].view]))
          : views.native.run.view;
      const row = {
        id: input.id,
        input,
        source,
        native,
        rawSource: views.source,
        rawNative: views.native,
        equal: false,
      };
      try {
        const qualification = compareRoutedView(input, source, native);
        row.qualification = qualification;
        row.equal = true;
        const calls = views.native[phases[0]].observedCalls;
        assert.ok(calls.length > 0);
        for (const phase of phases) {
          assert.deepEqual(views.native[phase].observedCalls, calls);
          const n = views.native[phase].nativeOwnershipChecks;
          assert.equal(typeof n, "number");
          if (phase !== "writer" && input.scenario !== "map-refusal")
            assert.ok(n > 0, "nonvacuous tool-owner checks");
        }
        if (qualification) {
          report.qualifiedPassed++;
          report.qualifiedNativeEvidence[input.id] = { calls, qualification };
        } else {
          report.passed++;
          report.nativeEvidence[input.id] = calls;
        }
      } catch (error) {
        report.failures.push({
          id: input.id,
          message: error.message,
          source,
          native,
        });
      }
      report.observations.push(row);
      save();
    }
  } finally {
    report.binaryHashAfter = hash(binary);
    report.sourceAfter = pins();
    save();
    assert.equal(report.binaryHashAfter, before);
    assert.deepEqual(report.sourceAfter, sourceBefore);
  }
  if (!allowFailures) assert.equal(report.failures.length, 0);
  return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [binary, output, sourceReport, onlyId] = process.argv.slice(2);
  const report = agentRoutedParity({ binary, output, sourceReport, onlyId });
  console.log(
    JSON.stringify({
      cases: report.cases,
      passed: report.passed,
      qualifiedPassed: report.qualifiedPassed,
      failures: report.failures.length,
    }),
  );
}
