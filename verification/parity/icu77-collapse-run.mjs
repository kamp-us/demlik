import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const [binary, output] = process.argv.slice(2);
assert.ok(binary && output && process.argv.length === 4);
const rawFile = `${output}.raw.json`;
const command = [
  "--import",
  createRequire(import.meta.url).resolve("tsx"),
  fileURLToPath(new URL("./graph-collapse-report.mts", import.meta.url)),
  binary,
  rawFile,
];
const result = spawnSync(process.execPath, command, {
  cwd: root,
  env: {
    ...process.env,
    TMPDIR: "/private/tmp",
    TSX_DISABLE_CACHE: "1",
    DEMLIK_ICU77_COLLAPSE: "1",
  },
  encoding: "utf8",
  maxBuffer: 32 << 20,
});
fs.writeFileSync(`${output}.stdout`, result.stdout ?? "");
fs.writeFileSync(`${output}.stderr`, result.stderr ?? "");
fs.writeFileSync(
  `${output}.process.json`,
  `${JSON.stringify(
    {
      command: [process.execPath, ...command],
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
    },
    null,
    2,
  )}\n`,
);
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr);
const report = JSON.parse(fs.readFileSync(rawFile));
const anchors = JSON.parse(
  fs.readFileSync(new URL("./icu77-collapse-anchors.json", import.meta.url)),
);
assert.equal(report.passed, 7);
assert.equal(report.attempted, 7);
assert.equal(report.qualifiedPairs, 0);
assert.deepEqual(report.failures, []);
const view = (report) => ({
  pairOrder: report.candidates.map((c) => [c.aId, c.bId]),
  skipped: report.skippedBlocks.map((b) => [b.size, b.kind, b.key]),
  clusters: report.clusters.map((c) => c.members),
  partials: report.partialTwins.map((p) => ({
    a: p.aId,
    b: p.bId,
    constants: p.sharedConstants,
  })),
  rankOrder: report.candidates.map((c) => [c.aId, c.bId, c.rank]),
});
for (const row of report.cases) {
  assert.deepEqual(view(row.source), anchors[row.id]);
  assert.deepEqual(view(row.native.output.report), anchors[row.id]);
  row.nativeTrace = row.native.output;
  row.qualifications = [];
  assert.ok(Object.values(row.native.output.owners).every(Boolean));
}
report.scope =
  "Seven frozen Source/native ICU77 collapse ordering rows; original graph/settings/pair owners, scalar/raw-unit keys, stable ties and numeric precedence. Existing raw Graph/host/all53CLI gaps remain OPEN.";
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    cases: report.passed,
    strict: report.unqualifiedPairs,
    failures: report.failures.length,
  }),
);
