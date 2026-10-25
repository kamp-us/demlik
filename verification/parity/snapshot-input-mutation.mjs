import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { report: { type: "string" } },
  strict: true,
});
const root = process.cwd(),
  source = "crates/tea/src/persistence/snapshot.rs",
  before = readFileSync(source, "utf8");
const digest = (v) => createHash("sha256").update(v).digest("hex");
const temporary = mkdtempSync(join(tmpdir(), "demlik-snapshot-input-mutant-")),
  target = mkdtempSync(join(tmpdir(), "demlik-snapshot-input-mutant-target-"));
const reportFile = resolve(
  values.report ?? "target/parity/snapshot-input-control.json",
);
function run(command, args, options = {}) {
  const p = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    p.status,
    0,
    `${command} ${args.join(" ")}\n${p.stdout}\n${p.stderr}`,
  );
  return p;
}
try {
  for (const path of ["Cargo.toml", "Cargo.lock", "crates"])
    cpSync(join(root, path), join(temporary, path), { recursive: true });
  const needle = "last_saved_seq: input.seq.number(),",
    fault = "last_saved_seq: Some(input.seq.number_or_zero()),";
  assert.equal(before.split(needle).length, 2);
  const mutated = before.replace(needle, fault);
  writeFileSync(join(temporary, source), mutated);
  const build = run(
    process.env.CARGO ?? "cargo",
    [
      "build",
      "--locked",
      "-p",
      "demlik-tea",
      "--example",
      "snapshot_input_driver",
    ],
    { cwd: temporary, env: { ...process.env, CARGO_TARGET_DIR: target } },
  );
  const binary = join(target, "debug/examples/snapshot_input_driver"),
    resultPath = join(temporary, "result.json");
  const check = spawnSync(
    "pnpm",
    [
      "exec",
      "node",
      "--import",
      "./verification/parity/node_modules/tsx/dist/loader.mjs",
      "verification/parity/snapshot-input.mts",
      "--native-bin",
      binary,
      "--report",
      resultPath,
    ],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  assert.equal(check.status, 1, check.stderr);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  assert(result.failures.some((c) => c.id === "snapshot.input.nonfinite-json"));
  const saved = resolve(
    "target/parity/control-binaries/snapshot-null-normalized",
  );
  mkdirSync(dirname(saved), { recursive: true });
  cpSync(binary, saved);
  const report = {
    id: "snapshot-null-normalized-to-zero",
    compiled: true,
    source: {
      path: source,
      originalSha256: digest(before),
      mutatedSha256: digest(mutated),
    },
    binary: { path: saved, sha256: digest(readFileSync(binary)) },
    detectedIds: result.failures.map((c) => c.id),
    results: result,
    build: { exit: build.status, stderr: build.stderr },
    activeSourceUnchanged: readFileSync(source, "utf8") === before,
  };
  assert(report.activeSourceUnchanged);
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      id: report.id,
      compiled: true,
      detected: report.detectedIds,
      report: reportFile,
    }),
  );
} finally {
  assert.equal(readFileSync(source, "utf8"), before);
  rmSync(temporary, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
}
