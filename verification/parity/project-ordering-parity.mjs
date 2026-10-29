import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  assertCheckPath,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";
import { projectOrderingCases } from "./project-ordering-cases.mjs";
import { buildExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const node22 = "/Users/cansirin/.volta/tools/image/node/22.21.1/bin/node";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (file) => hash(fs.readFileSync(file));
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function verifySourceSummary(file) {
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  const summary = lines.pop();
  assert.deepEqual(
    lines,
    projectOrderingCases.map(({ id }) => `${id} PASS`),
  );
  assert.ok(summary);
  assert.deepEqual(JSON.parse(summary), {
    SourceWholeviews: 20,
    SourceProcesses: 24,
    NativeExecutions: 0,
    newSharedCredit: 0,
  });
}
const record = (file) => ({ path: path.resolve(file), sha256: hashFile(file) });
const sourcePins = {
  "packages/code-graph/src/extract/project.ts":
    "08aa30497ce1dde9d1d8587fc5f17bfd77c47de7206222d12285db5bad5cf69a",
  "packages/code-graph/src/project.ts":
    "f1c6d3b052e733eef0334fec0ab3e19267da0c6600315aa9ed24711de53b2eaf",
  "packages/code-graph/src/extract/wrangler-config.ts":
    "2050b3506fc9e8877a94ca4fa8cf6391e9e83f0c40f06d12193ec1e22e7925be",
  "packages/code-graph/src/hexagon/read.ts":
    "02b17d4cdd6b6582163d9e2776c2f522b18b1f31ce8047b6310b8f35593fa50e",
  "packages/code-graph/src/hexagon/cli.ts":
    "a83d8afe0120789dd544743affbbe1ec9343a0167feed1dbb994cfdde86fad25",
  "packages/code-graph/src/hexagon/ports.ts":
    "7c3588e149917aacc955b6da21b2f5ea8081c906cc576ef5404ba169f50b838e",
  "packages/code-graph/src/layers/resolve-target.ts":
    "d63159a96199cee842eec8b19c2be5bde946dac32b4fc90ebcf7bcdc01392355",
  "packages/code-graph/src/schema/core.ts":
    "13d33837f3765d59c359f4c8f541bd8b665206bdc54bbbc7278d1fd7f4393ad2",
  "packages/code-graph/src/extract/assemble.ts":
    "b30d35677ccd714af2bb00c9b94374a0d7d621f2be5957f0e08a54cad829b644",
  "packages/code-graph/src/extract/edges.ts":
    "857e177da82d6bb994cfbc45154f2cdcba4fb6ba5dacc4caff2b90e86a82db2d",
  "packages/code-graph/src/syntax/file.ts":
    "c2d723cb783109b30fb504e43da5fc9361a46d387d2c11a6721266b0322a20fa",
  "packages/code-graph/src/engine/oxc.ts":
    "298285f020ecc50856adc9508b675408e61ab96c844aec46d2d3317f39dc409c",
  "packages/code-graph/src/index.ts":
    "a57a3ed8c585cafaf0c5667dad942eafd20269ca56f5ed2f305fb6bd593692b1",
  "packages/code-graph/src/cli.ts":
    "128a353027f720b3729b0d1c4c5685088cff042ddaf1a11f923cf0b80d55c2cf",
  "verification/parity/project-ordering-cases.mjs":
    "d90a23d0e37db8ef027f5971e4f71820316c8b346c51e1649a24d4972bbc253a",
  "verification/parity/project-ordering-reference.mjs":
    "48a04c3cd43e6370f243746628fe4101876d9f6427355775e16b2c8f9f4d651e",
  "verification/parity/project-ordering-source.mjs":
    "6ae69f1607073efc0293070e48b0465e7c3d4e4182a0115c15acce28a243188c",
};
const driver = "crates/code-graph/examples/project_ordering_driver.rs";
const driverSHA =
  "dc23b22050a6baf3e565a71237acfcc5221d69d0af532397321c7d79662a26a3";
const nativeWorker = "verification/parity/project-ordering-native.py";
const nativeWorkerSHA =
  "214f2cc3ee4d8468c44111e6af0026225f7e268ebc049f414720c569bbbfc382";
const historical = {
  source: "c5aaab508b0300f6a16dd12e8f42992358c439a656e2dc30e7e17570c66daa80",
  native: "78e200f41621917cfbf4e4272731d65f9e8a65faae22a1668e1fe351fae0d023",
  nativeWorker:
    "ce051e957390dda3b91b16455f2c990880bb8b493587fcbbbb400dac2c64ad5a",
};
function aliases() {
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, `${key} must be unset`);
}
function pins() {
  return Object.fromEntries(
    [...Object.keys(sourcePins), driver, nativeWorker].map((file) => [
      file,
      hashFile(path.join(root, file)),
    ]),
  );
}
function read(entry) {
  assert.ok(path.isAbsolute(entry.path));
  assert.equal(hashFile(entry.path), entry.sha256, entry.path);
  return json(entry.path);
}
function bytes(file, expected) {
  const value = fs.readFileSync(file);
  assert.equal(hash(value), expected, file);
  return value;
}
function files(view, id, source) {
  return Object.fromEntries(
    Object.entries(view).map(([file, value]) => {
      if (!Object.hasOwn(value, "readError")) return [file, value];
      assert.equal(id, "cheap-bom-unreadable");
      assert.equal(file, "locked.ts");
      assert.equal(value.mode, 0);
      assert.equal(value.bytes, 44);
      if (source) assert.equal(value.readError.code, "EACCES");
      else assert.equal(value.readError.errno, 13);
      return [file, { unreadable: true, mode: value.mode, bytes: value.bytes }];
    }),
  );
}
function sourceProcess(step, input, directory, action) {
  const proc = step.process;
  assert.equal(proc.command[0], node22);
  assert.equal(
    path.basename(proc.command[3]),
    "project-ordering-reference.mjs",
  );
  assert.equal(proc.command[1], "--import");
  assert.equal(proc.cwd, directory);
  assert.equal(proc.signal, null);
  assert.equal(proc.error, null);
  assert.equal(proc.status, action ? step.view.exitCode : 0);
  const request = JSON.parse(bytes(proc.request, proc.requestSHA256));
  assert.deepEqual(request, {
    input,
    directory,
    response: proc.response,
    ...(action ? { action } : {}),
  });
  assert.equal(proc.command[4], proc.request);
  assert.deepEqual(JSON.parse(bytes(proc.response, proc.responseSHA256)), {
    view: step.view,
    errors: step.errors,
    io: step.io,
  });
  const stdout = bytes(proc.stdout, proc.stdoutSHA256).toString("utf8");
  const stderr = bytes(proc.stderr, proc.stderrSHA256).toString("utf8");
  assert.equal(stdout, action ? step.stdout : "");
  assert.equal(stderr, action ? step.stderr : "");
}
function nativeProcess(
  proc,
  frame,
  input,
  directory,
  action,
  binary,
  sealed,
  compiler,
) {
  assert.equal(proc.cwd, directory);
  assert.equal(proc.status, action ? frame.exitCode : 0);
  assert.equal(proc.binarySha256, binary.sha256);
  assert.equal(proc.argv[0], binary.path);
  const request = JSON.parse(bytes(proc.request, proc.requestSha256));
  if (action) {
    assert.equal(proc.argv.length, 1);
    assert.deepEqual(request, {
      id: `${input.id}.${action.id}`,
      trace: proc.response,
      argv: [directory, ...action.flags],
      compiler,
      plain: true,
      lateReports: true,
      ...(action.initial === undefined ? {} : { initial: action.initial }),
    });
    assert.equal(request.id, `${input.id}.${action.id}`);
    assert.equal(request.trace, proc.response);
    assert.equal(request.plain, true);
    assert.equal(request.lateReports, true);
    assert.equal(request.initial, action.initial);
    if (sealed)
      assert.equal(
        proc.stdin,
        undefined,
        "historical parsed-request scope only",
      );
    else {
      const actual = bytes(proc.stdin, proc.stdinSha256);
      assert.equal(actual.length, proc.stdinBytes);
      assert.deepEqual(
        JSON.parse(actual),
        request,
        "actual stdin bytes and retained parsed request agree",
      );
    }
  } else {
    assert.deepEqual(proc.argv, [binary.path, proc.request]);
    assert.deepEqual(request, { input, directory });
  }
  assert.deepEqual(
    JSON.parse(bytes(proc.response, proc.responseSha256)),
    frame,
  );
  const stdout = bytes(proc.stdout, proc.stdoutSha256).toString("utf8");
  const stderr = bytes(proc.stderr, proc.stderrSha256).toString("utf8");
  if (!action) {
    assert.deepEqual(JSON.parse(stdout), frame);
    assert.equal(stderr, "");
  }
  return { stdout, stderr };
}
function producer(proof, name, binary) {
  if (!proof) return;
  assert.equal(proof.driver.target.name, name);
  assert.ok(proof.driver.target.kind.includes("example"));
  assert.ok(proof.driver.filenames.includes(proof.actualArtifact));
  assert.equal(proof.binarySha256, binary.sha256);
  assert.equal(proof.binary, binary.path);
  assert.equal(hashFile(proof.binary), binary.sha256);
  assert.equal(hashFile(proof.cargoJson), proof.cargoJsonSha256);
  assert.ok(
    fs
      .readFileSync(proof.cargoJson, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .some((row) => JSON.stringify(row) === JSON.stringify(proof.driver)),
  );
  const library = proof.libraries.demlik_code_graph;
  assert.ok(
    library?.artifact.target.kind.includes("lib") &&
      library.artifact.profile.test === false,
  );
  assert.ok(library.artifact.filenames.includes(library.path));
  assert.equal(hashFile(library.retainedPath), library.retainedSha256);
  assert.equal(
    hash(gunzipSync(fs.readFileSync(library.retainedPath))),
    library.sha256,
  );
  assert.equal(proof.source.path, proof.driver.target.src_path);
  assert.equal(hashFile(proof.source.path), proof.source.sha256);
}
export function normalizeProjectOrderingReport(raw, producers = null) {
  aliases();
  assert.equal(process.execPath, node22);
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.phases, ["source20", "native20"]);
  assert.ok(
    ["sealed-source-first", "fresh-source-first"].includes(raw.lineage),
  );
  const sealed = raw.lineage === "sealed-source-first";
  if (sealed) {
    assert.equal(raw.source.sha256, historical.source);
    assert.equal(raw.native.sha256, historical.native);
    assert.equal(raw.nativeWorkerSHA, historical.nativeWorker);
  } else {
    assert.deepEqual(raw.sourceHashesBefore, pins());
    assert.deepEqual(raw.sourceHashesAfter, raw.sourceHashesBefore);
    assert.equal(raw.nativeWorkerSHA, nativeWorkerSHA);
    assert.equal(raw.launchers.length, 2);
    for (const [index, launch] of raw.launchers.entries()) {
      assert.equal(launch.status, 0);
      assert.equal(launch.signal, null);
      assert.equal(launch.error, null);
      assert.equal(hashFile(launch.stdout.path), launch.stdout.sha256);
      assert.equal(hashFile(launch.stderr.path), launch.stderr.sha256);
      assert.equal(fs.readFileSync(launch.stderr.path, "utf8"), "");
      if (index === 0) {
        assert.deepEqual(launch.command, [
          node22,
          path.join(root, "verification/parity/project-ordering-source.mjs"),
          path.dirname(raw.source.path),
        ]);
        verifySourceSummary(launch.stdout.path);
      } else {
        assert.equal(launch.command[1], path.join(root, nativeWorker));
        const response = json(launch.stdout.path);
        assert.deepEqual(response, {
          observations: 20,
          passed: 20,
          qualified: 0,
          processCount: 24,
          failures: [],
        });
        assert.ok(
          launch.command.includes(raw.source.path) &&
            launch.command.includes(raw.native.path),
        );
      }
    }
  }
  for (const [file, expected] of Object.entries(sourcePins))
    assert.equal(hashFile(path.join(root, file)), expected);
  assert.equal(hashFile(path.join(root, driver)), driverSHA);
  assert.equal(hashFile(path.join(root, nativeWorker)), nativeWorkerSHA);
  const source = read(raw.source),
    native = read(raw.native);
  assert.deepEqual(source.engine, {
    node: "v22.21.1",
    v8: "12.4.254.21-node.33",
    icu: "77.1",
    locale: "en-US",
  });
  assert.deepEqual(source.sourceHashes, sourcePins);
  assert.deepEqual(native.sourceHashes, sourcePins);
  assert.deepEqual(native.sourceEngine, source.engine);
  assert.equal(source.complete, true);
  assert.equal(source.NativeProjectionStarted, false);
  assert.equal(source.NativeExecutions, 0);
  assert.equal(native.sourceSha256, raw.source.sha256);
  assert.equal(native.source, raw.source.path);
  assert.equal(native.complete, true);
  assert.equal(native.observations, 20);
  assert.equal(native.passed, 20);
  assert.equal(native.qualified, 0);
  assert.deepEqual(native.failures, []);
  assert.equal(native.rows.length, 20);
  assert.equal(source.rows.length, 20);
  assert.equal(source.processes.length, 24);
  assert.equal(native.processes.length, 24);
  for (const key of ["project", "cli"]) {
    assert.equal(native.binaryHashesAfter[key], native.binaries[key].sha256);
    assert.equal(
      hashFile(native.binaries[key].path),
      native.binaries[key].sha256,
    );
    producer(
      producers?.[key],
      key === "project" ? "project_ordering_driver" : "collapse_cli_driver",
      native.binaries[key],
    );
  }
  const cases = [],
    evidence = {},
    seenProcesses = [],
    sourceProcesses = [];
  for (let i = 0; i < projectOrderingCases.length; i++) {
    const input = projectOrderingCases[i],
      s = source.rows[i],
      n = native.rows[i];
    assert.equal(s.id, input.id);
    assert.equal(n.id, input.id);
    assert.deepEqual(s.input, input);
    assert.deepEqual(n.input, input);
    assert.deepEqual(n.reference, s.observation);
    assert.equal(n.passed, true);
    const calls = [];
    if (input.mode === "cli") {
      assert.equal(n.native.length, 3);
      assert.equal(s.observation.length, 3);
      for (let j = 0; j < input.actions.length; j++) {
        const action = input.actions[j],
          ss = s.observation[j],
          nn = n.native[j];
        assert.equal(ss.id, action.id);
        assert.equal(nn.id, action.id);
        sourceProcess(ss, input, s.directory, action);
        sourceProcesses.push(ss.process);
        const streams = nativeProcess(
          nn.process,
          nn.trace,
          input,
          s.directory,
          action,
          native.binaries.cli,
          sealed,
          native.binaries.compiler.path,
        );
        assert.deepEqual(ss.view, nn.view);
        assert.equal(nn.view.exitCode, nn.trace.exitCode);
        assert.equal(ss.stdout, nn.stdout);
        assert.equal(ss.stderr, nn.stderr);
        assert.deepEqual(streams, { stdout: nn.stdout, stderr: nn.stderr });
        assert.deepEqual(
          files(ss.before, input.id, true),
          files(nn.before, input.id, false),
        );
        assert.deepEqual(
          files(ss.after, input.id, true),
          files(nn.after, input.id, false),
        );
        calls.push(...nn.trace.observedCalls);
        seenProcesses.push(nn.process);
      }
    } else {
      sourceProcess(s.observation, input, s.directory, null);
      sourceProcesses.push(s.observation.process);
      const proc = native.processes.find((row) => row.id === input.id);
      assert.ok(proc);
      nativeProcess(
        proc,
        n.native,
        input,
        s.directory,
        null,
        native.binaries.project,
        sealed,
        native.binaries.compiler.path,
      );
      assert.equal(n.native.id, input.id);
      assert.deepEqual(s.observation.view, n.native.view);
      calls.push(...n.native.observedCalls);
      seenProcesses.push(proc);
    }
    const directory = path.join(
      path.dirname(raw.native.path),
      `${path.basename(raw.native.path, ".json")}.files`,
    );
    const before = json(path.join(directory, `${input.id}.before.json`));
    const after = json(path.join(directory, `${input.id}.after.json`));
    assert.deepEqual(
      files(s.before, input.id, true),
      files(before, input.id, false),
    );
    assert.deepEqual(
      files(s.after, input.id, true),
      files(after, input.id, false),
    );
    assert.ok(
      calls.length > 0 &&
        calls.every(
          (call) =>
            typeof call === "string" && call.startsWith("demlik_code_graph::"),
        ),
    );
    const nativeTrace = { observedCalls: calls };
    evidence[input.id] = nativeTrace;
    cases.push({
      id: input.id,
      input,
      passed: true,
      qualifications: [],
      nativeTrace,
    });
  }
  assert.deepEqual(seenProcesses, native.processes);
  assert.deepEqual(
    sourceProcesses.map(({ responseSHA256: _responseSHA256, ...rest }) => rest),
    source.processes,
  );
  return {
    passed: 20,
    attempted: 20,
    observations: 20,
    unqualifiedPairs: 20,
    qualifiedPairs: 0,
    rejectedInvalidInputs: 0,
    rejectedInvalidInputRows: 0,
    responseGuards: 0,
    failures: [],
    reference: source.engine,
    sourceExecutions: 24,
    nativeExecutions: 24,
    nativeEvidence: evidence,
    qualifiedNativeEvidence: {},
    cases,
    producer: producers,
    rawRecords: { source: raw.source, native: raw.native },
    binaryHashes: {
      project_ordering_driver: native.binaries.project.sha256,
      collapse_cli_driver: native.binaries.cli.sha256,
    },
    limits: [
      ...native.limits,
      ...(sealed
        ? [
            "Historical six CLI stdin byte files were not retained; parsed requests and exact original serialization source retained. No reconstructed stdin claimed original.",
          ]
        : []),
    ],
  };
}
export function projectOrderingCheckpointParity(cargo, options = {}) {
  aliases();
  assert.equal(process.execPath, node22);
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const reportFile = path.resolve(
    options.reportFile ??
      path.join(root, "target/parity/project-ordering.json"),
  );
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const proof = `${reportFile}.proof`;
  assert.ok(!fs.existsSync(proof));
  fs.mkdirSync(proof);
  assertCheckPath(proof, path.join(root, "target"));
  const before = pins(),
    phases = [],
    launchers = [];
  let result, pending, sourceFile;
  function launch(name, command) {
    const proc = spawnSync(command[0], command.slice(1), {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${path.dirname(node22)}${path.delimiter}${process.env.PATH}`,
        TMPDIR: "/private/tmp",
      },
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(proof, `${name}.stdout`), proc.stdout ?? "");
    fs.writeFileSync(path.join(proof, `${name}.stderr`), proc.stderr ?? "");
    const entry = {
      command,
      status: proc.status,
      signal: proc.signal,
      error: proc.error?.message ?? null,
      stdout: record(path.join(proof, `${name}.stdout`)),
      stderr: record(path.join(proof, `${name}.stderr`)),
    };
    launchers.push(entry);
    fs.writeFileSync(
      path.join(proof, `${name}.process.json`),
      `${JSON.stringify(entry, null, 2)}\n`,
    );
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(proc.signal, null);
    assert.ifError(proc.error);
  }
  try {
    const sourceDirectory = path.join(proof, "source");
    fs.mkdirSync(sourceDirectory);
    launch("source20", [
      node22,
      path.join(root, "verification/parity/project-ordering-source.mjs"),
      sourceDirectory,
    ]);
    sourceFile = path.join(sourceDirectory, "source-first.json");
    phases.push("source20");
    let projectProducer = null,
      cliProducer = null,
      binary,
      cliBinary;
    if (options.binary) binary = path.resolve(options.binary);
    else {
      projectProducer = buildExample(
        cargo,
        "demlik-code-graph",
        "project_ordering_driver",
        `${reportFile}.project`,
      );
      binary = projectProducer.binary;
    }
    if (options.cliBinary) cliBinary = path.resolve(options.cliBinary);
    else if (options.binary)
      cliBinary = path.join(path.dirname(binary), "collapse_cli_driver");
    else {
      cliProducer = buildExample(
        cargo,
        "demlik-code-graph",
        "collapse_cli_driver",
        `${reportFile}.cli`,
      );
      cliBinary = cliProducer.binary;
    }
    const compiler = fs.realpathSync(
      path.join(
        fs.realpathSync(
          path.join(
            root,
            "packages/code-graph/node_modules/@typescript/native-preview",
          ),
        ),
        "../native-preview-darwin-arm64/lib/tsgo",
      ),
    );
    const output = `${reportFile}.native.raw.json`;
    launch("native20", [
      process.env.DEMLIK_ICU77_PYTHON ?? "python3",
      path.join(root, nativeWorker),
      "--source",
      sourceFile,
      "--binary",
      binary,
      "--cli-binary",
      cliBinary,
      "--compiler",
      compiler,
      "--output",
      output,
    ]);
    phases.push("native20");
    const raw = {
      version: 1,
      lineage: "fresh-source-first",
      phases,
      source: record(sourceFile),
      native: record(output),
      nativeWorkerSHA,
      sourceHashesBefore: before,
      sourceHashesAfter: pins(),
      launchers,
    };
    fs.writeFileSync(
      `${reportFile}.raw.json`,
      `${JSON.stringify(raw, null, 2)}\n`,
    );
    result = normalizeProjectOrderingReport(
      raw,
      projectProducer || cliProducer
        ? { project: projectProducer, cli: cliProducer }
        : null,
    );
    fs.writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    pending = error;
  } finally {
    const beforeFile = path.join(proof, "source/source-before.json");
    if (fs.existsSync(beforeFile)) {
      const runtime = json(beforeFile).runtime;
      assert.ok(
        path.dirname(runtime) === "/private/tmp" &&
          path.basename(runtime).startsWith("demlik-project-source-"),
      );
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  }
  if (pending) throw pending;
  return result;
}
