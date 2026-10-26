import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const checkpoints = {
  prerequisite: {
    driver: "agent_state_prerequisite_driver",
    module: "agent-state-prerequisite-run.mjs",
    run: "prerequisiteParity",
  },
  state: {
    driver: "agent_state_driver",
    module: "agent-state-run.mts",
    run: "stateParity",
  },
  fanout: {
    driver: "agent_fanout_restore_driver",
    module: "agent-state-fanout-restore.mts",
    run: "fanoutRestoreParity",
  },
  base: {
    driver: "agent_base_driver",
    module: "agent-base-run.mjs",
    run: "agentBaseParity",
  },
};

async function checkpointParity(cargo, name, options = {}) {
  const scope = JSON.parse(await readFile(path.join(here, "scope.json")));
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const checkpoint = checkpoints[name];
  let binary = path.resolve(
    options.binary ??
      path.join(
        process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
        "debug/examples",
        checkpoint.driver,
      ),
  );
  const reportFile = path.resolve(
    options.reportFile ??
      path.join(root, `target/parity/agent-checkpoint-${name}.json`),
  );
  await mkdir(path.dirname(reportFile), { recursive: true });
  await rm(reportFile, { force: true });
  let cargoArtifacts;
  if (!options.binary) {
    const args = [
      "build",
      "--locked",
      "--offline",
      "--message-format=json",
      "-p",
      "demlik-tea",
      "--example",
      checkpoint.driver,
    ];
    const build = spawnSync(cargo, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (build.error) throw build.error;
    const file = `${reportFile}.cargo.jsonl`;
    await writeFile(file, build.stdout);
    await writeFile(`${reportFile}.cargo.stderr`, build.stderr);
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const events = build.stdout.trim().split("\n").map(JSON.parse);
    const executables = events.filter(
      (event) =>
        event.reason === "compiler-artifact" &&
        event.target.name === checkpoint.driver &&
        event.executable,
    );
    const libraries = events.filter(
      (event) =>
        event.reason === "compiler-artifact" &&
        event.target.name === "demlik_tea" &&
        event.target.kind.includes("lib") &&
        event.filenames.some((file) => file.endsWith(".rlib")),
    );
    assert.equal(executables.length, 1);
    assert.equal(libraries.length, 1);
    const artifact = async (file) => ({
      path: file,
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    });
    const executable = await artifact(executables[0].executable);
    const library = await artifact(
      libraries[0].filenames.find((file) => file.endsWith(".rlib")),
    );
    binary = `${reportFile}.${executable.sha256}.bin`;
    await copyFile(executable.path, binary);
    cargoArtifacts = {
      file,
      command: [cargo, ...args],
      executable,
      libraries: { demlik_tea: library },
    };
  }
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      "--input-type=module",
      "--eval",
      "const checks = await import(process.argv[1]); await checks[process.argv[2]](JSON.parse(process.argv[3]));",
      pathToFileURL(path.join(here, checkpoint.module)).href,
      checkpoint.run,
      JSON.stringify({
        binary,
        reportFile,
        quiet: true,
        allowFailures: true,
      }),
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `${name}: ${child.stdout}\n${child.stderr}`);
  const report = JSON.parse(await readFile(reportFile));
  assert.equal(report.cases, report.passed + report.failures.length);
  assert.equal(Object.keys(report.nativeEvidence).length, report.passed);
  for (const [id, calls] of Object.entries(report.nativeEvidence)) {
    assert.ok(calls.length, `${id}: no compiled consumer calls`);
    assert.ok(!report.failures.some((failure) => failure.id === id));
  }
  for (const row of report.qualifiedObservations ?? [])
    assert.ok(!Object.hasOwn(report.nativeEvidence, row.id));
  assert.equal(
    report.binarySha256,
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  );
  return { ...report, reportFile, binary, cargoArtifacts };
}

export const agentStatePrerequisiteParity = (cargo, options) =>
  checkpointParity(cargo, "prerequisite", options);
export const agentStateParity = (cargo, options) =>
  checkpointParity(cargo, "state", options);
export const agentStateFanoutParity = (cargo, options) =>
  checkpointParity(cargo, "fanout", options);
export const agentBaseCheckpointParity = (cargo, options) =>
  checkpointParity(cargo, "base", options);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      suite: { type: "string" },
      binary: { type: "string" },
      report: { type: "string" },
    },
  });
  const names = values.suite ? [values.suite] : Object.keys(checkpoints);
  assert.ok(!values.binary || names.length === 1);
  assert.ok(!values.report || names.length === 1);
  for (const name of names) {
    assert.ok(Object.hasOwn(checkpoints, name), "unknown agent checkpoint");
    const result = await checkpointParity(process.env.CARGO ?? "cargo", name, {
      binary: values.binary,
      reportFile: values.report,
    });
    console.log(
      JSON.stringify({
        suite: name,
        cases: result.cases,
        passed: result.passed,
        failures: result.failures,
        reportFile: result.reportFile,
      }),
    );
    if (result.failures.length) process.exitCode = 1;
  }
}
