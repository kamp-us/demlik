import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentErrorParity } from "./agent-error-run.mjs";
import { agentGuardControls } from "./agent-guards-mutations.mjs";
import { agentGuardsParity } from "./agent-guards-run.mjs";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  sha = (b) => createHash("sha256").update(b).digest("hex");
const owner = "crates/tea/src/agent/schema.rs";
const controls = [
  {
    name: "live-fields-leak",
    file: owner,
    edits: [
      [
        "Self::Live(_) => serializer.serialize_map(Some(0))?.end(),",
        'Self::Live(_) => {let mut map=serializer.serialize_map(Some(1))?;map.serialize_entry("leaked",&true)?;map.end()},',
      ],
    ],
    id: "agent-error.guard-null",
    witness: (row) => assert.equal(row.native.result.wire.leaked, true),
  },
  {
    name: "false-live-revival",
    file: owner,
    edits: [
      [
        "PlainData::deserialize(deserializer).map(|value| Self::Plain(Rc::new(value)))",
        'PlainData::deserialize(deserializer).map(|value| Self::Live(StructuredOutputRejection { value:Rc::new(value),expected:"an AgentTurn" }))',
      ],
    ],
    id: "agent-error.guard-null",
    witness: (row) => assert.equal(row.native.result.decodedKind, "live"),
  },
  {
    name: "message-shaped-data-misclassified",
    file: owner,
    edits: [
      [
        "Self::Plain(value) => describe_error(ErrorView::Value(value)),",
        'Self::Plain(value) => {if let PlainData::Object(fields)=value.as_ref() && let Some(PlainData::String(message))=fields.get("message") {return describe_error(ErrorView::ErrorMessage(message));} describe_error(ErrorView::Value(value))},',
      ],
    ],
    id: "agent-error.plain-message-shaped",
    witness: (row) =>
      assert.deepEqual(row.native.result.description, {
        ok: true,
        value: "not a real Error",
      }),
  },
  {
    name: "coercion-error-swallowed",
    file: owner,
    edits: [
      [
        "Self::Plain(value) => describe_error(ErrorView::Value(value)),",
        'Self::Plain(value) => describe_error(ErrorView::Value(value)).or_else(|_| Ok("swallowed".into())),',
      ],
    ],
    id: "agent-error.plain-coercion-fails",
    witness: (row) =>
      assert.deepEqual(row.native.result.description, {
        ok: true,
        value: "swallowed",
      }),
  },
  ...agentGuardControls
    .filter((c) =>
      ["schema-remints-the-original", "schema-refusal-message-lost"].includes(
        c.name,
      ),
    )
    .map((c) => ({
      ...c,
      id: c.ids[0],
      guard: true,
      witness: (row) => {
        if (c.name === "schema-remints-the-original")
          assert.equal(row.native.output.turnParsed.sameOriginal, false);
        else
          assert.equal(
            row.native.output.turnParsed.error.message,
            "structured-output parse failed: an AgentTurn",
          );
      },
    })),
];
assert.equal(controls.length, 6);
let baselineFile, evidence, only;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--baseline") baselineFile = path.resolve(args[++i]);
  else if (args[i] === "--evidence") evidence = path.resolve(args[++i]);
  else if (args[i] === "--only") only = args[++i];
  else throw new Error(`unknown ${args[i]}`);
}
assert.ok(baselineFile && evidence);
const selected = only
  ? controls.filter((control) => control.name === only)
  : controls;
assert.ok(selected.length > 0, "known control selection required");
fs.mkdirSync(evidence, { recursive: true });
const baselineBytes = fs.readFileSync(baselineFile),
  baseline = JSON.parse(baselineBytes);
