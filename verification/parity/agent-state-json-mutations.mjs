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

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
let baselineFile, evidence;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--baseline") baselineFile = path.resolve(args[++i]);
  else if (args[i] === "--evidence") evidence = path.resolve(args[++i]);
  else throw new Error(`unknown ${args[i]}`);
}
assert.ok(baselineFile && evidence);
fs.mkdirSync(evidence, { recursive: true });
const baselineBytes = fs.readFileSync(baselineFile),
  baseline = JSON.parse(baselineBytes);
assert.equal(baseline.passed, 12);
assert.deepEqual(baseline.failures, []);
assert.equal(
  hash(fs.readFileSync(baseline.binary.path)),
  baseline.binary.sha256,
);
const driver = "crates/tea/examples/agent_state_json_driver.rs",
  turn = "crates/tea/src/agent/turn_view.rs",
  runtime = "crates/tea/src/agent/knob/runtime.rs";
const faults = [
  {
    id: "app-error-wire-fabricates-fields",
    file: driver,
    caseId: "agent-state-json.promise.guard-error",
    from: "Self::Model(_) | Self::Guard(_) => s.serialize_map(Some(0))?.end(),",
    to: 'Self::Model(_) | Self::Guard(_) => { let mut map=s.serialize_map(Some(1))?; map.serialize_entry("leaked",&true)?; map.end() },',
    witness: (r) =>
      assert.equal(r.native.writer.view.wire.failure.error.error.leaked, true),
  },
  {
    id: "decoded-call-drops-unknown-field",
    file: turn,
    caseId: "agent-state-json.effect.tools",
    from: "let owner = Rc::new(PlainData::deserialize(deserializer)?);",
    to: 'let mut value=PlainData::deserialize(deserializer)?; if let PlainData::Object(fields)=&mut value {fields.shift_remove("unknownCall");} let owner=Rc::new(value);',
    witness: (r) => {
      assert.equal(
        Object.hasOwn(
          r.native.writer.view.wire.tools.running[0],
          "unknownCall",
        ),
        true,
      );
      assert.equal(
        Object.hasOwn(
          r.native.reader.view.ready.wire.tools.running[0],
          "unknownCall",
        ),
        false,
      );
    },
  },
  {
    id: "cold-loaded-init-runs-before-boot",
    file: runtime,
    caseId: "agent-state-json.promise.tools",
    from: "Step::new(loaded.unwrap_or_else(|| init.init()), vec![])",
    to: 'match loaded {Some(state)=>init.boot(&state,50.0).expect("counterfeit eager cold boot"),None=>Step::new(init.init(),vec![])}',
    witness: (r) =>
      assert.ok(
        r.native.reader.view.ready.modelCalls > 0 ||
          r.native.reader.view.ready.toolCalls > 0,
      ),
  },
];
const original = Object.fromEntries(
  faults.map((f) => [f.file, fs.readFileSync(path.join(root, f.file), "utf8")]),
);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  controls = [];
const env = cargoCheckEnvironment({
  CARGO_NET_OFFLINE: "true",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
});
for (const key of [
  "CARGO_BUILD_TARGET",
  "CARGO_TARGET_TMPDIR",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTFLAGS",
  "CARGO_ENCODED_RUSTFLAGS",
])
  delete env[key];
