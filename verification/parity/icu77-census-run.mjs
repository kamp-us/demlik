import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const spec = JSON.parse(
  fs.readFileSync(
    new URL("./icu77-census-admission.json", import.meta.url),
    "utf8",
  ),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileHash = (file) => hash(fs.readFileSync(file));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]);
  return value;
}
const digest = (value) => hash(JSON.stringify(canonical(value)));
const expectedIds = spec.rows.map((row) => row.id);
const number = (value) =>
  value === "NaN"
    ? NaN
    : value === "+Infinity"
      ? Infinity
      : value === "-Infinity"
        ? -Infinity
        : value === "-0"
          ? -0
          : value;
const tag = (value) =>
  Number.isNaN(value)
    ? "NaN"
    : value === Infinity
      ? "+Infinity"
      : value === -Infinity
        ? "-Infinity"
        : Object.is(value, -0)
          ? "-0"
          : value;
function pinSource() {
  for (const [file, pin] of Object.entries(spec.sourcePins))
    assert.equal(
      fileHash(path.join(root, "packages/code-graph/src", `${file}.ts`)),
      pin,
      `Source ${file}`,
    );
}
export function assertCensusResponse(frame, id) {
  assert.deepEqual(Object.keys(frame).sort(), [
    "id",
    "observedCalls",
    "output",
  ]);
  assert.equal(frame.id, id);
  assert.ok(
    Array.isArray(frame.observedCalls) && frame.observedCalls.length > 0,
  );
  for (const call of frame.observedCalls)
    assert.match(call, /^demlik_code_graph::boundaries::/);
}
function nativeView(frame, input) {
  if (input.mode !== "deployable") return frame.output;
  const { identity, ...view } = frame.output;
  assert.ok(Array.isArray(identity));
  return view;
}
function sourceReferences(row, frame) {
  if (row.input.mode !== "deployable") return;
  const actual = frame.output.identity;
  for (const entry of actual) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "aliasInputMaterializedAsSeparateOwnedRows",
      "allOriginalRows",
      "originalIndices",
      "qualification",
    ]);
    assert.equal(
      entry.qualification,
      "Original input references, including repeated references, are retained.",
    );
  }
  assert.equal(actual.length, row.sourceOriginalReferences.length);
  for (const [index, source] of row.sourceOriginalReferences.entries()) {
    assert.equal(source.allOriginalRows, true);
    assert.equal(actual[index].allOriginalRows, true);
    assert.equal(
      actual[index].aliasInputMaterializedAsSeparateOwnedRows,
      false,
    );
    assert.deepEqual(actual[index].originalIndices, source.inputIndices);
  }
}
function frameOf(process, id) {
  assert.equal(process.status, 0);
  assert.equal(process.signal ?? null, null);
  const stdout = fs.readFileSync(process.stdout);
  const stderr = fs.readFileSync(process.stderr);
  assert.equal(hash(stdout), process.stdoutSha256);
  assert.equal(hash(stderr), process.stderrSha256);
  assert.equal(stderr.length, 0);
  const frame = JSON.parse(stdout.toString("utf8"));
  assertCensusResponse(frame, id);
  return frame;
}
export function sharedCensus(raw, rawFile, expectedBinarySHA) {
  assert.equal(process.version, spec.engine.node);
  assert.equal(process.versions.v8, spec.engine.v8);
  assert.equal(process.versions.icu, spec.engine.icu);
  assert.equal(raw.inputRecords, 26);
  assert.equal(raw.valueProfileMatches, 26);
  assert.deepEqual(raw.failedValueProfileIds, []);
  assert.equal(raw.binarySha256, expectedBinarySHA);
  assert.match(expectedBinarySHA, /^[a-f0-9]{64}$/);
  assert.equal(raw.newSharedCredit, 0);
  pinSource();
  assert.deepEqual(
    raw.observations.map((row) => row.id),
    expectedIds,
  );
  assert.equal(new Set(expectedIds).size, 26);
  assert.deepEqual(raw.nativeFixtureBefore, spec.fixtureFiles);
  assert.deepEqual(raw.nativeFixtureAfter, spec.fixtureFiles);
  const processes = new Map(raw.processes.map((item) => [item.id, item]));
  assert.equal(processes.size, 26);
  const nativeEvidence = {};
  const cases = raw.observations.map((row, index) => {
    const expected = spec.rows[index];
    assert.deepEqual(row.input, expected.input);
    assert.equal(
      digest(row.source),
      digest(expected.expected),
      `${row.id}: frozen Source view`,
    );
    assert.deepEqual(
      row.sourceOriginalReferenceFacts,
      expected.sourceOriginalReferences,
    );
    assert.deepEqual(row.failures, []);
    assert.equal(row.valueProfileMatches, true);
    assert.equal(row.nativeProcessStatus, 0);
    assert.deepEqual(row.qualifications ?? [], []);
    const process = processes.get(row.id);
    assert.ok(process);
    assert.equal(process.binarySha256, expectedBinarySHA);
    assert.equal(process.command[0], raw.processes[0].command[0]);
    assert.equal(process.command.length, 2);
    assert.ok(path.isAbsolute(process.command[1]));
    assert.equal(fileHash(process.stdin), process.stdinSha256);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(process.stdin, "utf8")),
      row.input,
    );
    const frame = frameOf(process, row.id);
    assert.deepEqual(frame.observedCalls, expected.observedCalls);
    assert.deepEqual(nativeView(frame, row.input), row.native);
    assert.deepEqual(row.source, row.native, `${row.id}: whole view`);
    if (row.input.mode === "deployable") {
      assert.deepEqual(frame.output.identity, row.nativeOriginalReferenceFacts);
      sourceReferences(expected, frame);
    }
    nativeEvidence[row.id] = { observedCalls: frame.observedCalls };
    return {
      id: row.id,
      input: row.input,
      ok: true,
      passed: true,
      qualifications: [],
      expected: row.source,
      output: row.native,
      sourceOriginalReferences: row.sourceOriginalReferenceFacts,
      nativeOriginalReferences: row.nativeOriginalReferenceFacts,
      inputSha256: digest(row.input),
      wholeviewSha256: digest(row.source),
      globalId: `graph.icu77-census.${row.id}`,
      nativeTrace: {
        observedCalls: frame.observedCalls,
        process,
        response: frame,
      },
    };
  });
  const protocol = raw.protocol;
  assert.equal(protocol.rejectedInvalidInputs, 5);
  assert.equal(protocol.rejectedInvalidInputRows, 0);
  assert.equal(protocol.newSharedCredit, 0);
  assert.deepEqual(
    protocol.observations.map((row) => row.id),
    spec.protocolInputs.map((row) => row.id),
  );
  for (const [index, process] of protocol.observations.entries()) {
    const expected = spec.protocolInputs[index];
    assert.equal(process.status, 1);
    assert.equal(process.signal, null);
    assert.equal(process.command.length, 2);
    assert.equal(process.command[0], raw.processes[0].command[0]);
    assert.ok(path.isAbsolute(process.command[1]));
    assert.equal(process.nativeInlineFrames, 0);
    assert.equal(process.parityCases, 0);
    assert.equal(process.binaryBeforeSha256, expectedBinarySHA);
    assert.equal(process.binaryAfterSha256, expectedBinarySHA);
    assert.equal(process.stdoutBytes, 0);
    assert.equal(fs.readFileSync(process.stdout).length, 0);
    assert.equal(fileHash(process.stdout), process.stdoutSha256);
    const stderr = fs.readFileSync(process.stderr);
    assert.equal(hash(stderr), process.stderrSha256);
    assert.equal(stderr.toString("utf8"), expected.decoderStderr);
    assert.ok(
      stderr.length > 0 && !stderr.toString("utf8").includes("panicked at"),
    );
    const input = fs.readFileSync(process.stdin.file);
    assert.equal(hash(input), expected.inputSha256);
    assert.equal(input.toString("base64"), expected.inputBase64);
    assert.equal(process.stdin.sha256, expected.inputSha256);
  }
  const sample = cases[0].nativeTrace.response;
  for (const corrupt of [
    { ...sample, extra: true },
    { ...sample, id: 7 },
    { ...sample, observedCalls: [] },
  ])
    assert.throws(() => assertCensusResponse(corrupt, sample.id));
  return {
    attempted: 26,
    passed: 26,
    unqualifiedPairs: 26,
    qualifiedPairs: 0,
    rejectedInvalidInputs: 5,
    rejectedInvalidInputRows: 0,
    responseGuards: 3,
    failures: [],
    reference: { Source: spec.reference, ...spec.engine },
    rustBinarySha256: expectedBinarySHA,
    cases,
    nativeEvidence,
    qualifiedNativeEvidence: {},
    rawReport: rawFile,
    scope:
      "K census checked collation, source-pinned comparison schedule and original borrowed row profiles. Current inventory and all CLI/raw/reflection/host gaps remain open; no full-port claim.",
    profiles: {
      SourceLineage: spec.lineage,
      originalReferenceIdentity:
        "Actual native pointer indices and alias repetitions, separate from counts/serialization.",
      inputBits:
        "Literal nonfinite/-0 transport labels preserved; native inputOrderUnchanged is the actual bitwise before/after comparison, not an invented external bit dump.",
      libraryModels:
        "Source pure supplied model versus existing native reader on real neutral package bytes; no extra reader/schema/Go credit.",
    },
    fixtureBytesAndModes: {
      before: raw.nativeFixtureBefore,
      after: raw.nativeFixtureAfter,
    },
    protocolObservations: protocol.observations,
    nativeOnlyRecording: { ids: [], nativeExecutions: 0, comparisonCredit: 0 },
  };
}
function manifest(service, dir) {
  return {
    service,
    dir,
    configFile: `${dir}/wrangler.json`,
    main: null,
    bindings: [],
    dataBindings: [],
    envKeys: [],
    bindingNames: [],
    devVarsKeys: [],
    devVarsFiles: [],
  };
}
async function sourceView(input) {
  const d = await import(
    pathToFileURL(
      path.join(
        root,
        "packages/code-graph/src/boundaries/deployables/census.ts",
      ),
    )
  );
  const l = await import(
    pathToFileURL(
      path.join(root, "packages/code-graph/src/boundaries/libraries/census.ts"),
    )
  );
  const r = await import(
    pathToFileURL(
      path.join(root, "packages/code-graph/src/boundaries/render.ts"),
    )
  );
  if (input.mode !== "deployable") {
    if (input.mode === "library-disabled") {
      const view = l.libraryCensus(
        { declared: false },
        { scopes: [], undeclared: [], unjudged: Infinity },
      );
      return { view, refs: null };
    }
    const dirs = ["packages/Z", "packages/a", "packages/ten", "packages/two"];
    const multiple = input.id === "library-multiple-directories";
    const names = multiple ? ["same"] : ["10", "2", "Z", "a", "unused"];
    const model = {
      declared: true,
      rules: {
        libraryTypes: Object.fromEntries(names.map((name) => [name, {}])),
      },
      dirs,
      typeOfDir: new Map(
        dirs.map((dir, index) => [
          dir,
          multiple ? "same" : ["Z", "a", "10", "2"][index],
        ]),
      ),
    };
    const census = l.libraryCensus(model, {
      scopes: [...dirs, "packages/a"],
      undeclared: ["packages/Zz", "packages/aa", "packages/aa"],
      unjudged: Infinity,
    });
    return {
      view: {
        types: Object.entries(census.types),
        undeclared: census.undeclared,
        unjudgedImports: "+Infinity",
        lines: l.censusLines(census),
        reportJson: r.renderBoundaries(
          [],
          ".",
          { libraries: census, deployables: null },
          true,
          false,
        ),
      },
      refs: null,
    };
  }
  const known = new Map(),
    ids = new WeakMap();
  const rows = input.rows.map((item) => {
    if (item.alias) return known.get(item.alias);
    const row = {
      file: item.file ?? "workers/Z/src/file.ts",
      line: number(item.line),
      binding: item.binding,
    };
    known.set(item.id, row);
    ids.set(row, item.id);
    return row;
  });
  const before = [...rows];
  const model = {
    kinds: new Set(
      input.id === "disabled" ? [] : ["binding-outside-driven-adapter"],
    ),
    catalog: {
      manifests: [
        manifest("Z", "workers/Z"),
        manifest("a", "workers/a"),
        manifest("nested", "workers/Z/deep"),
      ],
      unparsedConfigs: [],
    },
    graph: { workers: ["a", "nested", "Z"], edges: [], unresolved: 3 },
    workspaces: new Set(),
    judged: new Map(),
  };
  const census = d.deployableCensus(model, rows);
  assert.ok(rows.every((row, index) => row === before[index]));
  const reports = [
    {
      scope: ".",
      features: ["demo"],
      filesScanned: rows.length,
      violations: [],
    },
  ];
  return {
    view: {
      workers:
        census?.workers.map((worker) => ({
          worker: worker.worker,
          files: worker.files,
          bindings: Object.entries(worker.bindings),
          sites: worker.sites.map((row) => ({ ...row, line: tag(row.line) })),
        })) ?? null,
      unresolved: census?.unresolvedServiceBindings ?? null,
      inputOrderUnchanged: true,
      lines: census ? d.deployableCensusLines(census) : null,
      reportText: r.renderBoundaries(
        reports,
        ".",
        { libraries: null, deployables: census },
        false,
        false,
      ),
      reportJson: r.renderBoundaries(
        reports,
        ".",
        { libraries: null, deployables: census },
        true,
        false,
      ),
      reportPretty: r.renderBoundaries(
        reports,
        ".",
        { libraries: null, deployables: census },
        true,
        true,
      ),
    },
    refs:
      census?.workers.map((worker) => ({
        allOriginalRows: worker.sites.every((row) => rows.includes(row)),
        referenceIds: worker.sites.map((row) => ids.get(row)),
        inputIndices: worker.sites.map((row) =>
          rows.flatMap((original, index) => (row === original ? [index] : [])),
        ),
      })) ?? [],
  };
}
function snapshot(directory) {
  const out = {};
  function walk(at) {
    for (const item of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, item.name);
      if (item.isDirectory()) walk(file);
      else
        out[path.relative(directory, file)] = {
          base64: fs.readFileSync(file).toString("base64"),
          mode: fs.statSync(file).mode & 0o777,
        };
    }
  }
  walk(directory);
  return out;
}
async function runCensus(binary, reportFile) {
  assert.equal(process.version, spec.engine.node);
  assert.equal(process.versions.v8, spec.engine.v8);
  assert.equal(process.versions.icu, spec.engine.icu);
  assert.equal(Intl.Collator().resolvedOptions().locale, "en-US");
  pinSource();
  const binarySHA = fileHash(binary);
  const temporary = fs.mkdtempSync(
    path.join("/private/tmp", "demlik-k-pairs-"),
  );
  const frames = `${reportFile}.frames`;
  fs.mkdirSync(frames, { recursive: true });
  const processes = [],
    observations = [],
    protocol = [];
  const partial = {
    inputRecords: 26,
    valueProfileMatches: 0,
    failedValueProfileIds: [],
    observations,
    processes,
    binarySha256: binarySHA,
    newSharedCredit: 0,
    protocol: {
      observations: protocol,
      rejectedInvalidInputs: 0,
      rejectedInvalidInputRows: 0,
      newSharedCredit: 0,
    },
  };
  const savePartial = () =>
    fs.writeFileSync(
      `${reportFile}.raw.json`,
      `${JSON.stringify(partial, null, 2)}\n`,
    );
  const saveProcess = (id, input) => {
    const stdin = path.join(frames, `${id}.stdin`);
    fs.writeFileSync(stdin, input);
    const result = spawnSync(binary, [temporary], {
      cwd: root,
      input,
      maxBuffer: 32 << 20,
      timeout: 30000,
    });
    assert.ifError(result.error);
    const stdout = path.join(frames, `${id}.stdout`),
      stderr = path.join(frames, `${id}.stderr`);
    fs.writeFileSync(stdout, result.stdout ?? Buffer.alloc(0));
    fs.writeFileSync(stderr, result.stderr ?? Buffer.alloc(0));
    return {
      result,
      record: {
        id,
        command: [binary, temporary],
        status: result.status,
        signal: result.signal,
        stdin,
        stdinSha256: fileHash(stdin),
        stdout,
        stdoutSha256: fileHash(stdout),
        stderr,
        stderrSha256: fileHash(stderr),
        binarySha256: binarySHA,
      },
    };
  };
  try {
    for (const [relative, file] of Object.entries(spec.fixtureFiles)) {
      const target = path.join(temporary, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(file.base64, "base64"));
      fs.chmodSync(target, file.mode);
    }
    const before = snapshot(temporary);
    partial.nativeFixtureBefore = before;
    savePartial();
    for (const row of spec.rows) {
      const source = await sourceView(row.input);
      assert.equal(digest(source.view), digest(row.expected));
      assert.deepEqual(source.refs, row.sourceOriginalReferences);
      const { result, record } = saveProcess(
        row.id,
        Buffer.from(`${JSON.stringify(row.input)}\n`),
      );
      processes.push(record);
      assert.equal(result.status, 0);
      assert.equal(result.signal, null);
      assert.equal(fs.readFileSync(record.stderr).length, 0);
      const frame = JSON.parse(fs.readFileSync(record.stdout, "utf8"));
      assertCensusResponse(frame, row.id);
      sourceReferences(row, frame);
      const actual = nativeView(frame, row.input);
      assert.deepEqual(actual, source.view);
      observations.push({
        id: row.id,
        input: row.input,
        source: source.view,
        native: actual,
        sourceOriginalReferenceFacts: source.refs,
        nativeOriginalReferenceFacts:
          row.input.mode === "deployable" ? frame.output.identity : null,
        valueProfileMatches: true,
        failures: [],
        nativeProcessStatus: 0,
      });
      partial.valueProfileMatches = observations.length;
      savePartial();
    }
    for (const row of spec.protocolInputs) {
      const input = Buffer.from(row.inputBase64, "base64");
      const { result, record } = saveProcess(row.id, input);
      protocol.push({
        id: row.id,
        command: record.command,
        status: record.status,
        signal: record.signal,
        stdin: {
          file: record.stdin,
          sha256: record.stdinSha256,
          bytes: input.length,
        },
        stdout: record.stdout,
        stdoutSha256: record.stdoutSha256,
        stdoutBytes: fs.readFileSync(record.stdout).length,
        stderr: record.stderr,
        stderrSha256: record.stderrSha256,
        stderrBytes: fs.readFileSync(record.stderr).length,
        binaryBeforeSha256: binarySHA,
        binaryAfterSha256: fileHash(binary),
        nativeInlineFrames: 0,
        parityCases: 0,
      });
      assert.equal(result.status, 1);
      assert.equal(result.signal, null);
      partial.protocol.rejectedInvalidInputs = protocol.length;
      savePartial();
    }
    const after = snapshot(temporary);
    assert.deepEqual(after, before);
    pinSource();
    return {
      inputRecords: 26,
      valueProfileMatches: 26,
      failedValueProfileIds: [],
      observations,
      processes,
      nativeFixtureBefore: before,
      nativeFixtureAfter: after,
      binarySha256: binarySHA,
      newSharedCredit: 0,
      protocol: {
        observations: protocol,
        rejectedInvalidInputs: 5,
        rejectedInvalidInputRows: 0,
        newSharedCredit: 0,
      },
    };
  } catch (error) {
    partial.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    partial.nativeFixtureAfter = snapshot(temporary);
    savePartial();
    fs.rmSync(temporary, { recursive: true, force: true });
    assert.equal(fileHash(binary), binarySHA);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [binaryArg, reportArg] = process.argv.slice(2);
  assert.ok(binaryArg && reportArg && process.argv.length === 4);
  const binary = path.resolve(binaryArg),
    reportFile = path.resolve(reportArg);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const before = fileHash(binary);
  const rawFile = `${reportFile}.raw.json`;
  try {
    const raw = await runCensus(binary, reportFile);
    fs.writeFileSync(rawFile, `${JSON.stringify(raw, null, 2)}\n`);
    const report = sharedCensus(raw, rawFile, before);
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
      JSON.stringify({
        passed: 26,
        strict: 26,
        qualified: 0,
        rejectedInvalidInputs: 5,
        rejectedInvalidInputRows: 0,
      }),
    );
  } finally {
    assert.equal(fileHash(binary), before);
  }
}
