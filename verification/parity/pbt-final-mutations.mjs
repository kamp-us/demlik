import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createCheckWorktree,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const owner = "crates/tea/src/pbt/proptest.rs";
const faults = [
  {
    id: "pbt-final-skips-empty-terminal",
    needle: "predicate_result(|| terminal(&trace.final_state))",
    fault:
      "if trace.steps.is_empty() { Ok(()) } else { predicate_result(|| terminal(&trace.final_state)) }",
    witness: "pbt-terminates.loaded-empty-false",
  },
  {
    id: "pbt-final-terminal-gets-boot-state",
    needle: "terminal(&trace.final_state)",
    fault: "terminal(&trace.states[0])",
    witness: "pbt-terminates.reducer.terminal-following",
  },
  {
    id: "pbt-final-trace-gets-boot-state",
    needle: "predicate(&trace.steps, &trace.final_state)",
    fault: "predicate(&trace.steps, &trace.states[0])",
    witness: "pbt-trace.reducer.terminal-following",
  },
  {
    id: "pbt-final-trace-clips-history",
    needle: "predicate(&trace.steps, &trace.final_state)",
    fault:
      "predicate(&trace.steps[..trace.steps.len().min(1)], &trace.final_state)",
    witness: "pbt-trace.reducer.complete-before-check",
  },
  {
    id: "pbt-final-trace-checks-each-prefix",
    needle: "predicate_result(|| predicate(&trace.steps, &trace.final_state))",
    fault:
      "predicate_result(|| { let mut result = Ok(true); for end in 1..=trace.steps.len() { result = predicate(&trace.steps[..end], &trace.steps[end - 1].next); if !matches!(&result, Ok(true)) { break; } } result })",
    witness: "pbt-trace.reducer.complete-before-check",
  },
  {
    id: "pbt-final-swallows-original-error",
    needle: "Ok(Err(error)) => Err(PredicateFailure::Error(error)),",
    fault: "Ok(Err(error)) => { drop(error); Err(PredicateFailure::False) },",
    witness: "pbt-trace.reducer.original-error-first",
  },
  {
    id: "pbt-final-substitutes-backend-handles",
    needle: "drop(minimum);",
    fault:
      "if let Some(evaluated) = failure.borrow_mut().as_mut() { evaluated.messages = minimum; }",
    native: true,
    witness:
      "final_modes_shrink_and_replay_original_evaluations_with_borrowed_typed_causes",
  },
];
export { faults as pbtFinalFaults };
const hash = (v) => createHash("sha256").update(v).digest("hex");
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
function adapter(root, binary, reportFile, witness) {
  const run = command(
    process.execPath,
    [
      "--import",
      join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
      join(root, "verification/parity/pbt-final.mts"),
      "--native-bin",
      binary,
      "--report",
      reportFile,
      ...(witness ? ["--case-id", witness] : []),
    ],
    { cwd: root },
  );
  assert([0, 1].includes(run.exit), JSON.stringify(run));
  return { run, report: JSON.parse(readFileSync(reportFile, "utf8")) };
}
export function pbtFinalMutations({
  binary,
  reportFile = "target/parity/pbt-final-controls.json",
  only,
} = {}) {
  assert(binary);
  const root = process.cwd(),
    source = readFileSync(owner, "utf8"),
    controls = [];
  reportFile = resolve(reportFile);
  mkdirSync(dirname(reportFile), { recursive: true });
  const baseline = adapter(
    root,
    resolve(binary),
    `${reportFile}.baseline.json`,
  );
  assert.equal(baseline.run.exit, 0);
  for (const f of faults.filter((f) => !only || only.includes(f.id))) {
    assert.equal(
      source.split(f.needle).length,
      2,
      `${f.id}: unique owner mutation`,
    );
    const mutationCheck = createCheckWorktree(
      process.cwd(),
      "pbt-final-mutations",
    );
    let mutationFailure;
    try {
      const temporary = mutationCheck.root,
        target = mutationCheck.target;
      try {
        const changed = source.replace(f.needle, f.fault);
        writeFileSync(join(temporary, owner), changed);
        const env = {
          ...process.env,
          CARGO_NET_OFFLINE: "true",
          CARGO_BUILD_JOBS: "1",
          CARGO_INCREMENTAL: "0",
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
        };
        const args = [
          f.native ? "test" : "build",
          ...(f.native ? ["--no-run"] : []),
          "--locked",
          "--offline",
          "--message-format=json",
          "-p",
          "demlik-tea",
          "--features",
          "pbt",
          f.native ? "--test" : "--example",
          f.native ? "pbt_final" : "pbt_property_driver",
        ];
        const build = command(process.env.CARGO ?? "cargo", args, {
          cwd: temporary,
          env,
        });
        assert.equal(
          build.exit,
          0,
          `Compile/setup failure is not a detection: ${f.id}\n${build.stderr}\n${build.stdout}`,
        );
        const rows = build.stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const executable = rows.find(
          (r) =>
            r.executable &&
            r.target.name === (f.native ? "pbt_final" : "pbt_property_driver"),
        )?.executable;
        assert(executable);
        let result, detectedIds;
        if (f.native) {
          const run = command(
            executable,
            [f.witness, "--exact", "--nocapture"],
            {
              cwd: temporary,
              env,
            },
          );
          assert.equal(run.exit, 101);
          assert(run.stdout.includes(`${f.witness} ... FAILED`));
          assert(
            run.stderr.includes("assertion failed: Arc::ptr_eq") ||
              run.stderr.includes(
                "returned messages must have been actually evaluated",
              ),
          );
          result = { run };
          detectedIds = [f.witness];
        } else {
          result = adapter(
            root,
            executable,
            join(temporary, "result.json"),
            f.witness,
          );
          assert.equal(
            result.run.exit,
            1,
            `${f.id}: behavioral mismatch required`,
          );
          detectedIds = result.report.failures.map((c) => c.id);
          assert(detectedIds.includes(f.witness));
        }
        const saved = resolve(
          "target/parity/control-binaries/pbt-final-controls",
          f.id,
        );
        mkdirSync(dirname(saved), { recursive: true });
        cpSync(executable, saved);
        controls.push({
          id: f.id,
          witness: f.witness,
          detectedIds,
          compiled: true,
          source: {
            path: owner,
            originalSha256: hash(source),
            mutatedSha256: hash(changed),
            needle: f.needle,
            fault: f.fault,
          },
          binary: { path: saved, sha256: hash(readFileSync(saved)) },
          build,
          result,
        });
        writeFileSync(
          `${reportFile}.progress.json`,
          `${JSON.stringify({ baseline: baseline.report.binary, controls }, null, 2)}\n`,
        );
      } finally {
        assert.equal(readFileSync(owner, "utf8"), source);
      }
    } catch (error) {
      mutationFailure = error;
      throw error;
    } finally {
      mutationCheck.remove(mutationFailure);
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
    semanticCases: 0,
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
    },
    strict: true,
  });
  const r = pbtFinalMutations({
    binary: values["native-bin"],
    reportFile: values.report,
    only: values.only,
  });
  console.log(
    JSON.stringify({
      controls: r.controls.length,
      detected: r.controls.length,
      activeSourceUnchanged: r.activeSourceUnchanged,
    }),
  );
}
