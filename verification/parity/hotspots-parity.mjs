import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCheckPath,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";
import { cases } from "./hotspots-cases.mjs";
import { hash } from "./hotspots-fixtures.mjs";
import { hotspotsParity } from "./hotspots-run.mjs";
import { buildExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const node22 = "/Users/cansirin/.volta/tools/image/node/22.21.1/bin/node";
const driver = "crates/code-graph/examples/hotspots_driver.rs";
const driverSHA =
  "07147b8686d7aa858655bda94fa6730759983cda0bb87859ebac53032a19fcfc";
const sourcePins = {
  "packages/code-graph/src/hotspots/churn.ts":
    "4d0a140e604eee8ed332f8caf4a5a66e8ff9b71f30c15975c64e2cd930d023c0",
  "packages/code-graph/src/hotspots/render.ts":
    "aac52a953fe6c8c81498936eda45f9d305b21d6cb05adccbcc8ffa61a52e0915",
  "packages/code-graph/src/extract/project.ts":
    "08aa30497ce1dde9d1d8587fc5f17bfd77c47de7206222d12285db5bad5cf69a",
  "packages/code-graph/src/extract/assemble.ts":
    "b30d35677ccd714af2bb00c9b94374a0d7d621f2be5957f0e08a54cad829b644",
  "packages/code-graph/src/schema/core.ts":
    "13d33837f3765d59c359f4c8f541bd8b665206bdc54bbbc7278d1fd7f4393ad2",
  "packages/code-graph/src/schema/graph.ts":
    "d3213e8491f1bc033771ad935421707132c5a4635eb0f8c658c727f15bdcfe05",
  "packages/code-graph/src/render/json.ts":
    "972e63df22fcf30504717be86a82dbd09014016b475bfa62c6d453967c80a61f",
  "verification/parity/hotspots-cases.mjs":
    "c0a4b6b4fc122b0b7f34340575392ddf353ec64c8e108ccb8c4984b720373cbf",
  "verification/parity/hotspots-reference.mjs":
    "950924cf4e592aeba5f24a909815d498548c3e789fde9ccd0936ed4b740f5acc",
  "verification/parity/hotspots-fixtures.mjs":
    "eb90b1e7055d8ff9c33ab68580bca7b4710b73e9b891e32b53e64bbf55743f3d",
  "verification/parity/hotspots-git-fixture.py":
    "6202932e952137fd49c676a387d90895f5040e37719b4a59310fb5d9bf21755b",
};
const workers = [
  "hotspots-source-freeze.mjs",
  "hotspots-source-supplement.mjs",
  "hotspots-run.mjs",
  "hotspots-parity.mjs",
];
const historical = {
  source24: "7ecc56ba559999ffdae8bd5263904245589db49edc33d55ae894164b6eed9f5d",
  source2: "4ea31bf8a22283ff27588628bd9b67e522d8e3ffc5f55090c47f6bde6be403c6",
  native24: "1784d25a539abdceeca7f212d1ac52b7b37043fe426d869e832043dfaab7b0a1",
  native2: "9dd24da15e8643b519b9a2a4402fb2a76f0b6884e0898f8e872fcbf70137d122",
};
const historicalWorkerPins = {
  "verification/parity/hotspots-cases.mjs":
    "1b519bec33354c353026053c19b508577047e4e4b95418f395ab84a54e85c9e5",
  "verification/parity/hotspots-reference.mjs":
    "66ffc94fe5bef9a13bcf033cefbf330ea37660d24ff029e15b6305def3e42fa3",
  "verification/parity/hotspots-fixtures.mjs":
    "c38c525ac44b4761c36f276d20961cc1441fe96dfb3c49e4205157326af0cee3",
  "verification/parity/hotspots-git-fixture.py":
    "d947937d70634511c61c5fdc21f16cd05a63f73f6f2914a3d420529ea45bd383",
};
const hashFile = (file) => hash(fs.readFileSync(file));
const record = (file) => ({ path: path.resolve(file), sha256: hashFile(file) });
const read = (entry) => {
  assert.ok(path.isAbsolute(entry.path));
  assert.equal(
    hashFile(entry.path),
    entry.sha256,
    `retained bytes: ${entry.path}`,
  );
  return JSON.parse(fs.readFileSync(entry.path, "utf8"));
};
const currentPins = () =>
  Object.fromEntries(
    [
      ...Object.keys(sourcePins),
      ...workers.map((name) => `verification/parity/${name}`),
      driver,
    ].map((file) => [file, hashFile(path.join(root, file))]),
  );

function processBytes(process, input, frame, native, binary) {
  assert.equal(process.status, 0);
  assert.equal(process.signal, null);
  assert.equal(process.error ?? null, null);
  assert.equal(process.args.length, native ? 1 : 3);
  if (native) {
    assert.equal(process.command, binary.path);
    assert.equal(process.binarySHA, binary.sha256);
    assert.ok(process.args[0].endsWith(".captures"));
  } else {
    assert.equal(process.command, node22);
    assert.equal(process.args[0], "--import");
    assert.equal(path.basename(process.args[2]), "hotspots-reference.mjs");
  }
  const stdin = process.stdin ?? process.stdout.replace(/\.stdout$/, ".stdin");
  const request = fs.readFileSync(stdin);
  assert.equal(
    request.toString("utf8"),
    `${JSON.stringify(input)}\n`,
    "actual request bytes",
  );
  if (process.stdinSHA) assert.equal(hash(request), process.stdinSHA);
  const stdout = fs.readFileSync(process.stdout);
  const stderr = fs.readFileSync(process.stderr);
  assert.equal(hash(stdout), process.stdoutSHA, "actual stdout digest");
  assert.equal(hash(stderr), process.stderrSHA, "actual stderr digest");
  assert.deepEqual(
    JSON.parse(stdout.toString("utf8")),
    frame,
    "actual stdout frame",
  );
  return { stdin, request, stderr };
}

function gitReceipt(process, controlled, expected, retained = null) {
  const file = process.stdout.replace(/\.stdout$/, ".git.jsonl");
  const records = controlled
    ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    : [];
  if (!controlled && fs.existsSync(file))
    assert.equal(fs.readFileSync(file, "utf8"), "");
  const starts = records.filter((entry) => entry.event === "start");
  const attempts = starts.map(({ phase, args, cwd }) => ({ phase, args, cwd }));
  assert.deepEqual(attempts, expected, "actual Git argv/cwd/order");
  for (const start of starts) {
    assert.ok(Number.isSafeInteger(start.pid) && start.pid > 0);
    assert.ok(
      records.some(
        (entry) =>
          entry.phase === start.phase &&
          (entry.event === "exit" ||
            (entry.event === "signal" && entry.pid === start.pid)),
      ),
      "Git exit/signal receipt",
    );
  }
  if (retained) {
    assert.deepEqual(retained.records, records);
    assert.deepEqual(retained.attempts, attempts);
    assert.equal(retained.allExited, true);
    assert.deepEqual(
      retained.children,
      starts.map(({ pid }) => ({ pid, alive: false })),
    );
  }
  return { path: controlled ? file : null, records };
}

export function normalizeHotspotsReport(raw, producer = null) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.phases, ["source24", "source2", "native24", "native2"]);
  assert.ok(
    ["fresh-source-first", "sealed-source-first"].includes(raw.lineage),
  );
  const sealed = raw.lineage === "sealed-source-first";
  const reports = Object.fromEntries(
    Object.entries(raw.records).map(([key, entry]) => [key, read(entry)]),
  );
  const {
    before,
    fixture,
    supplementBefore,
    source24,
    source2,
    native24,
    native2,
  } = reports;
  assert.deepEqual(Object.keys(reports).sort(), [
    "before",
    "fixture",
    "native2",
    "native24",
    "source2",
    "source24",
    "supplementBefore",
  ]);
  if (sealed) {
    for (const key of ["source24", "source2"])
      assert.equal(raw.records[key].sha256, historical[key]);
  } else {
    assert.deepEqual(raw.sourceHashesBefore, currentPins());
    assert.deepEqual(raw.sourceHashesAfter, raw.sourceHashesBefore);
    assert.equal(raw.launchers.length, 2);
    for (const [index, launcher] of raw.launchers.entries()) {
      assert.equal(launcher.command[0], node22);
      assert.equal(
        path.basename(launcher.command[1]),
        index === 0
          ? "hotspots-source-freeze.mjs"
          : "hotspots-source-supplement.mjs",
      );
      assert.equal(launcher.status, 0);
      assert.equal(launcher.signal, null);
      assert.equal(launcher.error, null);
      for (const stream of ["stdout", "stderr"])
        assert.equal(hashFile(launcher[stream].path), launcher[stream].sha256);
      assert.equal(fs.readFileSync(launcher.stderr.path, "utf8"), "");
    }
  }
  for (const [file, pin] of Object.entries(sourcePins)) {
    assert.equal(
      hashFile(path.join(root, file)),
      pin,
      `Source/case/fixture pin: ${file}`,
    );
    assert.equal(
      source24.sourcePins[file],
      sealed ? (historicalWorkerPins[file] ?? pin) : pin,
    );
  }
  assert.equal(hashFile(path.join(root, driver)), driverSHA);
  assert.deepEqual(before.files, source24.sourcePins);
  assert.deepEqual(before.engine, {
    node: "v22.21.1",
    v8: "12.4.254.21-node.33",
    icu: "77.1",
  });
  assert.equal(before.beforeAnyRustProjection, true);
  assert.equal(source24.SourceFirstBeforeNativeProjection, true);
  assert.equal(source24.NativeOrCargoExecutions, 0);
  assert.equal(source24.cases, 24);
  assert.equal(source24.passed, 24);
  assert.deepEqual(before.inputs, fixture.inputs);
  assert.equal(fixture.identityOverrides, false);
  assert.ok(fixture.setup.length > 0);
  for (const step of fixture.setup) {
    assert.equal(step.exit, 0);
    assert.equal(step.error, null);
    assert.equal(step.identityOverride, false);
  }
  assert.deepEqual(source24.fixtureBytesBefore, fixture.before);
  assert.deepEqual(source24.fixtureBytesAfter, fixture.before);
  assert.equal(source2.SourceOnly, true);
  assert.equal(source2.beforeAnyNativeProjection, true);
  assert.equal(source2.original24Unchanged, true);
  assert.equal(source2.cases, 2);
  assert.equal(supplementBefore.beforeAnyNativeProjection, true);
  assert.equal(
    supplementBefore.original24ReportSHA,
    raw.records.source24.sha256,
  );
  assert.deepEqual(supplementBefore.files, source2.sourcePins);
  for (const [name, pin] of Object.entries(source2.sourcePins)) {
    const file = `verification/parity/${name}`;
    const oldPin =
      name === "hotspots-source-supplement.mjs"
        ? "3cc32c65d11acd1d777cac80ecf1565a75c4d33c8b4be9b030bb8fce5acb55ef"
        : name === "hotspots-git-fixture.py"
          ? sourcePins[file]
          : historicalWorkerPins[file];
    assert.equal(sealed ? oldPin : hashFile(path.join(root, file)), pin);
  }
  if (!sealed)
    assert.equal(
      source24.sourcePins["verification/parity/hotspots-source-freeze.mjs"],
      hashFile(
        path.join(root, "verification/parity/hotspots-source-freeze.mjs"),
      ),
    );
  assert.deepEqual(
    fixture.inputs.map((input) => {
      const { root: _root, queries: _queries, ...fixed } = input;
      return fixed;
    }),
    cases,
  );
  const supplement = ["text", "invalid"].map((stderr) => ({
    ...fixture.inputs.find((input) => input.id === "git-duplicates-raw-paths"),
    id: `git-stderr-${stderr}`,
    controlled: { fail: null, stderr },
  }));
  assert.deepEqual(supplementBefore.inputs, supplement);
  const inputs = [...fixture.inputs, ...supplement];
  const sourceRows = [...source24.rows, ...source2.rows];
  const rows = [...native24.rows, ...native2.rows];
  assert.deepEqual(
    sourceRows.map((row) => row.id),
    inputs.map((input) => input.id),
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    inputs.map((input) => input.id),
  );
  assert.deepEqual(raw.binary, native24.binary);
  assert.deepEqual(native2.binary, native24.binary);
  assert.equal(
    hashFile(raw.binary.path),
    raw.binary.sha256,
    "executed binary digest",
  );
  const calls = new Set(
    [
      ...fs
        .readFileSync(path.join(root, driver), "utf8")
        .matchAll(/observe!\(\s*[^,]+,\s*([\w:]+)/g),
    ].map((match) => match[1]),
  );
  const nativeEvidence = {},
    processes = [],
    captures = [];
  for (const [index, row] of rows.entries()) {
    const source = sourceRows[index],
      input = inputs[index];
    assert.deepEqual(row.input, input, `${row.id}: exact input`);
    assert.deepEqual(source.input, input);
    assert.equal(row.protocolValid, true);
    assert.equal(row.equal, true);
    assert.deepEqual(row.errors, []);
    assert.equal(source.allControlledChildrenExited, true);
    assert.equal(source.frame.id, input.id);
    assert.equal(source.frame.ok, true);
    assert.deepEqual(Object.keys(source.frame).sort(), ["id", "ok", "output"]);
    assert.deepEqual(row.source, source.frame, "Source report frame");
    assert.deepEqual(
      row.native.output,
      source.frame.output,
      "entire actual comparison view",
    );
    assert.deepEqual(Object.keys(row.native).sort(), [
      "id",
      "nativeOnlyFailures",
      "nativeTrace",
      "ok",
      "output",
    ]);
    assert.equal(row.native.id, row.id);
    assert.equal(row.native.ok, true);
    assert.ok(row.native.nativeTrace.length > 0);
    for (const call of row.native.nativeTrace)
      assert.ok(calls.has(call), `actual driver call: ${call}`);
    const sourceBytes = processBytes(
      source.process,
      input,
      source.frame,
      false,
      raw.binary,
    );
    const nativeBytes = processBytes(
      row.process,
      input,
      row.native,
      true,
      raw.binary,
    );
    assert.deepEqual(
      nativeBytes.stderr,
      sourceBytes.stderr,
      "complete stderr bytes",
    );
    if (source.sourceStderrHex !== undefined)
      assert.equal(sourceBytes.stderr.toString("hex"), source.sourceStderrHex);
    gitReceipt(
      source.process,
      input.controlled,
      source.gitAttempts,
      source.git ??
        JSON.parse(
          fs.readFileSync(
            source.process.stdout.replace(/\.stdout$/, ".process.json"),
            "utf8",
          ),
        ).controlledGit,
    );
    gitReceipt(
      row.process,
      input.controlled,
      source.gitAttempts,
      row.rawControlledGit,
    );
    assert.deepEqual(row.git, source.gitAttempts);
    if (row.repositoryBefore !== undefined) {
      assert.deepEqual(row.repositoryBefore, fixture.before);
      assert.deepEqual(row.repositoryAfter, row.repositoryBefore);
    } else {
      assert.equal(sealed, true, "fresh Native repository snapshots required");
      assert.equal(
        raw.records[index < 24 ? "native24" : "native2"].sha256,
        historical[index < 24 ? "native24" : "native2"],
      );
    }
    const expectedCaptures = row.native.nativeOnlyFailures.flatMap((failure) =>
      ["stdout", "stderr"]
        .filter((stream) => failure.data[stream])
        .map((stream) => ({
          stage: failure.stage,
          stream,
          path: failure.data[stream],
          bytes: failure.data[`${stream}Bytes`],
          sha256: hashFile(failure.data[stream]),
        })),
    );
    assert.deepEqual(row.nativeCaptureFacts, expectedCaptures);
    for (const capture of expectedCaptures)
      assert.equal(fs.statSync(capture.path).size, capture.bytes);
    captures.push(...expectedCaptures);
    processes.push(source.process, row.process);
    nativeEvidence[row.id] = row.native.nativeTrace;
  }
  for (const [report, count, flag, key] of [
    [native24, 24, false, "source24"],
    [native2, 2, true, "source2"],
  ]) {
    assert.equal(report.complete, true);
    assert.equal(report.cases, count);
    assert.equal(report.passed, count);
    assert.deepEqual(report.failures, []);
    assert.equal(report.supplement, flag);
    assert.equal(report.SourcePackageEdits, 0);
    assert.equal(report.DateOwnerCredit, 0);
    assert.equal(report.CLICredit, 0);
    assert.deepEqual(
      report.processes,
      report.rows.map((row) => row.process),
    );
    assert.deepEqual(report.sourceReport, raw.records[key]);
    if (!sealed) assert.deepEqual(report.fixtureSetup, raw.records.fixture);
  }
  if (producer) {
    assert.equal(producer.binary, raw.binary.path);
    assert.equal(producer.binarySha256, raw.binary.sha256);
    assert.equal(producer.source.sha256, driverSHA);
    assert.equal(producer.driver.target.name, "hotspots_driver");
    assert.ok(producer.driver.target.kind.includes("example"));
    assertCheckPath(producer.actualArtifact, path.join(root, "target"));
    assertCheckPath(
      producer.libraries.demlik_code_graph.path,
      path.join(root, "target"),
    );
  }
  return {
    cases: rows.map((row) => ({
      ...row,
      valid: true,
      protocol: false,
      passed: true,
      qualifications: [],
      nativeTrace: { observedCalls: row.native.nativeTrace },
    })),
    observations: 26,
    passed: 26,
    attempted: 26,
    unqualifiedPairs: 26,
    qualifiedPairs: 0,
    rejectedInvalidInputs: 0,
    rejectedInvalidInputRows: 0,
    responseGuards: 0,
    nativeEvidence,
    qualifiedNativeEvidence: {},
    failures: [],
    processes,
    captures,
    rustBinarySha256: raw.binary.sha256,
    binary: raw.binary,
    producer,
    raw,
    limits: [
      "Date/window construction and actual CLI remain open.",
      "No structured transport-refusal or UTF8 admission credit.",
      "Raw OS/error-write and canonical Graph boundaries remain scoped.",
      ...(sealed
        ? [
            "Saved admission only: historical native snapshots were compared but not separately retained.",
          ]
        : []),
    ],
  };
}

