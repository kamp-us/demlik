import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const anchors = JSON.parse(
  fs.readFileSync(new URL("./icu77-collapse-anchors.json", import.meta.url)),
);
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
export function sharedIcu77Collapse(report) {
  assert.equal(report.passed, 7);
  assert.equal(report.attempted, 7);
  assert.equal(report.unqualifiedPairs, 7);
  assert.equal(report.qualifiedPairs, 0);
  assert.equal(report.rejectedInvalidInputs, 4);
  if (report.rejectedInvalidInputRows !== undefined) {
    assert.equal(report.rejectedInvalidInputRows, 0);
  }
  assert.equal(report.responseGuards, 3);
  assert.deepEqual(report.failures, []);
  const ids = Object.keys(anchors).sort();
  assert.equal(report.cases.length, 7);
  assert.deepEqual(report.cases.map((row) => row.id).sort(), ids);
  assert.deepEqual(Object.keys(report.nativeEvidence).sort(), ids);
  assert.deepEqual(report.qualifiedNativeEvidence, {});
  assert.match(report.nativeExecutable.sha256, /^[0-9a-f]{64}$/);
  for (const row of report.cases) {
    assert.equal(row.passed, true);
    assert.notEqual(row.protocol, true);
    assert.notEqual(row.nativeOnly, true);
    if (row.qualifications !== undefined) {
      assert.deepEqual(row.qualifications, []);
    }
    assert.equal(row.native.id, row.id);
    assert.deepEqual(row.native.output.report, row.source);
    assert.deepEqual(row.native.output.numeric, row.sourceNumeric);
    assert.ok(row.native.output.observedCalls.length > 0);
    assert.deepEqual(
      report.nativeEvidence[row.id].observedCalls,
      row.native.output.observedCalls,
    );
    assert.deepEqual(view(row.source), anchors[row.id]);
    assert.deepEqual(view(row.native.output.report), anchors[row.id]);
    row.nativeTrace = row.native.output;
    row.qualifications = [];
    assert.deepEqual(row.native.output.owners, {
      settings: true,
      nodes: true,
      representatives: true,
      partials: true,
    });
  }
  report.rejectedInvalidInputRows = 0;
  report.scope =
    "Seven frozen Source/native ICU77 collapse ordering rows; original graph/settings/pair owners, scalar/raw-unit keys, stable ties and numeric precedence. Existing raw Graph/host/all53CLI gaps remain OPEN.";
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
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
  sharedIcu77Collapse(report);
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      cases: report.passed,
      strict: report.unqualifiedPairs,
      failures: report.failures.length,
    }),
  );
}
