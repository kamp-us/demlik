import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const file = "crates/tea/src/agent/knob/runtime.rs";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const faults = [
  {
    id: "brain-success-bypasses-settlement",
    from: "Settlement::Ok(_) => reduce.succeed(state, msg, at),",
    to: "Settlement::Ok(crate::resilience::resilient_call::CallValue::Shared(value)) => reduce.turn(state, Rc::clone(&value.output), at),\n                            Settlement::Ok(_) => reduce.succeed(state, msg, at),",
    caseId: "agent-runtime.promise.normal",
    witness: (view) => assert.equal(view.state.calls.collect, "running"),
  },
  {
    id: "brain-failure-becomes-cancel",
    from: "Settlement::Err(_) => reduce.fail(state, msg, at),",
    to: "Settlement::Err(_) => reduce.cancel(state, at),",
    caseId: "agent-runtime.effect.model-error",
    witness: (view) => assert.equal(view.state.phase, "cancelled"),
  },
  {
    id: "brain-settles-without-engine-provenance",
    from: ".with_error_classifier(classify_brain)\n                .settle_in(v, edge)?",
    to: ".with_error_classifier(classify_brain)\n                .settle(v, edge.now())?",
    example: "agent_runtime_interface",
    assertion: "assert!(guard.check(&message).is_ok());",
  },
  {
    id: "loaded-init-resumes-before-explicit-boot",
    from: "Step::new(loaded.unwrap_or_else(|| init.init()), vec![])",
    to: 'let state = loaded.unwrap_or_else(|| init.init());\n                init.boot(&state, 17.25).expect("counterfeit auto boot")',
    caseId: "agent-runtime.promise.restart-brain",
    witness: (view) => assert.ok(view.restart.newModelCallsAtReady > 0),
  },
  {
    id: "declared-deadline-projection-is-swallowed",
    from: ".map(|list| (!list.is_empty()).then_some(list))\n                        .map_err(AgentMachineError::Agent)",
    to: ".map(|list| (!list.is_empty()).then_some(list))\n                        .map_err(AgentMachineError::Agent).or(Ok(None))",
    test: "agent_runtime",
    testName:
      "loaded_projection_refusal_retains_deadline_kind_and_declared_agent_error",
    diagnostic: "projection fails ready",
  },
  {
    id: "only-first-deadline-is-armed",
    from: ".map(|list| (!list.is_empty()).then_some(list))",
    to: ".map(|list| { let list = list.into_iter().take(1).collect::<Vec<_>>(); (!list.is_empty()).then_some(list) })",
    caseId: "agent-runtime.effect.retry-once",
    witness: (view) =>
      assert.ok(
        !view.timers.some(
          (row, i, rows) =>
            row[0] === "arm" &&
            row[1] === 22.25 &&
            rows[i + 1]?.[0] === "arm" &&
            rows[i + 1]?.[1] === 100,
        ),
      ),
  },
  {
    id: "bare-tool-error-is-routed-to-cancel",
    from: "reduce.tool_err_reason(state, call_id, reason, *at)",
    to: "reduce.cancel(state, *at)",
    caseId: "agent-runtime.promise.bad-total",
    witness: (view) => assert.equal(view.state.phase, "cancelled"),
  },
  {
    id: "tool-work-cleanup-is-dropped",
    from: "cleanup: work.cleanup,",
    to: "cleanup: None,",
    example: "agent_runtime_interface",
    assertion: "assert_eq!(cleanups.get(), 1);",
  },
  {
    id: "configured-message-loader-is-ignored",
    from: "BrainPorts::new(&self.model).with_loader(&self.loader)",
    to: "BrainPorts::new(&self.model)",
    caseId: "agent-runtime.effect.normal",
    witness: (view) => {
      assert.equal(view.modelCalls, 0);
      assert.ok(view.reports.some((row) => row[0] === "interpret"));
    },
  },
];

const args = process.argv.slice(2);
let baselineFile, evidence;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--baseline") baselineFile = path.resolve(args[++i]);
  else if (args[i] === "--evidence") evidence = path.resolve(args[++i]);
  else throw new Error(`unknown argument ${args[i]}`);
}
assert.ok(baselineFile && evidence, "--baseline and --evidence are required");
fs.mkdirSync(evidence, { recursive: true });
const baselineBytes = fs.readFileSync(baselineFile);
const baseline = JSON.parse(baselineBytes);
assert.equal(baseline.passed, 34);
assert.equal(baseline.failures.length, 0);
assert.equal(new Set(baseline.rows.map((row) => row.id)).size, 34);
assert.equal(
  sha(fs.readFileSync(baseline.binary.path)),
  baseline.binary.sha256,
);
const original = fs.readFileSync(path.join(root, file), "utf8");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const env = cargoCheckEnvironment({
  CARGO_NET_OFFLINE: "true",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
});
for (const key of [
  "CARGO_BUILD_TARGET",
  "CARGO_BUILD_TARGET_DIR",
  "CARGO_BUILD_BUILD_DIR",
  "CARGO_TARGET_TMPDIR",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTFLAGS",
  "CARGO_ENCODED_RUSTFLAGS",
])
  delete env[key];
