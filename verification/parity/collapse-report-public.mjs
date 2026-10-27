import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const [cargoFile, reportFile, evidenceDirectory] = process.argv.slice(2);
assert.ok(cargoFile && reportFile && evidenceDirectory);
for (const k of [
  "CARGO_TARGET_DIR",
  "CARGO_BUILD_TARGET_DIR",
  "CARGO_BUILD_BUILD_DIR",
  "DEMLIK_MUTATION_TARGET_DIR",
])
  assert.equal(process.env[k], undefined, k);
const root = fileURLToPath(new URL("../..", import.meta.url)),
  target = path.join(root, "target");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const rows = fs
  .readFileSync(cargoFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((s) => JSON.parse(s));
const libs = rows.filter(
  (r) =>
    r.reason === "compiler-artifact" &&
    r.target.name === "demlik_code_graph" &&
    r.target.kind.includes("lib") &&
    r.filenames.some((f) => f.endsWith(".rlib")),
);
assert.equal(libs.length, 1);
const artifact = libs[0],
  library = artifact.filenames.find((f) => f.endsWith(".rlib"));
assert.ok(library.startsWith(`${target}/`));
fs.mkdirSync(evidenceDirectory, { recursive: true });
function save(file, name) {
  const bytes = fs.readFileSync(file),
    gz = gzipSync(bytes),
    p = path.resolve(evidenceDirectory, `${name}.gz`);
  fs.writeFileSync(p, gz);
  return {
    path: p,
    sha256: hash(bytes),
    bytes: bytes.length,
    gzipSha256: hash(gz),
    gzipBytes: gz.length,
  };
}
const selected = save(library, "public-library");
const checks = [];
for (const [name, code] of [
  ["borrowed", null],
  ["lifetime", "E0597"],
]) {
  const source = path.join(
      root,
      `verification/parity/fixtures/collapse-report-${name}.rs`,
    ),
    out = path.join(target, `collapse-report-${name}`);
  const args = [
    "--edition=2024",
    "-Cdebuginfo=0",
    "--error-format=json",
    source,
    "--extern",
    `demlik_code_graph=${library}`,
    "-L",
    `dependency=${path.join(target, "debug/deps")}`,
    "-o",
    out,
  ];
  const compiled = spawnSync(process.env.RUSTC ?? "rustc", args, {
    cwd: root,
    encoding: "utf8",
  });
  assert.ifError(compiled.error);
  const stderr = path.resolve(evidenceDirectory, `${name}.stderr.jsonl`),
    stdout = path.resolve(evidenceDirectory, `${name}.stdout`);
  fs.writeFileSync(stderr, compiled.stderr);
  fs.writeFileSync(stdout, compiled.stdout);
  const errors = compiled.stderr
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s))
    .filter((d) => d.level === "error" && d.code)
    .map((d) => d.code.code);
  const check = {
    name,
    sourceSha256: hash(fs.readFileSync(source)),
    command: { cwd: root, executable: process.env.RUSTC ?? "rustc", args },
    compileExit: compiled.status,
    errors,
    stderr,
    stdout,
  };
  if (code) {
    assert.notEqual(compiled.status, 0);
    assert.deepEqual(errors, [code]);
  } else {
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(out, [], { encoding: "utf8" });
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    Object.assign(check, {
      runExit: run.status,
      runStdout: run.stdout,
      runStderr: run.stderr,
      executable: save(out, name),
    });
  }
  checks.push(check);
}
fs.writeFileSync(
  reportFile,
  `${JSON.stringify({ artifact, library: selected, cargoFile, cargoSha256: hash(fs.readFileSync(cargoFile)), checks, passed: true, qualification: "Compiled against this default-target Cargo-selected library; no cold/archive build claimed." }, null, 2)}\n`,
);
