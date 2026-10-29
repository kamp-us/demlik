import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCheckWorktree,
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const cargo = process.env.CARGO ?? "cargo";
const mutationCheck = createCheckWorktree(process.cwd(), "reconcile-mutations");
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const reports = path.join(root, "target/parity");
  const target = mutationCheck.target;
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
          env: { ...process.env },
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
  }
} catch (error) {
  mutationFailure = error;
  throw error;
} finally {
  mutationCheck.remove(mutationFailure);
}
