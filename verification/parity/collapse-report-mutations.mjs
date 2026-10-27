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

const [baseline, baselineReport, reportFile, evidenceDirectory] =
  process.argv.slice(2);
assert.ok(baseline && baselineReport && reportFile && evidenceDirectory);
for (const k of [
  "CARGO_TARGET_DIR",
  "CARGO_BUILD_TARGET_DIR",
  "CARGO_BUILD_BUILD_DIR",
  "DEMLIK_MUTATION_TARGET_DIR",
])
  assert.equal(process.env[k], undefined, k);
const root = fileURLToPath(new URL("../..", import.meta.url)),
  evidence = path.resolve(evidenceDirectory),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const checked = JSON.parse(fs.readFileSync(baselineReport, "utf8")),
  baselineHash = hash(fs.readFileSync(baseline));
assert.equal(checked.passed, 104);
assert.equal(checked.attempted, 104);
assert.equal(Object.keys(checked.nativeEvidence).length, 104);
assert.equal(checked.rejectedInvalidInputs, 4);
assert.equal(checked.responseGuards, 3);
assert.deepEqual(checked.failures, []);
assert.equal(checked.nativeExecutable.sha256, baselineHash);
const mutations = [
  {
    name: "test-functions-admitted",
    file: "candidates.rs",
    before: "function.is_test || function.edges.is_none()",
    after: "function.edges.is_none()",
    witness: "predicate.test",
  },
  {
    name: "constructor-admitted",
    file: "candidates.rs",
    before:
      "FunctionKind::Constructor | FunctionKind::Getter | FunctionKind::Setter",
    after: "FunctionKind::Getter | FunctionKind::Setter",
    witness: "predicate.kind.constructor",
  },
  {
    name: "stem-disabled",
    file: "tokens.rs",
    before: "if token.len() > suffix.len() + 2 && token.ends_with(suffix)",
    after:
      "if false && token.len() > suffix.len() + 2 && token.ends_with(suffix)",
    witness: "tokens.weights.weight",
  },
  {
    name: "camel-boundary-removed",
    file: "tokens.rs",
    before: "chars[i - 1].is_ascii_lowercase()",
    after: "false",
    witness: "tokens.BUILD__MEMBERSHIPS.createMembership",
  },
  {
    name: "one-element-set-admitted",
    file: "signals.rs",
    before:
      "if (a.len() as f64) < s.min_set_size || (b.len() as f64) < s.min_set_size",
    after:
      "if (a.len() as f64) < s.min_set_size - 1.0 || (b.len() as f64) < s.min_set_size - 1.0",
    witness: "signals.duplicate-callees",
  },
  {
    name: "jaccard-equality-rejected",
    file: "signals.rs",
    before: "if score < threshold",
    after: "if score <= threshold",
    witness: "signals.callee-threshold-0.5",
  },
  {
    name: "confidence-divides-fired-count",
    file: "candidates.rs",
    before: "/ 4.0,",
    after: "/ signals.len() as f64,",
    witness: "membership",
  },
  {
    name: "exact-block-limit-skipped",
    file: "candidates.rs",
    before: "if members.len() as f64 > settings.max_block_size",
    after: "if members.len() as f64 >= settings.max_block_size",
    witness: "blocks.limit-3",
  },
  {
    name: "pair-orientation-reversed",
    file: "candidates.rs",
    before: "considered.sort_by(|a, b| locale_compare(&a.id, &b.id));",
    after: "considered.sort_by(|a, b| locale_compare(&b.id, &a.id));",
    witness: "order.reversed-input",
  },
  {
    name: "std-log2-rounding-substituted",
    file: "cost.rs",
    before: "libm::log2(1.0 + c.caller_union as f64)",
    after: "(1.0 + c.caller_union as f64).log2()",
    witness: "cost.std-log2-boundary",
  },
  {
    name: "caller-union-inflated",
    file: "cost.rs",
    before: "caller_union: callers.len(),",
    after: "caller_union: callers.len() + 1,",
    witness: "seven-callers",
  },
  {
    name: "package-prefix-loses-slash",
    file: "cost.rs",
    before: ".is_some_and(|tail| tail.starts_with('/'))",
    after: ".is_some_and(|_| true)",
    witness: "packages.slash-boundary",
  },
  {
    name: "effect-traversal-reversed",
    file: "cost.rs",
    before: "reverse.entry(to).or_default().push(from.clone());",
    after: "reverse.entry(from.clone()).or_default().push(to);",
    witness: "effects.transitive",
  },
  {
    name: "excluded-effect-seed-dropped",
    file: "cost.rs",
    before: ".filter(|f| matches!(f.node_kind, Some(NodeKind::Effect { .. })))",
    after:
      ".filter(|f| f.loc >= 5 && matches!(f.node_kind, Some(NodeKind::Effect { .. })))",
    witness: "effect-path",
  },
  {
    name: "first-file-wins",
    file: "cost.rs",
    before: "file_of: functions\n                .iter()",
    after: "file_of: functions\n                .iter().rev()",
    witness: "packages.last-file-wins",
  },
  {
    name: "cliques-become-connected-components",
    file: "candidates.rs",
    before: "if !joinable(cluster, joiner, pairs)",
    after: "if false && !joinable(cluster, joiner, pairs)",
    witness: "chain",
  },
  {
    name: "representative-reminted",
    file: "candidates.rs",
    before: "representative: Arc::clone(candidate),",
    after:
      "representative: Arc::new(CollapseCandidate { a: candidate.a, b: candidate.b, signals: candidate.signals.iter().map(|s| Signal { signal: s.signal, strength: s.strength, detail: s.detail.clone() }).collect(), confidence: candidate.confidence, cost: candidate.cost, cost_inputs: candidate.cost_inputs, rank: candidate.rank }),",
    witness: "membership",
  },
  {
    name: "independent-partials-dropped",
    file: "candidates.rs",
    before: "partial_twins: find_partial_twins(&considered, settings),",
    after: "partial_twins: find_partial_twins(&[], settings),",
    witness: "partial.independent-blocks",
  },
  {
    name: "rank-ignores-cost",
    file: "candidates.rs",
    before: "rank: round4(confidence / cost),",
    after: "rank: round4(confidence),",
    witness: "seven-callers",
  },
  {
    name: "round-tie-goes-down",
    file: "../number.rs",
    before: "value - lower < 0.5",
    after: "value - lower <= 0.5",
    witness: "seven-callers",
  },
];
const owner = (f) => path.join(root, "crates/code-graph/src/collapse", f),
  original = new Map(
    mutations.map((m) => [m.file, fs.readFileSync(owner(m.file), "utf8")]),
  );
