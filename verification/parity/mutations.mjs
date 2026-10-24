import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const directory = await mkdtemp(path.join(tmpdir(), "demlik-parity-mutation-"));
const reportDirectory = path.join(root, "target/parity");
const cargo = process.env.CARGO ?? "cargo";
const mutations = [
  {
    name: "command-input-encoded-before-identity",
    file: "crates/tea/src/command.rs",
    before: "plain_data(&self.input)",
    after:
      "plain_data(&serde_json::to_value(&self.input).map_err(<S::Error as serde::ser::Error>::custom)?)",
    witness: "command.dependency-infinity",
  },
  {
    name: "runtime-terminal-result-ignores-save",
    suite: "runtime",
    file: "crates/tea/src/runtime/engine.rs",
    before:
      "if !matches!(view.saved, SaveStatus::Saved) {\n            return None;\n        }",
    after: "if false {\n            return None;\n        }",
    witness: "runtime.promise.held-save",
  },
  {
    name: "runtime-announces-before-command",
    suite: "runtime",
    file: "crates/tea/src/runtime/engine.rs",
    before:
      "let result = self.run_commands(commands).await;\n        tokio::task::yield_now().await;\n        self.core.committed(message.as_deref(), &state);",
    after:
      "self.core.committed(message.as_deref(), &state);\n        let result = self.run_commands(commands).await;\n        tokio::task::yield_now().await;",
    witness: "runtime.promise.serial",
  },
  {
    name: "memory-load-discards-shared-cell",
    file: "crates/tea/src/storage.rs",
    before: ".state\n            .clone())",
    after: ".state\n            .as_ref().and_then(|_| None))",
    witness: "storage.memory-alias-live-and-snapshot",
  },
  {
    name: "schema-invalid-state-boots-fresh",
    file: "crates/tea/src/storage.rs",
    before:
      'match parse(raw) {\n            Ok(state) => Migrated::State(state),\n            Err(_) => Migrated::Refused(refuse("the saved state does not match the schema")),',
    after:
      "match parse(raw) {\n            Ok(state) => Migrated::State(state),\n            Err(_) => Migrated::Fresh,",
    witness: "storage.schema-reject",
  },
  {
    name: "file-cas-accepts-stale-writer",
    file: "crates/tea/src/file_store.rs",
    before: "if actual_version != expected_version {",
    after: "if false {",
    witness: "storage.file-fenced-cas-no-overwrite",
  },
  {
    name: "file-save-never-renames-state",
    file: "crates/tea/src/file_store.rs",
    before:
      'fs::rename(&temp, &*self.path)\n            .await\n            .map_err(|error| FileStoreError::io("rename", &self.path, error))?;',
    after: "let _ = &temp;",
    witness: "storage.file-write-reload-delete",
  },
  {
    name: "record-spread-retains-prototype",
    file: "crates/tea/src/js_record.rs",
    before: "own: self.own.clone(),\n            prototype: Prototype::Object,",
    after:
      "own: self.own.clone(),\n            prototype: self.prototype.clone(),",
    witness: "policies.cache-injected-prototype-and-spread-reset",
  },
  {
    name: "record-prototype-assignment-becomes-own-data",
    file: "crates/tea/src/js_record.rs",
    before: "&& setter_visible",
    after: "&& false",
    witness: "policies.cache-injected-prototype-and-spread-reset",
  },
  {
    name: "circuit-excludes-cooldown-edge",
    file: "crates/tea/src/resilience/circuit_breaker.rs",
    before: "now_ms - opened_at_ms >= policy.cooldown_ms",
    after: "now_ms - opened_at_ms > policy.cooldown_ms",
    witness: "policies.circuit-cooldown-probe-and-late-results",
  },
  {
    name: "bucket-discards-nan",
    file: "crates/tea/src/resilience/rate_limit.rs",
    before: "js_min(bucket.capacity, replenished)",
    after: "bucket.capacity.min(replenished)",
    witness: "policies.bucket-nan-propagation",
  },
  {
    name: "window-retains-cutoff-hit",
    file: "crates/tea/src/resilience/rate_limit.rs",
    before: "*hit > cutoff",
    after: "*hit >= cutoff",
    witness: "policies.window-half-open-expiry-and-read-only-remaining",
  },
  {
    name: "cache-retains-expiry-edge",
    file: "crates/tea/src/resilience/cache.rs",
    before: "if entry.missing() || now_ms >= entry.timestamp()?",
    after: "if entry.missing() || now_ms > entry.timestamp()?",
    witness: "policies.cache-half-open-ttl-null-failure-and-removal",
  },
  {
    name: "idempotency-overwrite-does-not-refresh-order",
    file: "crates/tea/src/idempotency.rs",
    before: "next.order.retain(|old| old != &key);\n    next.order.push(key);",
    after: "if !next.order.contains(&key) { next.order.push(key); }",
    witness: "policies.idempotency-overwrite-ttl-lru-and-failure-data",
  },
  {
    name: "backoff-ignores-cap",
    file: "crates/tea/src/retry_backoff.rs",
    before: "js_min(curve.cap_ms, exponential)",
    after: "exponential",
    witness: "retry.cap",
  },
  {
    name: "scc-component-numbering-starts-at-one",
    file: "crates/code-graph/src/scc.rs",
    before: "next_component: 0,",
    after: "next_component: 1,",
    witness: "scc.cycle-with-caller",
  },
  {
    name: "command-output-validation-bypassed",
    file: "crates/tea/src/command.rs",
    before: '(definition.parse_output)(returned["value"].clone())',
    after: 'Ok::<_, SchemaError>(returned["value"].clone())',
    witness: "command.parsed-output-strip",
  },
  {
    name: "command-dispatch-provenance-bypassed",
    file: "crates/tea/src/command.rs",
    before: "minted.ptr_eq(&Arc::downgrade(&message.0))",
    after: "minted.strong_count() > 0",
    witness: "command.dispatch-mint-provenance",
  },
];
const results = [];
const onlyArgument = process.argv.indexOf("--only");
const selected =
  onlyArgument === -1
    ? mutations
    : mutations.filter(
        (mutation) => mutation.name === process.argv[onlyArgument + 1],
      );
