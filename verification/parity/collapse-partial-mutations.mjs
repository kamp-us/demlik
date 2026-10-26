import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const baseline = process.argv[2],
  reportFile = process.argv[3];
assert.ok(baseline && reportFile);
assert.equal(process.argv.length, 4);
assert.equal(process.version, "v22.21.1");
assert.equal(
  process.env.CARGO_TARGET_DIR,
  undefined,
  "Every check owns its registered worktree/default target",
);
const root = fileURLToPath(new URL("../..", import.meta.url)),
  evidence = fs.mkdtempSync(
    path.join(path.dirname(reportFile), "partial-faults-"),
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  baselineHash = hash(fs.readFileSync(baseline));
const environment = {
  ...process.env,
  CARGO_NET_OFFLINE: "true",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
  TSX_DISABLE_CACHE: "1",
};
const edits = [
  {
    name: "test-functions-included",
    file: "candidates.rs",
    before: "if function.is_test || function.edges.is_none() {",
    after: "if function.edges.is_none() {",
    witness: "candidate.test",
  },
  {
    name: "inclusive-loc-boundary-lost",
    file: "candidates.rs",
    before: "function.loc as f64 >= settings.min_loc",
    after: "function.loc as f64 > settings.min_loc",
    witness: "candidate.loc-boundary",
  },
  {
    name: "constant-position-ignored",
    file: "partial.rs",
    before: "if theirs.const_args.contains(name) {",
    after: "if b.iter().any(|call| call.const_args.contains(name)) {",
    witness: "constants-positional",
  },
  {
    name: "duplicate-constants-inflate-evidence",
    file: "partial.rs",
    replacements: [
      ["let mut shared = IndexSet::new();", "let mut shared = Vec::new();"],
      ["shared.insert(name.as_str());", "shared.push(name.as_str());"],
    ],
    witness: "constants-duplicate-does-not-inflate",
  },
  {
    name: "maximal-left-extension-omitted",
    file: "partial.rs",
    before:
      "while a_start > 0 && b_start > 0 && a[a_start - 1].callee_id == b[b_start - 1].callee_id {",
    after:
      "while false && a_start > 0 && b_start > 0 && a[a_start - 1].callee_id == b[b_start - 1].callee_id {",
    witness: "left-extension-through-skipped-bucket",
  },
  {
    name: "maximal-right-extension-omitted",
    file: "partial.rs",
    before:
      "while a_end < a.len() && b_end < b.len() && a[a_end].callee_id == b[b_end].callee_id {",
    after:
      "while false && a_end < a.len() && b_end < b.len() && a[a_end].callee_id == b[b_end].callee_id {",
    witness: "right-extension-through-skipped-bucket",
  },
  {
    name: "containment-treated-as-divergence",
    file: "partial.rs",
    before: "let a_diverges = a_calls.get(a_next)?;",
    after: "let a_diverges = a_calls.get(a_next.saturating_sub(1))?;",
    witness: "containment",
  },
  {
    name: "literal-space-collisions-removed",
    file: "partial.rs",
    before: "key.extend(&call.callee_id);",
    after:
      'key.push_str(&format!("{}:", call.callee_id.units().len())); key.extend(&call.callee_id);',
    witness: "space-shingle-collision",
  },
  {
    name: "nul-pair-collisions-removed",
    file: "partial.rs",
    before: 'let key = format!("{}\\0{}", twin.a.id, twin.b.id);',
    after:
      'let key = format!("{}:{}{}", twin.a.id.len(), twin.a.id, twin.b.id);',
    witness: "nul-pair-collision",
  },
  {
    name: "bucket-counts-functions-not-occurrences",
    file: "partial.rs",
    before: "bucket.len() as f64 > settings.partial_max_block_size",
    after:
      "bucket.iter().map(|entry| entry.index).collect::<IndexSet<_>>().len() as f64 > settings.partial_max_block_size",
    witness: "bucket-repeats-count-as-occurrences",
  },
  {
    name: "best-pair-prefers-shorter-run",
    file: "partial.rs",
    before: "return candidate.shared_block.len() > held.shared_block.len();",
    after: "return candidate.shared_block.len() < held.shared_block.len();",
    witness: "best-longer-block",
  },
  {
    name: "best-pair-prefers-fewer-constants",
    file: "partial.rs",
    before: "candidate.shared_constants.len() > held.shared_constants.len()",
    after: "candidate.shared_constants.len() < held.shared_constants.len()",
    witness: "best-more-constants",
  },
  {
    name: "exact-tie-replaces-first-pair",
    file: "partial.rs",
    before: "candidate.shared_constants.len() > held.shared_constants.len()",
    after: "candidate.shared_constants.len() >= held.shared_constants.len()",
    witness: "best-exact-tie-first",
  },
  {
    name: "final-id-order-reversed",
    file: "partial.rs",
    before: "locale_compare(&x.a.id, &y.a.id)",
    after: "locale_compare(&y.a.id, &x.a.id)",
    witness: "unicode-id-final-order",
  },
];
const originals = new Map(
  [...new Set(edits.map((row) => row.file))].map((file) => [
    file,
    fs.readFileSync(
      path.join(root, "crates/code-graph/src/collapse", file),
      "utf8",
    ),
  ]),
);
for (const edit of edits)
  for (const [before] of edit.replacements ?? [[edit.before, edit.after]])
    assert.equal(originals.get(edit.file).split(before).length, 2, edit.name);
function git(args) {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}
const checkpoint = git(["rev-parse", "HEAD"]).trim();
function links(tree) {
  const rows = [];
  for (const name of [
    "node_modules",
    "packages/code-graph/node_modules",
    "verification/parity/node_modules",
  ]) {
    const link = path.join(tree, name),
      target = path.join(root, name);
    fs.symlinkSync(target, link, "dir");
    rows.push({ path: link, target, resolved: fs.realpathSync(link) });
  }
  return rows;
}
function compare(tree, binary, name, ids) {
  const report = path.join(evidence, `${name}.json`),
    command = [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(tree, "verification/parity/graph-collapse-partial.mts"),
      binary,
      report,
      "--ids",
      ids.join(","),
    ];
  const run = spawnSync(process.execPath, command, {
    cwd: tree,
    env: environment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(evidence, `${name}.log`), run.stdout + run.stderr);
  assert.ok(
    fs.existsSync(report),
    `missing comparison report: ${run.stdout}${run.stderr}`,
  );
  return {
    command: [process.execPath, ...command],
    status: run.status,
    reportFile: report,
    report: JSON.parse(fs.readFileSync(report, "utf8")),
  };
}
const controls = [],
  trees = [];
let before;
function record(extra = {}) {
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ checkpoint, detected: controls.length, planned: edits.length, escaped: 0, baseline: before, baselineDriverSha256: baselineHash, sourceHashes: Object.fromEntries([...originals].map(([file, text]) => [file, hash(text)])), scriptSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))), profile: { registeredDisposableWorktrees: true, CARGO_TARGET_DIR: null, cargoDefaultTarget: true, offline: true, jobs: 1, debug: 0, incremental: false, retention: "Compact reports/Cargo diagnostics/source diff/observed artifact hashes only. Mutant executables/dependency caches removed with completed worktrees, not claimed as retained immutable binaries." }, trees, controls, ...extra }, null, 2)}\n`,
  );
}
try {
  for (const [index, edit] of edits.entries()) {
    const tree = path.join(
      os.tmpdir(),
      `demlik-partial-fault-${process.pid}-${index}`,
    );
    assert.ok(!fs.existsSync(tree));
    const registration = git(["worktree", "add", "--detach", tree, checkpoint]);
    const item = {
      path: tree,
      checkpoint,
      registration,
      worktreeRegistry: git(["worktree", "list", "--porcelain"]),
      dependencyLinks: links(tree),
      status: "registered",
    };
    trees.push(item);
    record({ activeWorktree: tree });
    try {
      if (before === undefined) {
        const ids = [...new Set(edits.map((row) => row.witness))];
        before = compare(tree, baseline, "baseline", ids);
        assert.equal(before.status, 0, JSON.stringify(before.report.failures));
        assert.equal(before.report.passed, ids.length);
        assert.equal(before.report.rejectedInvalidInputs, 7);
        record({ activeWorktree: tree });
      }
      const file = path.join(tree, "crates/code-graph/src/collapse", edit.file);
      let text = originals.get(edit.file);
      for (const [old, replacement] of edit.replacements ?? [
        [edit.before, edit.after],
      ])
        text = text.replace(old, replacement);
      fs.writeFileSync(file, text);
      const diff = spawnSync(
        "git",
        ["diff", "--", "crates/code-graph/src/collapse"],
        { cwd: tree, encoding: "utf8" },
      );
      assert.equal(diff.status, 0);
      const patchFile = path.join(evidence, `${edit.name}.diff`);
      fs.writeFileSync(patchFile, diff.stdout);
      item.sourceSha256 = hash(text);
      item.status = "building";
      record({ activeWorktree: tree });
      const args = [
        "build",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "collapse_partial_driver",
        "--message-format=json",
      ];
      const build = spawnSync(process.env.CARGO ?? "cargo", args, {
        cwd: tree,
        env: environment,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      const cargoJson = path.join(evidence, `${edit.name}.build.jsonl`),
        cargoLog = path.join(evidence, `${edit.name}.build.log`);
      fs.writeFileSync(cargoJson, build.stdout);
      fs.writeFileSync(cargoLog, build.stderr);
      item.status = "built";
      record({ activeWorktree: tree });
      assert.equal(
        build.status,
        0,
        `${edit.name}: compile errors are not semantic detections\n${build.stderr}`,
      );
      const artifacts = build.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter(
          (row) =>
            row.reason === "compiler-artifact" &&
            row.target.name === "collapse_partial_driver" &&
            row.executable,
        );
      assert.equal(artifacts.length, 1);
      const artifact = artifacts[0];
      assert.ok(
        artifact.executable.startsWith(path.join(tree, "target") + path.sep),
      );
      assert.equal(artifact.fresh, false);
      const binaryBytes = fs.readFileSync(artifact.executable);
      const result = compare(tree, artifact.executable, edit.name, [
        edit.witness,
      ]);
      assert.notEqual(result.status, 0, edit.name);
      assert.equal(result.report.attempted, 1);
      assert.equal(result.report.rejectedInvalidInputs, 7);
      assert.ok(result.report.failures.length > 0);
      assert.ok(
        result.report.failures.every((row) => row.kind === "semantic"),
        "protocol/harness failures cannot count",
      );
      assert.ok(result.report.failures.some((row) => row.id === edit.witness));
      controls.push({
        ...edit,
        detected: true,
        sourceSha256: hash(text),
        patchFile,
        build: {
          command: [process.env.CARGO ?? "cargo", ...args],
          cwd: tree,
          status: build.status,
          cargoJson,
          cargoLog,
          artifact,
        },
        observedExecutable: {
          path: artifact.executable,
          sha256: hash(binaryBytes),
          bytes: binaryBytes.length,
          retained: false,
        },
        comparison: result,
      });
      assert.equal(hash(fs.readFileSync(baseline)), baselineHash);
      for (const [file, original] of originals)
        assert.equal(
          fs.readFileSync(
            path.join(root, "crates/code-graph/src/collapse", file),
            "utf8",
          ),
          original,
        );
    } finally {
      git(["worktree", "remove", "--force", tree]);
      item.status = "removed";
      item.defaultTargetRemoved = !fs.existsSync(path.join(tree, "target"));
      record();
    }
    process.stdout.write(
      `${JSON.stringify({ detected: edit.name, completed: controls.length, total: edits.length, worktreeRemoved: true })}\n`,
    );
  }
  record({ complete: true });
  console.log(
    JSON.stringify({
      detected: controls.length,
      escaped: 0,
      allWorktreesRemoved: trees.every((t) => t.status === "removed"),
    }),
  );
} catch (error) {
  record({ incomplete: true, failure: String(error) });
  throw error;
}
