import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cases } from "./report-ordering-cases.mjs";
import { buildExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const admission = JSON.parse(
  fs.readFileSync(new URL("./report-ordering-admission.json", import.meta.url)),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const encoded = (value) => hash(JSON.stringify(canonical(value)));

function anchor(row, source) {
  const expected = structuredClone(row.expected);
  if (row.input.mode === "cheap" || row.input.mode === "go") {
    const graph = expected.output.graph;
    assert.equal(graph.root, path.relative(source.cwd, row.directory) || ".");
    graph.root = "<runtime-root>";
    if (row.input.mode === "go") {
      assert.equal(
        graph.provenance.tsConfig,
        path.join(row.directory, "tsconfig.json"),
      );
      graph.provenance.tsConfig = "<runtime-root>/tsconfig.json";
    }
  }
  return expected;
}
function sourceContract(source) {
  assert.equal(source.complete, true);
  assert.equal(source.NativeProjectionStarted, false);
  assert.equal(source.SourceGit, admission.Source);
  assert.equal(source.sourceTree, admission.sourceTree);
  assert.deepEqual(source.sourceHashes, admission.sourcePins);
  assert.equal(source.node, "v22.21.1");
  assert.equal(source.v8, "12.4.254.21-node.33");
  assert.equal(source.icu, "77.1");
  assert.equal(source.locale, "en-US");
  assert.ok(source.cwd === admission.archivedCwd || source.cwd === root);
  if (source.runtime !== admission.archivedRuntime) {
    assert.equal(path.dirname(source.runtime), fs.realpathSync(os.tmpdir()));
    assert.ok(
      path
        .basename(source.runtime)
        .startsWith("demlik-report-ordering-admitted-"),
    );
  }
  assert.deepEqual(
    source.rows.map((row) => row.input),
    cases,
  );
  assert.deepEqual(cases, admission.caseInputs);
  for (const row of source.rows) {
    assert.equal(row.id, row.input.id);
    assert.equal(row.directory, path.join(source.runtime, row.id));
    assert.equal(row.expectedSha256, hash(JSON.stringify(row.expected)));
    assert.equal(
      encoded(anchor(row, source)),
      admission.wholeviews[row.id],
      row.id,
    );
    const before = Object.fromEntries(
      Object.entries(row.input.files ?? {}).map(([file, text]) => [
        file,
        {
          base64: Buffer.from(text).toString("base64"),
          mode: 0o644,
        },
      ]),
    );
    assert.deepEqual(row.before, before);
    if (row.input.mode !== "cli") assert.deepEqual(row.after, row.before);
    else assert.deepEqual(row.after, row.expected.output.at(-1).after);
  }
  for (const [file, digest] of Object.entries(admission.sourcePins))
    assert.equal(
      hash(fs.readFileSync(path.join(root, "packages/code-graph/src", file))),
      digest,
    );
  for (const [file, digest] of Object.entries(admission.sourceObserverPins))
    assert.equal(
      hash(fs.readFileSync(path.join(root, "verification/parity", file))),
      digest,
    );
  assert.equal(
    hash(
      fs.readFileSync(
        path.join(root, "crates/code-graph/examples/report_ordering_driver.rs"),
      ),
    ),
    admission.nativeObserverSha256,
  );
}
function captured(process, key, file) {
  const field = `${key}Base64`;
  const bytes =
    process[field] === undefined
      ? fs.readFileSync(file)
      : Buffer.from(process[field], "base64");
  assert.equal(hash(bytes), process[`${key}Sha256`], `${key} digest`);
  if (process[field] !== undefined)
    assert.equal(bytes.toString("base64"), process[field]);
  if (process[`${key}File`] !== undefined)
    assert.equal(process[`${key}File`], file);
  if (fs.existsSync(file)) assert.deepEqual(fs.readFileSync(file), bytes);
  return bytes;
}
function processContract(
  process,
  directory,
  expectedRequest,
  binary,
  args,
  cwd,
) {
  assert.deepEqual(process.command, [binary, ...args]);
  assert.equal(process.cwd, cwd);
  assert.equal(process.signal, null);
  assert.equal(process.error, undefined);
  const request = captured(
    process,
    "request",
    path.join(directory, "request.json"),
  );
  assert.deepEqual(JSON.parse(request.toString()), expectedRequest);
  const stdout = captured(process, "stdout", path.join(directory, "stdout"));
  const stderr = captured(process, "stderr", path.join(directory, "stderr"));
  return {
    process,
    request: { base64: request.toString("base64"), sha256: hash(request) },
    stdout: { base64: stdout.toString("base64"), sha256: hash(stdout) },
    stderr: { base64: stderr.toString("base64"), sha256: hash(stderr) },
  };
}

export function sharedReportOrdering(
  raw,
  source,
  rawFile,
  sourceFile,
  expectedBinaries,
  binaryPaths,
) {
  sourceContract(source);
  assert.deepEqual(Object.keys(expectedBinaries).sort(), ["cli", "driver"]);
  for (const digest of Object.values(expectedBinaries))
    assert.match(digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(binaryPaths).sort(), ["cli", "driver"]);
  assert.equal(raw.rustBinary, binaryPaths.driver);
  assert.equal(raw.cliBinary, binaryPaths.cli);
  assert.equal(raw.rustBinarySha256, expectedBinaries.driver);
  assert.equal(raw.cliBinarySha256, expectedBinaries.cli);
  assert.equal(raw.binaryHashesUnchanged, true);
  assert.equal(raw.attempted, 23);
  assert.equal(raw.passed, 23);
  assert.equal(raw.unqualifiedPairs, 23);
  assert.equal(raw.qualifiedPairs, 0);
  assert.deepEqual(raw.failures, []);
  assert.equal(raw.reference.sourceFile, sourceFile);
  assert.equal(raw.reference.sourceSha256, hash(fs.readFileSync(sourceFile)));
  assert.equal(raw.reference.Source, admission.Source);
  assert.equal(raw.reference.sourceTree, admission.sourceTree);
  assert.deepEqual(raw.reference.sourceHashes, admission.sourcePins);
  assert.equal(raw.reference.node, source.node);
  assert.equal(raw.reference.v8, source.v8);
  assert.equal(raw.reference.icu, source.icu);
  assert.deepEqual(
    raw.cases.map((row) => row.id),
    cases.map((row) => row.id),
  );
  const compilerManifest = createRequire(
    path.join(root, "packages/code-graph/package.json"),
  ).resolve("@typescript/native-preview/package.json");
  assert.equal(
    hash(fs.readFileSync(compilerManifest)),
    admission.nativeCompilerManifestSha256,
  );
  const nativeEvidence = {},
    frames = [];
  const normalized = raw.cases.map((row, index) => {
    const frozen = source.rows[index],
      input = cases[index];
    assert.deepEqual(row.input, input);
    assert.equal(row.passed, true);
    assert.notEqual(row.valid, false);
    assert.notEqual(row.protocol, true);
    assert.notEqual(row.nativeOnly, true);
    assert.equal(row.error, undefined);
    assert.deepEqual(row.qualifications, []);
    assert.deepEqual(row.expected, frozen.expected.output);
    assert.deepEqual(row.actual, row.expected);
    assert.deepEqual(row.before, frozen.before);
    assert.deepEqual(row.after, frozen.after);
    assert.deepEqual(row.sourceProcess, frozen.process);
    const sourceDirectory = path.join(
      path.dirname(sourceFile),
      "source-processes",
      row.id,
    );
    const sourceRequest = captured(
      frozen.process,
      "request",
      path.join(sourceDirectory, "request.json"),
    );
    assert.deepEqual(JSON.parse(sourceRequest.toString()), {
      input,
      directory: frozen.directory,
      saved: sourceDirectory,
      response: path.join(sourceDirectory, "response.json"),
    });
    assert.equal(frozen.process.status, 0);
    assert.equal(frozen.process.signal, null);
    assert.equal(
      captured(frozen.process, "stdout", path.join(sourceDirectory, "stdout"))
        .length,
      0,
    );
    assert.equal(
      captured(frozen.process, "stderr", path.join(sourceDirectory, "stderr"))
        .length,
      0,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(sourceDirectory, "response.json"))),
      frozen.expected,
    );
    const directory = `${rawFile}-processes/${row.id}`;
    let caseFrames;
    if (input.mode === "cli") {
      assert.equal(row.actual.length, 10);
      assert.equal(row.nativeTrace.actions.length, 10);
      caseFrames = row.nativeTrace.actions.map((action, i) => {
        const spec = input.actions[i],
          step = row.actual[i];
        assert.equal(action.id, spec.id);
        assert.equal(step.id, spec.id);
        const actionDir = path.join(directory, spec.id);
        const traceFile = path.join(actionDir, "trace.json");
        const frame = action.trace;
        assert.deepEqual(Object.keys(frame).sort(), [
          "exitCode",
          "id",
          "io",
          "observedCalls",
          "outcome",
          "writeObservations",
        ]);
        assert.equal(encoded(frame), admission.cliTraceWholeviews[spec.id]);
        assert.equal(frame.id, spec.id);
        assert.equal(action.process.status, spec.code ?? spec.initial ?? 0);
        assert.equal(frame.exitCode, action.process.status);
        const captured = processContract(
          action.process,
          actionDir,
          {
            id: spec.id,
            trace: traceFile,
            argv: [frozen.directory, ...spec.flags],
            compiler: "/nonexistent/explicit-no-go",
            plain: true,
            lateReports: true,
            ...(spec.initial === undefined ? {} : { initial: spec.initial }),
          },
          raw.cliBinary,
          [],
          frozen.directory,
        );
        assert.deepEqual(step.process, {
          status: action.process.status,
          signal: null,
          stdout: Buffer.from(captured.stdout.base64, "base64").toString(),
          stderr: Buffer.from(captured.stderr.base64, "base64").toString(),
        });
        if (fs.existsSync(traceFile))
          assert.deepEqual(JSON.parse(fs.readFileSync(traceFile)), frame);
        return { ...captured, frame };
      });
      assert.deepEqual(
        row.nativeTrace.observedCalls,
        caseFrames.flatMap((f) => f.frame.observedCalls),
      );
    } else {
      assert.equal(row.nativeProcess.status, 0);
      assert.equal(row.nativeProcess.command.length, 2);
      assert.equal(row.nativeProcess.command[1], compilerManifest);
      const capture = processContract(
        row.nativeProcess,
        directory,
        { input, root: frozen.directory },
        raw.rustBinary,
        [compilerManifest],
        source.cwd,
      );
      const literal = Buffer.from(capture.stdout.base64, "base64").toString();
      assert.equal(literal.trim().split("\n").length, 1);
      const frame = JSON.parse(literal);
      assert.deepEqual(Object.keys(frame).sort(), [
        "observedCalls",
        "ok",
        "output",
      ]);
      assert.equal(frame.ok, true);
      assert.deepEqual(frame.output, row.actual);
      assert.deepEqual(frame, row.nativeTrace);
      assert.equal(capture.stderr.base64, "");
      caseFrames = [{ ...capture, frame }];
    }
    assert.deepEqual(
      row.nativeTrace.observedCalls,
      admission.observedCalls[row.id],
    );
    assert.ok(row.nativeTrace.observedCalls.length > 0);
    frames.push(...caseFrames);
    nativeEvidence[row.id] = { observedCalls: row.nativeTrace.observedCalls };
    return {
      ...row,
      valid: true,
      passed: true,
      qualifications: [],
      nativeTrace: { ...row.nativeTrace, frames: caseFrames },
    };
  });
  assert.equal(frames.length, 32);
  return {
    attempted: 23,
    passed: 23,
    unqualifiedPairs: 23,
    qualifiedPairs: 0,
    rejectedInvalidInputs: 0,
    rejectedInvalidInputRows: 0,
    responseGuards: 0,
    failures: [],
    nativeEvidence,
    qualifiedNativeEvidence: {},
    cases: normalized,
    rustBinarySha256: expectedBinaries.driver,
    cliBinarySha256: expectedBinaries.cli,
    reference: {
      Source: admission.Source,
      sourceHashes: admission.sourcePins,
      sourceFile,
      sourceSha256: hash(fs.readFileSync(sourceFile)),
      rawFile,
      rawSha256: hash(fs.readFileSync(rawFile)),
    },
    profiles: {
      scope: admission.scope,
      anchors:
        "Only validated structured graph.root and Go selected tsconfig are tokenized for frozen Source anchors. Raw Source/native views, stderr/stdout and file bytes remain exact.",
      invalidInputs:
        "Zero generic stdin/refusal/UTF8 observations; no invented protocol credit.",
      identity:
        "Original Summary/input identity assertions are source-bound native observer laws, not fabricated returned identity fields or smell-array alias credit.",
    },
  };
}