for (const m of mutations) {
  assert.equal(original.get(m.file).split(m.before).length, 2, m.name);
  assert.ok(
    checked.cases.some((c) => c.id === m.witness && c.passed),
    m.witness,
  );
}
fs.mkdirSync(evidence, { recursive: true });
const environment = cargoCheckEnvironment({
  CARGO_NET_OFFLINE: "true",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
});
delete environment.CARGO_BUILD_TARGET_DIR;
delete environment.CARGO_BUILD_BUILD_DIR;
const command = (file, args, cwd, env = environment) =>
  spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
function preserve(file, name) {
  const bytes = fs.readFileSync(file),
    packed = gzipSync(bytes),
    p = path.join(evidence, `${name}.gz`);
  fs.writeFileSync(p, packed);
  return {
    path: p,
    sha256: hash(bytes),
    bytes: bytes.length,
    gzipSha256: hash(packed),
    gzipBytes: packed.length,
  };
}
let check;
const controls = [];
try {
  check = createCheckWorktree(root, "collapse-report-faults", evidence);
  for (const relative of [
    "node_modules",
    "packages/code-graph/node_modules",
    "packages/tea/node_modules",
    "verification/parity/node_modules",
  ]) {
    const from = path.join(root, relative),
      to = path.join(check.root, relative);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.symlinkSync(fs.realpathSync(from), to);
    }
  }
  for (const m of mutations) {
    for (const [f, s] of original)
      fs.writeFileSync(
        path.join(check.root, "crates/code-graph/src/collapse", f),
        s,
      );
    for (const [f, s] of original)
      assert.equal(
        hash(
          fs.readFileSync(
            path.join(check.root, "crates/code-graph/src/collapse", f),
          ),
        ),
        hash(s),
      );
    const modified = original.get(m.file).replace(m.before, m.after),
      modifiedCopy = path.join(evidence, `${m.name}.rs`);
    fs.writeFileSync(
      path.join(check.root, "crates/code-graph/src/collapse", m.file),
      modified,
    );
    fs.writeFileSync(modifiedCopy, modified);
    const build = command(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "collapse_report_driver",
        "--message-format=json",
      ],
      check.root,
    );
    fs.writeFileSync(
      path.join(evidence, `${m.name}.cargo.jsonl`),
      build.stdout,
    );
    fs.writeFileSync(
      path.join(evidence, `${m.name}.cargo.stderr`),
      build.stderr,
    );
    assert.equal(build.status, 0, m.name + build.stderr);
    const rows = build.stdout
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s));
    const lib = compiledCheckLibrary(
      rows,
      "demlik_code_graph",
      check.root,
      check.target,
    );
    const artifacts = rows.filter(
      (r) =>
        r.reason === "compiler-artifact" &&
        r.target.name === "collapse_report_driver" &&
        r.executable,
    );
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].fresh, false);
    const executable = assertCheckPath(artifacts[0].executable, check.target);
    const depInfoPath = path.join(
      path.dirname(lib.path),
      path
        .basename(lib.path)
        .replace(/^lib/, "")
        .replace(/\.rlib$/, ".d"),
    );
    const depInfo = fs.readFileSync(depInfoPath);
    const modifiedPath = path.normalize(
      path.join(check.root, "crates/code-graph/src/collapse", m.file),
    );
    assert.ok(
      depInfo
        .toString("utf8")
        .includes(
          path.relative(check.root, assertCheckPath(modifiedPath, check.root)),
        ),
      `${m.name}: modified owner in actual library dep-info`,
    );
    const depInfoCopy = path.join(evidence, `${m.name}.d`);
    fs.writeFileSync(depInfoCopy, depInfo);
    const savedLib = preserve(lib.path, `${m.name}-library`),
      savedExe = preserve(executable, `${m.name}-executable`);
    const pairFile = path.join(evidence, `${m.name}.pairs.json`),
      run = command(
        process.execPath,
        [
          "--import",
          path.join(
            check.root,
            "verification/parity/node_modules/tsx/dist/loader.mjs",
          ),
          path.join(
            check.root,
            "verification/parity/graph-collapse-report.mts",
          ),
          executable,
          pairFile,
        ],
        check.root,
        { ...environment, DEMLIK_COLLAPSE_REPORT_CASES: m.witness },
      );
    fs.writeFileSync(path.join(evidence, `${m.name}.stdout`), run.stdout);
    fs.writeFileSync(path.join(evidence, `${m.name}.stderr`), run.stderr);
    assert.ok(fs.existsSync(pairFile), m.name + run.stderr);
    const pairs = JSON.parse(fs.readFileSync(pairFile, "utf8"));
    assert.equal(pairs.nativeExecutable.sha256, savedExe.sha256);
    assert.equal(pairs.attempted, 1);
    assert.equal(pairs.rejectedInvalidInputs, 4);
    assert.notEqual(run.status, 0);
    assert.ok(
      pairs.failures.some((f) => f.id === m.witness && f.kind === "semantic"),
      m.name + JSON.stringify(pairs.failures),
    );
    assert.deepEqual(
      pairs.reference.sourceHashes,
      checked.reference.sourceHashes,
    );
    assert.equal(hash(fs.readFileSync(baseline)), baselineHash);
    for (const [f, s] of original)
      assert.equal(fs.readFileSync(owner(f), "utf8"), s);
    const control = {
      ...m,
      buildExit: build.status,
      libraryArtifact: lib.artifact,
      driverArtifact: artifacts[0],
      depInfo: { path: depInfoCopy, sha256: hash(depInfo) },
      library: savedLib,
      executable: savedExe,
      modifiedSourceCopy: modifiedCopy,
      modifiedSourceSha256: hash(modified),
      driverSourceSha256: hash(
        fs.readFileSync(
          path.join(
            check.root,
            "crates/code-graph/examples/collapse_report_driver.rs",
          ),
        ),
      ),
      reportFile: pairFile,
      reportSha256: hash(fs.readFileSync(pairFile)),
      failures: pairs.failures,
      detected: true,
    };
    controls.push(control);
    fs.writeFileSync(
      path.join(evidence, "progress.json"),
      `${JSON.stringify({ detected: controls.length, planned: mutations.length, controls }, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        detected: m.name,
        completed: controls.length,
        total: mutations.length,
      }),
    );
  }
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ detected: controls.length, escaped: 0, baselineFullCases: checked.passed, baselineDriverSha256: baselineHash, baselineReportSha256: hash(fs.readFileSync(baselineReport)), reference: checked.reference, sourceHashes: Object.fromEntries([...original].map(([f, s]) => [f, hash(s)])), controls, buildProfile: { defaultTarget: true, worktree: check.root, target: check.target, jobs: 1, debug: 0, incremental: false } }, null, 2)}\n`,
  );
} catch (error) {
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ incomplete: true, detected: controls.length, planned: mutations.length, error: String(error), controls, noBuildOrProtocolFailureCredit: true }, null, 2)}\n`,
  );
  throw error;
} finally {
  if (check) check.remove();
}
