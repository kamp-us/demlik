import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ids = [
  "html-real-hub",
  "html-json-pretty-ignored",
  "html-wins-late-modes",
  "html-by-warning",
  "html-losing-plan-suppresses-warning",
  "html-losing-collapse-analysis",
  "html-data-and-kinds",
  "html-deep-package-visible-scope",
  "html-deep-two-packages",
  "html-empty-project",
  "html-real-file-overwrite-workflow",
  "html-initial-exit-preserved",
  "html-load-refusal-before-output",
  "ci-wins-html-edge-pass",
  "prepared-smell-wins-html",
  "comments-win-html-no-compiler",
  "html-write-failure",
  "html-warning-before-write-failure",
  "html-pending-stdout",
  "html-file-before-pending-banner",
];
const qualified = new Map([
  ["html-write-failure", ["backend-exception-diagnostic-qualified"]],
  [
    "html-warning-before-write-failure",
    ["backend-exception-diagnostic-qualified"],
  ],
  ["html-pending-stdout", ["pending-stdio-notification-contract"]],
  ["html-file-before-pending-banner", ["pending-stdio-notification-contract"]],
]);
const dispatcher =
  "demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_reports_blocking";
const earlier = new Map([
  [
    "prepared-smell-wins-html",
    "demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_smell_ledger_blocking",
  ],
  [
    "comments-win-html-no-compiler",
    "demlik_code_graph::cli::frontdoor::PreparedGatesCli::dispatch_comments",
  ],
]);

export function sharedCliHtml(report, rawFile) {
  assert.equal(report.sourceOnly, false);
  assert.equal(report.passed, 20);
  assert.equal(report.attempted, 20);
  assert.equal(report.strictPairs, 16);
  assert.equal(report.qualifiedPairs, 4);
  assert.equal(report.nativeOnlyCases, 0);
  assert.equal(report.sourceExecutions, 22);
  assert.equal(report.rejectedInvalidInputs, 5);
  assert.equal(report.responseGuards, 3);
  assert.match(report.driverSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(
    report.cases.map((row) => row.id),
    [...ids, ...Array.from({ length: 5 }, (_, i) => `invalid-${i}`)],
  );
  assert.equal(
    report.cases.some((row) => row.nativeOnly === true),
    false,
  );
  assert.deepEqual(
    Object.keys(report.nativeEvidence),
    ids.filter((id) => !qualified.has(id)),
  );
  assert.deepEqual(Object.keys(report.qualifiedNativeEvidence), [
    ...qualified.keys(),
  ]);
  const shared = report.cases.filter((row) => row.protocol !== true);
  assert.equal(
    shared.reduce((n, row) => n + row.source.length, 0),
    22,
  );
  assert.equal(
    shared.reduce((n, row) => n + row.native.length, 0),
    22,
  );
  for (const row of report.cases) {
    assert.equal(row.passed, true);
    if (row.protocol === true) {
      assert.notEqual(row.status, 0);
      assert.equal(row.stdout, "");
      assert.ok(row.stderr.length > 0);
      assert.equal(Object.hasOwn(report.nativeEvidence, row.id), false);
      assert.equal(
        Object.hasOwn(report.qualifiedNativeEvidence, row.id),
        false,
      );
      continue;
    }
    assert.equal(row.nativeOnly, false);
    assert.deepEqual(row.qualifications, qualified.get(row.id) ?? []);
    assert.equal(row.native.length, row.source.length);
    assert.equal(
      row.native.length,
      row.id === "html-real-file-overwrite-workflow" ? 3 : 1,
    );
    for (const step of row.native) {
      assert.ok(step.argv.includes("--html"));
      assert.equal(
        step.trace.observedCalls.at(-1),
        earlier.get(row.id) ?? dispatcher,
      );
    }
    const calls = [
      ...new Set(row.native.flatMap((step) => step.trace.observedCalls)),
    ];
    const evidence = qualified.has(row.id)
      ? report.qualifiedNativeEvidence
      : report.nativeEvidence;
    assert.deepEqual(evidence[row.id], calls);
    row.nativeTrace = { observedCalls: calls };
    evidence[row.id] = { observedCalls: calls };
  }
  report.scope =
    "Prepared HTML CLI through the canonical graph/IO owner with exact Source priority and file/exit behavior. Controlled stdio/backend diagnostics remain qualified; browser/CDN, TTY/bootstrap/distribution, existing rawGraph/string/numeric profiles, hotspots and all53 CLI gaps remain OPEN.";
  report.unqualifiedPairs = 16;
  report.nativeExecutions = 22;
  report.sharedNativeExecutions = 22;
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
      fileURLToPath(new URL("./graph-cli-reports.mjs", import.meta.url)),
      binary,
      rawFile,
      "html",
    ],
    { encoding: "utf8", maxBuffer: 32 << 20 },
  );
  const report = sharedCliHtml(
    JSON.parse(fs.readFileSync(rawFile, "utf8")),
    rawFile,
  );
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
