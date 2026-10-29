import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedExecFileSync as execFileSync } from "./check-worktree.mjs";
import { cases } from "./icu77-env-keys-cases.mjs";
import { buildExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { z } = createRequire(import.meta.url)("zod");
const admission = JSON.parse(
  fs.readFileSync(
    new URL("./icu77-env-keys-admission.json", import.meta.url),
    "utf8",
  ),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encoded = (value) => hash(JSON.stringify(value));
const privateFrame = z.discriminatedUnion("ok", [
  z.strictObject({
    id: z.string(),
    ok: z.literal(true),
    output: z.unknown(),
    observedCalls: z.array(z.string()).min(1),
  }),
  z.strictObject({
    id: z.string(),
    ok: z.literal(false),
    error: z.strictObject({ name: z.string(), message: z.string() }),
    observedCalls: z.array(z.string()).min(1),
  }),
]);
const cliFrame = z.strictObject({
  id: z.string(),
  outcome: z.unknown(),
  io: z.unknown(),
  exitCode: z.number().int(),
  observedCalls: z.array(z.string()).min(1),
});

// Only the known missing-ports diagnostic's owned path is tokenized for the
// frozen Source anchor. It never changes the full raw Source/native comparison.
export function sourceAnchor(row, directory) {
  const expected = structuredClone(row);
  if (expected.ok && Array.isArray(expected.output)) {
    const action = expected.output.find(
      (step) => step.id === "earlier-hexagon",
    );
    assert(action);
    assert.equal(
      action.process.stderr,
      `code-graph: missing ports.ts: ${path.join(directory, "ports.ts")}\n`,
    );
    action.process.stderr =
      "code-graph: missing ports.ts: <owned-runtime>/ports.ts\n";
  }
  return expected;
}

function sourceContract(source) {
  assert.equal(source.complete, true);
  assert.equal(source.NativeProjectionStarted, false);
  assert.deepEqual(
    [source.node, source.v8, source.icu, source.locale],
    ["v22.21.1", "12.4.254.21-node.33", "77.1", "en-US"],
  );
  assert.deepEqual(source.sourceHashes, admission.sourcePins);
  for (const [file, digest] of Object.entries(admission.sourcePins))
    assert.equal(
      hash(fs.readFileSync(path.join(root, "packages/code-graph/src", file))),
      digest,
    );
  assert.deepEqual(
    source.observations.map((row) => row.id),
    cases.map((row) => row.id),
  );
  assert.deepEqual(source.SourceOnly, admission.SourceOnly);
  for (const [index, row] of source.observations.entries()) {
    const input = cases[index];
    assert.deepEqual(row.input, input);
    assert.equal(row.directory, path.join(source.runtime, input.id));
    assert.equal(encoded(row.expected), row.expectedSha256);
    assert.equal(
      encoded(sourceAnchor(row.expected, row.directory)),
      admission.wholeviews[input.id],
    );
    assert.deepEqual(
      row.before,
      Object.fromEntries(
        Object.entries(input.files)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([file, body]) => [
            file,
            { base64: Buffer.from(body).toString("base64"), mode: 0o644 },
          ]),
      ),
    );
    if (input.mode !== "cli") assert.deepEqual(row.after, row.before);
  }
}

function actualFrame(process, request, binarySha256, isCli) {
  assert.equal(process.signal, null);
  for (const field of ["input", "stdout", "stderr"])
    assert.equal(
      hash(fs.readFileSync(process[field])),
      process[`${field}Sha256`],
    );
  assert.deepEqual(JSON.parse(fs.readFileSync(process.input, "utf8")), request);
  const response = isCli
    ? request.trace
    : process.input.replace(/\.request\.json$/, ".response.json");
  const bytes = fs.readFileSync(response);
  const frame = (isCli ? cliFrame : privateFrame).parse(JSON.parse(bytes));
  assert.equal(frame.id, request.id);
  if (isCli) assert.equal(process.status, frame.exitCode);
  else assert.equal(process.status, 0);
  return {
    binarySha256,
    requestSha256: process.inputSha256,
    responseSha256: hash(bytes),
    process,
    responseFile: response,
    frame,
  };
}

export function sharedEnvKeys(
  raw,
  source,
  rawFile,
  sourceFile,
  expectedBinaries,
  binaryPaths,
) {
  assert.deepEqual(JSON.parse(fs.readFileSync(sourceFile, "utf8")), source);
  sourceContract(source);
  assert.equal(raw.attempted, 18);
  assert.equal(raw.passed, 18);
  assert.deepEqual(raw.failures, []);
  assert.deepEqual(raw.sourceHashes, admission.sourcePins);
  assert.equal(raw.sourceReportSha256, hash(fs.readFileSync(sourceFile)));
  assert.deepEqual(raw.binaryHashes, expectedBinaries);
  assert.deepEqual(raw.finalBinaryHashes, expectedBinaries);
  for (const value of Object.values(expectedBinaries))
    assert.match(value, /^[a-f0-9]{64}$/);
  assert.deepEqual(raw.SourceOnly, admission.SourceOnly);
  if (raw.qualifiedPairs !== undefined) assert.equal(raw.qualifiedPairs, 0);
  if (raw.qualifiedNativeEvidence !== undefined)
    assert.deepEqual(raw.qualifiedNativeEvidence, {});
  if (raw.rejectedInvalidInputs !== undefined)
    assert.equal(raw.rejectedInvalidInputs, 0);
  if (raw.rejectedInvalidInputRows !== undefined)
    assert.equal(raw.rejectedInvalidInputRows, 0);
  assert.deepEqual(
    raw.cases.map((row) => row.id),
    cases.map((row) => row.id),
  );
  const nativeEvidence = {};
  const normalized = raw.cases.map((row, index) => {
    const frozen = source.observations[index];
    const input = cases[index];
    assert.equal(row.passed, true);
    if (row.valid !== undefined) assert.equal(row.valid, true);
    if (row.protocol !== undefined) assert.equal(row.protocol, false);
    if (row.qualifications !== undefined)
      assert.deepEqual(row.qualifications, []);
    assert.deepEqual(row.input, input);
    assert.deepEqual(row.expected, frozen.expected);
    assert.deepEqual(row.actual, row.expected);
    const frames = [];
    if (input.mode === "cli") {
      assert.equal(row.processes.length, input.actions.length);
      assert.equal(row.actual.output.length, 9);
      for (const [i, action] of input.actions.entries()) {
        const process = row.processes[i];
        const request = JSON.parse(fs.readFileSync(process.input, "utf8"));
        assert.deepEqual(
          Object.keys(request).sort(),
          [
            "id",
            "trace",
            "argv",
            "compiler",
            ...(action.initial === undefined ? [] : ["initial"]),
          ].sort(),
        );
        assert.equal(request.id, `${input.id}.${action.id}`);
        assert.deepEqual(request.argv, [
          frozen.directory,
          "--env-keys",
          ...action.flags,
        ]);
        assert.equal(
          request.compiler,
          path.join(frozen.directory, "no-compiler"),
        );
        assert.equal(request.initial, action.initial);
        assert.equal(
          request.trace,
          process.input.replace(/\.request\.json$/, ".trace.json"),
        );
        assert.equal(process.command[0], binaryPaths.cli);
        const frame = actualFrame(process, request, expectedBinaries.cli, true);
        const step = row.actual.output[i];
        assert.equal(step.id, action.id);
        assert.equal(process.command.length, 1);
        assert.deepEqual(step.process, {
          status: process.status,
          signal: process.signal,
          stdout: fs.readFileSync(process.stdout, "utf8"),
          stderr: fs.readFileSync(process.stderr, "utf8"),
        });
        frames.push(frame);
      }
    } else {
      assert.equal(row.processes.length, 1);
      const process = row.processes[0];
      assert.equal(process.command[0], binaryPaths.fixture);
      assert.deepEqual(process.command.slice(1), [
        "--exact",
        "env_keys::query::icu77_probe::paired",
        "--include-ignored",
        "--nocapture",
        "--test-threads=1",
      ]);
      const frame = actualFrame(
        process,
        {
          id: input.id,
          mode: input.mode,
          directory: frozen.directory,
          units: input.units,
          candidates: input.candidates,
        },
        expectedBinaries.fixture,
        false,
      );
      assert.deepEqual(
        row.actual,
        frame.frame.ok
          ? { ok: true, output: frame.frame.output }
          : { ok: false, error: frame.frame.error },
      );
      frames.push(frame);
    }
    const calls = frames.flatMap((item) => item.frame.observedCalls);
    assert.deepEqual(row.observedCalls, calls);
    assert.deepEqual(calls, admission.observedCalls[input.id]);
    nativeEvidence[input.id] = { observedCalls: calls };
    return {
      ...row,
      valid: true,
      passed: true,
      qualifications: [],
      nativeTrace: { observedCalls: calls, frames },
    };
  });
  return {
    attempted: 18,
    passed: 18,
    unqualifiedPairs: 18,
    qualifiedPairs: 0,
    rejectedInvalidInputs: 0,
    rejectedInvalidInputRows: 0,
    responseGuards: 0,
    failures: [],
    nativeEvidence,
    qualifiedNativeEvidence: {},
    cases: normalized,
    rustBinarySha256: expectedBinaries.fixture,
    cliBinarySha256: expectedBinaries.cli,
    reference: {
      sourceHashes: admission.sourcePins,
      frozenSource: admission.frozenSourceReportSha256,
      rawFile,
      rawSha256: hash(fs.readFileSync(rawFile)),
    },
    profiles: {
      scope:
        "18 exact env-key wholeviews:17 private-owner cases plus one nine-action CLI case. Original private libtest and separate real CLI producer; no private helper published alias. Source-only malformed/nonfinite observations, remaining ordering inventory, raw model/host/stdio and all53 CLI gaps remain open.",
      invalidInputs:
        "No generic stdin/refusal or UTF8-driver proof; zero protocol and response-guard credit.",
      anchor:
        "Only the exact Source earlier-hexagon ports diagnostic is owned-root tokenized for frozen anchor validation; raw Source/native comparison and bytes are unchanged.",
    },
    SourceOnly: source.SourceOnly,
  };
}

async function main() {
  const [fixture, reportFile] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert(fixture && reportFile);
  assert.match(reportFile, /\.json$/);
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  assert.equal(process.versions.icu, "77.1");
  const before = hash(fs.readFileSync(fixture));
  const fixtureLog = reportFile.replace(/\.json$/, ".cargo.jsonl");
  const selected = fs
    .readFileSync(fixtureLog, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter(
      (event) =>
        event.reason === "compiler-artifact" &&
        event.target.name === "demlik_code_graph" &&
        event.profile.test &&
        event.executable === fixture,
    );
  assert.equal(selected.length, 1, "actual graph unitTest Cargo selection");
  // The CLI helper owns actual Cargo JSON selection and its normal rlib bytes.
  // The supplied private libtest is selected by graph.mjs's existing unitTest path.
  const cli = buildExample(
    process.env.CARGO ?? "cargo",
    "demlik-code-graph",
    "env_keys_cli_driver",
    `${reportFile}.cli-producer.json`,
  );
  const binaries = { fixture: before, cli: cli.binarySha256 };
  const runtime = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "demlik-env-keys-admitted-")),
  );
  const sourceFile = reportFile.replace(/\.json$/, ".source.json");
  const rawFile = reportFile.replace(/\.json$/, ".raw.json");
  try {
    const ref = await import("./icu77-env-keys-reference.mjs");
    const observations = [];
    for (const input of cases) {
      const directory = path.join(runtime, input.id);
      const saved = `${reportFile}.source-processes/${input.id}`;
      fs.mkdirSync(saved, { recursive: true });
      const files = Object.fromEntries(
        Object.entries(input.files).map(([file, text]) => [
          file,
          { base64: Buffer.from(text).toString("base64"), mode: 0o644 },
        ]),
      );
      ref.restore(directory, files);
      const before = ref.snapshot(directory);
      const expected =
        input.mode === "cli"
          ? ref.cliReference(input, directory, files, saved)
          : ref.reference(input, directory);
      observations.push({
        id: input.id,
        input,
        directory,
        before,
        after: ref.snapshot(directory),
        expected,
        expectedSha256: encoded(expected),
      });
    }
    const source = {
      node: process.version,
      v8: process.versions.v8,
      icu: process.versions.icu,
      locale: Intl.Collator().resolvedOptions().locale,
      runtime,
      sourceHashes: ref.sourcePins(),
      observations,
      complete: true,
      NativeProjectionStarted: false,
      SourceOnly: ref.sourceOnly(),
    };
    fs.writeFileSync(sourceFile, `${JSON.stringify(source, null, 2)}\n`);
    sourceContract(source);
    execFileSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(new URL("./icu77-env-keys.mjs", import.meta.url)),
        fixture,
        cli.binary,
        sourceFile,
        rawFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 32 << 20 },
    );
    const normalized = sharedEnvKeys(
      JSON.parse(fs.readFileSync(rawFile, "utf8")),
      source,
      rawFile,
      sourceFile,
      binaries,
      { fixture, cli: cli.binary },
    );
    normalized.cliProducer = {
      file: `${reportFile}.cli-producer.json.artifacts.json`,
      binarySha256: cli.binarySha256,
      normalLibrary: cli.libraries.demlik_code_graph,
      notLinkedIntoPrivateLibtest: true,
    };
    normalized.fixtureProducer = {
      cargoLog: fixtureLog,
      cargoLogSha256: hash(fs.readFileSync(fixtureLog)),
      compilerArtifact: selected[0],
      normalRlibLinkageClaimed: false,
    };
    fs.writeFileSync(reportFile, `${JSON.stringify(normalized, null, 2)}\n`);
  } finally {
    try {
      assert.equal(hash(fs.readFileSync(fixture)), before);
      assert.equal(hash(fs.readFileSync(cli.binary)), binaries.cli);
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  }
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
