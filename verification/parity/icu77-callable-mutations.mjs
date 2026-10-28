import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const [baseline, baselineReport, sourceArchive, output] = process.argv.slice(2);
assert.equal(process.argv.length, 6);
assert.equal(process.version, "v22.21.1");
assert.equal(fs.realpathSync(os.tmpdir()), "/private/tmp");
const root = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const evidence = path.resolve(output);
fs.mkdirSync(evidence, { recursive: true });

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const faults = [
  {
    id: "function-name-before-line",
    owner: "crates/code-graph/src/extract/functions.rs",
    needle:
      ".then(left.0.start_line.cmp(&right.0.start_line))\n            .then_with(|| collation.compare(&left.2, &right.2))",
    fault:
      ".then_with(|| collation.compare(&left.2, &right.2))\n            .then(left.0.start_line.cmp(&right.0.start_line))",
    witness: "syntax-line-before-name",
  },
  {
    id: "drop-duplicate-call-constant-union",
    owner: "crates/code-graph/src/extract/edges.rs",
    needle: ".chain(site.const_args)",
    fault: ".chain(site.const_args.into_iter().take(0))",
    witness: "edge-merge-constant-union",
  },
  {
    id: "omit-forwarded-factory-implementation",
    owner: "crates/code-graph/src/extract/callee/factory.rs",
    needle: "Ok(ids.into_iter().map(|(id, _)| id).collect())",
    fault: "Ok(ids.into_iter().take(1).map(|(id, _)| id).collect())",
    witness: "factory-forward-multiple-originals",
  },
  {
    id: "lossy-classification-evidence-key",
    owner: "crates/code-graph/src/kinds/classify.rs",
    needle: "CollationInput::from_utf16(value.units())",
    fault: "CollationInput::from_text(&value.to_lossy())",
    witness: "classify-entry-raw-context",
  },
];
const original = Object.fromEntries(
  [...new Set(faults.map((f) => f.owner))].map((file) => [
    file,
    fs.readFileSync(path.join(root, file), "utf8"),
  ]),
);
for (const fault of faults)
  assert.equal(original[fault.owner].split(fault.needle).length, 2, fault.id);
