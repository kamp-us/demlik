import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (b) => createHash("sha256").update(b).digest("hex");
const ledger = "crates/code-graph/src/unreachable/ledger.rs";
const gate = "crates/code-graph/src/unreachable/gate.rs";
export const unreachableFaults = [
  {
    id: "last-reason-wins",
    owner: ledger,
    needle:
      ".entry(finding_key(&entry.finding))\n            .or_insert_with(|| Arc::clone(entry));",
    fault: ".insert(finding_key(&entry.finding), Arc::clone(entry));",
    witness: "pure.first-reason.text",
  },
  {
    id: "prune-foreign-scope",
    owner: ledger,
    needle:
      "entry.finding.scope == *scope\n            && gated.contains(&entry.finding.kind)",
    fault: "true\n            && gated.contains(&entry.finding.kind)",
    witness: "pure.foreign-scope.text",
  },
  {
    id: "prune-ungated-kind",
    owner: ledger,
    needle:
      "entry.finding.scope == *scope\n            && gated.contains(&entry.finding.kind)",
    fault: "entry.finding.scope == *scope",
    witness: "pure.ungated-kind.text",
  },
  {
    id: "dedupe-unrecorded",
    owner: ledger,
    needle:
      ".filter(|finding| !recorded_keys.contains(&finding_key(finding)))\n            .collect(),",
    fault:
      ".filter(|finding| !recorded_keys.contains(&finding_key(finding)))\n            .scan(IndexSet::new(), |seen, finding| Some((seen.insert(finding_key(finding)), finding)))\n            .filter_map(|(fresh, finding)| fresh.then_some(finding))\n            .collect(),",
    witness: "pure.duplicate-findings.text",
  },
  {
    id: "key-omit-kind",
    owner: ledger,
    needle:
      "serde_json::to_string(&(&finding.scope, &finding.kind, &finding.id))",
    fault: "serde_json::to_string(&(&finding.scope, &finding.id))",
    witness: "pure.kind-change.text",
  },
  {
    id: "accept-dead-only",
    owner: gate,
    needle:
      "let result = reconcile_unreachable(&gate.ledger, &gate.scope, &findings, &all);",
    fault:
      "let result = reconcile_unreachable(&gate.ledger, &gate.scope, &findings, &all[..1]);",
    witness: "run.accept-both",
  },
  {
    id: "missing-reach-success",
    owner: gate,
    needle: "return Ok(2);",
    fault: "return Ok(0);",
    witness: "run.missing-reach",
  },
  {
    id: "repeat-write",
    owner: gate,
    needle: "if !result.pruned.is_empty() || !result.unrecorded.is_empty() {",
    fault: "if true {",
    witness: "run.repeat-no-write",
  },
  {
    id: "emit-before-prune",
    owner: gate,
    needle:
      "if !result.pruned.is_empty() {\n                write_unreachable_ledger(&gate.file, &result.kept)\n                    .map_err(UnreachableRunError::Write)?;\n            }",
    fault: "/* moved after the callback by this control */",
    afterNeedle:
      "(out.emit)(&payload).map_err(UnreachableRunError::Emit)?;\n            Ok(rendered.exit_code)",
    afterFault:
      "(out.emit)(&payload).map_err(UnreachableRunError::Emit)?;\n            if !result.pruned.is_empty() { write_unreachable_ledger(&gate.file, &result.kept).map_err(UnreachableRunError::Write)?; }\n            Ok(rendered.exit_code)",
    witness: "run.prune-before-emit-error",
  },
];
function invoke(program, args, cwd, env) {
  const r = spawnSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return {
    command: [program, ...args],
    cwd,
    exit: r.status,
    signal: r.signal,
    error: r.error?.message,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}
function logicalBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .reduce(
      (sum, e) =>
        sum +
        (e.isDirectory()
          ? logicalBytes(path.join(dir, e.name))
          : e.isFile()
            ? fs.statSync(path.join(dir, e.name)).size
            : 0),
      0,
    );
}
export function unreachableMutations({ baseline, baselineReport, evidence }) {
  fs.mkdirSync(evidence, { recursive: true });
  const baselineHash = hash(fs.readFileSync(baseline));
  const trusted = JSON.parse(fs.readFileSync(baselineReport, "utf8"));
  assert.deepEqual(trusted.failures, []);
  assert.equal(trusted.rejectedInvalidInputs, 4);
  assert.equal(trusted.binary.sha256, baselineHash);
  const original = Object.fromEntries(
    [ledger, gate].map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]),
  );
  for (const f of unreachableFaults) {
    assert.equal(
      original[f.owner].split(f.needle).length,
      2,
      `${f.id}: unique needle`,
    );
    if (f.afterNeedle)
      assert.equal(original[f.owner].split(f.afterNeedle).length, 2);
  }
  const environment = cargoCheckEnvironment({
    CARGO_NET_OFFLINE: "true",
    CARGO_BUILD_JOBS: "1",
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
  });
  const report = {
    planned: 9,
    cargoSelections: 0,
    controls: [],
    baseline: { path: baseline, sha256: baselineHash, report: baselineReport },
    complete: false,
    semanticPairs: 0,
    resourceSamples: [],
    mutantLibrariesRetained: false,
    artifacts: [],
  };
  const started = performance.now();
  let check, operationError, cleanupError;
  const save = () =>
    fs.writeFileSync(
      path.join(evidence, "controls.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  try {
    check = createCheckWorktree(root, "unreachable-ledger-controls", evidence);
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
    for (const f of unreachableFaults) {
      for (const [owner, text] of Object.entries(original))
        fs.writeFileSync(path.join(check.root, owner), text);
      let text = original[f.owner].replace(f.needle, f.fault);
      if (f.afterNeedle) text = text.replace(f.afterNeedle, f.afterFault);
      fs.writeFileSync(path.join(check.root, f.owner), text);
      const dir = path.join(evidence, f.id);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "mutant.rs"), text);
      const build = invoke(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--example",
          "unreachable_driver",
          "--message-format=json",
        ],
        check.root,
        environment,
      );
      report.cargoSelections++;
      fs.writeFileSync(path.join(dir, "cargo.jsonl"), build.stdout);
      fs.writeFileSync(path.join(dir, "cargo.stderr"), build.stderr);
      fs.writeFileSync(
        path.join(dir, "build.json"),
        `${JSON.stringify({ ...build, stdout: undefined, stderr: undefined }, null, 2)}\n`,
      );
      save();
      assert.equal(build.error, undefined);
      assert.equal(build.signal, null);
      assert.equal(
        build.exit,
        0,
        `${f.id}: compile failure earns zero semantic credit`,
      );
      const events = build.stdout
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s));
      const library = compiledCheckLibrary(
        events,
        "demlik_code_graph",
        check.root,
        check.target,
      );
      const consumers = events.filter(
        (r) =>
          r.reason === "compiler-artifact" &&
          r.target.name === "unreachable_driver" &&
          r.executable,
      );
      assert.equal(consumers.length, 1);
      assert.equal(consumers[0].fresh, false);
      const executable = assertCheckPath(consumers[0].executable, check.target);
      assertCheckPath(consumers[0].target.src_path, check.root);
      const bytes = fs.readFileSync(executable),
        digest = hash(bytes),
        blob = path.join(dir, "executed-driver.gz");
      fs.writeFileSync(blob, gzipSync(bytes));
      const script = assertCheckPath(
        path.join(
          check.root,
          "verification/parity/graph-unreachable-ledger.mts",
        ),
        check.root,
      );
      const loader = fs.realpathSync(
        path.join(
          check.root,
          "verification/parity/node_modules/tsx/dist/loader.mjs",
        ),
      );
      const paired = path.join(dir, "pairs.json");
      const run = invoke(
        process.execPath,
        ["--import", loader, script, executable, paired],
        check.root,
        environment,
      );
      fs.writeFileSync(
        path.join(dir, "run.json"),
        `${JSON.stringify(run, null, 2)}\n`,
      );
      assert.equal(run.error, undefined);
      assert.equal(run.signal, null);
      assert.equal(run.exit, 1, `${f.id}: comparison must fail observably`);
      const observed = JSON.parse(fs.readFileSync(paired, "utf8"));
      assert.equal(observed.binary.sha256, digest);
      const witness = observed.cases.find((r) => r.id === f.witness);
      assert.ok(witness, `${f.id}: named witness exists`);
      assert.equal(witness.process.status, 0);
      assert.equal(witness.passed, false);
      assert.equal(witness.qualified, false);
      assert.ok(witness.actual);
      assert.ok(witness.calls.length);
      assert.ok(observed.failures.some((r) => r.id === f.witness));
      report.controls.push({
        id: f.id,
        owner: f.owner,
        sourceSha256: hash(text),
        witness: f.witness,
        compileExit: 0,
        protocolValid: true,
        semanticMismatch: true,
        library: {
          path: library.path,
          sha256: hash(fs.readFileSync(library.path)),
          artifact: library.artifact,
          retained: false,
        },
        consumer: consumers[0],
        executedArtifact: {
          original: executable,
          sha256: digest,
          gzip: blob,
          gzipSha256: hash(fs.readFileSync(blob)),
        },
        comparison: paired,
      });
      report.artifacts.push({
        role: f.id,
        ...report.controls.at(-1).executedArtifact,
      });
      report.resourceSamples.push({
        after: f.id,
        logicalTargetBytes: logicalBytes(check.target),
      });
      for (const [owner, source] of Object.entries(original))
        fs.writeFileSync(path.join(check.root, owner), source);
      assert.equal(hash(fs.readFileSync(baseline)), baselineHash);
      save();
    }
    assert.equal(report.cargoSelections, 9);
    assert.equal(report.controls.length, 9);
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
      try {
        check.remove();
      } catch (error) {
        cleanupError = error;
        report.cleanupFailure = { name: error.name, message: error.message };
      }
    }
    report.elapsedMs = performance.now() - started;
    report.worktreeRemoved = !check || !fs.existsSync(check.root);
    report.defaultTargetRemoved = !check || !fs.existsSync(check.target);
    report.originalOwnersUnchanged = Object.entries(original).every(
      ([owner, text]) =>
        fs.readFileSync(path.join(root, owner), "utf8") === text,
    );
    report.baselineUnchanged = hash(fs.readFileSync(baseline)) === baselineHash;
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
      `Unreachable controls failed; ${evidence}`,
    );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const report = unreachableMutations({
    baseline: process.argv[2],
    baselineReport: process.argv[3],
    evidence: path.resolve(process.argv[4]),
  });
  console.log(
    JSON.stringify({
      detected: report.controls.length,
      complete: report.complete,
      worktreeRemoved: report.worktreeRemoved,
    }),
  );
}
