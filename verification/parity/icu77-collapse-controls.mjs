import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
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
const [baseline, evidence] = process.argv.slice(2);
assert.ok(baseline && evidence && process.argv.length === 4);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = "crates/code-graph/src/collapse/candidates.rs";
const original = fs.readFileSync(path.join(root, source), "utf8");
const mutations = [
  {
    name: "skipped-key-prepared-lossily",
    before: "let key = CollationInput::from_utf16(block.key.units())?;",
    after: "let key = CollationInput::from_text(&block.key.to_lossy())?;",
    witness: "icu.skipped-raw-units",
    group: true,
    field: "skipped",
  },
  {
    name: "canonical-tie-broken-by-utf8",
    before: "keyed.sort_by(|(_, a), (_, b)| collation.compare(a, b));",
    after:
      "keyed.sort_by(|(x, a), (y, b)| collation.compare(a, b).then_with(|| x.id.cmp(&y.id)));",
    witness: "icu.considered-canonical-ties",
    group: true,
    field: "orientation",
  },
  {
    name: "candidate-rank-priority-lost",
    before:
      "candidates.sort_by(|(a, aa, ab), (b, ba, bb)| {\n        descending(a.rank, b.rank)",
    after:
      "candidates.sort_by(|(_a, aa, ab), (_b, ba, bb)| {\n        Ordering::Equal",
    witness: "icu.rank-before-id",
    group: true,
    field: "rank",
  },
  {
    name: "representative-reminted",
    before: "representative: Arc::clone(candidate),",
    after:
      "representative: Arc::new(CollapseCandidate { a: candidate.a, b: candidate.b, signals: candidate.signals.iter().map(|s| Signal { signal: s.signal, strength: s.strength, detail: s.detail.clone() }).collect(), confidence: candidate.confidence, cost: candidate.cost, cost_inputs: candidate.cost_inputs, rank: candidate.rank }),",
    witness: "membership",
    group: false,
    field: "representative",
  },
];
for (const mutation of mutations)
  assert.equal(original.split(mutation.before).length, 2, mutation.name);
