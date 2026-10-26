import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  checkEvidenceDirectory,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Build one mutation in a registered worktree with Cargo's default target. */
export function classifiedCommandControl(cargo, options) {
  const directory = path.resolve(options.directory);
  const check = createCheckWorktree(root, "classified-command", directory);
  try {
    return classifiedCommandControlIn(
      cargo,
      directory,
      check.root,
      check.target,
    );
  } finally {
    check.remove();
  }
}

function classifiedCommandControlIn(cargo, directory, mutantRoot, target) {
  assert.notEqual(mutantRoot, path.resolve(root));
  assert.equal(target, path.join(mutantRoot, "target"));
  fs.mkdirSync(directory, { recursive: true });
  const relative = "crates/tea/src/command.rs";
  const baseline = fs.readFileSync(path.join(root, relative), "utf8");
  const file = path.join(mutantRoot, relative);
  assert.equal(fs.readFileSync(file, "utf8"), baseline);
  const witness =
    "classifier_view_is_checked_and_preserved_as_undeclared_failure_data";
  const before = "if !failure_tag(&failure)";
  assert.equal(baseline.split(before).length, 2);
  const mutated = baseline.replace(
    before,
    "if false && !failure_tag(&failure)",
  );
  const mutationSource = path.join(directory, "guard-bypass.command.rs");
  fs.writeFileSync(mutationSource, mutated);
  const command = [
    "test",
    "--locked",
    "-p",
    "demlik-tea",
    "--test",
    "command_classified",
    "--no-run",
    "--message-format=json",
  ];
  const attempt = {
    phase: "prepare",
    checkWorktree: mutantRoot,
    defaultTarget: target,
    command: [cargo, ...command],
    mutationSource,
    mutationSourceSha256: hash(mutated),
  };
  try {
    fs.writeFileSync(file, mutated);
    attempt.phase = "compile";
    const built = spawnSync(cargo, command, {
      cwd: mutantRoot,
      encoding: "utf8",
      env: cargoCheckEnvironment({
        CARGO_NET_OFFLINE: "true",
        CARGO_PROFILE_DEV_DEBUG: "0",
        CARGO_PROFILE_TEST_DEBUG: "0",
        CARGO_INCREMENTAL: "0",
        CARGO_BUILD_JOBS: "1",
      }),
      maxBuffer: 16 * 1024 * 1024,
    });
    const cargoJson = path.join(directory, "guard-bypass.cargo.jsonl");
    fs.writeFileSync(cargoJson, built.stdout ?? "");
    fs.writeFileSync(`${cargoJson}.stderr`, built.stderr ?? "");
    attempt.compile = {
      exit: built.status,
      signal: built.signal,
      cargoJson,
    };
    if (built.error) throw built.error;
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const rows = built.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const library = compiledCheckLibrary(
      rows,
      "demlik_tea",
      mutantRoot,
      target,
    );
    library.sha256 = hash(fs.readFileSync(library.path));
    const artifacts = rows.filter(
      (row) =>
        row.reason === "compiler-artifact" &&
        row.target.name === "command_classified" &&
        row.executable,
    );
    assert.equal(artifacts.length, 1);
    const artifact = artifacts[0];
    assert.equal(artifact.fresh, false);
    assertCheckPath(artifact.executable, target);
    assert.equal(hash(fs.readFileSync(file)), hash(mutated));
    const effectiveBinary = path.join(directory, "guard-bypass.bin");
    fs.copyFileSync(artifact.executable, effectiveBinary);
    const binarySha256 = hash(fs.readFileSync(effectiveBinary));
    assert.equal(binarySha256, hash(fs.readFileSync(artifact.executable)));
    attempt.phase = "execute";
    attempt.artifact = artifact;
    attempt.library = library;
    attempt.effectiveBinary = effectiveBinary;
    attempt.binarySha256 = binarySha256;
    const ran = spawnSync(
      effectiveBinary,
      [witness, "--exact", "--nocapture"],
      { cwd: mutantRoot, encoding: "utf8" },
    );
    attempt.execution = { exit: ran.status, signal: ran.signal };
    fs.writeFileSync(
      path.join(directory, "guard-bypass.stdout"),
      ran.stdout ?? "",
    );
    fs.writeFileSync(
      path.join(directory, "guard-bypass.stderr"),
      ran.stderr ?? "",
    );
    fs.writeFileSync(
      path.join(directory, "guard-bypass.process.json"),
      `${JSON.stringify({ artifact, library, effectiveBinary, binarySha256, sourceSha256: hash(mutated), status: ran.status, signal: ran.signal }, null, 2)}\n`,
    );
    if (ran.error) throw ran.error;
    assert.equal(ran.status, 101, ran.stdout + ran.stderr);
    assert.match(ran.stdout, new RegExp(`${witness}.*FAILED`));
    assert.match(ran.stderr, /undeclared classifier view reached the model/);
    const report = {
      name: "classified-command-tag-guard-bypass",
      baselineSourceSha256: hash(baseline),
      mutationSource,
      mutationSourceSha256: hash(mutated),
      command: [cargo, ...command],
      cargoJson,
      compileExit: built.status,
      artifact,
      library,
      binarySha256,
      effectiveBinary,
      witness,
      executionExit: ran.status,
      detectedSemanticFailure: true,
      baselineTargetWasUsed: false,
      defaultTarget: target,
      checkWorktree: mutantRoot,
    };
    fs.writeFileSync(
      path.join(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  } catch (error) {
    fs.writeFileSync(
      path.join(directory, "report.json"),
      `${JSON.stringify({ ...attempt, incomplete: true, detectedSemanticFailure: false, failure: { name: error.name, message: error.message, code: error.code, errno: error.errno, syscall: error.syscall, path: error.path, stack: error.stack } }, null, 2)}\n`,
    );
    throw error;
  } finally {
    fs.writeFileSync(file, baseline);
    assert.equal(fs.readFileSync(path.join(root, relative), "utf8"), baseline);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { values } = parseArgs({ options: { directory: { type: "string" } } });
  const report = classifiedCommandControl(process.env.CARGO ?? "cargo", {
    directory:
      values.directory ?? checkEvidenceDirectory(root, "classified-command"),
  });
  console.log(
    JSON.stringify({
      detected: report.detectedSemanticFailure,
      compileExit: report.compileExit,
      executionExit: report.executionExit,
    }),
  );
}
