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
const sha = (value) => createHash("sha256").update(value).digest("hex");
const faults = [
  {
    id: "plain-cursor-copies-owner",
    file: "crates/tea/src/agent/turn_view.rs",
    from: "owner: Rc::clone(value),",
    to: "owner: Rc::new(value.as_ref().clone()),",
    caseId: "agent-turn.promise.normal.extras",
    witness: (view) => assert.equal(view.ownership.callOriginal, false),
  },
  {
    id: "call-codec-drops-unknown-fields",
    file: "crates/tea/src/agent/turn_view.rs",
    from: "JsonData(self.raw_call()).serialize(serializer)",
    to: `use serde::ser::SerializeMap;
        let mut fields=serializer.serialize_map(Some(3))?;
        fields.serialize_entry("callId",self.call_id())?;
        fields.serialize_entry("name",self.name())?;
        fields.serialize_entry("args",&JsonData(self.args()))?;
        fields.end()`,
    caseId: "agent-turn.effect.normal.extras",
    witness: (view) =>
      assert.equal(
        Object.hasOwn(view.codecs[0].record.call, "unknownCall"),
        false,
      ),
  },
  {
    id: "last-duplicate-wins",
    file: "crates/tea/src/agent/conversation.rs",
    from: `calls
        .iter()
        .filter(|call| seen.insert(id(call)))
        .map(Rc::clone)
        .collect()`,
    to: `calls
        .iter().rev()
        .filter(|call| seen.insert(id(call)))
        .map(Rc::clone)
        .collect()`,
    caseId: "agent-turn.promise.duplicate.array-args",
    witness: (view) => {
      assert.equal(view.ownership.firstWins, false);
      assert.deepEqual(view.selections[0].slice(1), [
        "second",
        "duplicate.json",
      ]);
      assert.equal(view.codecs[0].record.outcome.result.value, 100);
    },
  },
  {
    id: "native-reader-reconstructs-call",
    file: "crates/tea/src/agent/turn_view.rs",
    from: "calls: fields.tool_calls.iter().map(Rc::clone).collect(),",
    to: "calls: fields.tool_calls.iter().map(|call| Rc::new(ToolCall {call_id:call.call_id.clone(),name:call.name.clone(),args:Rc::clone(&call.args)})).collect(),",
    test: "agent_turn_owners",
    testName:
      "native_call_owner_survives_opaque_invoice_tool_and_record_workflow",
    diagnostic: "native invoice call keeps original owner",
  },
  {
    id: "unreported-usage-becomes-zero",
    file: "crates/tea/src/agent/turn_view.rs",
    from: "None | Some(PlainData::Undefined) => None,",
    to: "None | Some(PlainData::Undefined) => Some(TurnUsage::new(0.0, 0.0)),",
    caseId: "agent-turn.effect.normal.usage-missing",
    witness: (view) => {
      assert.ok(
        view.usageReadings.some(
          (r) => r[1] === "collect" && r[2] === "tools" && r[4] === 0,
        ),
      );
      assert.ok(
        !view.usageReadings.some(
          (r) => r[1] === "collect" && r[2] === "tools" && r[4] === null,
        ),
      );
    },
  },
  {
    id: "loaded-init-resumes-without-boot",
    file: "crates/tea/src/agent/knob/runtime.rs",
    from: "Step::new(loaded.unwrap_or_else(|| init.init()), vec![])",
    to: `let state=loaded.unwrap_or_else(||init.init());
                init.boot(&state,17.25).expect("counterfeit auto boot")`,
    caseId: "agent-turn.promise.restart-tool.extras",
    witness: (view) => {
      assert.ok(view.restart.newToolCallsAtReady > 0);
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
assert.equal(baseline.passed, 54);
assert.equal(baseline.failures.length, 0);
assert.equal(new Set(baseline.rows.map((row) => row.id)).size, 54);
assert.equal(
  sha(fs.readFileSync(baseline.binary.path)),
  baseline.binary.sha256,
);
const originals = Object.fromEntries(
  [...new Set(faults.map((f) => f.file))].map((file) => [
    file,
    fs.readFileSync(path.join(root, file), "utf8"),
  ]),
);
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
    `${JSON.stringify({ sourceCommit, baselineFile, baselineSha256: sha(baselineBytes), baselineBinarySha256: baseline.binary.sha256, originalSourceSha256: Object.fromEntries(Object.entries(originals).map(([file, source]) => [file, sha(source)])), controls, ...extra }, null, 2)}\n`,
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
    check = createCheckWorktree(root, `agent-turn-${fault.id}`, directory);
    const file = fault.file;
    const original = originals[file];
    const source = path.join(check.root, file);
    const before = fs.readFileSync(source, "utf8");
    assert.equal(before, original, "fault starts from the frozen source");
    assert.equal(before.split(fault.from).length - 1, 1);
    const changed = before.replace(fault.from, fault.to);
    fs.writeFileSync(source, changed);
    fs.writeFileSync(path.join(directory, "modified-source.rs"), changed);
    control.source = {
      path: source,
      beforeSha256: sha(before),
      sha256: sha(changed),
    };
    const targetName = fault.test ?? fault.example ?? "agent_turn_driver";
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
      control.observed = actual;
      control.expected = testCase.source;
      save({ complete: false });
      assert.notDeepEqual(actual.view, testCase.source.view);
      fault.witness(actual.view);
    } else {
      assert.equal(run.status, 101, "the intended native assertion must fail");
      assert.ok(
        fault.test && run.stderr.includes(fault.diagnostic),
        run.stderr,
      );
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
    for (const [file, original] of Object.entries(originals))
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
