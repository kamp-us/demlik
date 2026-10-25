import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, "../..");
const cargo = process.env.CARGO ?? "cargo";
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-resilient-mutations-"),
);
const reportDirectory = path.join(root, "target/parity");
const module = "crates/tea/src/resilience/resilient_call/mod.rs";
const decode = "crates/tea/src/resilience/resilient_call/decode.rs";
const mutations = [
  {
    name: "cache-gate-disappears",
    file: module,
    before: "if self.config.cache.is_some() {",
    after: "if false && self.config.cache.is_some() {",
    witness: "resilient.cache",
  },
  {
    name: "spent-budget-reaches-cache",
    file: module,
    before:
      "if self.config.deadline.is_some() && budget.remaining_ms.number_or_zero() <= 0.0 {",
    after:
      "if false && self.config.deadline.is_some() && budget.remaining_ms.number_or_zero() <= 0.0 {",
    witness: "resilient.budget-before-cache",
  },
  {
    name: "resume-charges-downtime",
    file: module,
    before:
      "budget: CallBudget {\n                        charging_since_ms: at,\n                        ..*budget\n                    },",
    after: "budget: self.charge(*budget, at),",
    sites: 2,
    witness: "resilient.named",
  },
  {
    name: "timer-id-loses-family",
    file: module,
    before: 'format!("{}:{kind}:", self.name())',
    after: 'format!("resilient:{kind}:")',
    witness: "resilient.named",
  },
  {
    name: "undefined-is-a-cache-hit",
    file: module,
    before: "if !value.is_undefined() {",
    after: "if true {",
    witness: "resilient.value-undefined",
  },
  {
    name: "restoration-defaults-null-attempt",
    file: decode,
    before: "attempt: fields.attempt,",
    after: "attempt: fields.attempt.number_or_zero().into(),",
    witness: "resilient.key-63-6f-6e-73-74-72-75-63-74-6f-72",
  },
  {
    name: "rate-denial-burns-a-circuit-probe",
    file: module,
    before:
      "let state = State::from_snapshot(Snapshot {\n                    bucket,",
    after:
      "let state = State::from_snapshot(Snapshot {\n                    circuit: self.config.circuit.map_or(state.0.circuit, |policy| circuit_breaker::can_pass(&state.0.circuit, &policy.into(), at).0),\n                    bucket,",
    witness: "resilient.zero-rate-before-circuit",
  },
  {
    name: "failure-guard-erases-raw-text",
    file: "crates/tea/src/command.rs",
    before:
      "let failure = plain_data(&error).map_err(CommandContractError::serialization)?;",
    after:
      "let failure = serde_json::to_value(&error).map(|value| PlainData::from(&value)).map_err(CommandContractError::serialization)?;",
    witness: "resilient.engine-port_rejected",
  },
  {
    name: "external-deadline-error-loses-cause",
    file: decode,
    before: '#[serde(rename_all = "camelCase", deny_unknown_fields)]',
    after: '#[serde(rename_all = "camelCase")]',
    witness: "resilient.error-extra-deadline",
  },
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const results = [];
try {
  execFileSync(process.execPath, [path.join(here, "resilient-call-run.mjs")], {
    cwd: root,
    stdio: "pipe",
    timeout: 120_000,
  });
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, file), path.join(directory, file), {
      recursive: true,
    });
  await mkdir(reportDirectory, { recursive: true });
  for (const mutation of mutations) {
    const file = path.join(directory, mutation.file),
      original = await readFile(file, "utf8");
    assert.equal(
      original.split(mutation.before).length,
      (mutation.sites ?? 1) + 1,
      `${mutation.name} exact source sites`,
    );
    const changed = original.replaceAll(mutation.before, mutation.after);
    await writeFile(file, changed);
    const target = path.join(
      root,
      "target/parity/resilient-call-mutation-build",
    );
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "-p",
        "demlik-parity",
        "--bin",
        "resilient-call-parity",
      ],
      {
        cwd: directory,
        env: { ...process.env, CARGO_TARGET_DIR: target },
        stdio: "pipe",
        timeout: 120_000,
      },
    );
    const reportFile = path.join(
      reportDirectory,
      `resilient-${mutation.name}.json`,
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(here, "resilient-call-run.mjs"),
        "--rust-bin",
        path.join(target, "debug/resilient-call-parity"),
        "--report",
        reportFile,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    assert.equal(
      result.status,
      1,
      `${mutation.name}: expected behavioral failure ${result.stdout} ${result.stderr}`,
    );
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    const witness = report.failures.find(
      (value) => value.id === mutation.witness,
    );
    assert.ok(witness, `${mutation.name} must fail its named case`);
    assert.equal(witness.reference.ok, true, "reference executed");
    assert.equal(
      witness.native.ok,
      true,
      "a driver or build failure is not detection",
    );
    assert.equal(
      hash(await readFile(path.join(root, mutation.file))),
      hash(original),
      "active source unchanged",
    );
    results.push({
      name: mutation.name,
      detected: true,
      witness: mutation.witness,
      failures: report.failures.length,
      originalSha256: hash(original),
      mutantSha256: hash(changed),
      binarySha256: report.binarySha256,
    });
    await writeFile(file, original);
  }
  await writeFile(
    path.join(reportDirectory, "resilient-call-mutations.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
