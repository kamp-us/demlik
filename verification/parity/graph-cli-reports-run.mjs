import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function sharedReports(report, rawFile) {
  assert.equal(report.sourceOnly, false);
  assert.equal(report.passed, 82);
  assert.equal(report.attempted, 82);
  assert.equal(report.strictPairs, 72);
  assert.equal(report.qualifiedPairs, 5);
  assert.equal(report.nativeOnlyCases, 5);
  assert.equal(report.sourceExecutions, 85);
  assert.equal(report.rejectedInvalidInputs, 5);
  assert.equal(report.responseGuards, 3);
  assert.deepEqual(report.failures, []);
  const nativeOnly = report.cases.filter((row) => row.nativeOnly === true);
  assert.deepEqual(
    nativeOnly.map((row) => row.id),
    [
      "unsupported-html-same-box",
      "unsupported-tree-same-box",
      "unsupported-hotspots-same-box",
      "unsupported-blast-same-box",
      "unsupported-find-same-box",
    ],
  );
  for (const row of nativeOnly) {
    assert.equal(row.passed, true);
    assert.equal(row.source.length, 0);
    assert.equal(row.native.length, 1);
    assert.equal(Object.hasOwn(report.nativeEvidence, row.id), false);
    assert.equal(Object.hasOwn(report.qualifiedNativeEvidence, row.id), false);
  }
  const workflow = report.cases.find(
    (row) => row.id === "two-package-console-workflow",
  );
  assert.equal(workflow.source.length, 9);
  assert.equal(workflow.native.length, 9);
  const valid = report.cases.filter((row) => row.protocol !== true);
  report.nativeExecutions = valid.reduce((n, row) => n + row.native.length, 0);
  assert.equal(report.nativeExecutions, 90);
  report.nativeOnlyRecording = {
    rawReport: rawFile,
    ids: nativeOnly.map((row) => row.id),
    nativeExecutions: 5,
    comparisonCredit: 0,
  };
  report.cases = report.cases.filter((row) => row.nativeOnly !== true);
  const shared = report.cases.filter((row) => row.protocol !== true);
  assert.equal(shared.length, 77);
  assert.equal(
    shared.reduce((n, row) => n + row.source.length, 0),
    85,
  );
  report.sharedNativeExecutions = shared.reduce(
    (n, row) => n + row.native.length,
    0,
  );
  assert.equal(report.sharedNativeExecutions, 85);
  for (const row of shared) {
    assert.equal(row.passed, true);
    assert.ok(row.source.length > 0 && row.native.length === row.source.length);
    const calls = [
      ...new Set(row.native.flatMap((step) => step.trace.observedCalls)),
    ];
    assert.ok(calls.length > 0);
    const declared =
      row.qualifications.length > 0
        ? report.qualifiedNativeEvidence
        : report.nativeEvidence;
    assert.deepEqual(declared[row.id], calls);
    row.nativeTrace = { observedCalls: calls };
    declared[row.id] = { observedCalls: calls };
  }
  report.passed = shared.length;
  report.attempted = report.passed;
  report.unqualifiedPairs = report.strictPairs;
  assert.equal(Object.keys(report.nativeEvidence).length, 72);
  assert.equal(Object.keys(report.qualifiedNativeEvidence).length, 5);
  assert.equal(
    report.cases.length,
    report.passed + report.rejectedInvalidInputs,
  );
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
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const report = sharedReports(
    JSON.parse(fs.readFileSync(rawFile, "utf8")),
    rawFile,
  );
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
