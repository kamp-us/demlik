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
const directory = await mkdtemp(path.join(tmpdir(), "demlik-boundary-config-"));
const reports = path.join(root, "target/parity");
const target = path.join(reports, "reconcile-mutation-build");
const faults = [
  {
    name: "boundary-config-loses-default-lib",
    before: "let defaults = Self::default();",
    after: "let mut defaults = Self::default(); defaults.lib.clear();",
    witness: "defaults",
  },
  {
    name: "boundary-config-accepts-unknown-keys",
    before: "if keys.is_empty() {",
    after: "if true {",
    witness: "unknown-root-one",
  },
];
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
  const file = path.join(
    directory,
    "crates/code-graph/src/boundaries/config.rs",
  );
  const source = await readFile(file, "utf8");
  const receipt = [];
  for (const fault of faults) {
    assert.equal(source.split(fault.before).length, 2, fault.name);
    await writeFile(file, source.replace(fault.before, fault.after));
    execFileSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "--package",
        "demlik-code-graph",
        "--example",
        "boundary_config_driver",
      ],
      {
        cwd: directory,
        env: { ...process.env, CARGO_TARGET_DIR: target },
        stdio: "pipe",
      },
    );
    const reportFile = path.join(reports, `${fault.name}.json`);
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        path.join(here, "graph-boundary-config.mts"),
        path.join(target, "debug/examples/boundary_config_driver"),
        reportFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    const witness = report.failures.find((item) => item.id === fault.witness);
    assert.ok(witness, fault.name);
    assert.equal(witness.reference.ok, true);
    assert.equal(witness.native.ok, true, "a failed driver is not detection");
    receipt.push({
      name: fault.name,
      detected: true,
      witness: witness.id,
      failures: report.failures.length,
      reportFile,
    });
  }
  await writeFile(
    path.join(reports, "boundary-config-mutations.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
