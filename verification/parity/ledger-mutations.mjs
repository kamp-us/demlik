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
const mutationCheck = createCheckWorktree(process.cwd(), "ledger-mutations");
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const reports = path.join(root, "target/parity");
  const target = mutationCheck.target;
  const reportFile = path.join(reports, "ledger-first-reason-mutation.json");
  try {
    await mkdir(reports, { recursive: true });
    const file = path.join(
      directory,
      "crates/code-graph/src/boundaries/ledger.rs",
    );
    const source = await readFile(file, "utf8");
    const before = "held.reason.is_none() && entry.reason.is_some()";
    assert.equal(
      source.split(before).length,
      2,
      "alter exactly one reason-owner rule",
    );
    await writeFile(file, source.replace(before, "entry.reason.is_some()"));
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "--package",
        "demlik-code-graph",
        "--example",
        "ledger_driver",
      ],
      {
        cwd: directory,
        env: { ...process.env },
        stdio: "pipe",
      },
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(here, "graph-ledger.mts"),
        path.join(target, "debug/examples/ledger_driver"),
        reportFile,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.equal(
      result.status,
      1,
      `the reason-owner fault must fail behavior: ${result.stderr}`,
    );
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    const witness = report.failures.find(
      (item) => item.id === "prefer-first-reason",
    );
    assert.ok(
      witness,
      "the intended reason-owner contract must detect the fault",
    );
    assert.equal(
      witness.reference.ok,
      true,
      "the TypeScript call must succeed",
    );
    assert.equal(
      witness.native.ok,
      true,
      "a failed driver cannot count as detection",
    );
    assert.equal(report.attempted, report.passed + report.failures.length);
    const receipt = [
      {
        name: "ledger-overwrites-first-reason",
        detected: true,
        witness: "prefer-first-reason",
        failures: report.failures.length,
        reportFile,
      },
    ];
    await writeFile(
      path.join(reports, "ledger-mutations.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
  }
} catch (error) {
  mutationFailure = error;
  throw error;
} finally {
  mutationCheck.remove(mutationFailure);
}
