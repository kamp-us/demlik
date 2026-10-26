import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function agentStatusTypes(libraries) {
  const directory = path.join(root, "target/parity/agent-status-types");
  fs.mkdirSync(directory, { recursive: true });
  for (const library of Object.values(libraries))
    assert.equal(hash(fs.readFileSync(library.path)), library.sha256);
  const probes = [
    { name: "opaque", source: "crates/tea/tests/agent_status.rs", test: true },
    { name: "ended-fields" },
    { name: "missing-idle", code: "E0004" },
    { name: "missing-cancelled", code: "E0004" },
    { name: "pending-outlives-owner", code: "E0515" },
  ];
  const checks = probes.map((probe) => {
    const source = path.join(
      root,
      probe.source ?? `verification/parity/agent-status-types/${probe.name}.rs`,
    );
    const binary = path.join(directory, probe.name);
    const args = [
      "--edition=2024",
      "-Dwarnings",
      "-Cdebuginfo=0",
      ...(probe.test ? ["--test"] : []),
      "--crate-name",
      `agent_status_${probe.name.replaceAll("-", "_")}`,
      source,
      "-L",
      `dependency=${path.dirname(libraries.demlik_tea.path)}`,
      ...Object.entries(libraries).flatMap(([name, library]) => [
        "--extern",
        `${name}=${library.path}`,
      ]),
      "-o",
      binary,
    ];
    const compiler = process.env.RUSTC ?? "rustc";
    const result = spawnSync(compiler, args, { cwd: root, encoding: "utf8" });
    if (result.error) throw result.error;
    const log = path.join(directory, `${probe.name}.compile.log`);
    fs.writeFileSync(log, result.stdout + result.stderr);
    let execution;
    if (probe.code) {
      assert.notEqual(result.status, 0, probe.name);
      assert.ok(result.stderr.includes(probe.code), result.stderr);
    } else {
      assert.equal(result.status, 0, result.stderr);
      const ran = spawnSync(binary, [], { cwd: root, encoding: "utf8" });
      if (ran.error) throw ran.error;
      fs.writeFileSync(`${binary}.run.log`, ran.stdout + ran.stderr);
      assert.equal(ran.status, 0, ran.stdout + ran.stderr);
      execution = { exit: ran.status, stdout: ran.stdout, stderr: ran.stderr };
    }
    return {
      name: probe.name,
      expected: probe.code ?? "compiled and executed",
      source,
      sourceSha256: hash(fs.readFileSync(source)),
      command: [compiler, ...args],
      compileExit: result.status,
      log,
      diagnosticsSha256: hash(result.stdout + result.stderr),
      execution,
    };
  });
  const report = {
    positivePrograms: 2,
    intendedRefusals: 3,
    libraries,
    checks,
  };
  fs.writeFileSync(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ agentStatusTypes: { positive: 2, negative: 3 } }),
  );
  return report;
}
