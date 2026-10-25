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
const cargo = process.env.CARGO ?? "cargo";
const directory = mkdtempSync(join(tmpdir(), "demlik-llm-call-mutants-"));
const reports = join(root, "target/parity/llm-call-controls");
mkdirSync(reports, { recursive: true });
const file = "crates/tea/src/llm_call.rs",
  baseline = readFileSync(join(root, file), "utf8");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mutations = [
  {
    name: "command-key-is-reconstructed",
    before: ".attempt(state, key, CallValue::shared(input), at)",
    after: '.attempt(state, "wrong", CallValue::shared(input), at)',
  },
  {
    name: "schema-rejection-becomes-success",
    before: "Err(cause) => self.rejected(cause),",
    after: "Err(_cause) => Outcome::ok(CallValue::Undefined),",
  },
  {
    name: "own-undefined-cause-becomes-carrier",
    before: "CallValue::Undefined | CallValue::Missing => LlmCause::Undefined,",
    after:
      "CallValue::Undefined | CallValue::Missing => LlmCause::Carrier(Rc::new(RunError {kind:error.kind,details:error.details.clone()})),",
  },
  {
    name: "stored-failure-loses-typed-cause",
    before: "rc::CallFailure::external(error),",
    after: "rc::CallFailure::Undefined,",
  },
];
const results = [];
const caseIds = corpus()
  .filter((test) => test.input.kind === "pure")
  .map((test) => test.id);
try {
  for (const name of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    cpSync(join(root, name), join(directory, name), { recursive: true });
  for (const mutation of mutations) {
    assert.equal(baseline.split(mutation.before).length, 2, mutation.name);
    const changed = baseline.replace(mutation.before, mutation.after);
    writeFileSync(join(directory, file), changed);
    const target = join(directory, `target-${mutation.name}`),
      artifact = join(reports, mutation.name);
    mkdirSync(artifact, { recursive: true });
    console.log(`building isolated control: ${mutation.name}`);
    const built = spawnSync(
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
      `${built.stdout}\n${built.stderr}`,
    );
    assert.equal(built.status, 0, built.stderr);
    const binary = join(target, "debug/llm_call_driver"),
      reportFile = join(artifact, "report.json");
    const report = await llmCallParity({ binary, reportFile, caseIds });
    assert(report.failures.length > 0, `${mutation.name}: escaped control`);
    const binaryHash = hash(readFileSync(binary));
    assert.equal(binaryHash, report.binaryHash);
    cpSync(binary, join(artifact, "llm_call_driver"));
    writeFileSync(join(artifact, "llm_call.rs"), changed);
    results.push({
      name: mutation.name,
      detected: report.failures.length,
      cases: report.total,
      caseIds: report.failures.map((result) => result.id),
      baselineSourceHash: hash(baseline),
      mutatedSourceHash: hash(changed),
      binaryHash,
      reportHash: hash(readFileSync(reportFile)),
      patch: { before: mutation.before, after: mutation.after },
    });
    console.log(
      `detected ${mutation.name}: ${report.failures.length}/${report.total} scripts`,
    );
    // This target belongs only to the finished disposable control.
    rmSync(target, { recursive: true, force: true });
  }
  assert.equal(readFileSync(join(root, file), "utf8"), baseline);
  writeFileSync(
    join(reports, "summary.json"),
    `${JSON.stringify({ version: 1, results }, null, 2)}\n`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
