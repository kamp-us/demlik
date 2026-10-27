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
    fileURLToPath(new URL("./graph-smell-ledger.mts", import.meta.url)),
    binary,
    rawFile,
    "icu77",
  ],
  { encoding: "utf8", maxBuffer: 32 << 20 },
);
const report = JSON.parse(fs.readFileSync(rawFile, "utf8"));
assert.equal(report.passed, 17);
assert.equal(report.strict, 17);
assert.equal(report.qualified, 0);
assert.equal(report.protocolRefusals, 4);
assert.deepEqual(report.failures, []);
assert.equal(
  new Set(report.cases.map((row) => row.id)).size,
  report.cases.length,
);
report.attempted = 17;
report.unqualifiedPairs = 17;
report.qualifiedPairs = 0;
report.rejectedInvalidInputs = 4;
report.nativeEvidence = {};
for (const row of report.cases) {
  if (row.protocol) continue;
  assert.equal(row.passed, true);
  assert.equal(row.qualified, false);
  assert.equal(row.process.status, 0);
  assert.ok(row.calls.length);
  row.qualifications = [];
  row.nativeTrace = { observedCalls: row.calls };
  report.nativeEvidence[row.id] = row.calls;
}
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
