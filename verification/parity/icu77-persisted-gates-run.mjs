import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile && process.argv.length === 4);
const names = [
  "ledger_driver",
  "scope_count_driver",
  "layer_driver",
  "reconcile_driver",
];
// The graph controller already builds these four existing drivers. Its artifact
// receipt must bind all four hashes, not only the primary ledger executable.
const binaries = Object.fromEntries(
  names.map((name) => [
    name,
    fs.realpathSync(
      name === "ledger_driver" ? binary : path.join(path.dirname(binary), name),
    ),
  ]),
);
const manifestFile = `${reportFile}.binaries.json`;
const rawFile = `${reportFile}.raw.json`;
fs.writeFileSync(manifestFile, `${JSON.stringify(binaries, null, 2)}\n`);
execFileSync(
  process.execPath,
  [
    "--import",
    createRequire(import.meta.url).resolve("tsx"),
    fileURLToPath(new URL("./icu77-persisted-gates.mts", import.meta.url)),
    manifestFile,
    rawFile,
  ],
  { encoding: "utf8", maxBuffer: 32 << 20 },
);
const report = JSON.parse(fs.readFileSync(rawFile, "utf8"));
assert.equal(report.passed, 31);
assert.equal(report.strict, 31);
assert.equal(report.qualified, 0);
assert.equal(report.cases.length, 31);
assert.equal(report.rejectedInvalidInputs, 0);
assert.deepEqual(report.failures, []);
assert.deepEqual(Object.keys(report.binaryHashes).sort(), [...names].sort());
assert.equal(new Set(report.cases.map((row) => row.id)).size, 31);
for (const row of report.cases) {
  assert.equal(row.passed, true);
  assert.equal(row.process.status, 0);
  assert.equal(row.actual.ok, true);
  assert.equal(row.actual.id, row.id);
  assert.ok(row.nativeTrace.observedCalls.length);
  assert.deepEqual(row.qualifications, []);
  assert.deepEqual(
    report.nativeEvidence[row.id],
    row.nativeTrace.observedCalls,
  );
}
report.unqualifiedPairs = 31;
report.qualifiedPairs = 0;
assert.deepEqual(report.qualifiedNativeEvidence, {});
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
