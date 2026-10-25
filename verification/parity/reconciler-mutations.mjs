import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcilerParity } from "./reconciler-run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, "../..");
const cargo = process.env.CARGO ?? "cargo";
const baselineTarget = path.resolve(
  process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
);
const target = path.resolve(
  process.env.DEMLIK_MUTATION_TARGET_DIR ??
    path.join(root, "target/reconciler-mutation-build"),
);
assert.notEqual(
  target,
  baselineTarget,
  "baseline and mutant Cargo artifacts must be isolated",
);
const reportDirectory = path.join(root, "target/parity");
const owner = "crates/tea/src/flow/reconciler.rs",
  cache = "crates/tea/src/resilience/cache.rs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const originals = Object.fromEntries(
  await Promise.all(
    [owner, cache].map(async (file) => [
      file,
      await readFile(path.join(root, file), "utf8"),
    ]),
  ),
);
const sourceHashes = Object.fromEntries(
  Object.entries(originals).map(([file, text]) => [file, hash(text)]),
);
const env = {
  ...process.env,
  CARGO_TARGET_DIR: target,
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
};
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-reconciler-controls-"),
);
const mutations = [
  {
    name: "emission-advances-before-ack",
    witness: "reconciler.wait-for-ack",
    edits: [
      [
        owner,
        "let next = State::from_snapshot(Snapshot {\n                    applied_cursor: cursor,",
        "let next = State::from_snapshot(Snapshot {\n                    applied_cursor: (cursor.number_or_zero() + 1.0).into(),",
      ],
    ],
  },
  {
    name: "ledger-identity-is-position",
    witness: "reconciler.replan-content-not-position",
    edits: [
      [
        owner,
        "let id = self.change_id(&CallValue::shared(change.clone()))?;",
        "let id = Some(JsText::from(cursor.number_or_zero().to_string()));",
      ],
      [
        owner,
        "let id = self.change_id(&change)?;",
        "let id = Some(JsText::from(state.applied_cursor().number_or_zero().to_string()));",
      ],
    ],
  },
  {
    name: "json-identity-sorts-object-keys",
    witness: "reconciler.json-property-order",
    edits: [
      [
        owner,
        ".map(|value| stringify_json(&value).map(JsText::from)),",
        ".map(|value| Some(JsText::from(crate::data::structural_hash(&value)))),",
      ],
    ],
  },
  {
    name: "restored-null-cursor-indexes-zero",
    witness: "reconciler.cursor-null-restored",
    edits: [
      [
        owner,
        "let change = cursor\n                .number()",
        "let change = Some(cursor.number_or_zero())",
      ],
    ],
  },
  {
    name: "undefined-failure-does-not-escalate",
    witness: "reconciler.undefined-terminal-error",
    edits: [
      [
        owner,
        "let phase = if state.phase() == Phase::Scanning",
        "let phase = if false && state.phase() == Phase::Scanning",
      ],
    ],
  },
  {
    name: "late-success-replans-completed-state",
    witness: "reconciler.late-done",
    edits: [
      [
        owner,
        "if state.phase() != Phase::Scanning {",
        "if false && state.phase() != Phase::Scanning {",
      ],
    ],
  },
  {
    name: "timer-requires-scanning-phase",
    witness: "reconciler.timer-outside-scanning",
    edits: [
      [
        owner,
        "let timed = self.walk.on_timer(state.walk(), msg)?;",
        "if state.phase() != Phase::Scanning { return Ok(Step::new(state.clone(), vec![])); }\n        let timed = self.walk.on_timer(state.walk(), msg)?;",
      ],
    ],
  },
  {
    name: "acknowledgment-uses-planned-change",
    witness: "reconciler.wrong-ack-is-not-validated",
    edits: [
      [
        owner,
        "let id = self.change_id(&change)?;",
        "let id = self.change_id(state.plan().get(state.applied_cursor().number_or_zero() as usize).unwrap_or(&CallValue::Undefined))?;",
      ],
    ],
  },
  {
    name: "applied-ledger-expires-early",
    witness: "reconciler.ttl-half-open",
    edits: [
      [
        owner,
        "const APPLIED_TTL_MS: f64 = 9_007_199_254_740_991.0;",
        "const APPLIED_TTL_MS: f64 = 1.0;",
      ],
    ],
  },
  {
    name: "items-callback-error-is-silenced",
    witness: "reconciler.callback-items",
    edits: [
      [
        owner,
        "(self.items_of)(&page).map_err(|cause| ReconcileError::Callback {\n            phase: CallbackPhase::ItemsOf,\n            cause,\n        })?",
        "(self.items_of)(&page).unwrap_or_default()",
      ],
    ],
  },
  {
    name: "undefined-key-becomes-empty-string",
    witness: "reconciler.json-undefined-ack",
    edits: [
      [
        cache,
        'self.unwrap_or_else(|| "undefined".into())',
        'self.unwrap_or_else(|| "".into())',
      ],
    ],
  },
  {
    name: "undefined-plan-slot-finishes-plan",
    witness: "reconciler.undefined-plan-slots",
    edits: [
      [
        owner,
        "let Some(CallValue::Shared(change)) = change else {\n                cursor = (cursor.number_or_zero() + 1.0).into();\n                continue;\n            };",
        "let Some(CallValue::Shared(change)) = change else { break; };",
      ],
    ],
  },
  {
    name: "undefined-stored-value-counts-as-applied",
    nativeTest:
      "a_stored_undefined_acknowledgment_does_not_mark_a_defined_change_as_applied",
    edits: [
      [
        owner,
        "Some(JsRead::Stored(value)) => !value.is_undefined(),",
        "Some(JsRead::Stored(_value)) => true,",
      ],
    ],
  },
];
const results = [];
await mkdir(reportDirectory, { recursive: true });
const cleanBinary = path.join(reportDirectory, "reconciler-clean-binary");
const activeBinary = path.join(target, "debug/reconciler-parity");
const baselineBinary = path.join(baselineTarget, "debug/reconciler-parity");
try {
  await cp(baselineBinary, cleanBinary);
  const baseline = await reconcilerParity(cargo, {
    binary: cleanBinary,
    reportFile: path.join(reportDirectory, "reconciler.json"),
    quiet: true,
  });
  assert.deepEqual(baseline.failures, []);
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, file), path.join(directory, file), {
      recursive: true,
    });
  for (const mutation of mutations) {
    const modified = { ...originals };
    for (const [file, before, after] of mutation.edits) {
      assert.equal(
        modified[file].split(before).length,
        2,
        `${mutation.name} exact source site`,
      );
      modified[file] = modified[file].replace(before, after);
    }
    for (const [file, text] of Object.entries(modified))
      await writeFile(path.join(directory, file), text);
    let changedCases;
    if (mutation.nativeTest) {
      const native = spawnSync(
        cargo,
        [
          "test",
          "--locked",
          "-p",
          "demlik-tea",
          "--test",
          "reconciler",
          mutation.nativeTest,
          "--",
          "--exact",
        ],
        {
          cwd: directory,
          env,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 240_000,
        },
      );
      await writeFile(
        path.join(reportDirectory, `reconciler-${mutation.name}.log`),
        `${native.stdout}\n${native.stderr}`,
      );
      assert.equal(
        native.status,
        101,
        `${mutation.name}: expected assertion failure: ${native.stderr}`,
      );
      assert.match(
        native.stdout,
        new RegExp(`test ${mutation.nativeTest} \\.\\.\\. FAILED`),
      );
      assert.match(native.stdout, /test result: FAILED\. 0 passed; 1 failed/);
      assert.doesNotMatch(native.stderr, /could not compile/);
      changedCases = [`native:${mutation.nativeTest}`];
    } else {
      execFileSync(
        cargo,
        [
          "build",
          "--locked",
          "-p",
          "demlik-parity",
          "--bin",
          "reconciler-parity",
        ],
        { cwd: directory, env, stdio: "pipe", timeout: 240_000 },
      );
      const report = await reconcilerParity(cargo, {
        binary: activeBinary,
        reportFile: path.join(
          reportDirectory,
          `reconciler-${mutation.name}.json`,
        ),
        quiet: true,
      });
      const witness = report.failures.find(
        (value) => value.id === mutation.witness,
      );
      assert.ok(witness, `${mutation.name} must fail its named contract`);
      assert.equal(witness.reference.ok, true);
      assert.equal(
        witness.native.ok,
        true,
        "a driver refusal or crash is not fault detection",
      );
      assert.deepEqual(report.referenceChanges, []);
      changedCases = report.failures.map((value) => value.id);
    }
    for (const [file, text] of Object.entries(originals))
      assert.equal(await readFile(path.join(root, file), "utf8"), text);
    results.push({
      name: mutation.name,
      witness: mutation.witness ?? `native:${mutation.nativeTest}`,
      changedCases,
      sourceHashes,
      mutantHashes: Object.fromEntries(
        Object.entries(modified).map(([file, text]) => [file, hash(text)]),
      ),
      binarySha256: mutation.nativeTest
        ? null
        : hash(await readFile(activeBinary)),
      buildSucceeded: true,
      behavioralAssertionDetected: true,
      activeSourceUnchanged: true,
    });
    process.stdout.write(
      `${mutation.name}: detected ${changedCases.length} cases\n`,
    );
  }
  const report = {
    controls: results.length,
    detected: results.length,
    targetPolicy:
      "Baseline and mutants use separate Cargo targets; all disposable controls share one lean mutation target.",
    results,
  };
  await writeFile(
    path.join(reportDirectory, "reconciler-mutations.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
} finally {
  assert.equal(
    hash(await readFile(baselineBinary)),
    hash(await readFile(cleanBinary)),
    "baseline binary unchanged by mutant builds",
  );
  await rm(directory, { recursive: true, force: true });
  for (const [file, text] of Object.entries(originals))
    assert.equal(await readFile(path.join(root, file), "utf8"), text);
}
