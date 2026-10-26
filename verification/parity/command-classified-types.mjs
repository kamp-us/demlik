import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Compile against libraries selected by an actual Cargo JSON invocation. */
export function classifiedCommandTypes(libraries, options = {}) {
  const directory =
    options.directory ??
    path.join(root, "target/parity/command-classified-types");
  fs.mkdirSync(directory, { recursive: true });
  for (const library of Object.values(libraries))
    assert.equal(hash(fs.readFileSync(library.path)), library.sha256);
  const fixture = "crates/tea/examples/command_opaque_error.rs";
  const original = fs.readFileSync(path.join(root, fixture), "utf8");
  const probes = [
    { name: "borrowed-opaque", source: original },
    {
      name: "wrong-failure-family",
      before: "RunError::port_rejected(Rc::clone(&cause))",
      after: '"foreign error family"',
      code: "E0308",
      reason: "RunError",
    },
    {
      name: "wrong-output",
      before: "Outcome::err(RunError::port_rejected(Rc::clone(&cause)))",
      after: "Outcome::ok(CallValue::value(42_u64))",
      code: "E0308",
      reason: "u64",
    },
    {
      name: "opaque-settlement-needs-wire-codec",
      before: "    guard.check(&messages[0]).unwrap();",
      after:
        "    guard.check(&messages[0]).unwrap();\n    serde_json::to_string(&messages[0]).unwrap();",
      code: "E0277",
      reason: "Serialize",
    },
  ];
  const checks = probes.map((probe) => {
    if (probe.before)
      assert.equal(original.split(probe.before).length, 2, probe.name);
    const source = probe.source ?? original.replace(probe.before, probe.after);
    const file = path.join(directory, `${probe.name}.rs`);
    fs.writeFileSync(file, source);
    const binary = path.join(directory, probe.name);
    const command = [
      "--edition=2024",
      "-Cdebuginfo=0",
      "--error-format=json",
      "--crate-name",
      `command_classified_${probe.name.replaceAll("-", "_")}`,
      file,
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
    const result = spawnSync(compiler, command, {
      cwd: root,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    const log = `${file}.compile.jsonl`;
    fs.writeFileSync(log, result.stdout + result.stderr);
    const codes = result.stderr
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((diagnostic) => diagnostic.level === "error" && diagnostic.code)
      .map((diagnostic) => diagnostic.code.code);
    let execution;
    if (probe.code) {
      assert.notEqual(result.status, 0, probe.name);
      assert.deepEqual(codes, [probe.code], result.stderr);
      assert.ok(result.stderr.includes(probe.reason), result.stderr);
    } else {
      assert.equal(result.status, 0, result.stderr);
      const ran = spawnSync(binary, [], { cwd: root, encoding: "utf8" });
      if (ran.error) throw ran.error;
      fs.writeFileSync(`${binary}.run.log`, ran.stdout + ran.stderr);
      assert.equal(ran.status, 0, ran.stdout + ran.stderr);
      execution = {
        exit: ran.status,
        stdout: ran.stdout,
        stderr: ran.stderr,
        binarySha256: hash(fs.readFileSync(binary)),
      };
    }
    return {
      name: probe.name,
      source: file,
      sourceSha256: hash(source),
      command: [compiler, ...command],
      compileExit: result.status,
      errorCodes: codes,
      log,
      diagnosticsSha256: hash(result.stdout + result.stderr),
      execution,
    };
  });
  const report = {
    fixture,
    fixtureSha256: hash(original),
    libraries,
    positivePrograms: 1,
    intendedRefusals: 3,
    checks,
  };
  fs.writeFileSync(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
