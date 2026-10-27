import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ledger = "crates/code-graph/src/smells/ledger.rs",
  render = "crates/code-graph/src/smells/ledger_render.rs",
  gate = "crates/code-graph/src/smells/gate.rs";
function once(source, needle, replacement) {
  assert.equal(source.split(needle).length, 2, `unique fault site: ${needle}`);
  return source.replace(needle, replacement);
}
export const smellLedgerFaults = [
  {
    id: "first-finding-wins",
    owner: ledger,
    witness: "pure.duplicate-last.text",
    apply: (s) =>
      once(
        s,
        "found.insert(smell_key(finding), finding);",
        "found.entry(smell_key(finding)).or_insert(finding);",
      ),
  },
  {
    id: "scope-prefix-without-slash",
    owner: ledger,
    witness: "pure.sibling-scope.text",
    apply: (s) => once(s, 'prefix.push_str("/");', 'prefix.push_str("");'),
  },
  {
    id: "prune-unmeasured",
    owner: ledger,
    witness: "pure.unmeasured.text",
    apply: (s) =>
      once(
        s,
        "if !in_play(finding.rule) || !in_reach {",
        "if !ledger.gated.contains(&finding.rule) || !in_reach {",
      ),
  },
  {
    id: "raise-kept-ceiling",
    owner: ledger,
    witness: "pure.worsened.text",
    apply: (s) =>
      once(
        s,
        "value: minimum(finding.value, measured.value),",
        "value: measured.value,",
      ),
  },
  {
    id: "remint-retained-entry",
    owner: ledger,
    witness: "pure.retained.text",
    apply: (s) =>
      once(
        s,
        "kept.push(Arc::clone(entry));",
        "kept.push(Arc::new(SmellLedgerEntry { finding: SmellFinding { rule: finding.rule, target: finding.target.clone(), value: finding.value }, reason: entry.reason.clone() }));",
      ),
  },
  {
    id: "drop-accepted-reason",
    owner: ledger,
    witness: "pure.accepted-reason.text",
    apply: (s) => {
      assert.equal(s.split("reason: reason.clone(),").length, 3);
      return s.replaceAll(
        "reason: reason.clone(),",
        "reason: JsString::default(),",
      );
    },
  },
  {
    id: "lowering-fails-gate",
    owner: render,
    witness: "pure.lowered.text",
    apply: (s) =>
      once(
        s,
        "let passed = result.unrecorded.is_empty() && result.worsened.is_empty();",
        "let passed = result.unrecorded.is_empty() && result.worsened.is_empty() && result.lowered.is_empty();",
      ),
  },
  {
    id: "skip-ratchet-write",
    owner: gate,
    witness: "run.lowered-before-emit-error",
    apply: (s) =>
      once(
        s,
        "if !result.pruned.is_empty() || !result.lowered.is_empty() {",
        "if false {",
      ),
  },
  {
    id: "rewrite-noop",
    owner: gate,
    witness: "run.repeat-no-write",
    apply: (s) => once(s, "if changed > 0 {", "if true {"),
  },
  {
    id: "json-passed-key",
    owner: render,
    witness: "pure.empty.json",
    apply: (s) =>
      once(
        s,
        "            passed: bool,",
        '            #[serde(rename = "kept")]\n            passed: bool,',
      ),
  },
  {
    id: "prune-section-before-lowering",
    owner: render,
    witness: "pure.sections.text",
    apply: (s) => {
      const start = s.indexOf("fn written_back_lines("),
        end = s.indexOf("pub fn render_smell_ledger_gate(");
      assert.ok(start >= 0 && end > start);
      const body = s.slice(start, end),
        lowerStart = body.indexOf("    if !result.lowered.is_empty()"),
        prunedStart = body.indexOf("    if !result.pruned.is_empty()"),
        tail = body.lastIndexOf("    lines\n}");
      assert.ok(
        lowerStart >= 0 && prunedStart > lowerStart && tail > prunedStart,
      );
      return (
        s.slice(0, start) +
        body.slice(0, lowerStart) +
        body.slice(prunedStart, tail) +
        body.slice(lowerStart, prunedStart) +
        body.slice(tail) +
        s.slice(end)
      );
    },
  },
  {
    id: "serialized-final-lf",
    owner: ledger,
    witness: "pure.empty.text",
    apply: (s) =>
      once(
        s,
        "    text.push('\\n');",
        "    // This control omits the ledger final LF.",
      ),
  },
  {
    id: "nan-ignoring-minimum",
    owner: ledger,
    witness: "pure.numeric-6-4",
    apply: (s) => {
      const start = s.indexOf("fn minimum("),
        end = s.indexOf("pub fn reconcile_smells");
      assert.ok(start >= 0 && end > start);
      return (
        s.slice(0, start) +
        "fn minimum(left: f64, right: f64) -> f64 { left.min(right) }\n" +
        s.slice(end)
      );
    },
  },
];
function invoke(command, cwd, env) {
  const r = spawnSync(command[0], command.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 96 << 20,
  });
  return {
    command,
    cwd,
    exit: r.status,
    signal: r.signal,
    error: r.error?.message,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}
