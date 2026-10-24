import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const directory = await mkdtemp(path.join(tmpdir(), "demlik-parity-mutation-"));
const reportDirectory = path.join(root, "target/parity");
const cargo = process.env.CARGO ?? "cargo";
const mutations = [
  {
    name: "backoff-ignores-cap",
    file: "crates/tea/src/retry_backoff.rs",
    before: "js_min(curve.cap_ms, exponential)",
    after: "exponential",
    witness: "retry.cap",
  },
  {
    name: "scc-component-numbering-starts-at-one",
    file: "crates/code-graph/src/scc.rs",
    before: "next_component: 0,",
    after: "next_component: 1,",
    witness: "scc.cycle-with-caller",
  },
];
const results = [];
try {
  await mkdir(reportDirectory, { recursive: true });
  execFileSync(process.execPath, [path.join(here, "run.mjs")], {
    cwd: root,
    stdio: "pipe",
  });
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ]) {
    await cp(path.join(root, file), path.join(directory, file), {
      recursive: true,
    });
  }
  for (const mutation of mutations) {
    const file = path.join(directory, mutation.file);
    const original = await readFile(file, "utf8");
    assert.equal(
      original.split(mutation.before).length,
      2,
      `${mutation.name} must alter exactly one site`,
    );
    await writeFile(file, original.replace(mutation.before, mutation.after));
    const targetDirectory = path.join(root, "target/parity/mutation-build");
    execFileSync(cargo, ["build", "--locked", "--package", "demlik-parity"], {
      cwd: directory,
      env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
      stdio: "pipe",
    });
    const reportFile = path.join(reportDirectory, `${mutation.name}.json`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(here, "run.mjs"),
        "--rust-bin",
        path.join(targetDirectory, "debug/demlik-parity"),
        "--report",
        reportFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(
      result.status,
      1,
      `${mutation.name} must produce a behavioral failure: ${result.stderr}`,
    );
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    const witness = report.failures.find(
      (failure) => failure.id === mutation.witness,
    );
    assert.ok(witness, `${mutation.name} must fail its intended contract`);
    assert.equal(
      witness.typescript.ok,
      true,
      "the reference must execute successfully",
    );
    assert.equal(
      witness.rust.ok,
      true,
      "a broken driver or build cannot count as detection",
    );
    results.push({
      name: mutation.name,
      detected: true,
      witness: mutation.witness,
      failures: report.failures.length,
    });
    await writeFile(file, original);
  }
  await writeFile(
    path.join(reportDirectory, "mutations.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
