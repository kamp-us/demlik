import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
} from "./check-worktree.mjs";
import { pbtFinalFaults } from "./pbt-final-mutations.mjs";
import { pbtPropertyFaults } from "./pbt-property-mutations.mjs";

const owner = "crates/tea/src/pbt/proptest.rs";
const faults = [
  {
    id: "constant-msg-rejects-valid-value",
    needle:
      "pub fn constant_msg<M: Tagged + fmt::Debug>(message: M) -> Just<Arc<M>> {\n    Just(Arc::new(message))\n}",
    fault:
      'pub fn constant_msg<M: Tagged + fmt::Debug>(message: M) -> impl Strategy<Value = Arc<M>> {\n    Just(Arc::new(message)).prop_filter("fault: rejected constant", |_| false)\n}',
    witness: "constructors.constant.stop",
    native: false,
  },
  {
    id: "record-msg-reuses-first-outer",
    needle: "    fields.prop_map(move |value| Arc::new(build(value)))",
    fault:
      "    let cached: RefCell<Option<Arc<M>>> = RefCell::new(None);\n    fields.prop_map(move |value| {\n        let copy = cached.borrow().as_ref().map(Arc::clone);\n        if let Some(first) = copy { return first; }\n        let message = Arc::new(build(value));\n        let old = cached.replace(Some(Arc::clone(&message)));\n        drop(old);\n        message\n    })",
    witness: "constructors.record.value-1",
    native: false,
  },
  {
    id: "record-msg-disables-field-shrinking",
    needle: "    fields.prop_map(move |value| Arc::new(build(value)))",
    fault:
      "    fields.no_shrink().prop_map(move |value| Arc::new(build(value)))",
    witness: "constructors.native.field-shrink",
    native: true,
  },
];
const hash = (x) => createHash("sha256").update(x).digest("hex");
const environment = () =>
  cargoCheckEnvironment({
    CARGO_NET_OFFLINE: "true",
    CARGO_BUILD_JOBS: "1",
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
  });