assert.ok(selected.length, "unknown mutation name");
try {
  await mkdir(reportDirectory, { recursive: true });
  execFileSync(process.execPath, [path.join(here, "run.mjs")], {
    cwd: root,
    stdio: "pipe",
  });
  for (const file of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ]) {
    await cp(path.join(root, file), path.join(directory, file), {
      recursive: true,
    });
  }
  for (const mutation of selected) {
    const file = path.join(directory, mutation.file);
    const original = await readFile(file, "utf8");
    assert.equal(
      original.split(mutation.before).length,
      2,
      `${mutation.name} must alter exactly one site`,
    );
    await writeFile(file, original.replace(mutation.before, mutation.after));
    const targetDirectory = path.join(root, "target/parity/mutation-build");
    execFileSync(cargo, ["build", "--locked", "--package", "demlik-parity"], {
      cwd: directory,
      env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
      stdio: "pipe",
    });
    if (mutation.suite === "runtime") {
      execFileSync(
        cargo,
        [
          "build",
          "--locked",
          "--package",
          "demlik-tea",
          "--example",
          "runtime_driver",
        ],
        {
          cwd: directory,
          env: { ...process.env, CARGO_TARGET_DIR: targetDirectory },
          stdio: "pipe",
        },
      );
    }
    const reportFile = path.join(reportDirectory, `${mutation.name}.json`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(here, "run.mjs"),
        "--rust-bin",
        path.join(targetDirectory, "debug/demlik-parity"),
        ...(mutation.suite === "runtime"
          ? [
              "--runtime-bin",
              path.join(targetDirectory, "debug/examples/runtime_driver"),
            ]
          : []),
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
      (failure) => failure.id === mutation.witness,
    );
    assert.ok(witness, `${mutation.name} must fail its intended contract`);
    assert.equal(
      witness.typescript.ok,
      true,
      "the reference must execute successfully",
    );
    assert.equal(
      witness.rust.ok,
      true,
      "a broken driver or build cannot count as detection",
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
    path.join(
      reportDirectory,
      onlyArgument === -1
        ? "mutations.json"
        : `mutations-${selected[0].name}.json`,
    ),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