const controls = [];
const reportFile = path.join(evidence, "report.json");
function save(extra = {}) {
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ sourceCommit, baselineFile, baselineSha256: sha(baselineBytes), baselineBinarySha256: baseline.binary.sha256, originalSourceSha256: sha(original), controls, ...extra }, null, 2)}\n`,
  );
}
save({ complete: false });
for (const fault of faults) {
  const directory = path.join(evidence, fault.id);
  fs.mkdirSync(directory, { recursive: true });
  const control = { id: fault.id, complete: false, detected: false };
  controls.push(control);
  let check;
  try {
    console.log(JSON.stringify({ starting: fault.id }));
    check = createCheckWorktree(root, `agent-${fault.id}`, directory);
    const source = path.join(check.root, file);
    const before = fs.readFileSync(source, "utf8");
    assert.equal(before, original, "fault starts from the frozen source");
    assert.equal(before.split(fault.from).length - 1, 1);
    const changed = before.replace(fault.from, fault.to);
    fs.writeFileSync(source, changed);
    fs.writeFileSync(path.join(directory, "modified-runtime.rs"), changed);
    control.source = {
      path: source,
      beforeSha256: sha(before),
      sha256: sha(changed),
    };
    const targetName = fault.test ?? fault.example ?? "agent_runtime_driver";
    const command = fault.test
      ? [
          "test",
          "--locked",
          "--offline",
          "-p",
          "demlik-tea",
          "--no-run",
          "--test",
          targetName,
          "--message-format=json",
        ]
      : [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-tea",
          "--example",
          targetName,
          "--message-format=json",
        ];
    const built = spawnSync(process.env.CARGO ?? "cargo", command, {
      cwd: check.root,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(directory, "cargo.jsonl"), built.stdout ?? "");
    fs.writeFileSync(path.join(directory, "cargo.stderr"), built.stderr ?? "");
    control.build = {
      command,
      exit: built.status,
      error: built.error ? String(built.error) : null,
    };
    save({ complete: false });
    assert.ifError(built.error);
    assert.equal(built.status, 0, "compilation failure is never a detection");
    const records = built.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const library = compiledCheckLibrary(
      records,
      "demlik_tea",
      check.root,
      check.target,
    );
    control.library = {
      ...library,
      sha256: sha(fs.readFileSync(library.path)),
      sourceSha256: sha(fs.readFileSync(library.sourcePath)),
      libraryRetained: false,
    };
    const outputs = records.filter(
      (row) =>
        row.reason === "compiler-artifact" &&
        row.target.name === targetName &&
        row.executable,
    );
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].fresh, false);
    assertCheckPath(outputs[0].target.src_path, check.root);
    assertCheckPath(outputs[0].manifest_path, check.root);
    const binary = assertCheckPath(outputs[0].executable, check.target);
    const executable = path.join(directory, "executed-bin");
    fs.copyFileSync(binary, executable);
    fs.chmodSync(executable, 0o755);
    const binaryHash = sha(fs.readFileSync(binary));
    assert.equal(sha(fs.readFileSync(executable)), binaryHash);
    control.binary = {
      producer: outputs[0],
      path: executable,
      sha256: binaryHash,
    };
    const testCase = fault.caseId
      ? baseline.rows.find((row) => row.id === fault.caseId)
      : null;
    assert.ok(!fault.caseId || testCase);
    const runArgs = fault.test
      ? ["--exact", fault.testName, "--nocapture"]
      : [];
    const input = testCase
      ? `${JSON.stringify({ id: testCase.id, ...testCase.input })}\n`
      : undefined;
    control.request = {
      args: runArgs,
      input,
      witness: fault.caseId ?? fault.testName ?? fault.assertion,
    };
    const run = spawnSync(executable, runArgs, {
      cwd: check.root,
      env,
      input,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
    });
    fs.writeFileSync(path.join(directory, "run.stdout"), run.stdout ?? "");
    fs.writeFileSync(path.join(directory, "run.stderr"), run.stderr ?? "");
    control.process = {
      exit: run.status,
      error: run.error ? String(run.error) : null,
      stdoutSha256: sha(run.stdout ?? ""),
      stderrSha256: sha(run.stderr ?? ""),
    };
    save({ complete: false });
    assert.ifError(run.error);
    if (testCase) {
      assert.equal(run.status, 0, "driver process failure is not a detection");
      const lines = run.stdout.trim().split("\n");
      assert.equal(lines.length, 1);
      const actual = JSON.parse(lines[0]);
      assert.equal(actual.id, testCase.id);
      assert.ok(
        Array.isArray(actual.calls) &&
          actual.calls.includes("demlik_tea::agent::Agent::to_machine"),
      );
      assert.notDeepEqual(actual.view, testCase.source.view);
      fault.witness(actual.view);
      control.observed = actual;
      control.expected = testCase.source;
    } else {
      assert.equal(run.status, 101, "the intended native assertion must fail");
      if (fault.test) assert.ok(run.stderr.includes(fault.diagnostic));
      else {
        const text = fs.readFileSync(
          path.join(root, "crates/tea/examples/agent_runtime_interface.rs"),
          "utf8",
        );
        const lines = text.split("\n");
        const line =
          lines.findIndex((row) => row.trim() === fault.assertion) + 1;
        assert.ok(line > 0);
        assert.ok(
          run.stderr.includes(`agent_runtime_interface.rs:${line}:`),
          run.stderr,
        );
        control.assertion = {
          source: "crates/tea/examples/agent_runtime_interface.rs",
          line,
          text: fault.assertion,
        };
      }
    }
    assert.equal(sha(fs.readFileSync(executable)), binaryHash);
    control.detected = true;
    control.complete = true;
  } catch (error) {
    control.error = String(error);
    save({ complete: false });
    throw error;
  } finally {
    if (check) check.remove();
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), original);
    assert.equal(
      sha(fs.readFileSync(baseline.binary.path)),
      baseline.binary.sha256,
    );
    save({
      complete:
        controls.length === faults.length &&
        controls.every((row) => row.complete && row.detected),
    });
  }
  console.log(
    JSON.stringify({ completed: fault.id, detected: control.detected }),
  );
}
assert.ok(controls.every((control) => control.detected));
console.log(
  JSON.stringify({ controls: controls.length, detected: controls.length }),
);
