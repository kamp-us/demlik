import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile && process.argv.length === 4);
const rawFile = `${reportFile}.raw.json`;
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL("./graph-cli-smell.mjs", import.meta.url)),
    binary,
    rawFile,
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const report = JSON.parse(fs.readFileSync(rawFile, "utf8"));
assert.equal(report.passed, 50);
assert.equal(report.attempted, 50);
assert.equal(report.strictPairs, 39);
assert.equal(report.qualifiedPairs, 8);
assert.equal(report.nativeOnlyCases, 3);
assert.equal(report.pairedExecutions, 55);
assert.equal(report.rejectedInvalidInputs, 5);
assert.equal(report.responseGuards, 3);
assert.deepEqual(report.failures, []);
const nativeOnly = report.cases.filter((row) => row.nativeOnly === true);
assert.deepEqual(
  nativeOnly.map((row) => row.id),
  [
    "ordinary-smells-remains-continuation",
    "generic-ci-remains-continuation",
    "explicit-missing-compiler-error",
  ],
);
for (const row of nativeOnly) {
  assert.equal(row.passed, true);
  assert.equal(Object.hasOwn(report.nativeEvidence, row.id), false);
  assert.equal(Object.hasOwn(report.qualifiedNativeEvidence, row.id), false);
}
const workflow = report.cases.find(
  (row) => row.id === "syntax-two-package-workflow",
);
assert.equal(workflow.source.length, 9);
assert.equal(workflow.native.length, 9);
report.nativeOnlyRecording = {
  rawReport: rawFile,
  ids: nativeOnly.map((row) => row.id),
  comparisonCredit: 0,
};
report.cases = report.cases.filter((row) => row.nativeOnly !== true);
report.passed = report.strictPairs + report.qualifiedPairs;
report.attempted = report.passed;
report.unqualifiedPairs = report.strictPairs;
assert.equal(report.cases.length, report.passed + report.rejectedInvalidInputs);
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
