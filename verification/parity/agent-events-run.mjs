import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function compareAgentEvents(expected, actual) {
  return isDeepStrictEqual(expected, actual);
}
export function compareAgentEventsProfile(row) {
  const listener = ["promise-listener", "effect-listener"].includes(row.id);
  const promiseSave = row.id === "promise-save";
  const effectSave = row.id === "effect-save";
  if (!listener && !promiseSave && !effectSave)
    return {
      strict: compareAgentEvents(row.expected, row.actual),
      qualified: false,
      qualifications: [],
    };
  const expected = structuredClone(row.expected);
  const actual = structuredClone(row.actual);
  const cause = listener
    ? {
        channel: "callback",
        originalSame: true,
        message: "invoice event listener failed",
      }
    : {
        channel: "store",
        originalSame: true,
        message: "invoice checkpoint refused",
      };
  assert.deepEqual(
    row.nativeOnly.causes,
    [cause],
    "one actual original cause/message read",
  );
  assert.equal(row.nativeOnly.id, row.id);
  assert.equal(row.nativeOnly.panicHooks.length, listener ? 1 : 0);
  const fields = [];
  if (listener) {
    assert.equal(expected.reports.length, 1);
    assert.equal(actual.reports.length, 1);
    assert.equal(expected.reports[0].phase, "event");
    assert.equal(actual.reports[0].phase, "event");
    assert.equal(actual.checks.callbackCauseSame, true);
    assert.deepEqual(Object.keys(expected.reports[0].error).sort(), [
      "message",
      "name",
      "stack",
    ]);
    assert.deepEqual(actual.reports[0].error, {
      name: "Panic",
      message: "non-string panic",
    });
    assert.equal(expected.reports[0].error.name, "Error");
    assert.equal(expected.reports[0].error.message, cause.message);
    assert.ok(
      expected.reports[0].error.stack.startsWith(`Error: ${cause.message}\n`),
    );
    delete expected.reports[0].error.stack;
    for (const field of ["name", "message"]) {
      delete expected.reports[0].error[field];
      delete actual.reports[0].error[field];
    }
    fields.push(
      "reports[0].error.name",
      "reports[0].error.message",
      "reports[0].error.stack(Source-only)",
    );
  } else {
    assert.equal(expected.reports.length, 0);
    assert.equal(actual.reports.length, 0);
    assert.equal(actual.checks.dispatchCauseSame, true);
    assert.deepEqual(actual.dispatchError, {
      name: "StoreFailed",
      message: "StoreFailed: Save(invoice checkpoint refused)",
    });
    assert.deepEqual(
      expected.dispatchError,
      promiseSave
        ? { name: "Error", message: "invoice checkpoint refused" }
        : { name: "StoreFailed", message: "@demlik/tea: store save failed." },
    );
    if (promiseSave) {
      delete expected.dispatchError.name;
      delete actual.dispatchError.name;
      fields.push("dispatchError.name");
    }
    delete expected.dispatchError.message;
    delete actual.dispatchError.message;
    fields.push("dispatchError.message");
  }
  const matches = compareAgentEvents(expected, actual);
  return {
    strict: false,
    qualified: matches,
    qualifications: matches
      ? [
          {
            profile: "HOST-ENVELOPE",
            fields,
            reason:
              "Exact typed Rust wrapper/panic representation versus the actual JavaScript Error. Original cause identity/message reads and every other whole-view field remain mandatory; no generic panic/Error/stack equivalence.",
          },
        ]
      : [],
  };
}
export function agentEventsParity({
  binary,
  sourceReport,
  usageReport,
  output,
}) {
  assert.equal(process.versions.node, "22.21.1");
  const before = sha(fs.readFileSync(binary));
  const source = JSON.parse(fs.readFileSync(sourceReport, "utf8"));
  const usage = JSON.parse(fs.readFileSync(usageReport, "utf8"));
  assert.equal(source.validRows, 14);
  assert.equal(source.rows.length, 14);
  const expected = [...source.rows, usage];
  const folder = path.dirname(path.resolve(output));
  fs.mkdirSync(folder, { recursive: true });
  const rows = [];
  let report;
  try {
    for (const row of expected) {
      const own = path.join(folder, "processes", row.input.id);
      fs.mkdirSync(own, { recursive: true });
      const args = [JSON.stringify(row.input), path.join(own, "invoice")];
      fs.writeFileSync(
        path.join(own, "request.json"),
        `${JSON.stringify({ input: row.input, binary, args }, null, 2)}\n`,
      );
      const process = spawnSync(binary, args, {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      });
      fs.writeFileSync(path.join(own, "stdout"), process.stdout ?? "");
      fs.writeFileSync(path.join(own, "stderr"), process.stderr ?? "");
      const raw = {
        status: process.status,
        signal: process.signal,
        error: process.error ? String(process.error) : null,
        stdoutSha256: sha(process.stdout ?? ""),
        stderrSha256: sha(process.stderr ?? ""),
      };
      fs.writeFileSync(
        path.join(own, "process.json"),
        `${JSON.stringify(raw, null, 2)}\n`,
      );
      let actual;
      let protocolError;
      try {
        assert.equal(process.status, 0);
        assert.equal(process.stderr, "");
        actual = JSON.parse(process.stdout);
        assert.deepEqual(actual.input, row.input);
        assert.ok(actual.nativeTrace.length > 0);
      } catch (error) {
        protocolError = String(error);
      }
      rows.push({
        id: row.input.id,
        input: row.input,
        expected: row.output,
        actual: actual?.output ?? null,
        nativeTrace: actual?.nativeTrace ?? [],
        nativeOnly: actual?.nativeOnly ?? null,
        process: raw,
        protocolError: protocolError ?? null,
        matches:
          protocolError === undefined &&
          compareAgentEvents(row.output, actual.output),
      });
    }
    report = {
      cases: rows.length,
      wholeViewMatches: rows.filter((r) => r.matches).length,
      failures: rows.filter((r) => !r.matches).map((r) => r.id),
      rows,
      binary: { path: binary, sha256: before },
      sourceInputs: [
        { path: sourceReport, sha256: sha(fs.readFileSync(sourceReport)) },
        { path: usageReport, sha256: sha(fs.readFileSync(usageReport)) },
      ],
      SourceExecutions: 0,
      newSharedCredit: 0,
    };
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    const after = sha(fs.readFileSync(binary));
    fs.writeFileSync(
      `${output}.binary-check.json`,
      `${JSON.stringify({ before, after, unchanged: before === after }, null, 2)}\n`,
    );
    assert.equal(after, before);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [binary, sourceReport, usageReport, output] = process.argv.slice(2);
  const result = agentEventsParity({
    binary,
    sourceReport,
    usageReport,
    output,
  });
  console.log(
    JSON.stringify({
      cases: result.cases,
      wholeViewMatches: result.wholeViewMatches,
      failures: result.failures,
      newSharedCredit: 0,
    }),
  );
  if (result.failures.length) process.exitCode = 1;
}
