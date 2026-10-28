import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ids = [
  "empty-root",
  "cheap-clean",
  "hierarchy-severity",
  "hub-sites-one-hop",
  "two-sites-not-hub",
  "self-sites-hub",
  "cycle-and-unknown",
  "duplicate-id-last-node",
  "literal-space-edge-key",
  "directory-before-same-leaf",
  "header-escaping",
  "raw-root-units",
  "unicode-directory-order",
  "smell-kinds-dedup",
];
const protocolIds = [
  "protocol.missing-input",
  "protocol.unknown-field",
  "protocol.numeric-root",
  "protocol.bad-health",
  "protocol.unknown-node-field",
];
const calls = [
  "demlik_code_graph::render::html::build_html_model",
  "demlik_code_graph::render::html::render_html",
];

export function sharedHtml(report, rawFile) {
  assert.equal(report.passed, 14);
  assert.equal(report.attempted, 14);
  assert.equal(report.unqualifiedPairs, 14);
  assert.equal(report.qualifiedPairs, 0);
  assert.equal(report.rejectedInvalidInputs, 5);
  assert.match(report.rustBinarySha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(
    report.cases.map((row) => row.id),
    [...ids, ...protocolIds],
  );
  assert.equal(
    report.cases.some((row) => row.nativeOnly === true),
    false,
  );
  assert.deepEqual(Object.keys(report.nativeEvidence), ids);
  assert.deepEqual(report.qualifiedNativeEvidence, {});
  for (const row of report.cases) {
    assert.equal(row.passed, true);
    assert.equal(row.process.status, 0);
    assert.equal(row.process.signal, null);
    assert.equal(row.process.stderr, "");
    assert.deepEqual(JSON.parse(row.process.stdout), row.actual);
    if (protocolIds.includes(row.id)) {
      assert.equal(row.protocol, true);
      assert.equal(row.actual.id, null);
      assert.equal(row.actual.ok, false);
      assert.ok(row.actual.error.length > 0);
      assert.deepEqual(row.actual.observedCalls, []);
      assert.equal(Object.hasOwn(report.nativeEvidence, row.id), false);
    } else {
      assert.notEqual(row.protocol, true);
      assert.deepEqual(row.qualifications, []);
      assert.equal(row.actual.id, row.id);
      assert.equal(row.actual.ok, true);
      assert.deepEqual(row.actual.output, row.expected);
      assert.deepEqual(row.actual.observedCalls, calls);
      assert.deepEqual(row.nativeTrace.observedCalls, calls);
      assert.deepEqual(report.nativeEvidence[row.id], calls);
      report.nativeEvidence[row.id] = {
        observedCalls: row.actual.observedCalls,
      };
    }
  }
  report.scope =
    "Borrowed canonical Graph/Summary HTML model and frozen Source page bytes. Browser/CDN execution, distribution, existing rawGraph/string/numeric profiles and all53 CLI gaps remain OPEN.";
  report.nativeOnlyRecording = {
    rawReport: rawFile,
    ids: [],
    nativeExecutions: 0,
    comparisonCredit: 0,
  };
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [binary, reportFile] = process.argv.slice(2);
  assert.ok(binary && reportFile && process.argv.length === 4);
  const rawFile = `${reportFile}.raw.json`;
  execFileSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      fileURLToPath(new URL("./graph-html.mjs", import.meta.url)),
      binary,
      rawFile,
    ],
    { encoding: "utf8", maxBuffer: 32 << 20 },
  );
  const report = sharedHtml(
    JSON.parse(fs.readFileSync(rawFile, "utf8")),
    rawFile,
  );
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