async function main() {
  const [driverArg, reportArg] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert.ok(driverArg && reportArg);
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  assert.equal(process.versions.icu, "77.1");
  const driver = fs.realpathSync(driverArg),
    reportFile = path.resolve(reportArg);
  const before = hash(fs.readFileSync(driver));
  let cli, cliBefore, runtime;
  try {
    cli = buildExample(
      process.env.CARGO ?? "cargo",
      "demlik-code-graph",
      "collapse_cli_driver",
      `${reportFile}.cli-producer.json`,
    );
    cliBefore = cli.binarySha256;
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(
      "@typescript/native-preview/package.json",
      { paths: [path.join(root, "packages/code-graph")] },
    );
    runtime = fs.realpathSync(
      fs.mkdtempSync(
        path.join(os.tmpdir(), "demlik-report-ordering-admitted-"),
      ),
    );
    const data = `${reportFile}.source-data`;
    const sourceFile = path.join(data, "source.json"),
      rawFile = `${reportFile}.raw.json`;
    const ref = await import("./report-ordering-reference.mjs");
    const rows = [];
    for (const input of cases) {
      const directory = path.join(runtime, input.id),
        saved = path.join(data, "source-processes", input.id);
      fs.mkdirSync(saved, { recursive: true });
      const files = Object.fromEntries(
        Object.entries(input.files ?? {}).map(([file, text]) => [
          file,
          { base64: Buffer.from(text).toString("base64"), mode: 0o644 },
        ]),
      );
      ref.restore(directory, files);
      const response = path.join(saved, "response.json"),
        packet = path.join(saved, "request.json");
      fs.writeFileSync(
        packet,
        JSON.stringify({ input, directory, saved, response }),
      );
      const command = [
        process.execPath,
        "--import",
        require.resolve("tsx"),
        path.join(root, "verification/parity/report-ordering-source.mjs"),
        packet,
      ];
      const child = spawnSync(command[0], command.slice(1), {
        cwd: root,
        env: { ...process.env, TMPDIR: fs.realpathSync(os.tmpdir()) },
        maxBuffer: 64 << 20,
      });
      fs.writeFileSync(path.join(saved, "stdout"), child.stdout ?? "");
      fs.writeFileSync(path.join(saved, "stderr"), child.stderr ?? "");
      const processRecord = {
        command,
        status: child.status,
        signal: child.signal,
        error: child.error?.message,
        requestSha256: hash(fs.readFileSync(packet)),
        stdoutSha256: hash(child.stdout ?? ""),
        stderrSha256: hash(child.stderr ?? ""),
        requestBase64: fs.readFileSync(packet).toString("base64"),
        stdoutBase64: (child.stdout ?? Buffer.alloc(0)).toString("base64"),
        stderrBase64: (child.stderr ?? Buffer.alloc(0)).toString("base64"),
      };
      fs.writeFileSync(
        path.join(saved, "process.json"),
        JSON.stringify(processRecord),
      );
      assert.ifError(child.error);
      assert.equal(child.signal, null);
      assert.equal(child.status, 0);
      const expected = JSON.parse(fs.readFileSync(response));
      rows.push({
        id: input.id,
        input,
        directory,
        before: files,
        after: ref.snapshot(directory),
        expected,
        expectedSha256: hash(JSON.stringify(expected)),
        process: processRecord,
      });
    }
    const source = {
      SourceGit: admission.Source,
      sourceTree: admission.sourceTree,
      sourceHashes: ref.pins(),
      node: process.version,
      v8: process.versions.v8,
      icu: process.versions.icu,
      locale: Intl.Collator().resolvedOptions().locale,
      cwd: root,
      runtime,
      rows,
      complete: true,
      NativeProjectionStarted: false,
    };
    fs.writeFileSync(sourceFile, `${JSON.stringify(source, null, 2)}\n`);
    sourceContract(source);
    execFileSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(root, "verification/parity/report-ordering-pairs.mjs"),
        driver,
        cli.binary,
        manifest,
        sourceFile,
        rawFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 },
    );
    const normalized = sharedReportOrdering(
      JSON.parse(fs.readFileSync(rawFile)),
      source,
      rawFile,
      sourceFile,
      { driver: before, cli: cliBefore },
      { driver, cli: cli.binary },
    );
    normalized.cliProducer = {
      file: `${reportFile}.cli-producer.json.artifacts.json`,
      binarySha256: cliBefore,
      normalLibrary: cli.libraries.demlik_code_graph,
    };
    fs.writeFileSync(reportFile, `${JSON.stringify(normalized, null, 2)}\n`);
  } finally {
    try {
      assert.equal(hash(fs.readFileSync(driver)), before);
      if (cli) assert.equal(hash(fs.readFileSync(cli.binary)), cliBefore);
    } finally {
      if (runtime) fs.rmSync(runtime, { recursive: true, force: true });
    }
  }
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
