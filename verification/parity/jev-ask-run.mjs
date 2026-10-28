import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export const cases = JSON.parse(
  fs.readFileSync(path.join(here, "jev-ask-cases.json.fixture"), "utf8"),
);
const ids = cases.map((c) => c.id);

export function compareJevAsk(reference, native) {
  assert.deepEqual(
    reference.map((row) => row.id),
    ids,
  );
  assert.deepEqual(
    native.map((row) => row.id),
    ids,
  );
  return reference.map((source, index) => {
    const actual = native[index];
    const errors = [];
    try {
      assert.equal(source.ok, true);
      assert.equal(actual.ok, true);
      assert.deepStrictEqual(actual.output, source.output);
      assert.equal(actual.evidence.originalSame, true);
      assert.ok(actual.evidence.nativeTrace.length > 0);
      if (cases[index].kind === "factory") {
        assert.equal(
          actual.evidence.stampChecks,
          actual.output.settlements.length,
        );
        assert.ok(actual.evidence.stampChecks > 0);
        assert.equal(actual.output.diagnostics.length, 0);
        if (cases[index].scenario !== "named")
          assert.ok(actual.evidence.errorChecks > 0);
      }
    } catch (error) {
      errors.push(error.message);
    }
    return {
      id: source.id,
      equal: errors.length === 0,
      errors,
      source,
      native: actual,
    };
  });
}

export function jevAskParity(
  binary,
  output,
  { sourceFile, allowFailures = false } = {},
) {
  const scope = JSON.parse(
    fs.readFileSync(path.join(here, "scope.json"), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const binarySha256 = hash(binary);
  const input = `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const processRecords = [];
  const run = (command, args, label) => {
    const result = spawnSync(command, args, {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 45_000,
    });
    const prefix = `${output}.${label}`;
    fs.writeFileSync(`${prefix}.stdout`, result.stdout ?? "");
    fs.writeFileSync(`${prefix}.stderr`, result.stderr ?? "");
    const record = {
      command,
      args,
      exit: result.status,
      signal: result.signal,
      error: result.error
        ? { name: result.error.name, message: result.error.message }
        : null,
      stdout: `${prefix}.stdout`,
      stderr: `${prefix}.stderr`,
    };
    processRecords.push(record);
    fs.writeFileSync(
      `${output}.processes.json`,
      `${JSON.stringify(processRecords, null, 2)}\n`,
    );
    assert.equal(record.error, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const reference = sourceFile
    ? fs
        .readFileSync(sourceFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : run(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          path.join(here, "jev-ask-reference.mjs"),
        ],
        "source",
      );
  let native, failure;
  try {
    native = run(binary, [], "native");
  } catch (error) {
    failure = error;
  }
  let hashFailure;
  try {
    assert.equal(hash(binary), binarySha256, "executed binary changed");
  } catch (error) {
    hashFailure = error;
  }
  if (failure && hashFailure) throw new AggregateError([failure, hashFailure]);
  if (failure || hashFailure) throw failure ?? hashFailure;
  const observations = compareJevAsk(reference, native);
  const failures = observations.filter((row) => !row.equal);
  const report = {
    cases: observations.length,
    passed: observations.length - failures.length,
    failures,
    observations,
    nativeEvidence: Object.fromEntries(
      observations.map((row) => [
        row.id,
        row.equal ? row.native.evidence.nativeTrace : [],
      ]),
    ),
    sourcePins: Object.fromEntries(
      [
        "packages/tea/src/internal/jev/ask/index.ts",
        "packages/tea/src/internal/resilience/resilient-call/index.ts",
        "packages/tea/src/pure/core.ts",
      ].map((file) => [file, hash(path.join(root, file))]),
    ),
    fixtureHash: hash(path.join(here, "jev-ask-reference.mjs")),
    inputsHash: hash(path.join(here, "jev-ask-cases.json.fixture")),
    binary: { path: binary, sha256: binarySha256 },
    processes: processRecords,
    reference: sourceFile
      ? {
          mode: "saved-actual-Source",
          file: sourceFile,
          sha256: hash(sourceFile),
          executionsThisRun: 0,
        }
      : { mode: "actual-Source", executionsThisRun: 1 },
    qualifications: [
      "Configured fallback, batching and foreign JevAskErr unwrapping are not implemented by this online profile.",
      "Scripted local replies use the actual Promise/Effect interpreters. No network, arbitrary scheduler, cancellation, panic or raw-JS claim.",
      "Wire comparisons use the existing canonical plain_data/stringify_json codec. Typed details can discard unknown fields; arbitrary raw serde_json float formatting and JS object reflection are outside this profile.",
      "Native generic error records move by value and retain their shared details; Jev errors, requests, content and questions retain their original Rc owners. JSON decoding does not preserve live object identity.",
      "Missing/manual nonnumeric stamps, literal-key typing, non-wire values and full Jev state Deserialize remain open.",
    ],
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  if (!allowFailures)
    assert.equal(
      failures.length,
      0,
      "JevAsk comparison failed; full report retained",
    );
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [binary, output, sourceFile] = process.argv.slice(2);
  assert.ok(
    binary && output,
    "usage: jev-ask-run.mjs BINARY OUTPUT [SAVED_SOURCE_STDOUT]",
  );
  const report = jevAskParity(binary, output, { sourceFile });
  console.log(
    JSON.stringify({
      cases: report.cases,
      passed: report.passed,
      failures: report.failures.length,
    }),
  );
}
