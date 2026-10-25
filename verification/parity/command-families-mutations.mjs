import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const cargo = process.env.CARGO ?? "cargo";
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-command-families-mutations-"),
);
const reportDirectory = path.join(root, "target/parity");
const mutations = [
  {
    name: "terminal-name-reverts-to-static-default",
    file: "crates/tea/src/command.rs",
    before: 'format!("{}_ok", self.name)',
    after: 'format!("{}_ok", D::NAME)',
    witness: "families.distinct.ok",
  },
  {
    name: "wire-definition-registers-static-default",
    file: "crates/tea/src/command.rs",
    before: "WireDefinition::new(self.cmd_type(), D::ERROR_TAGS,",
    after: "WireDefinition::new(D::NAME, D::ERROR_TAGS,",
    witness: "families.distinct.ok",
  },
  {
    name: "typed-guard-trusts-another-engine-edge",
    file: "crates/tea/src/command.rs",
    before: ".is_some_and(|stamp| Arc::ptr_eq(&stamp.edge, &self.edge))",
    after: ".is_some_and(|_| true)",
    witness: "families.distinct.ok",
  },
];
const results = [];
try {
  execFileSync(
    process.execPath,
    [path.join(here, "command-families-run.mjs")],
    {
      cwd: root,
      stdio: "pipe",
    },
  );
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, file), path.join(directory, file), {
      recursive: true,
    });
  await mkdir(reportDirectory, { recursive: true });
  for (const mutation of mutations) {
    const file = path.join(directory, mutation.file);
    const original = await readFile(file, "utf8");
    assert.equal(
      original.split(mutation.before).length,
      2,
      `${mutation.name} must alter exactly one site`,
    );
    await writeFile(file, original.replace(mutation.before, mutation.after));
    const target = path.join(
      root,
      "target/parity/command-families-mutation-build",
    );
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "--package",
        "demlik-parity",
        "--bin",
        "command-families-parity",
      ],
      {
        cwd: directory,
        env: { ...process.env, CARGO_TARGET_DIR: target },
        stdio: "pipe",
      },
    );
    const reportFile = path.join(reportDirectory, `${mutation.name}.json`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(here, "command-families-run.mjs"),
        "--rust-bin",
        path.join(target, "debug/command-families-parity"),
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
      (test) => test.id === mutation.witness,
    );
    assert.ok(witness, `${mutation.name} must fail its named contract`);
    assert.equal(
      witness.reference.ok,
      true,
      "the reference must execute successfully",
    );
    assert.equal(
      witness.native.ok,
      true,
      "a build/driver failure does not count as detection",
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
    path.join(reportDirectory, "command-families-mutations.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
