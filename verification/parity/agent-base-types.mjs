import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function agentBaseTypes(library) {
  const fixture = "crates/tea/tests/agent_base.rs";
  const original = fs.readFileSync(path.join(root, fixture), "utf8");
  const directory = path.join(root, "target/parity/agent-base-types");
  fs.mkdirSync(directory, { recursive: true });
  assert.equal(hash(fs.readFileSync(library.path)), library.sha256);
  const probes = [
    { name: "borrowed-opaque", source: original },
    {
      name: "wrong-turn-view",
      before: "            turn_view,\n        )\n        .instructions",
      after:
        "            |_: &AuditTurn<'_>| &0_u8,\n        )\n        .instructions",
      code: "E0308",
      reason: "AgentTurn",
    },
    {
      name: "untagged-tool-command",
      before:
        'ctx.calls.borrow_mut().push("toolOf");\n                ToolCommand(Rc::clone(call))',
      after:
        'ctx.calls.borrow_mut().push("toolOf");\n                String::from("wrong command family")',
      code: "E0277",
      reason: "Tagged",
    },
  ];
  const checks = probes.map((probe) => {
    if (probe.before)
      assert.equal(original.split(probe.before).length, 2, probe.name);
    const source = probe.source ?? original.replace(probe.before, probe.after);
    const file = path.join(directory, `${probe.name}.rs`);
    fs.writeFileSync(file, source);
    const command = [
      "--edition=2024",
      "--test",
      "--emit=metadata",
      "--crate-name",
      `agent_base_${probe.name.replaceAll("-", "_")}`,
      file,
      "--extern",
      `demlik_tea=${library.path}`,
      "-L",
      `dependency=${path.dirname(library.path)}`,
      "-o",
      path.join(directory, `${probe.name}.rmeta`),
    ];
    const compiler = process.env.RUSTC ?? "rustc";
    const result = spawnSync(compiler, command, {
      cwd: root,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    const log = `${file}.log`;
    fs.writeFileSync(log, result.stdout + result.stderr);
    if (probe.code) {
      assert.notEqual(result.status, 0, probe.name);
      assert.ok(result.stderr.includes(probe.code), result.stderr);
      assert.ok(result.stderr.includes(probe.reason), result.stderr);
    } else assert.equal(result.status, 0, result.stderr);
    return {
      name: probe.name,
      expected: probe.code ?? "compiled",
      exit: result.status,
      source: file,
      sourceSha256: hash(source),
      log,
      diagnosticsSha256: hash(result.stdout + result.stderr),
      command: [compiler, ...command],
    };
  });
  const report = {
    fixture,
    fixtureSha256: hash(original),
    library,
    positive: 1,
    negative: 2,
    checks,
  };
  fs.writeFileSync(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify({ agentBaseTypes: { positive: 1, negative: 2 } }));
  return report;
}
