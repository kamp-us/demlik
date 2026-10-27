import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function subscriptionTypes(library, directory) {
  fs.mkdirSync(directory, { recursive: true });
  assert.equal(hash(fs.readFileSync(library.path)), library.sha256);
  const cases = [
    { name: "actor-owned" },
    { name: "actor-borrow", code: "E0597" },
    { name: "wrong-family", code: "E0308" },
  ];
  const checks = cases.map((test) => {
    const source = path.join(
      root,
      "verification/parity/subscription-interface-types",
      `${test.name}.rs`,
    );
    const out = path.join(directory, `${test.name}.rmeta`);
    const compiler = process.env.RUSTC ?? "rustc";
    const args = [
      "--edition=2024",
      "-Cdebuginfo=0",
      "--emit=metadata",
      "--error-format=json",
      "--crate-name",
      `subscription_${test.name.replaceAll("-", "_")}`,
      source,
      "-L",
      `dependency=${path.dirname(library.path)}`,
      "--extern",
      `demlik_tea=${library.path}`,
      "-o",
      out,
    ];
    const result = spawnSync(compiler, args, { cwd: root, encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    fs.writeFileSync(`${out}.log`, result.stdout + result.stderr);
    const codes = result.stderr
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter((d) => d.level === "error" && d.code)
      .map((d) => d.code.code);
    if (test.code) {
      assert.equal(result.status, 1);
      assert.deepEqual(codes, [test.code]);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(codes, []);
    }
    return {
      name: test.name,
      source,
      sourceSha256: hash(fs.readFileSync(source)),
      command: [compiler, ...args],
      status: result.status,
      codes,
      compileOnly: true,
      log: `${out}.log`,
    };
  });
  const report = {
    scope:
      "Inherited interface typing rechecked against this actual Cargo-selected conformance library. Owned actor positive is compile-only; real Promise/Effect execution is in the eight new owner tests and 65 strict scripts.",
    library,
    checks,
  };
  fs.writeFileSync(
    path.join(directory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
