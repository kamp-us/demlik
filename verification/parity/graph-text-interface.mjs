import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const backendCases = new Map([
  ["raw-config.context-text", ["context", "parseConfigFile"]],
  ["raw-config.assembly-text", ["assembly", "parseConfigFile"]],
  ["raw-source.context-text", ["context", "getSourceFile"]],
  ["raw-source.assembly-text", ["assembly", "getSourceFile"]],
  ["raw-low.context-text", ["context", "parseConfigFile"]],
  ["raw-low.assembly-text", ["assembly", "parseConfigFile"]],
]);
const regexCases = new Set([
  "regex-error.assembly-text",
  "regex-error.assembly-path",
]);

export function normalizeTextInterfaceReport(report) {
  assert.equal(report.passed, 47);
  assert.equal(report.attempted, 47);
  assert.deepEqual(report.failures, []);
  const passing = report.cases.filter((row) => !row.protocol);
  assert.equal(passing.length, 47);
  assert.equal(new Set(passing.map((row) => row.id)).size, 47);
  report.nativeEvidence = {};
  report.qualifiedNativeEvidence = {};
  const regex = new Set();
  for (const row of passing) {
    assert.equal(row.passed, true);
    const actual =
      row.native.result === undefined
        ? { thrown: row.native.thrown }
        : { result: row.native.result };
    if (row.qualification === "actual-backend-offset") {
      const allowed = backendCases.get(row.id);
      assert.ok(allowed, `${row.id}: unapproved backend qualification`);
      const [stage, method] = allowed;
      for (const thrown of [row.source.thrown, actual.thrown]) {
        assert.equal(thrown.stage, stage);
        assert.equal(thrown.name, "Error");
        assert.equal(thrown.backendMethod, method);
      }
      const suffix = (message) => {
        assert.match(message, / after offset \d+$/);
        return message.replace(/ after offset \d+$/, " after offset <backend>");
      };
      assert.notEqual(actual.thrown.message, row.source.thrown.message);
      assert.deepEqual(
        {
          thrown: { ...actual.thrown, message: suffix(actual.thrown.message) },
        },
        {
          thrown: {
            ...row.source.thrown,
            message: suffix(row.source.thrown.message),
          },
        },
      );
    } else if (row.qualification === "native-regexp-diagnostic") {
      assert.ok(
        regexCases.has(row.id),
        `${row.id}: unapproved regex qualification`,
      );
      assert.equal(actual.thrown.name, "SyntaxError");
      assert.equal(row.source.thrown.name, "SyntaxError");
      assert.equal(actual.thrown.stage, row.source.thrown.stage);
      assert.ok(actual.thrown.message.length > 0);
      assert.ok(row.source.thrown.message.length > 0);
      regex.add(row.id);
    } else {
      assert.equal(row.qualification, undefined);
      assert.deepEqual(actual, row.source);
    }
    row.qualifications = row.qualification ? [row.qualification] : [];
    const evidence = row.qualifications.length
      ? report.qualifiedNativeEvidence
      : report.nativeEvidence;
    assert.ok(row.native.observedCalls.length);
    evidence[row.id] = row.native.observedCalls;
  }
  assert.deepEqual(
    regex,
    regexCases,
    "both existing regex qualifiers required",
  );
  const exact = Object.keys(report.nativeEvidence).length;
  const qualified = Object.keys(report.qualifiedNativeEvidence).length;
  assert.equal(exact + qualified, 47);
  assert.equal(report.unqualifiedPairs, exact);
  assert.equal(report.qualifiedPairs, qualified);
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
      fileURLToPath(new URL("./graph-text-interface.mts", import.meta.url)),
      binary,
      rawFile,
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const report = normalizeTextInterfaceReport(
    JSON.parse(fs.readFileSync(rawFile, "utf8")),
  );
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
