import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  checkEvidenceDirectory,
  compiledCheckLibrary,
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";
import { buildTeaExample, buildTeaTest } from "./tea-example.mjs";
import { typedReducerControls } from "./typed-reducer-controls.mjs";
import { typedReducerInterfaceProbes } from "./typed-reducer-interface-probes.mjs";
import { typedReducerParity } from "./typed-reducer-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const owners = [
  ...new Set([
    ...typedReducerControls.map((control) => control.file),
    "crates/tea/tests/typed_reducer.rs",
    "crates/tea/tests/typed_reducer_runtime.rs",
    "crates/tea/tests/typed_reducer_lifecycle.rs",
    "crates/tea/examples/typed_reducer_driver.rs",
    "crates/tea/examples/typed_reducer/actor.rs",
    "crates/tea/examples/typed_reducer/pure.rs",
  ]),
];
const inputs = [
  ...owners,
  "verification/parity/check-worktree.mjs",
  "verification/parity/tea-example.mjs",
  "verification/parity/typed-reducer-checks-run.mjs",
  "verification/parity/typed-reducer-controls.mjs",
  "verification/parity/typed-reducer-interface-probes.mjs",
  "verification/parity/typed-reducer-interface-types/wrong_error.rs",
  "verification/parity/typed-reducer-interface-types/borrowed_actor_error.rs",
  "verification/parity/typed-reducer-cases.mjs",
  "verification/parity/typed-reducer-run.mjs",
  "verification/parity/typed-reducer-reference.mts",
  "verification/parity/typed-reducer-actor-reference.mts",
  "packages/tea/src/pure/core.ts",
  "packages/tea/src/internal/engine/loop.ts",
  "packages/tea/src/promise/run.ts",
  "packages/tea/src/effect/run.ts",
];
const nativeTargets = [
  { name: "typed_reducer", count: 2 },
  { name: "typed_reducer_runtime", count: 2 },
  { name: "typed_reducer_lifecycle", count: 6 },
];
function environment() {
  return cargoCheckEnvironment({
    CARGO_NET_OFFLINE: "true",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "1",
  });
}
function failure(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    stack: error.stack,
    stdout: error.stdout?.toString(),
    stderr: error.stderr?.toString(),
  };
}
function externalProof(check, directory) {
  assert.equal(fs.realpathSync(check.root), fs.realpathSync(root));
  assert.equal(
    path.resolve(check.target),
    path.join(path.resolve(check.root), "target"),
  );
  const relative = path.relative(check.root, path.resolve(directory));
  assert(
    relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative),
    "proof must outlive the check",
  );
  fs.mkdirSync(directory, { recursive: true });
}
function ownerTest(check, binary, count, output) {
  const run = spawnSync(binary, [], {
    cwd: check.root,
    env: environment(),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const result = {
    command: [binary],
    exit: run.status,
    signal: run.signal,
    error: run.error?.message,
    stdout: run.stdout,
    stderr: run.stderr,
  };
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  assert.equal(run.error, undefined);
  assert.equal(run.signal, null);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(
    run.stdout,
    new RegExp(`test result: ok\\. ${count} passed; 0 failed`),
  );
  return {
    count,
    output,
    binary: { path: binary, sha256: hash(fs.readFileSync(binary)) },
  };
}
function logicalBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .reduce((sum, entry) => {
      const file = path.join(directory, entry.name);
      return (
        sum +
        (entry.isDirectory()
          ? logicalBytes(file)
          : entry.isFile()
            ? fs.statSync(file).size
            : 0)
      );
    }, 0);
}
export async function typedReducerMutations({
  check,
  binary,
  ownerBinary,
  directory,
  only,
}) {
  externalProof(check, directory);
  assert(
    binary && ownerBinary,
    "immutable driver and lifecycle baselines required",
  );
  const originals = Object.fromEntries(
    owners.map((file) => [
      file,
      fs.readFileSync(path.join(check.root, file), "utf8"),
    ]),
  );
  const originalHashes = Object.fromEntries(
    Object.entries(originals).map(([file, text]) => [file, hash(text)]),
  );
  const binaryHashes = {
    driver: hash(fs.readFileSync(binary)),
    owner: hash(fs.readFileSync(ownerBinary)),
  };
  const controls = typedReducerControls.filter(
    (control) => !only || only.includes(control.id),
  );
  assert(controls.length);
  if (only) assert.equal(controls.length, new Set(only).size);
  for (const control of controls) {
    let text = originals[control.file];
    for (const [before, after] of control.patches) {
      assert.equal(
        text.split(before).length,
        2,
        `${control.id}: unique mutation needle`,
      );
      text = text.replace(before, after);
    }
  }
  const results = [];
  const reportFile = path.join(directory, "report.json");
  const state = {
    complete: false,
    semanticPairs: 0,
    controls: results,
    planned: controls.length,
    sourceHashes: originalHashes,
    check: { root: check.root, target: check.target, cargoDefaultTarget: true },
    resourceSamples: [],
  };
  const save = (extra = {}) => {
    Object.assign(state, extra);
    fs.writeFileSync(reportFile, `${JSON.stringify(state, null, 2)}\n`);
  };
  let attempt = { phase: "baseline" };
  try {
    const baseline = await typedReducerParity({
      binary,
      reportFile: path.join(directory, "full94-baseline.json"),
      quiet: true,
    });
    assert.equal(baseline.cases, 94);
    assert.equal(baseline.passed, 94);
    assert.equal(baseline.protocolRefusals, 4);
    assert.deepEqual(baseline.failures, []);
    const native = ownerTest(
      check,
      ownerBinary,
      6,
      path.join(directory, "owner-baseline.json"),
    );
    save({
      baseline: { cases: 94, protocolRefusals: 4, native, binaryHashes },
    });
    for (const control of controls) {
      for (const [file, text] of Object.entries(originals))
        fs.writeFileSync(path.join(check.root, file), text);
      for (const [file, digest] of Object.entries(originalHashes))
        assert.equal(
          hash(fs.readFileSync(path.join(check.root, file))),
          digest,
        );
      let mutated = originals[control.file];
      for (const [before, after] of control.patches)
        mutated = mutated.replace(before, after);
      fs.writeFileSync(path.join(check.root, control.file), mutated);
      const controlDir = path.join(directory, control.id);
      fs.mkdirSync(controlDir, { recursive: true });
      fs.writeFileSync(path.join(controlDir, "mutated.rs"), mutated);
      const args = control.test
        ? ["test", "--no-run", "--test", "typed_reducer_lifecycle"]
        : ["build", "--example", "typed_reducer_driver"];
      const command = [
        ...args,
        "--locked",
        "--offline",
        "--message-format=json",
        "-p",
        "demlik-tea",
      ];
      attempt = {
        id: control.id,
        phase: "compile",
        owner: control.file,
        originalSha256: originalHashes[control.file],
        mutantSha256: hash(mutated),
        command,
      };
      const build = spawnSync(process.env.CARGO ?? "cargo", command, {
        cwd: check.root,
        env: environment(),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 240_000,
      });
      fs.writeFileSync(
        path.join(controlDir, "cargo.jsonl"),
        build.stdout ?? "",
      );
      fs.writeFileSync(
        path.join(controlDir, "compile.log"),
        build.stderr ?? "",
      );
      attempt.build = {
        exit: build.status,
        signal: build.signal,
        error: build.error?.message,
        cargoJson: path.join(controlDir, "cargo.jsonl"),
        stderr: path.join(controlDir, "compile.log"),
      };
      state.resourceSamples.push({
        id: control.id,
        logicalTargetBytes: logicalBytes(check.target),
      });
      save({ attempt });
      assert.equal(build.error, undefined);
      assert.equal(build.signal, null);
      assert.equal(
        build.status,
        0,
        `${control.id}: compilation refusal is not detection; inspect ${attempt.build.cargoJson}`,
      );
      const rows = build.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const library = compiledCheckLibrary(
        rows,
        "demlik_tea",
        check.root,
        check.target,
      );
      const name = control.test
        ? "typed_reducer_lifecycle"
        : "typed_reducer_driver";
      const selected = rows.filter(
        (row) =>
          row.reason === "compiler-artifact" &&
          row.target.name === name &&
          row.executable,
      );
      assert.equal(selected.length, 1);
      const artifact = selected[0];
      assert.equal(artifact.fresh, false);
      assertCheckPath(artifact.target.src_path, check.root);
      assertCheckPath(artifact.manifest_path, check.root);
      const actual = assertCheckPath(artifact.executable, check.target);
      const sha256 = hash(fs.readFileSync(actual));
      const executed = path.join(controlDir, `${sha256}.bin`);
      fs.copyFileSync(actual, executed);
      attempt.phase = "execute";
      save({ attempt });
      let witness;
      if (control.test) {
        const args = [control.test, "--exact", "--nocapture"];
        const run = spawnSync(executed, args, {
          cwd: check.root,
          env: environment(),
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        const processResult = {
          command: [executed, ...args],
          exit: run.status,
          signal: run.signal,
          error: run.error?.message,
          stdout: run.stdout,
          stderr: run.stderr,
        };
        fs.writeFileSync(
          path.join(controlDir, "native.json"),
          `${JSON.stringify(processResult, null, 2)}\n`,
        );
        const text = `${run.stdout}\n${run.stderr}`;
        assert.equal(run.error, undefined);
        assert.equal(run.signal, null);
        assert.equal(
          run.status,
          101,
          `${control.id}: intended native assertion required`,
        );
        assert(run.stdout.includes(`test ${control.test} ... FAILED`));
        assert(text.includes(control.assertion));
        witness = {
          kind: "native-owner-law",
          test: control.test,
          assertion: control.assertion,
          process: processResult,
        };
      } else {
        const paired = await typedReducerParity({
          binary: executed,
          caseIds: control.cases,
          reportFile: path.join(controlDir, "pairs.json"),
          quiet: true,
        });
        assert(
          paired.failures.length > 0,
          `${control.id}: compiled regression escaped`,
        );
        assert(
          paired.failures.some((failure) => control.cases.includes(failure.id)),
        );
        for (const failure of paired.failures) {
          assert(control.cases.includes(failure.id));
          assert.equal(failure.source.ok, true);
          assert.equal(failure.native.ok, true);
          assert.equal(paired.nativeEvidence[failure.id], undefined);
        }
        witness = {
          kind: "source-native-semantic",
          declared: control.cases,
          detected: paired.failures.map((failure) => failure.id),
          report: paired.reportFile,
        };
      }
      assert.equal(hash(fs.readFileSync(executed)), sha256);
      results.push({
        ...control,
        compiled: true,
        detected: true,
        command,
        build: attempt.build,
        sourceSha256: originalHashes[control.file],
        mutantSha256: hash(mutated),
        binary: executed,
        sha256,
        actualArtifact: actual,
        executableArtifact: artifact,
        library: {
          path: library.path,
          observedSha256: hash(fs.readFileSync(library.path)),
          artifact: library.artifact,
          retained: false,
        },
        witness,
      });
      save({ attempt: { phase: "between-controls" } });
    }
  } catch (error) {
    save({
      complete: false,
      incomplete: true,
      attempt,
      processingFailure: failure(error),
    });
    throw error;
  } finally {
    for (const [file, text] of Object.entries(originals))
      fs.writeFileSync(path.join(check.root, file), text);
    const sourceUnchanged = Object.entries(originalHashes).every(
      ([file, digest]) =>
        hash(fs.readFileSync(path.join(check.root, file))) === digest,
    );
    const baselineArtifactsUnchanged =
      hash(fs.readFileSync(binary)) === binaryHashes.driver &&
      hash(fs.readFileSync(ownerBinary)) === binaryHashes.owner;
    save({
      activeSourceUnchanged: sourceUnchanged,
      baselineArtifactsUnchanged,
      ownersRestored: true,
    });
    assert(sourceUnchanged && baselineArtifactsUnchanged);
  }
  save({
    complete: true,
    incomplete: false,
    detected: results.length,
    escaped: 0,
    sourceNativeControls: results.filter((result) => !result.test).length,
    nativeOwnerControls: results.filter((result) => result.test).length,
  });
  return { ...state, reportFile };
}
export async function typedReducerSuiteInCheck({
  check,
  directory,
  binary,
  ownerBinary,
}) {
  externalProof(check, directory);
  const built = buildTeaExample(
    process.env.CARGO ?? "cargo",
    "typed_reducer_driver",
    path.join(directory, "baseline-driver"),
  );
  const events = fs
    .readFileSync(built.cargoJson, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const library = compiledCheckLibrary(
    events,
    "demlik_tea",
    check.root,
    check.target,
  );
  assertCheckPath(built.actualArtifact, check.target);
  const driver = events.filter(
    (row) =>
      row.reason === "compiler-artifact" &&
      row.target.name === "typed_reducer_driver" &&
      row.executable,
  );
  assert.equal(driver.length, 1);
  assert.equal(driver[0].fresh, false);
  assertCheckPath(driver[0].target.src_path, check.root);
  assertCheckPath(driver[0].manifest_path, check.root);
  const savedLibrary = path.join(
    directory,
    `libdemlik_tea-${hash(fs.readFileSync(library.path))}.rlib`,
  );
  fs.copyFileSync(library.path, savedLibrary);
  const natives = [];
  for (const target of nativeTargets) {
    const produced = buildTeaTest(
      process.env.CARGO ?? "cargo",
      target.name,
      path.join(directory, target.name),
    );
    const rows = fs
      .readFileSync(produced.cargoJson, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const selected = rows.filter(
      (row) =>
        row.reason === "compiler-artifact" &&
        row.target.name === target.name &&
        row.executable,
    );
    assert.equal(selected.length, 1);
    assert.equal(selected[0].fresh, false);
    assertCheckPath(selected[0].target.src_path, check.root);
    assertCheckPath(selected[0].manifest_path, check.root);
    assertCheckPath(produced.actualArtifact, check.target);
    natives.push({ ...target, produced, artifact: selected[0] });
  }
  const external = {};
  for (const [key, supplied] of [
    ["driver", binary],
    ["owner", ownerBinary],
  ]) {
    if (!supplied) continue;
    const sha256 = hash(fs.readFileSync(supplied));
    const saved = path.join(directory, `external-${key}-${sha256}.bin`);
    fs.copyFileSync(supplied, saved);
    external[key] = {
      originalPath: supplied,
      path: saved,
      sha256,
      qualification:
        "Externally supplied baseline; no new Cargo-producer claim.",
    };
  }
  const owner = natives.find(
    (target) => target.name === "typed_reducer_lifecycle",
  );
  const baseline = {
    driver: external.driver?.path ?? built.binary,
    owner: external.owner?.path ?? owner.produced.binary,
  };
  const nativeResults = natives
    .filter((target) => target.name !== "typed_reducer_lifecycle")
    .map((target) =>
      ownerTest(
        check,
        target.produced.binary,
        target.count,
        path.join(directory, `${target.name}.execution.json`),
      ),
    );
  const typeProof = typedReducerInterfaceProbes({
    check,
    library: savedLibrary,
    dependencies: path.dirname(library.path),
    directory: path.join(directory, "types"),
  });
  const baselineBuild = {
    driver: built,
    natives,
    external,
    library: {
      path: savedLibrary,
      sha256: hash(fs.readFileSync(savedLibrary)),
      actualArtifact: library.path,
      artifact: library.artifact,
    },
    selected: baseline,
    nativeResults,
    typeProof,
  };
  fs.writeFileSync(
    path.join(directory, "baseline-build.json"),
    `${JSON.stringify(baselineBuild, null, 2)}\n`,
  );
  const controls = await typedReducerMutations({
    check,
    binary: baseline.driver,
    ownerBinary: baseline.owner,
    directory: path.join(directory, "controls"),
  });
  assert.equal(controls.detected, 16);
  assert.equal(controls.sourceNativeControls, 12);
  assert.equal(controls.nativeOwnerControls, 4);
  assert.equal(
    hash(fs.readFileSync(savedLibrary)),
    baselineBuild.library.sha256,
  );
  const report = {
    complete: true,
    baselineBuild: path.join(directory, "baseline-build.json"),
    sharedCases: 94,
    protocolRefusals: 4,
    nativeTestFunctions: 10,
    typeRefusals: 2,
    controls: 16,
    controlsReport: controls.reportFile,
    sampledLogicalTargetBytes: logicalBytes(check.target),
    semanticPairsAdded: 0,
  };
  fs.writeFileSync(
    path.join(directory, "suite.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
export async function typedReducerChecks(options = {}) {
  const scope = JSON.parse(
    fs.readFileSync(new URL("./scope.json", import.meta.url), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const base =
    options.directory ?? checkEvidenceDirectory(root, "typed-reducer");
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(path.resolve(base), "suite-"));
  const before = Object.fromEntries(
    inputs.map((file) => [file, hash(fs.readFileSync(path.join(root, file)))]),
  );
  const report = {
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceHashes: before,
    directory,
    complete: false,
    semanticPairsAdded: 0,
    runtime: { node: process.version, v8: process.versions.v8 },
    profile: { defaultTarget: true, cacheCopies: false },
  };
  const started = performance.now();
  let check;
  let operationError;
  let cleanupError;
  try {
    check = createCheckWorktree(root, "typed-reducer", directory);
    report.check = { root: check.root, target: check.target };
    for (const [file, digest] of Object.entries(before))
      assert.equal(
        hash(fs.readFileSync(path.join(check.root, file))),
        digest,
        `${file}: committed check input`,
      );
    for (const name of [
      "node_modules",
      "packages/tea/node_modules",
      "verification/parity/node_modules",
    ])
      fs.symlinkSync(
        fs.realpathSync(path.join(root, name)),
        path.join(check.root, name),
        "dir",
      );
    fs.mkdirSync(check.target, { recursive: true });
    const input = {
      check: { root: check.root, target: check.target },
      directory,
      binary: options.binary && path.resolve(options.binary),
      ownerBinary: options.ownerBinary && path.resolve(options.ownerBinary),
    };
    const bootstrap = `import { typedReducerSuiteInCheck } from ${JSON.stringify(pathToFileURL(path.join(check.root, "verification/parity/typed-reducer-checks-run.mjs")).href)};\nawait typedReducerSuiteInCheck(${JSON.stringify(input)});\n`;
    const bootstrapFile = path.join(check.target, "typed-reducer-suite.mjs");
    fs.writeFileSync(bootstrapFile, bootstrap);
    fs.writeFileSync(path.join(directory, "bootstrap.mjs"), bootstrap);
    const child = spawnSync(process.execPath, [bootstrapFile], {
      cwd: check.root,
      env: environment(),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    report.process = {
      command: [process.execPath, bootstrapFile],
      exit: child.status,
      signal: child.signal,
      error: child.error?.message,
      stdout: child.stdout,
      stderr: child.stderr,
    };
    fs.writeFileSync(
      path.join(directory, "process.json"),
      `${JSON.stringify(report.process, null, 2)}\n`,
    );
    report.sampledLogicalTargetBytes = logicalBytes(check.target);
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    report.suite = JSON.parse(
      fs.readFileSync(path.join(directory, "suite.json"), "utf8"),
    );
    report.complete = true;
  } catch (error) {
    operationError = error;
    report.processingFailure = failure(error);
  } finally {
    try {
      check?.remove();
    } catch (error) {
      cleanupError = error;
      report.cleanupFailure = failure(error);
    }
    report.elapsedMs = performance.now() - started;
    report.sourceUnchanged = Object.entries(before).every(
      ([file, digest]) =>
        hash(fs.readFileSync(path.join(root, file))) === digest,
    );
    report.worktreeRemoved = check ? !fs.existsSync(check.root) : true;
    report.defaultTargetRemoved = check ? !fs.existsSync(check.target) : true;
    report.complete &&=
      !cleanupError &&
      report.sourceUnchanged &&
      report.worktreeRemoved &&
      report.defaultTargetRemoved;
    fs.writeFileSync(
      path.join(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  if (operationError || cleanupError)
    throw new AggregateError(
      [operationError, cleanupError].filter(Boolean),
      `Typed-reducer suite failed: ${directory}`,
    );
  assert.equal(report.complete, true);
  return { ...report, reportFile: path.join(directory, "report.json") };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { parseArgs } = await import("node:util");
  const { values } = parseArgs({
    options: { binary: { type: "string" }, "owner-binary": { type: "string" } },
    strict: true,
  });
  const report = await typedReducerChecks({
    binary: values.binary,
    ownerBinary: values["owner-binary"],
  });
  console.log(
    JSON.stringify({
      reportFile: report.reportFile,
      ...report.suite,
      worktreeRemoved: report.worktreeRemoved,
    }),
  );
}
