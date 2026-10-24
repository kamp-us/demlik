import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const cargo = process.env.CARGO ?? "cargo";
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-reconcile-mutation-"),
);
const reports = path.join(root, "target/parity");
const target = path.join(reports, "reconcile-mutation-build");
const mutations = [
  {
    name: "reconcile-prunes-outside-requested-scope",
    file: "reconcile.rs",
    before:
      "in_reach(&entry.scope, under) && !measured_keys.contains(&ledger_key(entry))",
    after: "!measured_keys.contains(&ledger_key(entry))",
    witness: 'scope-"app"',
  },
  {
    name: "migration-counts-deduplicated-crossings",
    file: "migrate.rs",
    before:
      "let measured = report\n                .violations\n                .iter()\n                .filter(|violation| counted(violation.kind()))\n                .count();",
    after:
      "let measured = measured_entries(std::slice::from_ref(report)).iter().filter(|entry| counted(entry.kind)).count();",
    witness: "count-duplicates-before-dedup",
  },
];
const results = [];
try {
  for (const name of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, name), path.join(directory, name), {
      recursive: true,
    });
  await mkdir(reports, { recursive: true });
  for (const mutation of mutations) {
    const file = path.join(
      directory,
      "crates/code-graph/src/boundaries",
      mutation.file,
    );
    const source = await readFile(file, "utf8");
    assert.equal(
      source.split(mutation.before).length,
      2,
      `${mutation.name}: alter exactly one rule`,
    );
    await writeFile(file, source.replace(mutation.before, mutation.after));
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "--package",
        "demlik-code-graph",
        "--example",
        "reconcile_driver",
      ],
      {
        cwd: directory,
        env: { ...process.env, CARGO_TARGET_DIR: target },
        stdio: "pipe",
      },
    );
    const reportFile = path.join(reports, `${mutation.name}.json`);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(here, "graph-reconcile.mts"),
        path.join(target, "debug/examples/reconcile_driver"),
        reportFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(result.status, 1, `${mutation.name}: ${result.stderr}`);
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    const witness = report.failures.find(
      (item) => item.id === mutation.witness,
    );
    assert.ok(witness, `${mutation.name}: intended witness must fail`);
    assert.equal(witness.reference.ok, true, "source call succeeds");
    assert.equal(
      witness.native.ok,
      true,
      "broken drivers do not count as detection",
    );
    results.push({
      name: mutation.name,
      detected: true,
      witness: mutation.witness,
      failures: report.failures.length,
      reportFile,
    });
    await writeFile(file, source);
  }
  await writeFile(
    path.join(reports, "reconcile-mutations.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
