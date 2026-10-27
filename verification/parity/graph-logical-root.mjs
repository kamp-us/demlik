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
    fileURLToPath(new URL("./graph-logical-root.mts", import.meta.url)),
    binary,
    rawFile,
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const report = JSON.parse(fs.readFileSync(rawFile, "utf8"));
assert.equal(report.passed, 16);
assert.deepEqual(report.failures, []);
report.attempted = report.cases.length;
report.nativeEvidence = {};
report.qualifiedNativeEvidence = {};
for (const row of report.cases) {
  row.qualifications = [];
  assert.ok(row.native.observedCalls.length);
  report.nativeEvidence[row.id] = row.native.observedCalls;
}
assert.equal(
  Object.keys(report.nativeEvidence).length,
  report.unqualifiedPairs,
);
assert.equal(report.qualifiedPairs, 0);
report.cases.push(
  ...report.invalid.map((row, index) => ({
    ...row,
    id: `protocol:${index}`,
    protocol: true,
  })),
);
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
