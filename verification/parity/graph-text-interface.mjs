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
    fileURLToPath(new URL("./graph-text-interface.mts", import.meta.url)),
    binary,
    rawFile,
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const report = JSON.parse(fs.readFileSync(rawFile, "utf8"));
assert.equal(report.passed, 47);
assert.deepEqual(report.failures, []);
report.nativeEvidence = {};
report.qualifiedNativeEvidence = {};
for (const row of report.cases) {
  if (row.protocol) continue;
  row.qualifications = row.qualification ? [row.qualification] : [];
  const evidence = row.qualifications.length
    ? report.qualifiedNativeEvidence
    : report.nativeEvidence;
  assert.ok(row.native.observedCalls.length);
  evidence[row.id] = row.native.observedCalls;
}
assert.equal(Object.keys(report.nativeEvidence).length, 45);
assert.equal(Object.keys(report.qualifiedNativeEvidence).length, 2);
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
