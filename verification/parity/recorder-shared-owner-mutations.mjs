import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const baseline = path.resolve(
  process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
);
const target = path.resolve(
  process.env.DEMLIK_MUTATION_TARGET_DIR ??
    path.join(root, "target/reconciler-mutation-build"),
);
assert.notEqual(
  baseline,
  target,
  "baseline and mutation artifacts must be isolated",
);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const owners = [
  "crates/tea/src/core.rs",
  "crates/tea/src/runtime/engine.rs",
  "crates/tea/src/runtime/listeners.rs",
];
const original = Object.fromEntries(
  await Promise.all(
    owners.map(async (file) => [
      file,
      await readFile(path.join(root, file), "utf8"),
    ]),
  ),
);
const controls = [
  {
    id: "callback-wrapper-is-the-identity",
    file: owners[2],
    before: "equivalent(item, &callback)",
    after: "Rc::ptr_eq(item, &callback)",
    sites: 2,
    test: "runtime_retained_observers",
    witness:
      "original_callback_rc_deduplicates_and_stale_unsubscribe_deletes_a_reregistered_callback",
  },
  {
    id: "retained-observer-is-silently-skipped",
    file: owners[1],
    before: "Self::Retained(callback) => callback(message, state),",
    after: "Self::Retained(_callback) => {},",
    sites: 1,
    test: "runtime_retained_observers",
    witness:
      "retained_handles_preserve_original_identity_mixed_hook_order_and_panic_isolation",
  },
  {
    id: "shared-fold-applies-only-first-message",
    file: owners[0],
    before:
      "fold_using(state, messages, |state, message| {\n        let next = update.apply(state, &message)?;",
    after:
      "fold_using(state, messages.into_iter().take(1), |state, message| {\n        let next = update.apply(state, &message)?;",
    sites: 1,
    test: "core_retained_fold",
    witness:
      "shared_fold_keeps_opaque_borrowed_values_and_original_message_handles_without_initializing",
  },
  {
    id: "shared-fold-swallows-no-cell-error",
    file: owners[0],
    before: "let next = update.apply(state, &message)?;",
    after:
      "let next = match update.apply(state, &message) { Ok(next) => next, Err(_) => return Ok(Step::new(Arc::clone(state), vec![])) };",
    sites: 1,
    test: "core_retained_fold",
    witness:
      "a_missing_cell_returns_the_original_contract_error_and_stops_the_fold",
  },
];
const temp = await mkdtemp(
  path.join(tmpdir(), "demlik-recorder-owner-controls-"),
);
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
  for (const control of controls) {
    for (const [file, text] of Object.entries(original))
      await writeFile(path.join(temp, file), text);
    assert.equal(
      original[control.file].split(control.before).length,
      control.sites + 1,
      `${control.id} exact source sites`,
    );
    const modified = original[control.file]
      .split(control.before)
      .join(control.after);
    await writeFile(path.join(temp, control.file), modified);
    const run = spawnSync(
      process.env.CARGO ?? "cargo",
      [
        "test",
        "--locked",
        "-p",
        "demlik-tea",
        "--test",
        control.test,
        control.witness,
        "--",
        "--exact",
      ],
      {
        cwd: temp,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
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
    const output = `${run.stdout}\n${run.stderr}`;
    const file = path.join(directory, `recorder-owner-${control.id}.log`);
    await writeFile(file, output);
    assert.equal(
      run.status,
      101,
      `${control.id}: expected a behavioral assertion failure\n${output}`,
    );
    assert.match(
      run.stdout,
      new RegExp(`test ${control.witness} \\.\\.\\. FAILED`),
    );
    assert.match(run.stdout, /test result: FAILED\. 0 passed; 1 failed/);
    assert.doesNotMatch(run.stderr, /could not compile/);
    for (const [file, text] of Object.entries(original))
      assert.equal(await readFile(path.join(root, file), "utf8"), text);
    results.push({
      id: control.id,
      witness: control.witness,
      buildSucceeded: true,
      behavioralAssertionDetected: true,
      sourceUnchanged: true,
      originalSha256: hash(original[control.file]),
      mutantSha256: hash(modified),
      log: path.relative(root, file),
      logSha256: hash(output),
    });
    process.stdout.write(`${control.id}: compiled regression detected\n`);
  }
  await writeFile(
    path.join(directory, "recorder-shared-owner-mutations.json"),
    `${JSON.stringify({ scope: "Native retained observation/fold owner seams only; source differential recorder verification remains separate", controls: results.length, detected: results.length, baselineTarget: baseline, mutationTarget: target, results }, null, 2)}\n`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
  for (const [file, text] of Object.entries(original))
    assert.equal(await readFile(path.join(root, file), "utf8"), text);
}
