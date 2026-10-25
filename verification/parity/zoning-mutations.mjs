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
const directory = await mkdtemp(path.join(tmpdir(), "demlik-zoning-mutation-"));
const reports = path.join(root, "target/parity");
const target = path.join(reports, "reconcile-mutation-build");
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
    "crates/code-graph/src/boundaries/rules.rs",
  );
  const source = await readFile(file, "utf8");
  const before =
    "static PORT_PORTS: ZoneRule = ZoneRule {\n    open_to_outside: true,";
  assert.equal(
    source.split(before).length,
    2,
    "alter only the port-layout ports rule",
  );
  await writeFile(
    file,
    source.replace(before, before.replace("true", "false")),
  );
  execFileSync(
    cargo,
    [
      "build",
      "--locked",
      "--package",
      "demlik-code-graph",
      "--example",
      "zoning_driver",
    ],
    {
      cwd: directory,
      env: { ...process.env, CARGO_TARGET_DIR: target },
      stdio: "pipe",
    },
  );
  const reportFile = path.join(reports, "zoning-closes-public-ports.json");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(here, "graph-zoning.mts"),
      path.join(target, "debug/examples/zoning_driver"),
      reportFile,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  const witness = report.failures.find((item) => item.id === "port-complete");
  assert.ok(
    witness,
    "public ports must be open to callers outside the hexagon",
  );
  assert.equal(witness.reference.ok, true);
  assert.equal(
    witness.native.ok,
    true,
    "a failed driver cannot count as detection",
  );
  const receipt = [
    {
      name: "zoning-closes-public-ports",
      detected: true,
      witness: witness.id,
      failures: report.failures.length,
      reportFile,
    },
  ];
  await writeFile(
    path.join(reports, "zoning-mutations.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