export function hotspotsCheckpointParity(cargo, options = {}) {
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, `${key} must be unset`);
  assert.equal(process.execPath, node22);
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/hotspots.json"),
  );
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const proof = `${reportFile}.proof`;
  assert.ok(!fs.existsSync(proof), "fresh Hotspots proof directory required");
  fs.mkdirSync(proof);
  const runtime = fs.mkdtempSync("/private/tmp/demlik-hotspots-runtime-");
  const launchers = [],
    phases = [];
  const before = currentPins();
  let producer = null,
    binary,
    binaryBefore,
    result,
    operationError,
    identityError;
  function source(script, args) {
    const prefix = path.join(proof, script.replace(/\.mjs$/, ""));
    const command = [
      node22,
      path.join(root, "verification/parity", script),
      ...args,
    ];
    const process = spawnSync(command[0], command.slice(1), {
      cwd: root,
      env: {
        ...globalThis.process.env,
        PATH: `${path.dirname(node22)}${path.delimiter}${globalThis.process.env.PATH}`,
        TMPDIR: "/private/tmp",
      },
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
    });
    fs.writeFileSync(`${prefix}.stdout`, process.stdout ?? "");
    fs.writeFileSync(`${prefix}.stderr`, process.stderr ?? "");
    const entry = {
      command,
      status: process.status,
      signal: process.signal,
      error: process.error?.message ?? null,
      stdout: record(`${prefix}.stdout`),
      stderr: record(`${prefix}.stderr`),
    };
    launchers.push(entry);
    fs.writeFileSync(
      `${prefix}.process.json`,
      `${JSON.stringify(entry, null, 2)}\n`,
    );
    assert.equal(process.status, 0, process.stderr);
    assert.equal(process.signal, null);
    assert.equal(process.error, undefined);
  }
  try {
    source("hotspots-source-freeze.mjs", [
      path.join(proof, "source-first"),
      runtime,
    ]);
    phases.push("source24");
    source("hotspots-source-supplement.mjs", [proof]);
    phases.push("source2");
    const records = {
      before: record(
        path.join(proof, "source-first/before-source-freeze.json"),
      ),
      fixture: record(path.join(proof, "source-first/fixture-setup.json")),
      supplementBefore: record(path.join(proof, "supplement-before.json")),
      source24: record(path.join(proof, "source-first/source-first.json")),
      source2: record(path.join(proof, "source-supplement2.json")),
    };
    if (options.binary) binary = path.resolve(options.binary);
    else {
      producer = buildExample(
        cargo,
        "demlik-code-graph",
        "hotspots_driver",
        reportFile,
      );
      binary = producer.binary;
    }
    binaryBefore = hashFile(binary);
    for (const [flag, sourceKey, nativeKey] of [
      [false, "source24", "native24"],
      [true, "source2", "native2"],
    ]) {
      const output = `${reportFile}.${nativeKey}.raw.json`;
      hotspotsParity(binary, proof, output, {
        supplement: flag,
        sourceReport: records[sourceKey],
        fixtureSetup: records.fixture,
      });
      records[nativeKey] = record(output);
      phases.push(nativeKey);
    }
    const raw = {
      version: 1,
      lineage: "fresh-source-first",
      phases,
      records,
      binary: { path: binary, sha256: binaryBefore },
      sourceHashesBefore: before,
      sourceHashesAfter: currentPins(),
      launchers,
    };
    fs.writeFileSync(
      `${reportFile}.raw.json`,
      `${JSON.stringify(raw, null, 2)}\n`,
    );
    result = normalizeHotspotsReport(raw, producer);
    const requests = result.processes.map((entry) => {
      const original =
        entry.stdin ?? entry.stdout.replace(/\.stdout$/, ".stdin");
      assertCheckPath(original, path.dirname(reportFile));
      const alias = original.replace(/\.stdin$/, ".request.json");
      assert.deepEqual(fs.readFileSync(alias), fs.readFileSync(original));
      return {
        original,
        alias,
        bytes: fs.statSync(original).size,
        sha256: hashFile(original),
        aliasSha256: hashFile(alias),
      };
    });
    const retention = `${reportFile}.retention.json`;
    fs.writeFileSync(
      retention,
      `${JSON.stringify({ requests, captures: result.captures, selectedEvidenceOnly: true }, null, 2)}\n`,
    );
    result.retention = record(retention);
    fs.writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    operationError = error;
    fs.writeFileSync(
      `${reportFile}.failure.json`,
      `${JSON.stringify({ phases, launchers, message: error.message, stack: error.stack }, null, 2)}\n`,
    );
  } finally {
    try {
      if (binaryBefore)
        assert.equal(hashFile(binary), binaryBefore, "executed binary changed");
    } catch (error) {
      identityError = error;
    }
    fs.rmSync(runtime, { recursive: true, force: true });
    fs.writeFileSync(
      `${reportFile}.runtime-cleanup.json`,
      `${JSON.stringify({ runtime, removed: !fs.existsSync(runtime) }, null, 2)}\n`,
    );
  }
  if (operationError && identityError)
    throw new AggregateError(
      [operationError, identityError],
      "Hotspots operation and binary identity failed",
    );
  if (operationError) throw operationError;
  if (identityError) throw identityError;
  return result;
}
