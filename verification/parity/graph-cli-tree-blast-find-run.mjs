import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const qualified = new Map([
  [
    "blast-warning-before-file-failure",
    ["backend-exception-diagnostic-qualified"],
  ],
  [
    "blast-warning-output-pending-stdout",
    ["pending-stdio-notification-contract"],
  ],
  [
    "find-pending-stderr-still-writes-file",
    ["pending-stdio-notification-contract"],
  ],
  [
    "find-raw-query-units",
    [
      "caller-supplied-UTF16-argv-profile",
      "source-unit-versus-native-encoded-write-observer",
    ],
  ],
]);

export function sharedTailReports(report, rawFile) {
  assert.equal(report.sourceOnly, false);
  assert.equal(report.passed, 32);
  assert.equal(report.attempted, 32);
  assert.equal(report.strictPairs, 28);
  assert.equal(report.qualifiedPairs, 4);
  assert.equal(report.nativeOnlyCases, 0);
  assert.equal(report.sourceExecutions, 38);
  assert.equal(report.rejectedInvalidInputs, 5);
  assert.equal(report.responseGuards, 3);
  assert.match(report.driverSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.failures, []);
  assert.equal(
    new Set(report.cases.map((row) => row.id)).size,
    report.cases.length,
  );
  assert.equal(report.cases.length, 37);
  assert.equal(report.cases.filter((row) => row.nativeOnly === true).length, 0);
  const protocol = report.cases.filter((row) => row.protocol === true);
  assert.equal(protocol.length, 5);
  for (const row of protocol) {
    assert.equal(row.passed, true);
    assert.notEqual(row.status, 0);
    assert.equal(row.stdout, "");
    assert.ok(row.stderr.length > 0);
    assert.equal(Object.hasOwn(report.nativeEvidence, row.id), false);
    assert.equal(Object.hasOwn(report.qualifiedNativeEvidence, row.id), false);
  }
  const shared = report.cases.filter((row) => row.protocol !== true);
  assert.equal(shared.length, 32);
  assert.equal(
    shared.reduce((n, row) => n + row.source.length, 0),
    38,
  );
  assert.equal(
    shared.reduce((n, row) => n + row.native.length, 0),
    38,
  );
  const workflow = shared.find((row) => row.id === "two-package-tail-workflow");
  assert.equal(workflow.source.length, 7);
  assert.equal(workflow.native.length, 7);
  for (const [map, ids] of [
    [
      report.nativeEvidence,
      shared.filter((row) => !qualified.has(row.id)).map((row) => row.id),
    ],
    [report.qualifiedNativeEvidence, [...qualified.keys()]],
  ])
    assert.deepEqual(Object.keys(map).sort(), ids.sort());
  for (const row of shared) {
    assert.equal(row.passed, true);
    assert.equal(row.native.length, row.source.length);
    assert.ok(row.source.length > 0);
    assert.deepEqual(row.qualifications, qualified.get(row.id) ?? []);
    const calls = [
      ...new Set(row.native.flatMap((step) => step.trace.observedCalls)),
    ];
    assert.ok(calls.length > 0);
    const evidence = qualified.has(row.id)
      ? report.qualifiedNativeEvidence
      : report.nativeEvidence;
    assert.deepEqual(evidence[row.id], calls);
    row.nativeTrace = { observedCalls: calls };
    evidence[row.id] = { observedCalls: calls };
  }
  report.scope =
    "Prepared tree/blast/find library CLI with explicit Plain/ANSI host fact, canonical cheap/official Go graph and borrowed nodes; controlled Source/native processes and exact file/exit behavior. AutomaticTTY/bootstrap, rawGraph/string/numeric/platform profiles, HTML and hotspots remain OPEN; all53 CLI gaps retained.";
  report.unqualifiedPairs = 28;
  report.nativeExecutions = 38;
  report.sharedNativeExecutions = 38;
  report.nativeOnlyRecording = {
    rawReport: rawFile,
    ids: [],
    nativeExecutions: 0,
    comparisonCredit: 0,
  };
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [binary, reportFile] = process.argv.slice(2);
  assert.ok(binary && reportFile && process.argv.length === 4);
  const rawFile = `${reportFile}.raw.json`;
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("./graph-cli-reports.mjs", import.meta.url)),
      binary,
      rawFile,
      "tree-blast-find",
    ],
    { encoding: "utf8", maxBuffer: 32 << 20 },
  );
  const report = sharedTailReports(
    JSON.parse(fs.readFileSync(rawFile, "utf8")),
    rawFile,
  );
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