fs.mkdirSync(evidence, { recursive: true });
const environment = cargoCheckEnvironment({
  CARGO_NET_OFFLINE: "true",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
  TMPDIR: "/private/tmp",
  TSX_DISABLE_CACHE: "1",
});
const baselineSha256 = hash(fs.readFileSync(baseline));
const cargo = process.env.CARGO ?? "cargo";
let check;
let attempt;
const controls = [];
const save = (name, value) =>
  fs.writeFileSync(
    path.join(evidence, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
function run(name, command, cwd, env) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  fs.writeFileSync(path.join(evidence, `${name}.stdout`), result.stdout ?? "");
  fs.writeFileSync(path.join(evidence, `${name}.stderr`), result.stderr ?? "");
  const record = {
    command,
    cwd,
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
  };
  save(`${name}.process.json`, record);
  assert.ifError(result.error);
  return { ...record, stdout: result.stdout ?? "" };
}
function retain(file, name) {
  const bytes = fs.readFileSync(file);
  const sha256 = hash(bytes);
  const retained = path.join(evidence, `${name}-${sha256}.gz`);
  const compressed = gzipSync(bytes, { level: 1 });
  fs.writeFileSync(retained, compressed);
  return {
    path: file,
    bytes: bytes.length,
    sha256,
    retained,
    retainedSha256: hash(compressed),
  };
}
function projection(row, field, native) {
  const report = native ? row.native.output.report : row.source;
  if (field === "representative")
    return native ? row.native.output.owners.representatives : true;
  if (field === "skipped")
    return report.skippedBlocks.map((block) => [block.kind, block.key]);
  if (field === "orientation")
    return report.candidates.map((pair) => [pair.aId, pair.bId]);
  return report.candidates.map((pair) => [pair.aId, pair.bId, pair.rank]);
}
try {
  check = createCheckWorktree(root, "icu77-collapse", evidence);
  const prepared = path.join(check.target, "icu77/prepared.json");
  const env = {
    ...environment,
    DEMLIK_ICU77_PREPARED: prepared,
    RUST_ICU_LINK_SEARCH_DIR: path.join(check.target, "icu77/install/lib"),
    RUST_ICU_MAJOR_VERSION_NUMBER: "77",
  };
  assert.ok(process.env.DEMLIK_ICU77_SOURCE_ARCHIVE);
  const prep = run(
    "prepare",
    [
      process.env.DEMLIK_ICU77_PYTHON ?? "python3",
      "tools/icu77/prepare.py",
      "prepare",
      "--host",
      "aarch64-apple-darwin",
      "--target",
      "aarch64-apple-darwin",
      "--source-archive",
      process.env.DEMLIK_ICU77_SOURCE_ARCHIVE,
      "--cargo",
      cargo,
    ],
    check.root,
    env,
  );
  assert.equal(prep.status, 0);
  for (const mutation of mutations) {
    attempt = { ...mutation, phase: "prepare" };
    const modified = original.replace(mutation.before, mutation.after);
    const file = path.join(check.root, source);
    fs.writeFileSync(file, modified);
    attempt.sourceSha256 = hash(modified);
    fs.writeFileSync(path.join(evidence, `${mutation.name}.rs`), modified);
    attempt.phase = "compile";
    const build = run(
      `${mutation.name}.build`,
      [
        cargo,
        "build",
        "-p",
        "demlik-code-graph",
        "--example",
        "collapse_report_driver",
        "--locked",
        "--offline",
        "--message-format=json",
      ],
      check.root,
      env,
    );
    attempt.build = { ...build, stdout: undefined };
    assert.equal(build.status, 0, "compile failure has no semantic credit");
    const rows = build.stdout.trim().split("\n").map(JSON.parse);
    const library = compiledCheckLibrary(
      rows,
      "demlik_code_graph",
      check.root,
      check.target,
    );
    attempt.library = {
      ...library,
      ...retain(library.path, `${mutation.name}.library`),
    };
    const artifacts = rows.filter(
      (row) =>
        row.reason === "compiler-artifact" &&
        row.target.name === "collapse_report_driver" &&
        row.executable,
    );
    assert.equal(artifacts.length, 1);
    const artifact = artifacts[0];
    assert.equal(artifact.fresh, false);
    assertCheckPath(artifact.target.src_path, check.root);
    assertCheckPath(artifact.manifest_path, check.root);
    assertCheckPath(artifact.executable, check.target);
    const effective = path.join(evidence, `${mutation.name}.driver`);
    fs.copyFileSync(artifact.executable, effective);
    attempt.driver = { artifact, ...retain(effective, mutation.name) };
    assert.equal(hash(fs.readFileSync(file)), attempt.sourceSha256);
    save("current-attempt.json", attempt);
    attempt.phase = "compare";
    const reportFile = path.join(evidence, `${mutation.name}.report.json`);
    const pairEnv = { ...environment };
    delete pairEnv.DEMLIK_ICU77_COLLAPSE;
    if (mutation.group) pairEnv.DEMLIK_ICU77_COLLAPSE = "1";
    pairEnv.DEMLIK_COLLAPSE_REPORT_CASES = mutation.witness;
    const comparison = run(
      `${mutation.name}.compare`,
      [
        process.execPath,
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        path.join(root, "verification/parity/graph-collapse-report.mts"),
        effective,
        reportFile,
      ],
      root,
      pairEnv,
    );
    attempt.comparison = { ...comparison, stdout: undefined, reportFile };
    const report = JSON.parse(fs.readFileSync(reportFile));
    assert.equal(report.nativeExecutable.sha256, attempt.driver.sha256);
    assert.notEqual(comparison.status, 0);
    assert.equal(report.attempted, 1);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].id, mutation.witness);
    assert.equal(report.failures[0].kind, "semantic");
    const row = report.cases.find((row) => row.id === mutation.witness);
    const expected = projection(row, mutation.field, false);
    const actual = projection(row, mutation.field, true);
    assert.notDeepEqual(actual, expected, "named semantic witness must differ");
    controls.push({
      ...attempt,
      phase: "detected",
      detected: true,
      semanticWitness: { expected, actual },
      extraCaseCredit: 0,
    });
    save("controls.json", { baselineSha256, controls });
    fs.unlinkSync(effective);
    fs.writeFileSync(file, original);
    console.log(JSON.stringify({ control: mutation.name, detected: true }));
  }
  assert.equal(hash(fs.readFileSync(baseline)), baselineSha256);
  assert.equal(fs.readFileSync(path.join(root, source), "utf8"), original);
  save("controls.json", {
    baselineSha256,
    productSourceSha256: hash(original),
    controls,
    passed: controls.length,
    failures: [],
  });
} catch (error) {
  save("incomplete.json", {
    baselineSha256,
    controls,
    attempt,
    failure: String(error),
  });
  throw error;
} finally {
  if (check) check.remove();
}
