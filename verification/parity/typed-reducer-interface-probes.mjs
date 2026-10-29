import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const probes = [
  { id: "wrong_error", code: "E0308" },
  { id: "borrowed_actor_error", code: "E0597" },
];
export function typedReducerInterfaceProbes({
  check,
  library,
  dependencies,
  directory,
}) {
  assert.equal(fs.realpathSync(check.root), fs.realpathSync(root));
  assertCheckPath(dependencies, check.target);
  const target = path.join(check.target, "typed-reducer-types");
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  const results = [];
  const compiler =
    process.env.RUSTC ??
    (process.env.CARGO
      ? path.join(path.dirname(process.env.CARGO), "rustc")
      : "rustc");
  for (const probe of probes) {
    const source = assertCheckPath(
      path.join(
        root,
        "verification/parity/typed-reducer-interface-types",
        `${probe.id}.rs`,
      ),
      root,
    );
    const copied = path.join(target, `${probe.id}.rs`);
    const bytes = fs.readFileSync(source);
    fs.writeFileSync(copied, bytes);
    fs.writeFileSync(path.join(directory, `${probe.id}.rs`), bytes);
    const args = [
      "--edition=2024",
      "--error-format=json",
      "--emit=metadata",
      copied,
      "--extern",
      `demlik_tea=${library}`,
      "-L",
      `dependency=${dependencies}`,
      "-o",
      path.join(target, `${probe.id}.rmeta`),
    ];
    const compiled = spawnSync(compiler, args, {
      cwd: check.root,
      env: cargoCheckEnvironment(),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    fs.writeFileSync(
      path.join(directory, `${probe.id}.stdout`),
      compiled.stdout ?? "",
    );
    fs.writeFileSync(
      path.join(directory, `${probe.id}.stderr`),
      compiled.stderr ?? "",
    );
    const diagnostics = (compiled.stderr ?? "")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const errors = diagnostics
      .filter((row) => row.level === "error" && row.code)
      .map((row) => ({ code: row.code.code, message: row.message }));
    const row = {
      ...probe,
      source,
      sourceSha256: hash(bytes),
      command: [compiler, ...args],
      exit: compiled.status,
      signal: compiled.signal,
      error: compiled.error?.message,
      errors,
    };
    results.push(row);
    fs.writeFileSync(
      path.join(directory, "results.json"),
      `${JSON.stringify({ results, complete: false, semanticCredit: 0 }, null, 2)}\n`,
    );
    assert.equal(compiled.error, undefined);
    assert.equal(compiled.signal, null);
    assert.equal(compiled.status, 1, "intentional type refusal required");
    assert.deepEqual(
      errors.map((error) => error.code),
      [probe.code],
      "sole intended coded diagnostic; setup errors are not proof",
    );
  }
  const report = {
    results,
    complete: true,
    semanticCredit: 0,
    library: { path: library, sha256: hash(fs.readFileSync(library)) },
    dependencies,
    outputDirectory: target,
  };
  fs.writeFileSync(
    path.join(directory, "results.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
