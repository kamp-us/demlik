import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Build one disposable mutation in a caller-owned, separate warm target. */
export function classifiedCommandControl(cargo, options) {
  const mutantRoot = path.resolve(options.mutantRoot);
  const target = path.resolve(options.target);
  const directory = path.resolve(options.directory);
  assert.notEqual(mutantRoot, path.resolve(root));
  assert.notEqual(
    target,
    path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(root, "target")),
  );
  assert.ok(fs.statSync(target).isDirectory(), "reuse a separate warm target");
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
  try {
    fs.writeFileSync(file, mutated);
    const built = spawnSync(cargo, command, {
      cwd: mutantRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CARGO_NET_OFFLINE: "true",
        CARGO_PROFILE_DEV_DEBUG: "0",
        CARGO_PROFILE_TEST_DEBUG: "0",
        CARGO_INCREMENTAL: "0",
        CARGO_BUILD_JOBS: "1",
        CARGO_TARGET_DIR: target,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (built.error) throw built.error;
    const cargoJson = path.join(directory, "guard-bypass.cargo.jsonl");
    fs.writeFileSync(cargoJson, built.stdout);
    fs.writeFileSync(`${cargoJson}.stderr`, built.stderr);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const artifact = built.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find(
        (row) =>
          row.reason === "compiler-artifact" &&
          row.target.name === "command_classified" &&
          row.executable,
      );
    assert.ok(artifact, "test binary must come from actual Cargo JSON");
    assert.equal(artifact.fresh, false);
    const ran = spawnSync(
      artifact.executable,
      [witness, "--exact", "--nocapture"],
      { cwd: mutantRoot, encoding: "utf8" },
    );
    if (ran.error) throw ran.error;
    fs.writeFileSync(path.join(directory, "guard-bypass.stdout"), ran.stdout);
    fs.writeFileSync(path.join(directory, "guard-bypass.stderr"), ran.stderr);
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
      binarySha256: hash(fs.readFileSync(artifact.executable)),
      witness,
      executionExit: ran.status,
      detectedSemanticFailure: true,
      baselineTargetWasUsed: false,
    };
    fs.writeFileSync(
      path.join(directory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  } finally {
    fs.writeFileSync(file, baseline);
    assert.equal(fs.readFileSync(path.join(root, relative), "utf8"), baseline);
  }
}
