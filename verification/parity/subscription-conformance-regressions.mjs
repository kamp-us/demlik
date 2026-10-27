import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { recorderRuntime } from "./recorder-runtime.mjs";
import { runtimeParity } from "./runtime.mjs";
import { runtimeContractParity } from "./runtime-contracts.mjs";
import { runtimeDeadlineParity } from "./runtime-deadline-run.mjs";
import { runtimeHooksParity } from "./runtime-hooks.mjs";
import { typedReducerParity } from "./typed-reducer-run.mjs";
export async function subscriptionRegressions(artifacts, directory) {
  await mkdir(directory, { recursive: true });
  const options = (name) => ({
    binary: artifacts.examples[name],
    reportFile: path.join(directory, `${name}.json`),
    quiet: true,
  });
  const cargo = process.env.CARGO ?? "cargo";
  const reports = {
    typed: await typedReducerParity(options("typed_reducer_driver")),
    runtime: await runtimeParity(cargo, options("runtime_driver")),
    contract: await runtimeContractParity(
      cargo,
      options("runtime_contract_driver"),
    ),
    hooks: await runtimeHooksParity(cargo, options("runtime_hooks_driver")),
    deadline: await runtimeDeadlineParity(
      cargo,
      options("runtime_deadline_driver"),
    ),
  };
  const native = spawnSync(artifacts.tests.recorder_runtime, ["--nocapture"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  await writeFile(
    path.join(directory, "recorder-native.log"),
    `${native.stdout}\n${native.stderr}`,
  );
  assert.equal(native.status, 0);
  reports.recorder = await recorderRuntime({
    fromLog: path.join(directory, "recorder-native.log"),
    reportFile: path.join(directory, "recorder.json"),
    quiet: true,
  });
  for (const report of Object.values(reports)) {
    assert.equal(report.passed, report.cases);
    assert.deepEqual(report.failures ?? [], []);
  }
  await writeFile(
    path.join(directory, "report.json"),
    `${JSON.stringify({ cases: Object.values(reports).reduce((n, r) => n + r.cases, 0), passed: Object.values(reports).reduce((n, r) => n + r.passed, 0), reports }, null, 2)}\n`,
  );
  return reports;
}
