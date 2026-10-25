import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const cargo = process.env.CARGO ?? "cargo";
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-timing-mutations-"),
);
const reportDirectory = path.join(root, "target/parity");
const mutations = [
  {
    name: "input-hold-copies-cache-object",
    file: "crates/tea/src/timing/throttled_input.rs",
    before: "cache: self.cache.clone(),",
    after:
      "cache: self.cache.as_ref().map(|cache| std::rc::Rc::new(cache.as_ref().clone())),",
    witness: "timing.knob-dedupe-before-pending",
  },
  {
    name: "debounce-loses-leading-latch",
    file: "crates/tea/src/timing/debounce.rs",
    before: "state.leading_fired = true;",
    after: "state.leading_fired = false;",
    witness: "timing.debounce-reentrant-leading",
  },
  {
    name: "throttle-arms-after-trailing-callback",
    file: "crates/tea/src/timing/throttle.rs",
    before: "self.arm()?;\n            (self.callback)(args);",
    after: "(self.callback)(args);\n            self.arm()?;",
    witness: "timing.throttle-reentrant-trailing-flush",
  },
  {
    name: "input-blocks-rate-edge",
    file: "crates/tea/src/timing/throttled_input.rs",
    before: "at-last<ms",
    after: "at-last<=ms",
    witness: "timing.knob-half-open-rate",
  },
  {
    name: "input-deadline-ignores-rate-floor",
    file: "crates/tea/src/timing/throttled_input.rs",
    before: "crate::js_math::max(settle_at, rate_at)",
    after: "settle_at",
    witness: "timing.knob-rate-floor",
  },
  {
    name: "deadline-restarts-full-delay",
    file: "crates/tea/src/resilience/deadline.rs",
    before: "crate::js_math::max(0.0, at_ms.number_or_zero() - timer.now_ms())",
    after: "crate::js_math::max(0.0, at_ms.number_or_zero())",
    witness: "timing.deadline-default",
  },
  {
    name: "restored-null-clock-becomes-nan",
    file: "crates/tea/src/timing/throttled_input.rs",
    before: "Some(PlainData::Null) => InputInstant(None),",
    after: "Some(PlainData::Null) => f64::NAN.into(),",
    witness: "timing.roundtrip-pending-nan",
  },
];
const results = [];
try {
  execFileSync(process.execPath, [path.join(here, "timing-run.mjs")], {
    cwd: root,
    stdio: "pipe",
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
    const file = path.join(directory, mutation.file);
    const original = await readFile(file, "utf8");
    assert.equal(
      original.split(mutation.before).length,
      2,
      `${mutation.name} must alter exactly one site`,
    );
    await writeFile(file, original.replace(mutation.before, mutation.after));
    const target = path.join(root, "target/parity/timing-mutation-build");
    execFileSync(
      cargo,
      [
        "build",
        "--locked",
        "--package",
        "demlik-parity",
        "--bin",
        "timing-parity",
      ],
      {
        cwd: directory,
        env: { ...process.env, CARGO_TARGET_DIR: target },
        stdio: "pipe",
      },
    );
    const reportFile = path.join(reportDirectory, `${mutation.name}.json`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(here, "timing-run.mjs"),
        "--rust-bin",
        path.join(target, "debug/timing-parity"),
        "--report",
        reportFile,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(
      result.status,
      1,
      `${mutation.name} must produce a behavioral failure: ${result.stderr}`,
    );
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    const witness = report.failures.find(
      (test) => test.id === mutation.witness,
    );
    assert.ok(witness, `${mutation.name} must fail its named contract`);
    assert.equal(
      witness.reference.ok,
      true,
      "the reference must execute successfully",
    );
    assert.equal(
      witness.native.ok,
      true,
      "a build/driver failure does not count as detection",
    );
    results.push({
      name: mutation.name,
      detected: true,
      witness: mutation.witness,
      failures: report.failures.length,
    });
    await writeFile(file, original);
  }
  await writeFile(
    path.join(reportDirectory, "timing-mutations.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
