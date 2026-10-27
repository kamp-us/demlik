import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile && process.argv.length === 4);
const rawFile = `${reportFile}.raw.json`;
execFileSync(
  process.execPath,
  [
    "--import",
    createRequire(import.meta.url).resolve("tsx"),
    fileURLToPath(new URL("./graph-unreachable-render.mts", import.meta.url)),
    binary,
    rawFile,
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const report = JSON.parse(fs.readFileSync(rawFile, "utf8"));
assert.equal(report.passed, 10);
assert.equal(report.cases.length, 10);
assert.deepEqual(report.failures, []);
report.attempted = 0;
report.unqualifiedPairs = 10;
report.qualifiedPairs = 0;
report.rejectedInvalidInputs = 0;
report.nativeEvidence = {};
report.qualifiedNativeEvidence = {};
for (const row of report.cases) {
  assert.equal(row.passed, true);
  assert.equal(row.process.status, 0);
  assert.equal(row.actual.id, row.id);
  assert.ok(row.actual.calls.length > 0);
  row.qualifications = [];
  row.nativeTrace = { observedCalls: row.actual.calls };
  assert.equal(Object.hasOwn(report.nativeEvidence, row.id), false);
  report.nativeEvidence[row.id] = row.actual.calls;
  report.attempted++;
}
assert.equal(report.attempted, 10);
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
