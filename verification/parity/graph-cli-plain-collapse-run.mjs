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
    fileURLToPath(new URL("./graph-cli-plain-collapse.mjs", import.meta.url)),
    binary,
    rawFile,
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const report = JSON.parse(fs.readFileSync(rawFile, "utf8"));
assert.equal(report.passed, 49);
assert.equal(report.attempted, 49);
assert.equal(report.strictPairs, 35);
assert.equal(report.qualifiedPairs, 10);
assert.equal(report.nativeOnlyCases, 4);
assert.equal(report.pairedExecutions, 51);
assert.deepEqual(report.failures, []);
const nativeOnly = report.cases.filter((row) => row.nativeOnly === true);
assert.equal(nativeOnly.length, 4);
for (const row of nativeOnly) {
  assert.equal(row.passed, true);
  assert.equal(Object.hasOwn(report.nativeEvidence, row.id), false);
  assert.equal(Object.hasOwn(report.qualifiedNativeEvidence, row.id), false);
}
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
