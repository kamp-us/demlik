import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cases } from "./agent-tool-map-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const qualifiedIds = ["runtime.promise", "runtime.effect"];
const causeText =
  'tool: "map_fault" is reserved — it is an agent-owned Msg prefix';
const nativeDiagnostic =
  'ReduceError: Reduce(ToolMapping(Reserved { name: "map_fault" }))';
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function compareToolMap(source, native, item) {
  assert.equal(source.id, item.id);
  assert.equal(native.id, item.id);
  assert.equal(source.ok, true);
  assert.equal(native.ok, true);
  const left = source.output,
    right = native.output;
  if (!qualifiedIds.includes(item.id)) {
    assert.deepEqual(right, left, "whole authored output");
    return { qualified: false };
  }
  assert.deepEqual(Object.keys(left.diagnostics[0]).sort(), [
    "message",
    "name",
    "stack",
  ]);
  assert.deepEqual(Object.keys(right.diagnostics[0]).sort(), [
    "message",
    "name",
  ]);
  assert.equal(left.diagnostics.length, 1);
  assert.equal(right.diagnostics.length, 1);
  assert.equal(left.diagnostics[0].name, "Error");
  assert.equal(left.diagnostics[0].message, causeText);
  assert.equal(typeof left.diagnostics[0].stack, "string");
  assert.ok(left.diagnostics[0].stack.startsWith(`Error: ${causeText}\n`));
  assert.equal(right.diagnostics[0].name, "ReduceError");
  assert.equal(right.diagnostics[0].message, nativeDiagnostic);
  for (const output of [left, right]) {
    assert.equal(output.handlerWork, 0);
    assert.equal(output.saves, 1);
    assert.equal(output.transitionSaves, 0);
    assert.equal(output.stopSaves, 1);
    assert.deepEqual(output.frames[0].error, {
      rejected: true,
      reports: 1,
      reportedSame: true,
    });
    assert.equal(output.frames[0].stateSame, true);
  }
  const { diagnostics: sourceDiagnostics, ...sourceView } = left;
  const { diagnostics: nativeDiagnostics, ...nativeView } = right;
  assert.deepEqual(
    nativeView,
    sourceView,
    "whole output apart from exact declared reporter fields",
  );
  return {
    qualified: true,
    reasons: ["typed-runtime-reporter-envelope"],
    fields: [
      "output.diagnostics[0].name",
      "output.diagnostics[0].message",
      "output.diagnostics[0].stack (Source only)",
    ],
    sourceDiagnostics,
    nativeDiagnostics,
  };
}
export function agentToolMapParity({
  binary,
  output,
  sourceReport,
  onlyId,
  allowFailures = false,
}) {
  const selected = onlyId ? cases.filter((c) => c.id === onlyId) : cases;
  assert.ok(selected.length > 0);
  const request = `${selected.map((c) => JSON.stringify(c)).join("\n")}\n`;
  const sourceFiles = [
    "packages/tea/src/agent/index.ts",
    "packages/tea/src/agent/tool-resilience.ts",
    "packages/tea/src/internal/flow/fan-out/index.ts",
  ];
  const pins = () =>
    Object.fromEntries(
      sourceFiles.map((f) => [f, hash(fs.readFileSync(path.join(root, f)))]),
    );
  const before = pins(),
    binaryHash = hash(fs.readFileSync(binary));
  let sourceRows, sourceProcess;
  if (sourceReport) {
    const saved = JSON.parse(fs.readFileSync(sourceReport, "utf8"));
    assert.equal(saved.Source, "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d");
    sourceRows = selected.map((c) => saved.rows.find((row) => row.id === c.id));
    sourceProcess = {
      reusedSavedSource: sourceReport,
      sha256: hash(fs.readFileSync(sourceReport)),
      newExecution: false,
    };
  } else {
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(
          new URL("./agent-tool-map-reference.mts", import.meta.url),
        ),
      ],
      { cwd: root, input: request, encoding: "utf8", timeout: 60_000 },
    );
    assert.ifError(run.error);
    assert.equal(run.status, 0);
    assert.equal(run.stderr, "");
    sourceRows = run.stdout.trim().split("\n").map(JSON.parse);
    sourceProcess = {
      status: run.status,
      signal: run.signal,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  }
  const run = spawnSync(binary, [], {
    cwd: root,
    input: request,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0);
  assert.equal(run.signal, null);
  assert.equal(run.stderr, "");
  const nativeRows = run.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(sourceRows.length, selected.length);
  assert.equal(nativeRows.length, selected.length);
  const observations = [],
    failures = [],
    nativeEvidence = {},
    qualifiedNativeEvidence = {};
  for (const [index, item] of selected.entries()) {
    const source = sourceRows[index],
      native = nativeRows[index];
    const row = { id: item.id, input: item, source, native, equal: false };
    try {
      const profile = compareToolMap(source, native, item);
      assert.ok(
        Array.isArray(native.observedCalls) && native.observedCalls.length > 0,
      );
      assert.ok(
        native.observedCalls.includes(
          item.kind === "fan"
            ? "demlik_tea::flow::fan_out::FanOut::try_scatter"
            : "demlik_tea::agent::AgentConfig::try_from_plain_turns",
        ),
      );
      Object.assign(row, { equal: true, ...profile });
      const evidence = { observedCalls: native.observedCalls };
      (profile.qualified ? qualifiedNativeEvidence : nativeEvidence)[item.id] =
        evidence;
    } catch (error) {
      row.failure = {
        name: error.name,
        message: error.message,
        actual: error.actual,
        expected: error.expected,
      };
      failures.push({ id: item.id, ...row.failure });
    }
    observations.push(row);
  }
  assert.deepEqual(pins(), before);
  assert.equal(hash(fs.readFileSync(binary)), binaryHash);
  const report = {
    cases: selected.length,
    passed: Object.keys(nativeEvidence).length,
    qualifiedPassed: Object.keys(qualifiedNativeEvidence).length,
    failures,
    observations,
    nativeEvidence,
    qualifiedNativeEvidence,
    binaryHash,
    sourceHashes: before,
    processes: {
      source: sourceProcess,
      native: {
        status: run.status,
        signal: run.signal,
        stdout: run.stdout,
        stderr: run.stderr,
      },
    },
    limits: [
      "Only runtime.promise/runtime.effect reporter name/Display/stack differ; exact raw diagnostics retained and original cause/rejection/cardinality/state/prefix/save-phase/handler checks are mandatory.",
      "No arbitrary JS exceptions/reflection, full routed Agent wire, raw stamp/scheduler or new runtime cancellation parity claim.",
      "Mapper prefix counters and existing policy cache are not rolled back. No transition Step/save/effect on rejection; explicit stop still flushes original state once.",
    ],
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  if (!allowFailures) assert.deepEqual(failures, []);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [binary, output, sourceReport, onlyId] = process.argv.slice(2);
  assert.ok(binary && output);
  const report = agentToolMapParity({
    binary,
    output,
    sourceReport,
    onlyId,
    allowFailures: process.env.DEMLIK_TOOL_MAP_ALLOW_FAILURES === "1",
  });
  console.log(
    JSON.stringify({
      cases: report.cases,
      passed: report.passed,
      qualifiedPassed: report.qualifiedPassed,
      failures: report.failures.length,
    }),
  );
}
