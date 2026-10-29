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
const mutationCheck = createCheckWorktree(process.cwd(), "zoning-mutations");
let mutationFailure;
try {
  const directory = mutationCheck.root;
  const reports = path.join(root, "target/parity");
  const target = mutationCheck.target;
  try {
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
        env: { ...process.env },
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
  }
} catch (error) {
  mutationFailure = error;
  throw error;
} finally {
  mutationCheck.remove(mutationFailure);
}
