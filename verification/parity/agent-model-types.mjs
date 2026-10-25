import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (x) => createHash("sha256").update(x).digest("hex");
export function agentModelTypes(options = {}) {
  const target = process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
    deps = path.join(target, "debug/deps"),
    candidates = fs
      .readdirSync(deps)
      .filter((x) => /^libdemlik_tea-.*\.rlib$/.test(x));
  assert.equal(candidates.length, 1);
  const library = path.join(deps, candidates[0]);
  const compiler = path.join(
    path.dirname(
      process.env.CARGO ??
        "/private/tmp/demlik-rust-toolchain-01a16c9d/cargo/bin/cargo",
    ),
    "rustc",
  );
  const checks = [
    ["unadapted-error-family", "E0271", "StructuredOutputError"],
    ["future-is-not-model", "E0277", "Llm"],
    ["model-is-required", "E0061", "argument"],
  ].map(([name, code, reason]) => {
    const source = path.join(
        root,
        `verification/parity/agent-model-types/${name}.rs`,
      ),
      command = [
        "--edition",
        "2024",
        "-C",
        "debuginfo=0",
        "--emit=metadata",
        source,
        "--extern",
        `demlik_tea=${library}`,
        "-L",
        `dependency=${deps}`,
        "-o",
        path.join(target, `agent-model-${name}.rmeta`),
      ];
    const out = spawnSync(compiler, command, {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    fs.writeFileSync(
      path.join(target, `agent-model-type-${name}.log`),
      out.stdout + out.stderr,
    );
    assert.notEqual(out.status, 0, name);
    assert.ok(out.stderr.includes(code), out.stderr);
    assert.ok(out.stderr.includes(reason), out.stderr);
    return {
      name,
      refused: true,
      code,
      sourceSha256: hash(fs.readFileSync(source)),
      compiler,
      command,
      diagnosticsSha256: hash(out.stdout + out.stderr),
    };
  });
  const report = {
    checks,
    library,
    librarySha256: hash(fs.readFileSync(library)),
    modelSha256: hash(
      fs.readFileSync(path.join(root, "crates/tea/src/agent/model.rs")),
    ),
    positiveConsumers: [
      "crates/tea/tests/agent_model.rs",
      "crates/tea/examples/agent_model/family.rs",
      "crates/tea/tests/agent_model_runtime.rs",
    ],
  };
  const file =
    options.reportFile ??
    path.join(root, "target/parity/agent-model-types.json");
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ refusals: checks.length, report: file }));
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  agentModelTypes();
