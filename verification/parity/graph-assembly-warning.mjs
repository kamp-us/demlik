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
    fileURLToPath(new URL("./graph-assembly-warning.mts", import.meta.url)),
    binary,
    rawFile,
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const report = JSON.parse(fs.readFileSync(rawFile, "utf8"));
assert.equal(report.passed, 30);
assert.deepEqual(report.failures, []);
report.attempted = report.cases.length;
report.nativeEvidence = {};
report.qualifiedNativeEvidence = {};
for (const row of report.cases) {
  row.qualifications = row.qualification ? [row.qualification] : [];
  assert.ok(typeof row.nativeCall === "string" && row.nativeCall.length);
  if (row.native.thrown?.stage === "load")
    assert.equal(
      row.nativeCall,
      "demlik_code_graph::project::load_edge_project_text",
      "load refusal must not claim an assembly call",
    );
  row.nativeTrace = { observedCalls: [row.nativeCall] };
  const evidence = row.qualifications.length
    ? report.qualifiedNativeEvidence
    : report.nativeEvidence;
  evidence[row.id] = row.nativeTrace.observedCalls;
}
assert.equal(
  Object.keys(report.nativeEvidence).length,
  report.unqualifiedPairs,
);
assert.equal(
  Object.keys(report.qualifiedNativeEvidence).length,
  report.qualifiedPairs,
);
report.cases.push(
  ...report.protocol.map((row) => ({ ...row, protocol: true })),
);
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
