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
    fileURLToPath(new URL("./graph-unreachable-ledger.mts", import.meta.url)),
    binary,
    rawFile,
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const report = JSON.parse(fs.readFileSync(rawFile, "utf8"));
assert.equal(report.passed, 81);
assert.equal(report.unqualifiedPairs, 78);
assert.equal(report.qualifiedPairs, 3);
assert.equal(report.rejectedInvalidInputs, 4);
assert.deepEqual(report.failures, []);
report.attempted = 0;
report.nativeEvidence = {};
report.qualifiedNativeEvidence = {};
for (const row of report.cases) {
  if (row.protocol) continue;
  assert.equal(row.passed, true);
  assert.equal(row.process.status, 0);
  assert.ok(row.calls.length > 0);
  assert.equal(Boolean(row.qualified), Boolean(row.qualification));
  row.qualifications = row.qualified ? [row.qualification] : [];
  row.nativeTrace = { observedCalls: row.calls };
  const evidence = row.qualified
    ? report.qualifiedNativeEvidence
    : report.nativeEvidence;
  assert.ok(!Object.hasOwn(evidence, row.id));
  evidence[row.id] = row.calls;
  report.attempted++;
}
assert.equal(report.attempted, 81);
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
