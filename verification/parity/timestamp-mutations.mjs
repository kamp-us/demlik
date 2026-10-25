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
import { fileURLToPath } from "node:url";
import { corpus, llmCallParity } from "./llm-call.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = mkdtempSync(join(tmpdir(), "demlik-stamp-null-control-"));
const artifact = join(root, "target/parity/timestamp-null-control");
mkdirSync(artifact, { recursive: true });
const source = "crates/tea/src/command.rs",
  original = readFileSync(join(root, source), "utf8");
const before =
  '    let at = record\n        .remove("at")\n        .map(serde_json::from_value)\n        .transpose()?;';
const after =
  '    let at = record\n        .remove("at")\n        .map(|value| serde_json::from_value::<f64>(value).map(NumberOrNull::from))\n        .transpose()?;';
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  assert.equal(original.split(before).length, 2);
  for (const name of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    cpSync(join(root, name), join(directory, name), { recursive: true });
  const changed = original.replace(before, after);
  writeFileSync(join(directory, source), changed);
  const target = join(directory, "target"),
    cargo = process.env.CARGO ?? "cargo";
  const build = spawnSync(
    cargo,
    ["build", "--locked", "-p", "demlik-parity", "--bin", "llm_call_driver"],
    {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: target,
        CARGO_PROFILE_DEV_DEBUG: "0",
        CARGO_PROFILE_TEST_DEBUG: "0",
        CARGO_INCREMENTAL: "0",
        CARGO_BUILD_JOBS: "1",
      },
    },
  );
  writeFileSync(
    join(artifact, "build.log"),
    `${build.stdout}\n${build.stderr}`,
  );
  assert.equal(build.status, 0, build.stderr);
  const caseIds = corpus()
    .filter((test) => test.id.startsWith("llm.restored-stamp."))
    .map((test) => test.id);
  assert.equal(caseIds.length, 3);
  const binary = join(target, "debug/llm_call_driver"),
    reportFile = join(artifact, "report.json");
  const report = await llmCallParity({ binary, reportFile, caseIds });
  assert.equal(report.failures.length, 3);
  assert(report.failures.every((result) => result.equal === false));
  cpSync(binary, join(artifact, "llm_call_driver"));
  writeFileSync(join(artifact, "command.rs"), changed);
  const receipt = {
    name: "restored-null-stamp-is-refused-as-f64",
    detected: report.failures.length,
    caseIds,
    baselineSourceHash: hash(original),
    mutatedSourceHash: hash(changed),
    binaryHash: hash(readFileSync(binary)),
    reportHash: hash(readFileSync(reportFile)),
    patch: { before, after },
  };
  writeFileSync(
    join(artifact, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  assert.equal(readFileSync(join(root, source), "utf8"), original);
  console.log(JSON.stringify(receipt));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
