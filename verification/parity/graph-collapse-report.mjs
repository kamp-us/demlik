import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
    fileURLToPath(new URL("./graph-collapse-report.mts", import.meta.url)),
    binary,
    rawFile,
  ],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const report = JSON.parse(fs.readFileSync(rawFile, "utf8"));
assert.equal(report.passed, 99);
assert.equal(report.attempted, 99);
assert.deepEqual(report.failures, []);
assert.equal(report.qualifiedPairs, 0);
for (const row of report.cases) {
  assert.equal(row.qualification, null);
  row.qualifications = [];
  row.nativeTrace = row.native.output;
  assert.deepEqual(
    row.nativeTrace.observedCalls,
    report.nativeEvidence[row.id].observedCalls,
  );
}
const first = report.cases[0].input;
const invalid = [
  "not JSON",
  "{}",
  JSON.stringify({ id: "unknown", input: { ...first, extra: true } }),
  JSON.stringify({
    id: "wrong",
    input: { operation: "pure", nodes: "x", settings: {}, packageRoots: [] },
  }),
];
assert.equal(report.rejectedInvalidInputs, invalid.length);
report.protocolRecording = {
  rawVerifierRefusals: report.rejectedInvalidInputs,
  recordedReplays: invalid.length,
  qualification:
    "Same four protocol checks replayed to retain process records; overlapping counts are not added.",
};
for (const [index, input] of invalid.entries()) {
  const result = spawnSync(binary, [], {
    input: `${input}\n`,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.ok(result.status !== null && result.status !== 0);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.length);
  report.cases.push({
    id: `protocol:${index}`,
    protocol: true,
    input,
    exit: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
