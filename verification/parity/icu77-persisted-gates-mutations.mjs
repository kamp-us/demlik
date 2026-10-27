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
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const [baselineManifest, baselineReport, sourceArchive, output] =
  process.argv.slice(2);
assert.ok(baselineManifest && baselineReport && sourceArchive && output);
assert.equal(process.version, "v22.21.1");
assert.equal(
  fs.realpathSync(os.tmpdir()),
  "/private/tmp",
  "call this suite with scoped TMPDIR=/private/tmp, outside ancestor Git ignores",
);
const root = fileURLToPath(new URL("../..", import.meta.url));
const evidence = path.resolve(output);
fs.mkdirSync(evidence, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const collation = "crates/code-graph/src/project/collation.rs";
const ledger = "crates/code-graph/src/boundaries/ledger.rs";
const gate = "crates/code-graph/src/comments/gate.rs";
const faults = [
  {
    id: "lossy-utf16",
    owner: collation,
    needle: "text: UChar::from(units.to_vec()),",
    fault:
      "text: UChar::from(String::from_utf16_lossy(units).encode_utf16().collect::<Vec<_>>()),",
    witness: "icu77-b.ledger.mixed-from",
  },
  {
    id: "numeric-collation",
    owner: collation,
    needle:
      'UColAttribute::UCOL_NUMERIC_COLLATION,\n                UColAttributeValue::UCOL_OFF,\n                "numeric",',
    fault:
      'UColAttribute::UCOL_NUMERIC_COLLATION,\n                UColAttributeValue::UCOL_ON,\n                "numeric",',
    witness: "icu77-b.ledger.numeric-off",
  },
  {
    id: "remint-ledger-owner",
    owner: ledger,
    needle: "by_key.insert(key, Arc::clone(entry));",
    fault: "by_key.insert(key, Arc::new((**entry).clone()));",
    witness:
      "canonical_gate_order_retains_selected_owners_and_rekey_remints_even_without_moves",
    nativeOnly: true,
    test: "icu77_persisted_gates",
  },
  {
    id: "initialize-before-admission",
    owner: gate,
    patches: [
      {
        owner: gate,
        needle: "    if !args.ci && !args.write_ceilings {",
        fault:
          "    let collation = request().map_err(CommentGateError::Collation)?;\n    if !args.ci && !args.write_ceilings {",
      },
      {
        owner: gate,
        needle:
          "        let collation = request().map_err(CommentGateError::Collation)?;\n",
        fault: "",
      },
      {
        owner: gate,
        needle:
          "    let collation = request().map_err(CommentGateError::Collation)?;\n    let census = order_census",
        fault: "    let census = order_census",
      },
      {
        owner: collation,
        needle:
          '        let mut handle = UCollator::try_from("en-US").map_err(CollationError::Initialize)?;',
        fault:
          "        let mut handle = std::result::Result::<UCollator, CollationError>::Err(CollationError::InputTooLong { units: 1, maximum: 0 })?;",
      },
    ],
    witness:
      "raw_self_root_policy_refusal_keeps_the_original_filename_until_output",
    nativeOnly: true,
    test: "cli_comments",
    qualification:
      "Forced native constructor refusal is only a native admission-port witness, zero Source comparison credit; no giant slice is allocated or claimed.",
  },
];
const original = Object.fromEntries(
  [collation, ledger, gate].map((file) => [
    file,
    fs.readFileSync(path.join(root, file), "utf8"),
  ]),
);
for (const fault of faults) {
  const texts = { ...original };
  for (const patch of fault.patches ?? [fault]) {
    assert.equal(
      texts[patch.owner].split(patch.needle).length,
      2,
      fault.id + ":" + patch.owner,
    );
    texts[patch.owner] = texts[patch.owner].replace(patch.needle, patch.fault);
  }
}
const trusted = JSON.parse(fs.readFileSync(baselineReport, "utf8"));
const baseline = JSON.parse(fs.readFileSync(baselineManifest, "utf8"));
const baselineHash = Object.fromEntries(
  Object.entries(baseline).map(([name, file]) => [
    name,
    hash(fs.readFileSync(file)),
  ]),
);
assert.deepEqual(trusted.failures, []);
assert.equal(trusted.passed, 31);
assert.equal(trusted.strict, 31);
assert.equal(trusted.qualified, 0);
for (const name of [
  "ledger_driver",
  "scope_count_driver",
  "layer_driver",
  "reconcile_driver",
])
  assert.equal(trusted.binaryHashes[name], baselineHash[name]);
const report = {
  planned: 4,
  cargoSelections: 0,
  nativePreparations: 0,
  controls: [],
  baseline: {
    manifest: baselineManifest,
    hashes: baselineHash,
    report: baselineReport,
  },
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
  check = createCheckWorktree(root, "icu77-persisted-gates-controls", evidence);
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
    TMPDIR: runtime,
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
    { ...environment, TMPDIR: path.join(check.target, "tmp") },
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
    const modified = { ...original };
    for (const patch of fault.patches ?? [fault])
      modified[patch.owner] = modified[patch.owner].replace(
        patch.needle,
        patch.fault,
      );
    const changed = Object.keys(original).filter(
      (owner) => modified[owner] !== original[owner],
    );
    for (const owner of changed) {
      fs.writeFileSync(path.join(check.root, owner), modified[owner]);
      fs.writeFileSync(
        path.join(evidence, `${fault.id}-${path.basename(owner)}`),
        modified[owner],
      );
    }
    const build = invoke(
      `${fault.id}-cargo`,
      process.env.CARGO ?? "cargo",
      [
        fault.nativeOnly ? "test" : "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-code-graph",
        ...(fault.nativeOnly
          ? ["--test", fault.test, "--no-run"]
          : [
              "--example",
              "ledger_driver",
              "--example",
              "scope_count_driver",
              "--example",
              "layer_driver",
              "--example",
              "reconcile_driver",
            ]),
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
          ? row.target.name === fault.test && row.profile.test
          : row.target.name === "ledger_driver"),
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
    let binaries;
    const retainedDrivers = {};
    if (!fault.nativeOnly) {
      binaries = {};
      for (const name of [
        "ledger_driver",
        "scope_count_driver",
        "layer_driver",
        "reconcile_driver",
      ]) {
        const rows = events.filter(
          (row) =>
            row.reason === "compiler-artifact" &&
            row.target.name === name &&
            row.executable,
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].fresh, false);
        binaries[name] = assertCheckPath(rows[0].executable, check.target);
        retainedDrivers[name] = {
          event: rows[0],
          retained:
            name === "ledger_driver"
              ? retainedConsumer
              : retain(binaries[name], `${fault.id}-${name}`),
        };
      }
      fs.writeFileSync(
        path.join(evidence, `${fault.id}-binaries.json`),
        JSON.stringify(binaries, null, 2) + "\n",
      );
    }
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
              "verification/parity/icu77-persisted-gates.mts",
            ),
            path.join(evidence, `${fault.id}-binaries.json`),
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
      assert.equal(
        observed.binaryHashes.ledger_driver,
        retainedConsumer.sha256,
      );
      assert.equal(observed.rejectedInvalidInputs, 0);
      assert.deepEqual(
        observed.cases.map((row) => row.id).sort(),
        trusted.cases.map((row) => row.id).sort(),
      );
      assert.ok(!observed.failures.some((row) => row.id === "harness"));
      const witness = observed.cases.find((row) => row.id === fault.witness);
      const baselineWitness = trusted.cases.find(
        (row) => row.id === fault.witness,
      );
      assert.equal(witness.process.status, 0);
      assert.equal(witness.passed, false);
      assert.deepEqual(witness.qualifications, []);
      assert.equal(witness.actual.ok, true);
      assert.ok(witness.actual && witness.nativeTrace.observedCalls.length);
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
      modifiedSources: Object.fromEntries(
        changed.map((owner) => [owner, hash(modified[owner])]),
      ),
      witness: fault.witness,
      compileExit: 0,
      library: { event: library.artifact, retained: retainedLibrary },
      consumer,
      retainedDrivers,
      qualification: fault.qualification,
      executed: retainedConsumer,
      observation,
    });
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(baseline).map(([name, file]) => [
          name,
          hash(fs.readFileSync(file)),
        ]),
      ),
      baselineHash,
    );
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
  report.baselineUnchanged = Object.entries(baseline).every(
    ([name, file]) => hash(fs.readFileSync(file)) === baselineHash[name],
  );
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