function retain(file, directory, name) {
  const bytes = fs.readFileSync(file),
    to = path.join(directory, `${name}.gz`);
  fs.writeFileSync(to, gzipSync(bytes));
  return {
    original: file,
    sha256: hash(bytes),
    retained: to,
    gzipSha256: hash(fs.readFileSync(to)),
  };
}
export function smellLedgerMutations({ baseline, baselineReport, evidence }) {
  fs.mkdirSync(evidence, { recursive: true });
  const trusted = JSON.parse(fs.readFileSync(baselineReport, "utf8")),
    baselineHash = hash(fs.readFileSync(baseline));
  assert.equal(trusted.binary.sha256, baselineHash);
  assert.deepEqual(trusted.failures, []);
  assert.equal(trusted.passed, 139);
  assert.equal(trusted.strict, 135);
  assert.equal(trusted.qualified, 4);
  assert.equal(trusted.protocolRefusals, 4);
  const original = Object.fromEntries(
    [ledger, render, gate].map((f) => [
      f,
      fs.readFileSync(path.join(root, f), "utf8"),
    ]),
  );
  for (const f of smellLedgerFaults) {
    const modified = f.apply(original[f.owner]);
    assert.notEqual(modified, original[f.owner]);
    assert.ok(
      trusted.cases.some((r) => r.id === f.witness && !r.qualified && r.passed),
    );
  }
  const env = cargoCheckEnvironment({
    RUSTUP_HOME: "/private/tmp/demlik-rust-toolchain-01a16c9d/rustup",
    CARGO_HOME: "/private/tmp/demlik-pbt-cargo-home-01a16c9d",
    RUSTUP_TOOLCHAIN: "stable",
    CARGO_NET_OFFLINE: "true",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "1",
    PATH: `/private/tmp/demlik-rust-toolchain-01a16c9d/cargo/bin:${process.env.PATH}`,
  });
  const report = {
    planned: 13,
    controls: [],
    cargoSelections: 0,
    baseline: { path: baseline, sha256: baselineHash, report: baselineReport },
    originalOwnerHashes: Object.fromEntries(
      Object.entries(original).map(([f, s]) => [f, hash(s)]),
    ),
    complete: false,
  };
  const save = () =>
    fs.writeFileSync(
      path.join(evidence, "controls.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  let check, operationError, cleanupError;
  try {
    check = createCheckWorktree(root, "smell-ledger-controls", evidence);
    report.worktree = check.root;
    report.target = check.target;
    for (const directory of [
      "node_modules",
      "packages/code-graph/node_modules",
      "verification/parity/node_modules",
    ]) {
      const from = path.join(root, directory);
      fs.symlinkSync(fs.realpathSync(from), path.join(check.root, directory));
    }
    for (const f of smellLedgerFaults) {
      for (const [owner, s] of Object.entries(original))
        fs.writeFileSync(path.join(check.root, owner), s);
      const modified = f.apply(original[f.owner]),
        directory = path.join(evidence, f.id);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(check.root, f.owner), modified);
      fs.writeFileSync(path.join(directory, "mutant.rs"), modified);
      const build = invoke(
        [
          process.env.CARGO ??
            "/private/tmp/demlik-rust-toolchain-01a16c9d/cargo/bin/cargo",
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--example",
          "smell_ledger_driver",
          "--message-format=json",
        ],
        check.root,
        env,
      );
      report.cargoSelections++;
      fs.writeFileSync(path.join(directory, "cargo.jsonl"), build.stdout);
      fs.writeFileSync(path.join(directory, "cargo.stderr"), build.stderr);
      fs.writeFileSync(
        path.join(directory, "build.json"),
        `${JSON.stringify(
          { ...build, stdout: undefined, stderr: undefined },
          null,
          2,
        )}\n`,
      );
      save();
      assert.equal(build.error, undefined);
      assert.equal(build.signal, null);
      assert.equal(
        build.exit,
        0,
        `${f.id}: compile failures earn zero semantic credit`,
      );
      const rows = build.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
        library = compiledCheckLibrary(
          rows,
          "demlik_code_graph",
          check.root,
          check.target,
        );
      const consumers = rows.filter(
        (r) =>
          r.reason === "compiler-artifact" &&
          r.target.name === "smell_ledger_driver" &&
          r.executable,
      );
      assert.equal(consumers.length, 1);
      assert.equal(consumers[0].fresh, false);
      const binary = assertCheckPath(consumers[0].executable, check.target);
      assertCheckPath(consumers[0].target.src_path, check.root);
      const retainedLibrary = retain(
          library.path,
          directory,
          "executed-library.rlib",
        ),
        retainedConsumer = retain(binary, directory, "executed-driver");
      const paired = path.join(directory, "pairs.json"),
        script = assertCheckPath(
          path.join(check.root, "verification/parity/graph-smell-ledger.mts"),
          check.root,
        ),
        loader = fs.realpathSync(
          path.join(
            check.root,
            "verification/parity/node_modules/tsx/dist/loader.mjs",
          ),
        );
      const run = invoke(
        [process.execPath, "--import", loader, script, binary, paired],
        check.root,
        env,
      );
      fs.writeFileSync(
        path.join(directory, "run.json"),
        `${JSON.stringify(run, null, 2)}\n`,
      );
      assert.equal(run.error, undefined);
      assert.equal(run.signal, null);
      assert.equal(run.exit, 1);
      const comparison = JSON.parse(fs.readFileSync(paired, "utf8"));
      assert.equal(comparison.binary.sha256, retainedConsumer.sha256);
      assert.deepEqual(comparison.sourceHashes, trusted.sourceHashes);
      const witness = comparison.cases.find((row) => row.id === f.witness);
      assert.ok(witness);
      assert.equal(witness.passed, false);
      assert.equal(witness.qualified, false);
      assert.equal(witness.process.status, 0);
      assert.equal(witness.process.signal, null);
      assert.ok(witness.actual);
      assert.ok(witness.calls.length);
      assert.ok(comparison.failures.some((row) => row.id === f.witness));
      report.controls.push({
        id: f.id,
        owner: f.owner,
        sourceSha256: hash(modified),
        witness: f.witness,
        compileExit: 0,
        protocolValid: true,
        semanticMismatch: true,
        library: { ...retainedLibrary, artifact: library.artifact },
        consumer: { ...retainedConsumer, artifact: consumers[0] },
        comparison: paired,
        otherFailureIds: comparison.failures
          .filter((row) => row.id !== f.witness)
          .map((row) => row.id),
      });
      for (const [owner, s] of Object.entries(original))
        fs.writeFileSync(path.join(check.root, owner), s);
      assert.equal(hash(fs.readFileSync(baseline)), baselineHash);
      save();
    }
    assert.equal(report.controls.length, 13);
    assert.equal(report.cargoSelections, 13);
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
      for (const [owner, s] of Object.entries(original))
        fs.writeFileSync(path.join(check.root, owner), s);
      report.restoredBeforeRemoval = Object.entries(original).every(
        ([f, s]) => fs.readFileSync(path.join(check.root, f), "utf8") === s,
      );
      try {
        check.remove();
      } catch (error) {
        cleanupError = error;
        report.cleanupFailure = { name: error.name, message: error.message };
      }
    }
    report.worktreeRemoved = !check || !fs.existsSync(check.root);
    report.defaultTargetRemoved = !check || !fs.existsSync(check.target);
    report.baselineUnchanged = hash(fs.readFileSync(baseline)) === baselineHash;
    report.originalOwnersUnchanged = Object.entries(original).every(
      ([f, s]) => fs.readFileSync(path.join(root, f), "utf8") === s,
    );
    report.complete &&=
      !operationError &&
      !cleanupError &&
      report.worktreeRemoved &&
      report.defaultTargetRemoved &&
      report.baselineUnchanged &&
      report.originalOwnersUnchanged;
    save();
  }
  if (operationError || cleanupError)
    throw new AggregateError(
      [operationError, cleanupError].filter(Boolean),
      "smell ledger control/check cleanup failed",
    );
  return report;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [baseline, baselineReport, evidence] = process.argv.slice(2);
  assert.ok(baseline && baselineReport && evidence);
  const result = smellLedgerMutations({ baseline, baselineReport, evidence });
  console.log(
    JSON.stringify({
      controls: result.controls.length,
      complete: result.complete,
    }),
  );
}