const reportFile = path.join(evidence, "report.json");
let check;
function save(extra = {}) {
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ sourceCommit, baselineFile, baselineSha256: hash(baselineBytes), baselineBinarySha256: baseline.binary.sha256, controls, ...extra }, null, 2)}\n`,
  );
}
save({ complete: false });
try {
  check = createCheckWorktree(root, "agent-state-json-controls", evidence);
  for (const relative of [
    "node_modules",
    "verification/parity/node_modules",
    "packages/tea/node_modules",
    "packages/code-graph/node_modules",
  ]) {
    const src = path.join(root, relative),
      dest = path.join(check.root, relative);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(fs.realpathSync(src), dest);
    }
  }
  for (const fault of faults) {
    for (const [file, bytes] of Object.entries(original))
      fs.writeFileSync(path.join(check.root, file), bytes);
    const record = {
      id: fault.id,
      caseId: fault.caseId,
      owner:
        fault.file === driver
          ? "application-codec-fixture"
          : "canonical-library",
      complete: false,
      detected: false,
    };
    controls.push(record);
    const folder = path.join(evidence, fault.id);
    fs.mkdirSync(folder);
    const before = fs.readFileSync(path.join(check.root, fault.file), "utf8");
    assert.equal(before, original[fault.file]);
    assert.equal(before.split(fault.from).length, 2);
    const after = before.replace(fault.from, fault.to);
    fs.writeFileSync(path.join(check.root, fault.file), after);
    fs.writeFileSync(path.join(folder, "modified.rs"), after);
    record.source = {
      file: fault.file,
      beforeSha256: hash(before),
      sha256: hash(after),
    };
    const command = [
      "build",
      "--locked",
      "--offline",
      "-p",
      "demlik-tea",
      "--example",
      "agent_state_json_driver",
      "--message-format=json",
    ];
    const build = spawnSync(process.env.CARGO ?? "cargo", command, {
      cwd: check.root,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(folder, "cargo.jsonl"), build.stdout ?? "");
    fs.writeFileSync(path.join(folder, "cargo.stderr"), build.stderr ?? "");
    record.build = {
      command,
      exit: build.status,
      error: build.error ? String(build.error) : null,
    };
    save({ complete: false });
    assert.ifError(build.error);
    assert.equal(build.status, 0, "compilation failure is never detection");
    const rows = build.stdout.split("\n").filter(Boolean).map(JSON.parse),
      lib = compiledCheckLibrary(rows, "demlik_tea", check.root, check.target),
      programs = rows.filter(
        (r) =>
          r.reason === "compiler-artifact" &&
          r.target.name === "agent_state_json_driver" &&
          r.executable,
      );
    assert.equal(programs.length, 1);
    assert.equal(programs[0].fresh, false);
    assertCheckPath(programs[0].target.src_path, check.root);
    assertCheckPath(programs[0].manifest_path, check.root);
    const binary = assertCheckPath(programs[0].executable, check.target),
      executed = path.join(folder, "executed.bin");
    fs.copyFileSync(binary, executed);
    fs.chmodSync(executed, 0o755);
    record.binary = {
      producer: programs[0],
      path: executed,
      sha256: hash(fs.readFileSync(executed)),
    };
    const library = path.join(folder, "library.rlib");
    fs.copyFileSync(lib.path, library);
    record.library = {
      ...lib,
      path: library,
      sha256: hash(fs.readFileSync(library)),
    };
    const pairs = path.join(folder, "pairs.json"),
      run = spawnSync(
        process.execPath,
        [
          path.join(check.root, "verification/parity/agent-state-json-run.mjs"),
          "--binary",
          executed,
          "--output",
          pairs,
          "--cases",
          fault.caseId,
        ],
        {
          cwd: check.root,
          env,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120000,
        },
      );
    fs.writeFileSync(path.join(folder, "run.stdout"), run.stdout ?? "");
    fs.writeFileSync(path.join(folder, "run.stderr"), run.stderr ?? "");
    record.process = {
      exit: run.status,
      signal: run.signal,
      error: run.error ? String(run.error) : null,
    };
    save({ complete: false });
    assert.ifError(run.error);
    assert.equal(run.status, 1);
    assert.equal(run.signal, null);
    const actual = JSON.parse(fs.readFileSync(pairs));
    record.reportSha256 = hash(fs.readFileSync(pairs));
    record.failures = actual.failures;
    record.observed = actual.rows[0];
    save({ complete: false });
    assert.equal(actual.cases, 1);
    assert.ok(
      actual.failures.some(
        (f) => f.id === fault.caseId && f.kind === "semantic",
      ),
    );
    assert.ok(
      record.observed.native.reader &&
        record.observed.native.writer &&
        record.observed.source.reader &&
        record.observed.source.writer,
      "four valid processes, no protocol/setup detection",
    );
    fault.witness(record.observed);
    assert.equal(hash(fs.readFileSync(executed)), record.binary.sha256);
    assert.equal(
      hash(fs.readFileSync(baseline.binary.path)),
      baseline.binary.sha256,
    );
    for (const [file, bytes] of Object.entries(original))
      assert.equal(fs.readFileSync(path.join(root, file), "utf8"), bytes);
    record.detected = true;
    record.complete = true;
    save({ complete: false });
    console.log(JSON.stringify({ completed: fault.id, detected: true }));
  }
  save({
    complete: true,
    planned: 3,
    defaultTarget: true,
    restorePerFault: true,
  });
} catch (e) {
  save({ complete: false, error: String(e) });
  throw e;
} finally {
  if (check) check.remove();
}
