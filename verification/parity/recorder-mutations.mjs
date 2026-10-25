import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recorderParity } from "./recorder-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  baseline = path.resolve(
    process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
  ),
  target = path.resolve(
    process.env.DEMLIK_MUTATION_TARGET_DIR ??
      path.join(root, "target/reconciler-mutation-build"),
  ),
  directory = path.join(root, "target/parity"),
  hash = (text) => createHash("sha256").update(text).digest("hex"),
  rec = "crates/tea/src/persistence/recorder.rs",
  wire = "crates/tea/src/persistence/recorder/wire.rs",
  replay = "crates/tea/src/persistence/trace_replay.rs",
  walk = "crates/tea/src/persistence/trace_replay/state_walk.rs";
assert.notEqual(
  baseline,
  target,
  "Mutation artifacts cannot share the baseline target",
);
const endpoint =
  "        self.inner.state.borrow_mut().final_state =\n            if (self.inner.state_kind)(&state) == StateKind::Undefined {\n                None\n            } else {\n                Some(Arc::clone(&state))\n            };\n";
const controls = [
  {
    id: "sampled-final-is-last-kept-state",
    file: rec,
    patches: [
      [endpoint, ""],
      [
        "        let mut recording = self.inner.state.borrow_mut();\n        recording.msgs.push",
        `${endpoint}        let mut recording = self.inner.state.borrow_mut();\n        recording.msgs.push`,
      ],
    ],
    witness: "recorder.record.all-dropped.true",
  },
  {
    id: "nan-rng-is-dropped",
    file: rec,
    patches: [
      [
        "(self.inner.rng)() >= self.inner.sample_rate",
        "!((self.inner.rng)() < self.inner.sample_rate)",
      ],
    ],
    witness: "recorder.record.half.true",
  },
  {
    id: "rate-one-pays-rng",
    file: rec,
    patches: [
      [
        "if self.inner.sample_rate < 1.0 &&",
        "if (self.inner.rng)() >= 0.0 && self.inner.sample_rate < 1.0 &&",
      ],
    ],
    witness: "recorder.record.default.false",
  },
  {
    id: "steps-presence-is-unconditional",
    file: rec,
    patches: [
      [
        "steps: self.inner.capture_steps.then(|| recording.steps.clone()),",
        "steps: Some(recording.steps.clone()),",
      ],
    ],
    witness: "recorder.record.default.false",
  },
  {
    id: "stop-does-not-detach",
    file: rec,
    patches: [["if self.inner.stopped.replace(true) {", "if true {"]],
    witness: "recorder.record.default.true",
  },
  {
    id: "short-steps-fall-back-to-final",
    file: wire,
    patches: [
      [
        "None => PlainData::Undefined,",
        "None => encode_state(&trace.final_state)?,",
      ],
    ],
    witness: "recorder.attachment.empty.default",
  },
  {
    id: "missing-state-is-not-known",
    file: wire,
    patches: [
      [
        "if !matches!(raw_state, PlainData::Null) {",
        "if !matches!(raw_state, PlainData::Null | PlainData::Undefined) {",
      ],
    ],
    witness: "recorder.parse.missing-state-tail",
  },
  {
    id: "null-step-overwrites-last-known",
    file: wire,
    patches: [["if !matches!(raw_state, PlainData::Null) {", "if true {"]],
    witness: "recorder.parse.null-state-tail",
  },
  {
    id: "signed-zero-is-equal",
    file: replay,
    patches: [
      [
        "left.to_bits() == right.to_bits() || left.is_nan() && right.is_nan()",
        "left == right || left.is_nan() && right.is_nan()",
      ],
    ],
    witness: "recorder.compare.grid-4-5",
  },
  {
    id: "object-key-walk-is-reversed",
    file: walk,
    patches: [["keys.sort();", "keys.sort(); keys.reverse();"]],
    witness: "recorder.compare.preorder",
  },
  {
    id: "missing-builtin-is-undefined",
    file: replay,
    patches: [
      [
        "match key.as_utf8().and_then(crate::js_record::builtin) {",
        "match None::<&'static str> {",
      ],
    ],
    witness: "recorder.compare.inherited-toString-false",
  },
  {
    id: "cold-replay-skips-messages",
    file: replay,
    patches: [
      ["trace.msgs.iter().cloned()", "trace.msgs.iter().cloned().take(0)"],
    ],
    witness: "recorder.replay.match",
  },
];
const files = [...new Set(controls.map((control) => control.file))],
  original = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        await readFile(path.join(root, file), "utf8"),
      ]),
    ),
  ),
  temp = await mkdtemp(path.join(tmpdir(), "demlik-recorder-controls-")),
  results = [];
await mkdir(directory, { recursive: true });
try {
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, file), path.join(temp, file), { recursive: true });
  for (const control of controls) {
    for (const [file, text] of Object.entries(original))
      await writeFile(path.join(temp, file), text);
    let modified = original[control.file];
    for (const [before, after] of control.patches) {
      assert.equal(
        modified.split(before).length,
        2,
        `${control.id} has one exact owner site`,
      );
      modified = modified.replace(before, after);
    }
    await writeFile(path.join(temp, control.file), modified);
    const build = spawnSync(
      process.env.CARGO ?? "cargo",
      ["build", "--locked", "-p", "demlik-parity", "--bin", "recorder-parity"],
      {
        cwd: temp,
        encoding: "utf8",
        timeout: 240_000,
        maxBuffer: 8 * 1024 * 1024,
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
    const output = `${build.stdout}\n${build.stderr}`,
      log = path.join(directory, `recorder-mutant-${control.id}.log`);
    await writeFile(log, output);
    assert.equal(
      build.status,
      0,
      `${control.id} must compile before detection\n${output}`,
    );
    const report = await recorderParity({
      binary: path.join(target, "debug/recorder-parity"),
      reportFile: path.join(directory, `recorder-mutant-${control.id}.json`),
      quiet: true,
      allowFailures: true,
    });
    assert.ok(
      report.failures.some((row) => row.id === control.witness),
      `${control.id} must fail its intended semantic witness`,
    );
    for (const [file, text] of Object.entries(original))
      assert.equal(await readFile(path.join(root, file), "utf8"), text);
    results.push({
      id: control.id,
      witness: control.witness,
      buildSucceeded: true,
      detected: report.failures.length,
      failedIds: report.failures.map((row) => row.id),
      sourceUnchanged: true,
      originalSha256: hash(original[control.file]),
      mutantSha256: hash(modified),
      log: path.relative(root, log),
      logSha256: hash(output),
    });
    process.stdout.write(
      `${control.id}: compiled, ${report.failures.length} regressions detected\n`,
    );
  }
  await writeFile(
    path.join(directory, "recorder-mutations.json"),
    `${JSON.stringify({ controls: controls.length, detected: results.length, baselineTarget: baseline, mutationTarget: target, results }, null, 2)}\n`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
  for (const [file, text] of Object.entries(original))
    assert.equal(await readFile(path.join(root, file), "utf8"), text);
}