assert.ok(fs.statSync(sourceArchive).isFile());
assert.ok(fs.statSync(process.env.DEMLIK_ICU77_PYTHON).isFile());
const trusted = JSON.parse(fs.readFileSync(baselineReport, "utf8"));
const baselineHash = hash(fs.readFileSync(baseline));
assert.equal(trusted.rustBinarySha256, baselineHash);
assert.deepEqual(trusted.failures, []);
assert.equal(trusted.passed, 19);
assert.equal(trusted.unqualifiedPairs, 19);
assert.equal(trusted.qualifiedPairs, 0);
assert.equal(trusted.rejectedInvalidInputs, 5);
const report = {
  sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim(),
  baseline: { path: baseline, sha256: baselineHash, report: baselineReport },
  planned: 4,
  cargoSelections: 0,
  nativePreparations: 0,
  controls: [],
  complete: false,
};
let check, runtime, operationError, cleanupError;
const save = () =>
  fs.writeFileSync(
    path.join(evidence, "controls.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
function invoke(name, program, args, cwd, env) {
  const began = Date.now();
  const child = spawnSync(program, args, { cwd, env, maxBuffer: 128 << 20 });
  fs.writeFileSync(path.join(evidence, `${name}.stdout`), child.stdout ?? "");
  fs.writeFileSync(path.join(evidence, `${name}.stderr`), child.stderr ?? "");
  const answer = {
    argv: [program, ...args],
    cwd,
    environment: Object.fromEntries(
      [
        "PATH",
        "RUSTUP_HOME",
        "CARGO_HOME",
        "RUSTUP_TOOLCHAIN",
        "CARGO_NET_OFFLINE",
        "CARGO_BUILD_JOBS",
        "CARGO_INCREMENTAL",
        "CARGO_PROFILE_DEV_DEBUG",
        "CARGO_PROFILE_TEST_DEBUG",
        "LANG",
        "LC_ALL",
        "TZ",
        "TMPDIR",
        "DEMLIK_ICU77_PYTHON",
        "RUST_ICU_MAJOR_VERSION_NUMBER",
        "RUST_ICU_LINK_SEARCH_DIR",
        "DEMLIK_ICU77_PREPARED",
        "DEMLIK_E_CASES",
        "DEMLIK_MUTATION_ALLOW_FAILURES",
      ]
        .filter((key) => env[key] !== undefined)
        .map((key) => [key, env[key]]),
    ),
    exit: child.status,
    signal: child.signal,
    error: child.error?.message,
    milliseconds: Date.now() - began,
    stdout: `${name}.stdout`,
    stderr: `${name}.stderr`,
  };
  fs.writeFileSync(
    path.join(evidence, `${name}.json`),
    `${JSON.stringify(answer, null, 2)}\n`,
  );
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  return {
    ...answer,
    text: child.stdout?.toString("utf8") ?? "",
    stderrText: child.stderr?.toString("utf8") ?? "",
  };
}
function retain(file, name) {
  const bytes = fs.readFileSync(file),
    retained = `${name}.gz`,
    packed = gzipSync(bytes);
  fs.writeFileSync(path.join(evidence, retained), packed);
  return {
    path: file,
    bytes: bytes.length,
    sha256: hash(bytes),
    retained,
    gzipSha256: hash(packed),
  };
}
function restore() {
  for (const [file, text] of Object.entries(original))
    fs.writeFileSync(path.join(check.root, file), text);
  assert.ok(
    Object.entries(original).every(
      ([file, text]) =>
        fs.readFileSync(path.join(check.root, file), "utf8") === text,
    ),
  );
}
try {
  check = createCheckWorktree(root, "icu77-callable-controls", evidence);
  runtime = path.join(path.dirname(check.root), "runtime");
  fs.mkdirSync(runtime);
  fs.mkdirSync(path.join(check.target, "tmp"), { recursive: true });
  for (const dir of [
    "node_modules",
    "packages/code-graph/node_modules",
    "packages/tea/node_modules",
    "verification/parity/node_modules",
  ]) {
    const from = path.join(root, dir);
    if (fs.existsSync(from))
      fs.symlinkSync(fs.realpathSync(from), path.join(check.root, dir));
  }
  const environment = cargoCheckEnvironment({
    PATH: process.env.PATH,
    RUSTUP_HOME: process.env.RUSTUP_HOME,
    CARGO_HOME: process.env.CARGO_HOME,
    RUSTUP_TOOLCHAIN: "stable",
    CARGO_NET_OFFLINE: "true",
    CARGO_BUILD_JOBS: "1",
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    TMPDIR: path.join(check.target, "tmp"),
    DEMLIK_ICU77_PYTHON: process.env.DEMLIK_ICU77_PYTHON,
    RUST_ICU_MAJOR_VERSION_NUMBER: "77",
    RUST_ICU_LINK_SEARCH_DIR: path.join(check.target, "icu77/install/lib"),
    DEMLIK_ICU77_PREPARED: path.join(check.target, "icu77/prepared.json"),
  });
  for (const name of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(environment[name], undefined);
  const prepare = invoke(
    "native-prepare",
    environment.DEMLIK_ICU77_PYTHON,
    [
      "tools/icu77/prepare.py",
      "prepare",
      "--host",
      "aarch64-apple-darwin",
      "--target",
      "aarch64-apple-darwin",
      "--source-archive",
      path.resolve(sourceArchive),
    ],
    check.root,
    environment,
  );
  report.nativePreparations++;
  save();
  assert.equal(prepare.exit, 0, "preparation failure earns no credit");
  fs.copyFileSync(
    environment.DEMLIK_ICU77_PREPARED,
    path.join(evidence, "native-prepared.json"),
  );
  for (const fault of faults) {
    restore();
    const modified = original[fault.owner].replace(fault.needle, fault.fault);
    fs.writeFileSync(path.join(check.root, fault.owner), modified);
    fs.writeFileSync(path.join(evidence, `${fault.id}.rs`), modified);
    const build = invoke(
      `${fault.id}-cargo`,
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--lib",
        "--example",
        "icu77_callable_driver",
        "--message-format=json",
      ],
      check.root,
      environment,
    );
    report.cargoSelections++;
    save();
    assert.equal(build.exit, 0, "compilation failure earns no semantic credit");
    const events = build.text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const library = compiledCheckLibrary(
      events,
      "demlik_code_graph",
      check.root,
      check.target,
    );
    const consumers = events.filter(
      (row) =>
        row.reason === "compiler-artifact" &&
        row.executable &&
        row.target.name === "icu77_callable_driver" &&
        !row.profile.test,
    );
    assert.equal(consumers.length, 1);
    const consumer = consumers[0];
    assert.equal(consumer.fresh, false);
    const executable = assertCheckPath(consumer.executable, check.target);
    const retainedLibrary = retain(library.path, `${fault.id}-library`),
      retainedConsumer = retain(executable, `${fault.id}-executed`);
    const runtimeEnvironment = cargoCheckEnvironment({
      ...environment,
      TMPDIR: runtime,
      DEMLIK_E_CASES: fault.witness,
      DEMLIK_MUTATION_ALLOW_FAILURES: "1",
    });
    delete runtimeEnvironment.RUST_ICU_LINK_SEARCH_DIR;
    delete runtimeEnvironment.DEMLIK_ICU77_PREPARED;
    delete runtimeEnvironment.DEMLIK_ICU77_PYTHON;
    const pairs = path.join(evidence, `${fault.id}-pairs.json`);
    const run = invoke(
      `${fault.id}-run`,
      process.execPath,
      [
        "--import",
        fs.realpathSync(
          path.join(
            check.root,
            "verification/parity/node_modules/tsx/dist/loader.mjs",
          ),
        ),
        path.join(check.root, "verification/parity/icu77-callable-graph.mjs"),
        executable,
        pairs,
      ],
      check.root,
      runtimeEnvironment,
    );
    assert.equal(run.exit, 0);
    const observed = JSON.parse(fs.readFileSync(pairs, "utf8"));
    assert.equal(observed.rustBinarySha256, retainedConsumer.sha256);
    assert.deepEqual(
      observed.reference.sourceHashes,
      trusted.reference.sourceHashes,
    );
    assert.equal(observed.attempted, 1);
    assert.equal(observed.rejectedInvalidInputs, 0);
    assert.deepEqual(
      observed.cases.map((row) => row.id),
      [fault.witness],
    );
    const witness = observed.cases[0],
      baselineWitness = trusted.cases.find((row) => row.id === fault.witness);
    assert.equal(baselineWitness.passed, true);
    assert.deepEqual(baselineWitness.qualifications, []);
    assert.equal(witness.process.status, 0);
    assert.equal(witness.process.signal, null);
    assert.equal(witness.process.stderr, "");
    assert.equal(witness.actual.ok, true);
    assert.equal(witness.passed, false);
    assert.deepEqual(witness.qualifications, []);
    assert.ok(witness.nativeTrace.observedCalls.length);
    assert.deepEqual(witness.input, baselineWitness.input);
    assert.deepEqual(witness.expected, baselineWitness.expected);
    assert.ok(observed.failures.some((row) => row.id === fault.witness));
    const observation = {
      nativeOnly: false,
      protocolValid: true,
      strictSemanticMismatch: true,
      comparison: pairs,
    };
    report.controls.push({
      id: fault.id,
      owner: fault.owner,
      sourceSha256: hash(modified),
      witness: fault.witness,
      compileExit: 0,
      library: { event: library.artifact, retained: retainedLibrary },
      consumer,
      executed: retainedConsumer,
      observation,
    });
    assert.equal(hash(fs.readFileSync(baseline)), baselineHash);
    save();
    console.log(
      JSON.stringify({
        id: fault.id,
        valid: true,
        nativeOnly: false,
      }),
    );
  }
  assert.equal(report.cargoSelections, 4);
  assert.equal(report.controls.length, 4);
  report.complete = true;
} catch (error) {
  operationError = error;
  report.operationFailure = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
} finally {
  if (check) {
    restore();
    report.checkOwnersRestored = true;
    const logs = path.join(check.target, "icu77/logs");
    if (fs.existsSync(logs)) {
      fs.mkdirSync(path.join(evidence, "native-logs"), { recursive: true });
      for (const file of fs.readdirSync(logs)) {
        const from = path.join(logs, file);
        if (fs.statSync(from).isFile())
          fs.writeFileSync(
            path.join(evidence, "native-logs", `${file}.gz`),
            gzipSync(fs.readFileSync(from)),
          );
      }
    }
    fs.rmSync(runtime, { recursive: true, force: true });
    try {
      check.remove();
    } catch (error) {
      cleanupError = error;
      report.cleanupFailure = String(error);
    }
  }
  report.worktreeRemoved = !check || !fs.existsSync(check.root);
  report.defaultTargetRemoved = !check || !fs.existsSync(check.target);
  report.originalOwnersUnchanged = Object.entries(original).every(
    ([file, text]) => fs.readFileSync(path.join(root, file), "utf8") === text,
  );
  report.baselineUnchanged = hash(fs.readFileSync(baseline)) === baselineHash;
  report.complete &&=
    !operationError &&
    !cleanupError &&
    report.worktreeRemoved &&
    report.defaultTargetRemoved &&
    report.originalOwnersUnchanged &&
    report.baselineUnchanged;
  save();
}
if (operationError || cleanupError)
  throw new AggregateError(
    [operationError, cleanupError].filter(Boolean),
    "callable graph controls failed",
  );
