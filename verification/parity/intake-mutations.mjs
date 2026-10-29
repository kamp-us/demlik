import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createCheckWorktree,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";
import { intakeParity } from "./idempotent-intake.mts";
import { intakeRuntimeParity } from "./intake-runtime.mts";

export async function intakeMutations(options = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    cargo = process.env.CARGO ?? "cargo";
  const env = {
    ...process.env,
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "1",
  };
  const reportDir = join(root, "target/parity"),
    module = "crates/tea/src/idempotency/intake.rs";
  mkdirSync(reportDir, { recursive: true });
  const baseline = await intakeParity({
    binary: options.binary,
    reportFile: join(reportDir, "intake-control-baseline.json"),
  });
  assert.equal(
    baseline.failures.length,
    0,
    "strict baseline must pass before controls",
  );
  const runtime = await intakeRuntimeParity({
    binary: options.runtimeBinary,
    reportFile: join(reportDir, "intake-runtime-control-baseline.json"),
  });
  assert.equal(runtime.failures.length, 0);
  const controls = [
    {
      name: "pending-ages-out",
      file: module,
      before: "Entry::Pending => return Ok(Some(Cached::Pending)),",
      after:
        "Entry::Pending => { if let (Some(at), Some(ttl)) = (at, self.ttl_ms) { if at.number_or_zero() - row.at_ms.number_or_zero() >= ttl { return Ok(None); } } return Ok(Some(Cached::Pending)); },",
      witness: "intake.pending-never-expires",
    },
    {
      name: "boot-rearms-completed-work",
      file: module,
      before:
        "if item.status != QueueItemStatus::Running || self.is_already_done(state, &item)? {",
      after: "if item.status != QueueItemStatus::Running {",
      witness: "intake.done-before-crash",
      runtimeWitness: "intake-runtime.promise.done.bytes",
    },
    {
      name: "done-cache-reconciliation-disappears",
      file: module,
      before: "self.is_already_done(state, &item)?",
      after: "false",
      sites: 2,
      witness: "intake.done-before-crash",
      runtimeWitness: "intake-runtime.promise.done.bytes",
      runtimeWorkers: { reference: [1, 1], rust: [1, 2] },
    },
    {
      name: "claim-takes-completed-work",
      file: module,
      before:
        "if item.status == QueueItemStatus::Pending && !self.is_already_done(state, &item)? {",
      after: "if item.status == QueueItemStatus::Pending {",
      witness: "intake.done-pending-claim",
    },
    {
      name: "cached-result-is-dropped",
      file: module,
      before: "QueueField::Value(value) => QueueField::Value(value.clone()),",
      after: "QueueField::Value(_) => QueueField::Undefined,",
      witness: "intake.result-identity-and-json-detachment",
    },
    {
      name: "inherited-payload-becomes-absent",
      file: module,
      before:
        "RecordLookup::Payload(_)\n            | RecordLookup::Value(Resolved::Builtin(_) | Resolved::ObjectPrototype) => {",
      after:
        "RecordLookup::Payload(_) => return Ok(None),\n            RecordLookup::Value(Resolved::Builtin(_) | Resolved::ObjectPrototype) => {",
      witness: "intake.injected-lookup-value",
    },
    {
      name: "restored-missing-result-becomes-owned",
      file: "crates/tea/src/idempotency/intake/wire.rs",
      before: "let mut result = IntakeValue::Absent;",
      after: "let mut result = IntakeValue::Undefined;",
      witness: "intake.undefined-result-presence",
    },
    {
      name: "stored-null-stamp-becomes-zero",
      file: "crates/tea/src/idempotency.rs",
      before: "at_ms: now_ms,",
      after: "at_ms: now_ms.number_or_zero().into(),",
      witness: "intake.clock-null",
    },
    {
      name: "queue-borrow-crosses-user-callback",
      file: module,
      before: "for item in state.queue.to_vec() {",
      after: "for item in state.queue.items().iter() {",
      sites: 2,
      nativeWitness:
        "every_key_callback_failure_retains_the_original_opaque_cause",
    },
  ].filter((control) => !options.only || control.name === options.only);
  assert(controls.length > 0, "select a named control");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const activeFiles = [...new Set(controls.map((c) => c.file))],
    sourceHashes = Object.fromEntries(
      activeFiles.map((f) => [f, hash(readFileSync(join(root, f)))]),
    );
  const mutationCheck = createCheckWorktree(process.cwd(), "intake-mutations");
  let mutationFailure;
  try {
    const copy = mutationCheck.root,
      target = mutationCheck.target;
    const command = (args) => {
      const result = spawnSync(cargo, args, {
        cwd: copy,
        env: { ...env },
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 360000,
      });
      assert.equal(result.status, 0, `control must compile: ${result.stderr}`);
      return result;
    };
    const results = [];
    try {
      for (const control of controls) {
        const file = join(copy, control.file),
          before = readFileSync(file, "utf8");
        assert.equal(
          before.split(control.before).length,
          (control.sites ?? 1) + 1,
          `${control.name}: exact source sites`,
        );
        const after = before.replaceAll(control.before, control.after);
        writeFileSync(file, after);
        const receipt = {
          name: control.name,
          sourceHash: hash(before),
          mutantHash: hash(after),
          detected: false,
        };
        if (control.nativeWitness) {
          const compiled = command([
            "test",
            "--locked",
            "-p",
            "demlik-tea",
            "--test",
            "idempotent_intake",
            "--no-run",
            "--message-format=json",
          ]);
          const artifacts = compiled.stdout
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
          const executable = artifacts.find(
            (a) =>
              a.reason === "compiler-artifact" &&
              a.target.name === "idempotent_intake" &&
              a.executable,
          )?.executable;
          assert(executable);
          const run = spawnSync(
            executable,
            ["--exact", control.nativeWitness, "--nocapture"],
            { cwd: copy, encoding: "utf8", timeout: 30000 },
          );
          assert.equal(run.status, 101);
          assert(run.stdout.includes(`${control.nativeWitness} ... FAILED`));
          assert(
            (run.stderr + run.stdout).includes("RefCell already borrowed"),
          );
          Object.assign(receipt, {
            detected: true,
            nativeWitness: control.nativeWitness,
            binaryHash: hash(readFileSync(executable)),
            stdout: run.stdout,
            stderr: run.stderr,
          });
        } else {
          command([
            "build",
            "--locked",
            "-p",
            "demlik-parity",
            "--bin",
            "intake_driver",
          ]);
          const reportFile = join(
            reportDir,
            `intake-control-${control.name}.json`,
          );
          const compared = await intakeParity({
            binary: join(target, "debug/intake_driver"),
            reportFile,
            caseIds: baseline.results.map((r) => r.id),
          });
          assert(
            compared.failures.some((f) => f.id === control.witness),
            `${control.name}: named actual-output witness`,
          );
          Object.assign(receipt, {
            detected: true,
            witness: control.witness,
            binaryHash: compared.binaryHash,
            detectedIds: compared.failures.map((f) => f.id),
            report: reportFile,
          });
          if (control.runtimeWitness) {
            command([
              "build",
              "--locked",
              "-p",
              "demlik-tea",
              "--example",
              "intake_runtime_driver",
            ]);
            const runtimeFile = join(
                reportDir,
                `intake-runtime-control-${control.name}.json`,
              ),
              comparedRuntime = await intakeRuntimeParity({
                binary: join(target, "debug/examples/intake_runtime_driver"),
                reportFile: runtimeFile,
              });
            const witness = comparedRuntime.failures.find(
              (f) => f.id === control.runtimeWitness,
            );
            assert(witness);
            const workerCounts = {
              reference: witness.reference.snapshots.map((s) => s.workers),
              rust: witness.rust.snapshots.map((s) => s.workers),
            };
            if (control.runtimeWorkers)
              assert.deepEqual(workerCounts, control.runtimeWorkers);
            Object.assign(receipt, {
              runtimeWitness: control.runtimeWitness,
              runtimeDetectedIds: comparedRuntime.failures.map((f) => f.id),
              runtimeBinaryHash: comparedRuntime.binaryHash,
              runtimeReport: runtimeFile,
              runtimeWorkers: workerCounts,
            });
          }
        }
        results.push(receipt);
        console.log(
          JSON.stringify({
            name: receipt.name,
            detected: receipt.detected,
            cases: receipt.detectedIds?.length ?? 1,
          }),
        );
        writeFileSync(file, before);
      }
      for (const [file, digest] of Object.entries(sourceHashes))
        assert.equal(
          hash(readFileSync(join(root, file))),
          digest,
          `active source unchanged: ${file}`,
        );
      const report = {
        version: 1,
        baseline: {
          cases: baseline.total,
          binaryHash: baseline.binaryHash,
          runtimeCases: runtime.total,
          runtimeBinaryHash: runtime.binaryHash,
        },
        sourceHashes,
        controls: results,
      };
      const reportFile =
        options.reportFile ?? join(reportDir, "intake-mutations.json");
      writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
      return report;
    } finally {
    }
  } catch (error) {
    mutationFailure = error;
    throw error;
  } finally {
    mutationCheck.remove(mutationFailure);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      binary: { type: "string" },
      "runtime-binary": { type: "string" },
      only: { type: "string" },
      report: { type: "string" },
    },
  });
  const report = await intakeMutations({
    binary: values.binary,
    runtimeBinary: values["runtime-binary"],
    only: values.only,
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      controls: report.controls.length,
      detected: report.controls.filter((c) => c.detected).length,
    }),
  );
}
