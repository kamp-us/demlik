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
    id: "pbt-reruns-failing-callbacks",
    needle: "let evaluated = failure.into_inner();",
    fault:
      "let mut evaluated = failure.into_inner(); if let Some(captured) = &mut evaluated { if let Err(second) = evaluate(machine, input, &captured.messages, &loaded, &check) { captured.failure = second; } }",
    witness: "pbt-property.reducer.false-first",
  },
  {
    id: "pbt-wrong-default-runs",
    needle: "num_runs: 200,",
    fault: "num_runs: 201,",
    witness: "pbt-property.count.default-200",
  },
  {
    id: "pbt-prefix-counted-in-tail-bounds",
    needle: "vec(message, options.tail)",
    fault:
      "vec(message, options.tail.start().saturating_sub(options.prefix.len())..options.tail.end_excl().saturating_sub(options.prefix.len()))",
    witness: "pbt-sequence.tail-3.prefix-1",
  },
  {
    id: "pbt-drops-fixed-prefix",
    needle: "options.prefix.iter().cloned().chain(tail).collect()",
    fault: "tail",
    witness: "pbt-sequence.tail-3.prefix-1",
  },
  {
    id: "pbt-skips-first-invariant",
    needle: "trace.steps.iter().enumerate()",
    fault: "trace.steps.iter().enumerate().skip(1)",
    witness: "pbt-property.reducer.false-first",
  },
  {
    id: "pbt-truncates-fold-before-check",
    needle: "messages.iter().cloned()",
    fault: "messages.iter().take(1).cloned()",
    witness: "pbt-property.reducer.complete-before-check",
  },
  {
    id: "pbt-swallows-original-error",
    needle: "Ok(Err(error)) => Err(PredicateFailure::Error(error)),",
    fault: "Ok(Err(error)) => { drop(error); Err(PredicateFailure::False) },",
    witness: "pbt-property.reducer.original-error-first",
  },
  {
    id: "pbt-enables-regression-file",
    needle: "failure_persistence: None,",
    fault:
      'failure_persistence: Some(Box::new(::proptest::test_runner::FileFailurePersistence::Direct("proptest-regressions.txt"))),',
    files: true,
    witness: "pbt-property.no-regression-files",
  },
  {
    id: "pbt-substitutes-recreated-minimum-handles",
    needle: "drop(minimum);",
    fault:
      "if let Some(evaluated) = failure.borrow_mut().as_mut() { evaluated.messages = minimum; }",
    native: true,
    witness:
      "standard_native_shrinking_keeps_the_evaluated_handles_and_replays_its_minimum",
  },
];
export { faults as pbtPropertyFaults };
const digest = (x) => createHash("sha256").update(x).digest("hex");
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
function adapter(root, binary, reportFile, caseId, files = false) {
  const result = command(
    process.execPath,
    [
      "--import",
      join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
      join(
        root,
        files
          ? "verification/parity/pbt-property-files.mts"
          : "verification/parity/pbt-property.mts",
      ),
      "--native-bin",
      binary,
      "--report",
      reportFile,
      ...(caseId && !files ? ["--case-id", caseId] : []),
    ],
    { cwd: root },
  );
  assert([0, 1].includes(result.exit), `${JSON.stringify(result)}`);
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  return { command: result, report };
}
export function pbtPropertyMutations({
  binary,
  reportFile = "target/parity/pbt-property-controls.json",
  only,
  binaryDirectory = "target/parity/control-binaries",
} = {}) {
  assert(binary, "baseline binary required");
  const root = process.cwd();
  reportFile = resolve(reportFile);
  mkdirSync(dirname(reportFile), { recursive: true });
  const baseline = adapter(
    root,
    resolve(binary),
    `${reportFile}.baseline.json`,
  );
  assert.equal(baseline.command.exit, 0);
  assert.equal(baseline.report.passed, 52);
  const source = readFileSync(owner, "utf8");
  const controls = [];
  for (const f of faults.filter((f) => !only || only.includes(f.id))) {
    assert.equal(
      source.split(f.needle).length,
      2,
      `${f.id}: exact owner mutation site`,
    );
    const temporary = mkdtempSync(join(tmpdir(), "demlik-pbt-mutant-")),
      target = mkdtempSync(join(tmpdir(), "demlik-pbt-mutant-target-"));
    try {
      for (const path of ["Cargo.toml", "Cargo.lock", "crates"])
        cpSync(join(root, path), join(temporary, path), { recursive: true });
      const changed = source.replace(f.needle, f.fault);
      writeFileSync(join(temporary, owner), changed);
      const env = {
        ...process.env,
        CARGO_TARGET_DIR: target,
        CARGO_PROFILE_DEV_DEBUG: "0",
        CARGO_PROFILE_TEST_DEBUG: "0",
        CARGO_INCREMENTAL: "0",
        CARGO_BUILD_JOBS: "1",
        CARGO_NET_OFFLINE: "true",
      };
      const args = f.native
        ? [
            "test",
            "--no-run",
            "--message-format=json",
            "--locked",
            "--offline",
            "-p",
            "demlik-tea",
            "--features",
            "pbt",
            "--test",
            "pbt_proptest",
          ]
        : [
            "build",
            "--message-format=json",
            "--locked",
            "--offline",
            "-p",
            "demlik-tea",
            "--features",
            "pbt",
            "--example",
            "pbt_property_driver",
          ];
      const build = command(process.env.CARGO ?? "cargo", args, {
        cwd: temporary,
        env,
      });
      assert.equal(
        build.exit,
        0,
        `Compile/setup failure is not a detection: ${f.id}\n${build.stderr}`,
      );
      const artifacts = build.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const executable = artifacts.find(
        (a) =>
          a.reason === "compiler-artifact" &&
          a.target.name ===
            (f.native ? "pbt_proptest" : "pbt_property_driver") &&
          a.executable,
      )?.executable;
      assert(executable);
      let result, detectedIds;
      if (f.native) {
        const run = command(executable, [f.witness, "--exact", "--nocapture"], {
          cwd: temporary,
          env,
        });
        assert.equal(
          run.exit,
          101,
          `${f.id}: must fail the named native assertion\n${run.stdout}\n${run.stderr}`,
        );
        assert(run.stdout.includes(`${f.witness} ... FAILED`));
        assert(
          run.stderr.includes(
            "backend-recreated handles would not have been evaluated",
          ) || run.stderr.includes("assertion failed: Arc::ptr_eq"),
        );
        result = { run };
        detectedIds = [f.witness];
      } else {
        result = adapter(
          root,
          executable,
          join(temporary, "result.json"),
          f.witness,
          f.files,
        );
        assert.equal(
          result.command.exit,
          1,
          `${f.id}: named behavioral mismatch expected`,
        );
        detectedIds = f.files
          ? result.report.equal
            ? []
            : [result.report.id]
          : result.report.failures.map((c) => c.id);
        assert(detectedIds.includes(f.witness));
      }
      const saved = resolve(binaryDirectory, f.id);
      mkdirSync(dirname(saved), { recursive: true });
      cpSync(executable, saved);
      controls.push({
        id: f.id,
        witness: f.witness,
        detectedIds,
        compiled: true,
        source: {
          path: owner,
          originalSha256: digest(source),
          mutatedSha256: digest(changed),
          needle: f.needle,
          fault: f.fault,
        },
        binary: { path: saved, sha256: digest(readFileSync(saved)) },
        build,
        result,
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
    controls,
    activeSourceUnchanged: readFileSync(owner, "utf8") === source,
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
      report: { type: "string" },
      only: { type: "string", multiple: true },
      "binary-directory": { type: "string" },
    },
    strict: true,
  });
  const r = pbtPropertyMutations({
    binary: values["native-bin"],
    reportFile: values.report,
    only: values.only,
    binaryDirectory: values["binary-directory"],
  });
  console.log(
    JSON.stringify({
      controls: r.controls.length,
      detected: r.controls.length,
      activeSourceUnchanged: r.activeSourceUnchanged,
    }),
  );
}