assert.equal(baseline.passed, 23);
assert.equal(baseline.unqualifiedPairs, 19);
assert.equal(baseline.qualifiedPairs, 4);
assert.deepEqual(baseline.failures, []);
for (const pin of [baseline.binary, baseline.coldBinary])
  assert.equal(sha(fs.readFileSync(pin.path)), pin.sha256);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  original = fs.readFileSync(path.join(root, owner), "utf8"),
  results = [];
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
let failure;
function save(extra = {}) {
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ sourceCommit, baselineFile, baselineSha256: sha(baselineBytes), baselineBinarySha256: baseline.binary.sha256, originalSourceSha256: sha(original), controls: results, selectedControlNames: selected.map((control) => control.name), ...(failure ? { failure } : {}), ...extra }, null, 2)}\n`,
  );
}
save({ complete: false });
try {
  check = createCheckWorktree(root, "agent-error-controls", evidence);
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
  for (const fault of selected) {
    const directory = path.join(evidence, fault.name);
    fs.mkdirSync(directory);
    const record = {
      name: fault.name,
      caseId: fault.id,
      guardDefinitionReused: Boolean(fault.guard),
      complete: false,
      detected: false,
    };
    results.push(record);
    fs.writeFileSync(path.join(check.root, owner), original);
    let changed = original;
    for (const [from, to] of fault.edits) {
      assert.equal(changed.split(from).length - 1, 1);
      changed = changed.replace(from, to);
    }
    fs.writeFileSync(path.join(check.root, fault.file), changed);
    fs.writeFileSync(path.join(directory, "modified-source.rs"), changed);
    record.source = {
      path: path.join(check.root, fault.file),
      beforeSha256: sha(original),
      sha256: sha(changed),
    };
    const targetName = fault.guard
        ? "agent_guards_driver"
        : "agent_error_driver",
      command = [
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
      maxBuffer: 32 << 20,
    });
    fs.writeFileSync(path.join(directory, "cargo.jsonl"), built.stdout ?? "");
    fs.writeFileSync(path.join(directory, "cargo.stderr"), built.stderr ?? "");
    record.build = {
      command,
      exit: built.status,
      error: built.error ? String(built.error) : null,
    };
    save({ complete: false });
    assert.ifError(built.error);
    assert.equal(built.status, 0, "compile failure is never detection");
    const rows = built.stdout
        .split("\n")
        .filter((x) => x.startsWith("{"))
        .map(JSON.parse),
      library = compiledCheckLibrary(
        rows,
        "demlik_tea",
        check.root,
        check.target,
      );
    record.library = {
      ...library,
      sha256: sha(fs.readFileSync(library.path)),
      sourceSha256: sha(fs.readFileSync(library.sourcePath)),
      libraryRetained: false,
    };
    const outputs = rows.filter(
      (r) =>
        r.reason === "compiler-artifact" &&
        r.target.name === targetName &&
        r.executable,
    );
    assert.equal(outputs.length, 1);
    const driver = outputs[0];
    assert.equal(driver.fresh, false);
    assertCheckPath(driver.target.src_path, check.root);
    assertCheckPath(driver.manifest_path, check.root);
    const actual = assertCheckPath(driver.executable, check.target),
      executed = path.join(directory, "executed-bin");
    fs.copyFileSync(actual, executed);
    fs.chmodSync(executed, 0o755);
    record.driver = {
      artifact: driver,
      actual,
      executed,
      sha256: sha(fs.readFileSync(executed)),
    };
    assert.equal(sha(fs.readFileSync(actual)), record.driver.sha256);
    save({ complete: false });
    let report, witness;
    if (fault.guard) {
      report = await agentGuardsParity({
        binary: executed,
        quiet: true,
        allowFailures: true,
        caseIds: [fault.id],
        reportFile: path.join(directory, "paired.json"),
      });
      assert.equal(report.cases, 1);
      assert.equal(report.failures.length, 1);
      witness = report.failures[0];
      assert.equal(witness.native.ok, true);
      assert.ok(witness.native.observedCalls.length);
    } else {
      report = agentErrorParity({
        binary: executed,
        coldBinary: baseline.coldBinary.path,
        cases: [fault.id],
        output: path.join(directory, "paired.json"),
      });
      assert.equal(report.cases, 1);
      assert.equal(report.failures.length, 1);
      witness = report.rows[0];
      assert.ok(witness.native.calls.length);
    }
    assert.equal(witness.id, fault.id);
    record.witness = witness;
    save({ complete: false });
    fault.witness(witness);
    assert.equal(sha(fs.readFileSync(executed)), record.driver.sha256);
    record.detected = true;
    record.complete = true;
    save({ complete: false });
  }
  fs.writeFileSync(path.join(check.root, owner), original);
  assert.equal(fs.readFileSync(path.join(root, owner), "utf8"), original);
  assert.equal(
    sha(fs.readFileSync(baseline.binary.path)),
    baseline.binary.sha256,
  );
  save({ complete: true, passed: results.filter((r) => r.detected).length });
} catch (error) {
  failure = { error: String(error), stack: error.stack };
  save({ complete: false });
  throw error;
} finally {
  if (check) {
    check.remove();
    save({
      complete:
        results.length === selected.length &&
        results.every((r) => r.complete && r.detected),
      removed: true,
      passed: results.filter((r) => r.detected).length,
    });
  }
}
