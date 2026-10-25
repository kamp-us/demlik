import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonTextParity } from "./json-text-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  owner = "crates/tea/src/data/json.rs";
const baseline = path.resolve(
  process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
);
const target = path.resolve(
  process.env.DEMLIK_MUTATION_TARGET_DIR ??
    path.join(root, "target/reconciler-mutation-build"),
);
assert.notEqual(target, baseline);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const original = await readFile(path.join(root, owner), "utf8");
const mutations = [
  {
    id: "escape-invalid-context",
    before: "if !quoted || escaped {",
    after: "if false && (!quoted || escaped) {",
    witness: "invalid-escaped-surrogate",
    referenceOk: false,
  },
  {
    id: "replace-valid-unit-lossily",
    before: String.raw`output.push_str(&format!("\\u{unit:04x}"));`,
    after: String.raw`output.push('\u{fffd}');`,
    witness: "literal-value",
    referenceOk: true,
  },
];
const temp = await mkdtemp(path.join(tmpdir(), "demlik-json-text-controls-"));
const directory = path.join(root, "target/parity");
await mkdir(directory, { recursive: true });
const results = [];
try {
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, file), path.join(temp, file), { recursive: true });
  for (const mutation of mutations) {
    assert.equal(original.split(mutation.before).length, 2);
    const modified = original.replace(mutation.before, mutation.after);
    await writeFile(path.join(temp, owner), modified);
    execFileSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "-p",
        "demlik-tea",
        "--example",
        "json_text_driver",
      ],
      {
        cwd: temp,
        stdio: "pipe",
        timeout: 240_000,
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
    const binary = path.join(target, "debug/examples/json_text_driver");
    const report = await jsonTextParity({
      binary,
      reportFile: path.join(directory, `json-text-${mutation.id}.json`),
      quiet: true,
    });
    const witness = report.failures.find(
      (value) => value.id === mutation.witness,
    );
    assert.ok(witness, mutation.id);
    assert.equal(witness.reference.ok, mutation.referenceOk);
    assert.equal(
      witness.native.ok,
      true,
      "detect an accepted wrong value, not a driver crash/refusal",
    );
    assert.equal(await readFile(path.join(root, owner), "utf8"), original);
    results.push({
      id: mutation.id,
      witness: mutation.witness,
      buildSucceeded: true,
      behaviorDetected: true,
      changedCases: report.failures.map((value) => value.id),
      sourceUnchanged: true,
      sourceSha256: hash(original),
      mutantSha256: hash(modified),
      binarySha256: hash(await readFile(binary)),
    });
    console.log(`${mutation.id}: detected ${report.failures.length} cases`);
  }
  await writeFile(
    path.join(directory, "json-text-mutations.json"),
    `${JSON.stringify({ controls: results.length, detected: results.length, baselineTarget: baseline, mutationTarget: target, results }, null, 2)}\n`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
  assert.equal(await readFile(path.join(root, owner), "utf8"), original);
}
