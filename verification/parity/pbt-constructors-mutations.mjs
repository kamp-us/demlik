import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

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
function command(program, args, options = {}) {
  const r = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    command: [program, ...args],
    exit: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error?.message,
  };
}
function adapter(root, binary, reportFile, caseId, native) {
  const run = command(
    process.execPath,
    [
      "--import",
      join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
      join(root, "verification/parity/pbt-constructors.mts"),
      "--native-bin",
      binary,
      "--report",
      reportFile,
      ...(native ? ["--native-only"] : []),
      ...(caseId ? ["--case-id", caseId] : []),
    ],
    { cwd: root },
  );
  assert([0, 1].includes(run.exit), JSON.stringify(run));
  return { run, report: JSON.parse(readFileSync(reportFile, "utf8")) };
}
export function pbtConstructorMutations({
  binary,
  warmTarget = process.env.CARGO_TARGET_DIR,
  reportFile = "target/parity/pbt-constructors-controls.json",
  only,
} = {}) {
  assert(
    binary && warmTarget,
    "Supply the immutable baseline binary and separate frozen warm target",
  );
  const root = process.cwd(),
    source = readFileSync(owner, "utf8"),
    controls = [];
  binary = resolve(binary);
  warmTarget = resolve(warmTarget);
  reportFile = resolve(reportFile);
  mkdirSync(dirname(reportFile), { recursive: true });
  const baseline = adapter(
    root,
    binary,
    `${reportFile}.baseline.json`,
    undefined,
    false,
  );
  assert.equal(baseline.run.exit, 0);
  assert.equal(baseline.report.passed, 90);
  const nativeBaseline = adapter(
    root,
    binary,
    `${reportFile}.native-baseline.json`,
    undefined,
    true,
  );
  assert.equal(nativeBaseline.run.exit, 0);
  assert.equal(nativeBaseline.report.passed, 3);
  for (const fault of faults.filter((f) => !only || only.includes(f.id))) {
    assert.equal(
      source.split(fault.needle).length,
      2,
      `${fault.id}: exact unique owner needle`,
    );
    const temporary = mkdtempSync(
        join(tmpdir(), "demlik-constructors-mutant-"),
      ),
      target = mkdtempSync(
        join(tmpdir(), "demlik-constructors-mutant-target-"),
      );
    try {
      for (const name of ["Cargo.toml", "Cargo.lock", "crates"])
        cpSync(join(root, name), join(temporary, name), { recursive: true });
      const changed = source.replace(fault.needle, fault.fault);
      writeFileSync(join(temporary, owner), changed);
      const clone = command("/bin/cp", ["-cR", `${warmTarget}/.`, target]);
      assert.equal(clone.exit, 0, clone.stderr);
      const env = {
        ...process.env,
        CARGO_TARGET_DIR: target,
        CARGO_NET_OFFLINE: "true",
        CARGO_BUILD_JOBS: "1",
        CARGO_INCREMENTAL: "0",
        CARGO_PROFILE_DEV_DEBUG: "0",
        CARGO_PROFILE_TEST_DEBUG: "0",
      };
      const build = command(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "--message-format=json",
          "-p",
          "demlik-tea",
          "--features",
          "pbt",
          "--example",
          "pbt_constructors_driver",
        ],
        { cwd: temporary, env },
      );
      assert.equal(
        build.exit,
        0,
        `${fault.id}: compile/setup failure is not a detection\n${build.stderr}`,
      );
      const artifacts = build.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const library = artifacts.find(
        (a) =>
          a.reason === "compiler-artifact" &&
          a.target.name === "demlik_tea" &&
          a.filenames.some((f) => f.endsWith(".rlib")),
      );
      const executable = artifacts.find(
        (a) =>
          a.reason === "compiler-artifact" &&
          a.target.name === "pbt_constructors_driver" &&
          a.executable,
      );
      assert(library && executable);
      assert.equal(
        library.fresh,
        false,
        "Mutated tea source must actually compile, not reuse the baseline library",
      );
      const result = adapter(
        root,
        executable.executable,
        join(temporary, "result.json"),
        fault.witness,
        fault.native,
      );
      assert.equal(
        result.run.exit,
        1,
        `${fault.id}: a protocol-valid named semantic mismatch is required`,
      );
      assert(result.report.failures.some((f) => f.id === fault.witness));
      assert.equal(result.report.cases.length, 1);
      const row = result.report.cases[0];
      assert(
        row.observedRustCalls.includes(
          `demlik_tea::pbt::${fault.id.startsWith("constant") ? "constant_msg" : "record_msg"}`,
        ),
      );
      const nativeCommand = result.report.nativeCommand;
      assert.equal(
        nativeCommand.exit,
        0,
        "Native process must succeed; a panic/protocol failure is not the witness",
      );
      const raw = row;
      if (fault.id === "constant-msg-rejects-valid-value") {
        assert.equal(raw.comparison.status, "refused");
        assert.equal(raw.comparison.phase, "generation");
        assert.equal(typeof raw.comparison.reason, "string");
      } else if (fault.id === "record-msg-reuses-first-outer") {
        assert.equal(raw.comparison.status, "ok");
        assert.deepEqual(raw.comparison.sameAsFirst, [true, true, true]);
      } else {
        assert.equal(raw.comparison.status, "case");
        assert.equal(raw.comparison.minimum, 87);
        assert.equal(raw.comparison.firstFailure, 87);
        assert.notEqual(raw.comparison.minimum, 13);
      }
      const saved = resolve(
        "target/parity/control-binaries/pbt-constructors",
        fault.id,
      );
      mkdirSync(dirname(saved), { recursive: true });
      cpSync(executable.executable, saved);
      controls.push({
        id: fault.id,
        witness: fault.witness,
        detectedIds: result.report.failures.map((f) => f.id),
        source: {
          path: owner,
          originalSha256: hash(source),
          mutatedSha256: hash(changed),
          needle: fault.needle,
          fault: fault.fault,
        },
        clone,
        build,
        result,
        nativeCommand,
        binary: { path: saved, sha256: hash(readFileSync(saved)) },
        actualLibraryFresh: library.fresh,
      });
      writeFileSync(
        `${reportFile}.progress.json`,
        `${JSON.stringify({ baseline: baseline.report.binary, controls }, null, 2)}\n`,
      );
    } finally {
      assert.equal(readFileSync(owner, "utf8"), source);
      rmSync(temporary, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  }
  const report = {
    baseline: {
      compared: baseline.report.compared,
      passed: baseline.report.passed,
      binary: baseline.report.binary,
    },
    nativeBaseline: {
      cases: nativeBaseline.report.nativeCases,
      passed: nativeBaseline.report.passed,
    },
    controls,
    activeSourceUnchanged: readFileSync(owner, "utf8") === source,
    semanticPairs: 0,
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      "native-bin": { type: "string" },
      "warm-target": { type: "string" },
      report: { type: "string" },
      only: { type: "string", multiple: true },
    },
    strict: true,
  });
  const report = pbtConstructorMutations({
    binary: values["native-bin"],
    warmTarget: values["warm-target"],
    reportFile: values.report,
    only: values.only,
  });
  console.log(
    JSON.stringify({
      controls: report.controls.length,
      detected: report.controls.length,
      activeSourceUnchanged: report.activeSourceUnchanged,
    }),
  );
}
