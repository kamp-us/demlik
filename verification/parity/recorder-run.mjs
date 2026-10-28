import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recorderCases, recorderLiteralChecks } from "./recorder-cases.mjs";
import { buildParityBinary } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  here = path.dirname(fileURLToPath(import.meta.url)),
  require = createRequire(import.meta.url),
  hash = (value) => createHash("sha256").update(value).digest("hex");
export async function recorderParity(options = {}) {
  const scope = JSON.parse(
    await readFile(path.join(here, "scope.json"), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const referenceChanges = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      scope.reference,
      "--",
      "packages/tea/src",
      "packages/code-graph/src",
    ],
    { cwd: root, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(referenceChanges, []);
  const reportFile =
    options.reportFile ?? path.join(root, "target/parity/recorder.json");
  const producer = options.binary
    ? null
    : buildParityBinary(
        process.env.CARGO ?? "cargo",
        "recorder-parity",
        reportFile,
      );
  const binary = options.binary ?? producer.binary;
  const cases = recorderCases(),
    input = `${cases.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const run = (command, args) =>
    execFileSync(command, args, {
      cwd: root,
      input,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const reference = run(process.execPath, [
      "--import",
      require.resolve("tsx"),
      path.join(here, "recorder-reference.mts"),
    ]),
    native = run(binary, []),
    failures = [],
    nativeEvidence = {},
    diagnostics = [];
  assert.equal(reference.length, cases.length);
  assert.equal(native.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    try {
      assert.equal(reference[i].id, cases[i].id);
      assert.equal(native[i].id, cases[i].id);
      assert.ok(native[i].observedCalls.length > 0);
      const { diagnostic: sourceDiagnostic, ...expected } = reference[i].result,
        { diagnostic: nativeDiagnostic, ...actual } = native[i].result;
      assert.deepEqual(actual, expected);
      if (sourceDiagnostic !== undefined || nativeDiagnostic !== undefined) {
        assert.equal(typeof sourceDiagnostic, "string");
        assert.equal(typeof nativeDiagnostic, "string");
        assert.ok(sourceDiagnostic.length && nativeDiagnostic.length);
        diagnostics.push({
          id: cases[i].id,
          source: sourceDiagnostic,
          native: nativeDiagnostic,
        });
      }
      nativeEvidence[cases[i].id] = native[i].observedCalls;
    } catch (error) {
      failures.push({
        id: cases[i].id,
        input: cases[i].input,
        reference: reference[i].result,
        native: native[i].result,
        message: error.message,
      });
    }
  }
  if (!failures.length) {
    recorderLiteralChecks(assert, reference);
    recorderLiteralChecks(assert, native);
  }
  const files = [
    "crates/tea/src/persistence/recorder.rs",
    "crates/tea/src/persistence/recorder/wire.rs",
    "crates/tea/src/persistence/recorder/projections.rs",
    "crates/tea/src/persistence/trace_replay.rs",
    "crates/tea/src/persistence/trace_replay/state_walk.rs",
    "crates/tea/src/js_record.rs",
    "crates/tea/src/core.rs",
    "crates/parity/src/bin/recorder-parity.rs",
    "verification/parity/recorder-reference.mts",
    "verification/parity/recorder-cases.mjs",
  ];
  const report = {
    producer,
    scope:
      "Native recorder/JSONL/attachment/breadcrumb/replay/state-walk, exact data and source-owned refusal parity",
    reference: scope.reference,
    referenceChanges,
    node: process.version,
    v8: process.versions.v8,
    cases: cases.length,
    passed: cases.length - failures.length,
    failures,
    groups: Object.fromEntries(
      [...new Set(cases.map((row) => row.input.op))].map((op) => [
        op,
        cases.filter((row) => row.input.op === op).length,
      ]),
    ),
    corpusSha256: hash(input),
    rustBinarySha256: hash(await readFile(binary)),
    nativeEvidence,
    sourceHashes: Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          hash(await readFile(path.join(root, file))),
        ]),
      ),
    ),
    referenceSourceHashes: Object.fromEntries(
      await Promise.all(
        [
          "packages/tea/src/internal/persistence/recorder/index.ts",
          "packages/tea/src/internal/persistence/trace-replay/index.ts",
          "packages/tea/src/internal/persistence/trace-replay/state-walk.ts",
        ].map(async (file) => [
          file,
          hash(await readFile(path.join(root, file))),
        ]),
      ),
    ),
    backendDiagnostics: diagnostics,
    qualifications: [
      "JSON syntax diagnostics retain actual serde and V8 causes separately. Exact source-owned error name/prefix/physical line, acceptance, decoded values, and successful JSONL bytes are compared without tolerance.",
      "The record action fixture supplies callback ingress only; the separate eight-case actual Runtime suite proves attachment and update-only cold replay in both native profiles.",
      "Raw structural comparison covers canonical plain data and pristine Object.prototype reads. Opaque native state uses the explicit typed comparison/codec APIs, with borrowed/non-serde witnesses.",
    ],
  };
  await mkdir(path.dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (!options.quiet)
    console.log(
      JSON.stringify(
        {
          ...report,
          nativeEvidence: { cases: Object.keys(nativeEvidence).length },
          failures: failures.slice(0, 20),
          reportFile,
        },
        null,
        2,
      ),
    );
  if (!options.allowFailures)
    assert.equal(
      failures.length,
      0,
      `Recorder mismatches: ${failures.length}; ${reportFile}`,
    );
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await recorderParity();