const controls = [
  ...faults.map((fault) => ({ ...fault, family: "constructors" })),
  ...pbtPropertyFaults.map((fault) => ({ ...fault, family: "property" })),
  ...pbtFinalFaults.map((fault) => ({ ...fault, family: "final" })),
];
function command(program, args, cwd) {
  const r = spawnSync(program, args, {
    cwd,
    env: environment(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command: [program, ...args],
    cwd,
    exit: r.status,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error?.message,
  };
}
function saveRun(prefix, run) {
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  fs.writeFileSync(`${prefix}.stdout`, run.stdout);
  fs.writeFileSync(`${prefix}.stderr`, run.stderr);
  const { stdout, stderr, ...metadata } = run;
  const record = {
    ...metadata,
    stdout: { path: `${prefix}.stdout`, sha256: hash(stdout) },
    stderr: { path: `${prefix}.stderr`, sha256: hash(stderr) },
  };
  fs.writeFileSync(
    `${prefix}.run.json`,
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}
function outsideCheck(check, reportFile) {
  assert.equal(
    path.resolve(check.target),
    path.join(path.resolve(check.root), "target"),
  );
  const relative = path.relative(
    path.resolve(check.root),
    path.resolve(reportFile),
  );
  assert(
    relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative),
    "proof must outlive the registered check",
  );
}
function adapter(check, binary, reportFile, script, args = []) {
  outsideCheck(check, reportFile);
  fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
  const run = command(
    process.execPath,
    [
      "--import",
      path.join(
        check.root,
        "verification/parity/node_modules/tsx/dist/loader.mjs",
      ),
      assertCheckPath(
        path.join(check.root, "verification/parity", script),
        check.root,
      ),
      "--native-bin",
      path.resolve(binary),
      "--report",
      path.resolve(reportFile),
      ...args,
    ],
    check.root,
  );
  const runRecord = saveRun(`${reportFile}.adapter`, run);
  assert.equal(run.error, undefined, JSON.stringify(runRecord));
  assert.equal(run.signal, null, JSON.stringify(runRecord));
  assert([0, 1].includes(run.exit), JSON.stringify(runRecord));
  assert(
    fs.existsSync(reportFile),
    `Adapter failed before a protocol-valid report: ${reportFile}; ${run.stderr}`,
  );
  return {
    run,
    runRecord,
    report: JSON.parse(fs.readFileSync(reportFile, "utf8")),
  };
}
export function pbtConstructorComparison({
  check,
  binary,
  reportFile,
  caseId,
  nativeOnly = false,
}) {
  assert(
    check && binary && reportFile,
    "owning check, explicit binary and external report required",
  );
  return adapter(check, binary, reportFile, "pbt-constructors.mts", [
    ...(nativeOnly ? ["--native-only"] : []),
    ...(caseId ? ["--case-id", caseId] : []),
  ]);
}
function assertProptest(rows, check) {
  const found = rows.filter(
    (r) =>
      r.reason === "compiler-artifact" &&
      r.target.name === "proptest" &&
      r.target.kind.includes("lib") &&
      r.filenames.some((f) => f.endsWith(".rlib")),
  );
  assert.equal(found.length, 1);
  const artifact = found[0];
  assert(artifact.package_id.endsWith("#proptest@1.11.0"));
  assert(artifact.features.includes("std"));
  assert(
    !artifact.features.includes("fork") &&
      !artifact.features.includes("timeout"),
  );
  const file = assertCheckPath(
    artifact.filenames.find((f) => f.endsWith(".rlib")),
    check.target,
  );
  return {
    artifact,
    path: file,
    sha256: hash(fs.readFileSync(file)),
    source: {
      path: artifact.target.src_path,
      sha256: hash(fs.readFileSync(artifact.target.src_path)),
    },
    manifest: {
      path: artifact.manifest_path,
      sha256: hash(fs.readFileSync(artifact.manifest_path)),
    },
  };
}
function witness(check, binary, file, control) {
  if (control.family === "constructors") {
    const result = pbtConstructorComparison({
      check,
      binary,
      reportFile: file,
      caseId: control.witness,
      nativeOnly: control.native,
    });
    assert.equal(result.run.exit, 1, "named semantic mismatch required");
    assert.equal(
      result.report.nativeCommand.exit,
      0,
      "panic/protocol failure is not a witness",
    );
    assert.equal(result.report.cases.length, 1);
    assert(result.report.failures.some((f) => f.id === control.witness));
    const row = result.report.cases[0];
    assert.equal(row.id, control.witness);
    assert(
      row.observedRustCalls.includes(
        `demlik_tea::pbt::${control.id.startsWith("constant") ? "constant_msg" : "record_msg"}`,
      ),
    );
    if (control.id === "constant-msg-rejects-valid-value") {
      assert.equal(row.comparison.status, "refused");
      assert.equal(row.comparison.phase, "generation");
      assert.equal(typeof row.comparison.reason, "string");
    } else if (control.id === "record-msg-reuses-first-outer") {
      assert.equal(row.comparison.status, "ok");
      assert.deepEqual(row.comparison.sameAsFirst, [true, true, true]);
    } else {
      assert.equal(row.comparison.status, "case");
      assert.equal(row.comparison.minimum, 87);
      assert.equal(row.comparison.firstFailure, 87);
      assert.notEqual(row.comparison.minimum, 13);
    }
    return {
      kind: control.native ? "native-constructor-law" : "shared-constructor",
      declared: control.witness,
      reportFile: file,
      run: result.runRecord,
    };
  }
  if (control.native) {
    const run = command(
      binary,
      [control.witness, "--exact", "--nocapture"],
      check.root,
    );
    const recorded = saveRun(`${file}.native`, run);
    assert.equal(run.error, undefined);
    assert.equal(run.signal, null);
    assert.equal(run.exit, 101, "named native assertion must fail");
    assert(run.stdout.includes(`${control.witness} ... FAILED`));
    const assertion =
      control.family === "property"
        ? "backend-recreated handles would not have been evaluated"
        : "returned messages must have been actually evaluated";
    assert(
      run.stderr.includes(assertion) ||
        run.stderr.includes("assertion failed: Arc::ptr_eq"),
    );
    return {
      kind: "native-owner-law",
      declared: control.witness,
      assertion,
      run: recorded,
    };
  }
  const script =
    control.family === "final"
      ? "pbt-final.mts"
      : control.files
        ? "pbt-property-files.mts"
        : "pbt-property.mts";
  const result = adapter(
    check,
    binary,
    file,
    script,
    control.files ? [] : ["--case-id", control.witness],
  );
  assert.equal(result.run.exit, 1, "named behavioral mismatch required");
  if (control.files) {
    assert.equal(result.report.id, control.witness);
    assert.equal(result.report.equal, false);
    assert.equal(result.report.commands.length, 2);
    assert(result.report.commands.every((r) => r.exit === 0));
    assert(result.report.observedRustCalls.includes("pbt::property_invariant"));
  } else {
    assert.equal(result.report.cases.length, 1);
    assert.equal(result.report.cases[0].id, control.witness);
    assert(result.report.failures.some((f) => f.id === control.witness));
    const expectedCall =
      control.family === "property"
        ? control.witness.startsWith("pbt-sequence.")
          ? "pbt::msg_sequence"
          : "pbt::property_invariant"
        : control.witness.startsWith("pbt-terminates.")
          ? "pbt::property_terminates"
          : "pbt::property_trace";
    assert(result.report.cases[0].observedRustCalls.includes(expectedCall));
  }
  assert.equal(result.report.binary.sha256, hash(fs.readFileSync(binary)));
  return {
    kind: control.files ? "file-side-effect" : "shared-fixed-profile",
    declared: control.witness,
    reportFile: file,
    run: result.runRecord,
  };
}
export function pbtConstructorMutations({
  check,
  baseline,
  reportFile,
  only,
  observeTarget = () => {},
} = {}) {
  assert(
    check && baseline && reportFile,
    "explicit owning check and immutable proven baseline required; no build fallback",
  );
  outsideCheck(check, reportFile);
  assert.equal(baseline.reports.constructors.compared, 90);
  assert.equal(baseline.reports.constructors.passed, 90);
  assert.equal(baseline.reports.native.passed, 3);
  assert.equal(baseline.reports.property.passed, 52);
  assert.equal(baseline.reports.files.equal, true);
  assert.equal(baseline.reports.final.passed, 108);
  if (only)
    assert(
      only.every((id) => controls.some((c) => c.id === id)),
      "unknown control ID",
    );
  const selected = controls.filter((c) => !only || only.includes(c.id));
  assert(selected.length);
  assert.equal(new Set(controls.map((c) => c.id)).size, 19);
  const sourceFile = assertCheckPath(path.join(check.root, owner), check.root);
  const source = fs.readFileSync(sourceFile, "utf8");
  for (const c of selected)
    assert.equal(
      source.split(c.needle).length,
      2,
      `${c.id}: unique current owner needle`,
    );
  const immutable = [
    ...Object.values(baseline.binaries),
    ...Object.values(baseline.libraries),
    ...Object.values(baseline.nativeTests),
  ];
  const intact = () =>
    immutable.every((a) => hash(fs.readFileSync(a.path)) === a.sha256);
  assert(intact());
  const evidence = path.dirname(path.resolve(reportFile));
  const report = {
    complete: false,
    planned: selected.length,
    detected: 0,
    controls: [],
    source: { path: owner, sha256: hash(source) },
    semanticPairs: 0,
  };
  let operationError, restorationError;
  try {
    for (const c of selected) {
      fs.writeFileSync(sourceFile, source);
      assert.equal(hash(fs.readFileSync(sourceFile)), hash(source));
      const changed = source.replace(c.needle, c.fault);
      fs.writeFileSync(sourceFile, changed);
      const directory = path.join(evidence, c.id);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "mutated.rs"), changed);
      const nativeTest = c.native && c.family !== "constructors";
      const target = nativeTest
        ? c.family === "property"
          ? "pbt_proptest"
          : "pbt_final"
        : c.family === "constructors"
          ? "pbt_constructors_driver"
          : "pbt_property_driver";
      const args = [
        nativeTest ? "test" : "build",
        ...(nativeTest ? ["--no-run"] : []),
        "--locked",
        "--offline",
        "--message-format=json",
        "-p",
        "demlik-tea",
        "--features",
        "pbt",
        nativeTest ? "--test" : "--example",
        target,
      ];
      const build = command(process.env.CARGO ?? "cargo", args, check.root);
      const recordedBuild = saveRun(path.join(directory, "cargo"), build);
      observeTarget();
      assert.equal(build.error, undefined);
      assert.equal(build.signal, null);
      assert.equal(
        build.exit,
        0,
        `${c.id}: compilation/setup failure earns no semantic credit\n${build.stdout}\n${build.stderr}`,
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
      assert(library.artifact.features.includes("pbt"));
      const proptest = assertProptest(rows, check);
      assert.equal(proptest.sha256, baseline.libraries.proptest.sha256);
      assert.equal(
        proptest.source.sha256,
        baseline.libraries.proptest.source.sha256,
      );
      const exes = rows.filter(
        (r) =>
          r.reason === "compiler-artifact" &&
          r.target.name === target &&
          r.executable,
      );
      assert.equal(exes.length, 1);
      assert.equal(
        exes[0].fresh,
        false,
        "effective consumer must rebuild for this fault",
      );
      assertCheckPath(exes[0].target.src_path, check.root);
      assertCheckPath(exes[0].manifest_path, check.root);
      const actual = assertCheckPath(exes[0].executable, check.target);
      const executable = path.join(
        directory,
        `${hash(fs.readFileSync(actual))}.bin`,
      );
      fs.copyFileSync(actual, executable);
      assert.equal(
        hash(fs.readFileSync(actual)),
        hash(fs.readFileSync(executable)),
      );
      const librarySha256 = hash(fs.readFileSync(library.path));
      const result = witness(
        check,
        executable,
        path.join(directory, "pairs.json"),
        c,
      );
      assert(intact(), "immutable baseline changed");
      report.controls.push({
        ...c,
        compiled: true,
        detected: true,
        build: recordedBuild,
        source: {
          path: owner,
          originalSha256: hash(source),
          mutatedSha256: hash(changed),
          copy: path.join(directory, "mutated.rs"),
        },
        library: {
          actualPath: library.path,
          sha256: librarySha256,
          retained: false,
          artifact: library.artifact,
          sourcePath: library.sourcePath,
          manifestPath: library.manifestPath,
        },
        proptest,
        binary: {
          path: executable,
          sha256: hash(fs.readFileSync(executable)),
          actualPath: actual,
          artifact: exes[0],
        },
        witnessResult: result,
      });
      report.detected = report.controls.length;
      fs.writeFileSync(
        `${reportFile}.progress.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      );
    }
    report.complete = true;
  } catch (error) {
    operationError = error;
    report.operationFailure = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } finally {
    try {
      fs.writeFileSync(sourceFile, source);
      assert.equal(hash(fs.readFileSync(sourceFile)), hash(source));
    } catch (error) {
      restorationError = error;
      report.restorationFailure = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    report.activeSourceUnchanged =
      fs.readFileSync(sourceFile, "utf8") === source;
    report.baselineArtifactsUnchanged = intact();
    report.complete &&=
      !restorationError &&
      report.activeSourceUnchanged &&
      report.baselineArtifactsUnchanged;
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (operationError || restorationError)
    throw new AggregateError(
      [operationError, restorationError].filter(Boolean),
      `PBT constructor controls failed; evidence: ${reportFile}`,
    );
  assert.equal(report.complete, true);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  throw new Error(
    "Run pbt-constructors-checks-run.mjs: an owning check and immutable proven baseline are required; no standalone build fallback",
  );
}
