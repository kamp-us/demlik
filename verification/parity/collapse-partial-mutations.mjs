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
const controls = [];
let before, suite, operationError, cleanupError;
function record(extra = {}) {
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ checkpoint, detected: controls.length, planned: edits.length, escaped: 0, baseline: before, baselineDriverSha256: baselineHash, sourceHashes: Object.fromEntries([...originals].map(([file, text]) => [file, hash(text)])), scriptSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))), profile: { registeredDisposableWorktree: true, CARGO_TARGET_DIR: null, cargoDefaultTarget: true, sequentialSuite: true, offline: true, jobs: 1, debug: 0, incremental: false, retention: "Compact results, actual Cargo JSON/diagnostics, source diffs and immutable selected executables. No library/dependency caches copied; complete suite/default target removed afterward." }, suite, controls, ...extra }, null, 2)}\n`,
  );
}
function restore(tree) {
  const hashes = {};
  for (const [file, text] of originals) {
    const target = path.join(tree, "crates/code-graph/src/collapse", file);
    fs.writeFileSync(target, text);
    hashes[file] = hash(fs.readFileSync(target));
    assert.equal(hashes[file], hash(text));
  }
  return hashes;
}
try {
  const reused = process.env.DEMLIK_PARTIAL_SUITE_WORKTREE;
  const requested =
    reused ?? path.join(os.tmpdir(), `demlik-partial-suite-${process.pid}`);
  if (reused) {
    assert.ok(
      git(["worktree", "list", "--porcelain"]).includes(
        `worktree ${fs.realpathSync(reused)}\n`,
      ),
      "reuse only a registered worktree",
    );
    const restored = restore(reused);
    assert.equal(git(["-C", reused, "status", "--porcelain"]), "");
    git(["-C", reused, "checkout", "--detach", checkpoint]);
    suite = {
      path: requested,
      physicalPath: fs.realpathSync(requested),
      checkpoint,
      reused: true,
      initialRestoreHashes: restored,
      registration: git(["worktree", "list", "--porcelain"]),
      status: "registered",
    };
  } else {
    assert.ok(!fs.existsSync(requested));
    const registration = git([
      "worktree",
      "add",
      "--detach",
      requested,
      checkpoint,
    ]);
    suite = {
      path: requested,
      physicalPath: fs.realpathSync(requested),
      checkpoint,
      reused: false,
      registration,
      status: "registered",
    };
  }
  for (const name of [
    "node_modules",
    "packages/code-graph/node_modules",
    "verification/parity/node_modules",
  ]) {
    const link = path.join(suite.path, name),
      target = path.join(root, name);
    if (!fs.existsSync(link)) fs.symlinkSync(target, link, "dir");
    assert.equal(fs.realpathSync(link), fs.realpathSync(target));
  }
  record({ activeWorktree: suite.path });
  const ids = [...new Set(edits.map((row) => row.witness))];
  before = compare(suite.path, baseline, "baseline", ids);
  assert.equal(before.status, 0, JSON.stringify(before.report.failures));
  assert.equal(before.report.passed, ids.length);
  assert.equal(before.report.rejectedInvalidInputs, 7);
  const lint = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/@biomejs/biome/bin/biome"),
      "check",
      "verification/parity/collapse-partial-mutations.mjs",
    ],
    { cwd: suite.path, env: environment, encoding: "utf8" },
  );
  fs.writeFileSync(
    path.join(evidence, "runner-biome.log"),
    lint.stdout + lint.stderr,
  );
  assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  for (const edit of edits) {
    const restored = restore(suite.path);
    let text = originals.get(edit.file);
    for (const [old, replacement] of edit.replacements ?? [
      [edit.before, edit.after],
    ])
      text = text.replace(old, replacement);
    fs.writeFileSync(
      path.join(suite.path, "crates/code-graph/src/collapse", edit.file),
      text,
    );
    const diff = git([
      "-C",
      suite.path,
      "diff",
      "--",
      "crates/code-graph/src/collapse",
    ]);
    const patchFile = path.join(evidence, `${edit.name}.diff`);
    fs.writeFileSync(patchFile, diff);
    suite.status = "building";
    record({ activeWorktree: suite.path, activeControl: edit.name });
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
      cwd: suite.path,
      env: environment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const cargoJson = path.join(evidence, `${edit.name}.build.jsonl`),
      cargoLog = path.join(evidence, `${edit.name}.build.log`);
    fs.writeFileSync(cargoJson, build.stdout);
    fs.writeFileSync(cargoLog, build.stderr);
    assert.equal(
      build.status,
      0,
      `${edit.name}: compile errors are not semantic detections\n${build.stderr}`,
    );
    const rows = build.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      rows.some(
        (row) => row.reason === "build-finished" && row.success === true,
      ),
    );
    const artifact = rows.find(
      (row) =>
        row.reason === "compiler-artifact" &&
        row.target.name === "collapse_partial_driver" &&
        row.executable,
    );
    const library = rows.find(
      (row) =>
        row.reason === "compiler-artifact" &&
        row.target.name === "demlik_code_graph" &&
        row.target.kind.includes("lib"),
    );
    assert.ok(artifact && library);
    assert.equal(artifact.fresh, false);
    assert.equal(library.fresh, false);
    assert.ok(
      artifact.executable.startsWith(
        path.join(suite.physicalPath, "target") + path.sep,
      ),
    );
    const libraryPath = library.filenames.find((file) =>
      file.endsWith(".rlib"),
    );
    assert.ok(libraryPath);
    const effective = path.join(evidence, `${edit.name}.driver`);
    fs.copyFileSync(
      artifact.executable,
      effective,
      fs.constants.COPYFILE_FICLONE,
    );
    const executableHash = hash(fs.readFileSync(effective));
    assert.equal(executableHash, hash(fs.readFileSync(artifact.executable)));
    const result = compare(suite.path, effective, edit.name, [edit.witness]);
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
      restoredSourceHashes: restored,
      sourceSha256: hash(text),
      patchFile,
      build: {
        command: [process.env.CARGO ?? "cargo", ...args],
        cwd: suite.path,
        status: build.status,
        cargoJson,
        cargoLog,
        artifact,
        libraryArtifact: library,
        observedLibrarySha256: hash(fs.readFileSync(libraryPath)),
      },
      effectiveExecutable: {
        path: effective,
        sha256: executableHash,
        bytes: fs.statSync(effective).size,
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
    suite.status = "between-controls";
    record({ activeWorktree: suite.path });
    process.stdout.write(
      `${JSON.stringify({ detected: edit.name, completed: controls.length, total: edits.length })}\n`,
    );
  }
} catch (error) {
  operationError = String(error);
} finally {
  if (suite) {
    try {
      suite.finalRestoreHashes = restore(suite.path);
      assert.equal(git(["-C", suite.path, "status", "--porcelain"]), "");
      git(["worktree", "remove", "--force", suite.path]);
      suite.status = "removed";
      suite.defaultTargetRemoved = !fs.existsSync(
        path.join(suite.path, "target"),
      );
    } catch (error) {
      cleanupError = String(error);
    }
  }
  record({
    complete: operationError === undefined && cleanupError === undefined,
    incomplete: operationError !== undefined || cleanupError !== undefined,
    operationError,
    cleanupError,
  });
}
if (operationError !== undefined || cleanupError !== undefined)
  throw new Error(JSON.stringify({ operationError, cleanupError }));
console.log(
  JSON.stringify({
    detected: controls.length,
    escaped: 0,
    worktreeRemoved: suite.status === "removed",
  }),
);
