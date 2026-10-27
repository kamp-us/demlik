import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const [baseline, baselineReport, sourceArchive, output] = process.argv.slice(2);
assert.ok(baseline && baselineReport && sourceArchive && output);
assert.equal(process.version, "v22.21.1");
const root = fileURLToPath(new URL("../..", import.meta.url));
const evidence = path.resolve(output);
fs.mkdirSync(evidence, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const collation = "crates/code-graph/src/project/collation.rs";
const ledger = "crates/code-graph/src/unreachable/ledger.rs";
const gate = "crates/code-graph/src/unreachable/gate.rs";
const faults = [
  {
    id: "lossy-utf16",
    owner: collation,
    needle: "text: UChar::from(units.to_vec()),",
    fault:
      "text: UChar::from(String::from_utf16_lossy(units).encode_utf16().collect::<Vec<_>>()),",
    witness: "pure.locale.text",
  },
  {
    id: "numeric-collation",
    owner: collation,
    needle:
      'UColAttribute::UCOL_NUMERIC_COLLATION,\n                UColAttributeValue::UCOL_OFF,\n                "numeric",',
    fault:
      'UColAttribute::UCOL_NUMERIC_COLLATION,\n                UColAttributeValue::UCOL_ON,\n                "numeric",',
    witness: "pure.numeric.text",
  },
  {
    id: "remint-ledger-owner",
    owner: ledger,
    needle: ".or_insert_with(|| Arc::clone(entry));",
    fault:
      ".or_insert_with(|| Arc::new(UnreachableLedgerEntry { finding: UnreachableFinding { scope: entry.finding.scope.clone(), kind: entry.finding.kind, id: entry.finding.id.clone() }, reason: entry.reason.clone() }));",
    witness: "pure.first-reason.text",
  },
  {
    id: "initialize-before-admission",
    owner: gate,
    needle:
      "    let admission = admit(opts, repo_root);\n    match admission {\n        Admission::Complete(value) => Ok((value, None)),\n        ready @ Admission::Order { .. } => {\n            let collation = initialize().map_err(UnreachablePreparationError::Collation)?;",
    fault:
      "    let collation = initialize().map_err(UnreachablePreparationError::Collation)?;\n    let admission = admit(opts, repo_root);\n    match admission {\n        Admission::Complete(value) => Ok((value, None)),\n        ready @ Admission::Order { .. } => {",
    witness: "unreachable::gate::tests::refusals_do_not_initialize_collation",
    nativeOnly: true,
  },
];
const original = Object.fromEntries(
  [collation, ledger, gate].map((file) => [
    file,
    fs.readFileSync(path.join(root, file), "utf8"),
  ]),
);
for (const fault of faults)
  assert.equal(original[fault.owner].split(fault.needle).length, 2, fault.id);
const trusted = JSON.parse(fs.readFileSync(baselineReport, "utf8"));
const baselineHash = hash(fs.readFileSync(baseline));
assert.deepEqual(trusted.failures, []);
assert.equal(trusted.passed, 81);
assert.equal(trusted.unqualifiedPairs, 78);
assert.equal(trusted.qualifiedPairs, 3);
assert.equal(trusted.binary.sha256, baselineHash);
const report = {
  planned: 4,
  cargoSelections: 0,
  nativePreparations: 0,
  controls: [],
  baseline: { path: baseline, sha256: baselineHash, report: baselineReport },
  complete: false,
};
let check;
let runtime;
let operationError;
let cleanupError;
const save = () =>
  fs.writeFileSync(
    path.join(evidence, "controls.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
function invoke(name, program, args, cwd, env) {
  const began = Date.now();
  const child = spawnSync(program, args, {
    cwd,
    env,
    maxBuffer: 64 << 20,
  });
  fs.writeFileSync(path.join(evidence, `${name}.stdout`), child.stdout ?? "");
  fs.writeFileSync(path.join(evidence, `${name}.stderr`), child.stderr ?? "");
  const result = {
    argv: [program, ...args],
    cwd,
    environment: env,
    exit: child.status,
    signal: child.signal,
    error: child.error?.message,
    milliseconds: Date.now() - began,
    stdout: `${name}.stdout`,
    stderr: `${name}.stderr`,
  };
  fs.writeFileSync(
    path.join(evidence, `${name}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  return { ...result, text: child.stdout?.toString("utf8") ?? "" };
}
function retain(file, name) {
  const bytes = fs.readFileSync(file);
  const retained = `${name}.gz`;
  fs.writeFileSync(path.join(evidence, retained), gzipSync(bytes));
  return {
    path: file,
    bytes: bytes.length,
    sha256: hash(bytes),
    retained,
    gzipSha256: hash(fs.readFileSync(path.join(evidence, retained))),
  };
}
try {
  check = createCheckWorktree(root, "icu77-unreachable-controls", evidence);
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
  const environment = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    TMPDIR: path.join(check.target, "tmp"),
    RUSTUP_HOME: process.env.RUSTUP_HOME,
    CARGO_HOME: process.env.CARGO_HOME,
    RUSTUP_TOOLCHAIN: "stable",
    CARGO_NET_OFFLINE: "true",
    CARGO_BUILD_JOBS: "1",
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    DEMLIK_ICU77_PYTHON: process.env.DEMLIK_ICU77_PYTHON,
    RUST_ICU_MAJOR_VERSION_NUMBER: "77",
    RUST_ICU_LINK_SEARCH_DIR: path.join(check.target, "icu77/install/lib"),
    DEMLIK_ICU77_PREPARED: path.join(check.target, "icu77/prepared.json"),
  };
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
  assert.equal(prepare.exit, 0, "native preparation failure earns no credit");
  fs.cpSync(
    path.join(check.target, "icu77/prepared.json"),
    path.join(evidence, "native-prepared.json"),
  );
  for (const fault of faults) {
    for (const [owner, text] of Object.entries(original))
      fs.writeFileSync(path.join(check.root, owner), text);
    assert.ok(
      Object.entries(original).every(
        ([file, text]) =>
          fs.readFileSync(path.join(check.root, file), "utf8") === text,
      ),
    );
    const modified = original[fault.owner].replace(fault.needle, fault.fault);
    fs.writeFileSync(path.join(check.root, fault.owner), modified);
    fs.writeFileSync(path.join(evidence, `${fault.id}.rs`), modified);
    const build = invoke(
      `${fault.id}-cargo`,
      process.env.CARGO ?? "cargo",
      [
        fault.nativeOnly ? "test" : "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-code-graph",
        ...(fault.nativeOnly ? ["--lib", "--no-run"] : []),
        "--example",
        "unreachable_driver",
        "--message-format=json",
      ],
      check.root,
      environment,
    );
    report.cargoSelections++;
    save();
    assert.equal(build.exit, 0, "compilation failure earns no control credit");
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
        (fault.nativeOnly
          ? row.target.name === "demlik_code_graph" && row.profile.test
          : row.target.name === "unreachable_driver"),
    );
    assert.equal(consumers.length, 1);
    const consumer = consumers[0];
    assert.equal(consumer.fresh, false);
    const executable = assertCheckPath(consumer.executable, check.target);
    const retainedLibrary = retain(library.path, `${fault.id}-library`);
    const retainedConsumer = retain(executable, `${fault.id}-executed`);
    const runtimeEnvironment = { ...environment, TMPDIR: runtime };
    delete runtimeEnvironment.RUST_ICU_LINK_SEARCH_DIR;
    delete runtimeEnvironment.DEMLIK_ICU77_PREPARED;
    delete runtimeEnvironment.DEMLIK_ICU77_PYTHON;
    const pairs = path.join(evidence, `${fault.id}-pairs.json`);
    const run = fault.nativeOnly
      ? invoke(
          `${fault.id}-run`,
          executable,
          [fault.witness, "--exact", "--nocapture"],
          check.root,
          runtimeEnvironment,
        )
      : invoke(
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
            path.join(
              check.root,
              "verification/parity/graph-unreachable-ledger.mts",
            ),
            executable,
            pairs,
          ],
          check.root,
          runtimeEnvironment,
        );
    let observation;
    if (fault.nativeOnly) {
      assert.equal(run.exit, 101);
      assert.ok(run.text.includes(`${fault.witness} ... FAILED`));
      assert.ok(run.text.includes("0 passed; 1 failed"));
      observation = {
        nativeOnly: true,
        strictComparisonCredit: 0,
        namedAssertionFailure: true,
      };
    } else {
      assert.equal(run.exit, 1);
      const observed = JSON.parse(fs.readFileSync(pairs, "utf8"));
      assert.equal(observed.binary.sha256, retainedConsumer.sha256);
      assert.equal(observed.rejectedInvalidInputs, 4);
      assert.deepEqual(observed.sourceHashes, trusted.sourceHashes);
      const witness = observed.cases.find((row) => row.id === fault.witness);
      const baselineWitness = trusted.cases.find(
        (row) => row.id === fault.witness,
      );
      assert.equal(witness.process.status, 0);
      assert.equal(witness.passed, false);
      assert.equal(witness.qualified, false);
      assert.ok(witness.actual && witness.calls.length);
      assert.deepEqual(witness.input, baselineWitness.input);
      assert.deepEqual(witness.expected, baselineWitness.expected);
      assert.ok(observed.failures.some((row) => row.id === fault.witness));
      observation = {
        nativeOnly: false,
        protocolValid: true,
        semanticMismatch: true,
        comparison: pairs,
      };
    }
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
    for (const [owner, text] of Object.entries(original))
      fs.writeFileSync(path.join(check.root, owner), text);
    report.checkOwnersRestored = Object.entries(original).every(
      ([owner, text]) =>
        fs.readFileSync(path.join(check.root, owner), "utf8") === text,
    );
    const nativeLogs = path.join(check.target, "icu77/logs");
    if (fs.existsSync(nativeLogs)) {
      fs.mkdirSync(path.join(evidence, "native-logs"), { recursive: true });
      for (const file of fs.readdirSync(nativeLogs)) {
        const from = path.join(nativeLogs, file);
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
    `ICU77 controls failed; ${evidence}`,
  );
console.log(
  JSON.stringify({
    detected: report.controls.length,
    complete: report.complete,
    worktreeRemoved: report.worktreeRemoved,
  }),
);
