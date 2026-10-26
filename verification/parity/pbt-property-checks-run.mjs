import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  assertPbtRuntime,
  buildPbtExample,
  pbtPropertyDescriptor,
  readPbtCargoArtifacts,
} from "./pbt-property-run.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
function command(script, args, cargo) {
  const argv = [path.join(root, "verification/parity", script), ...args];
  const p = spawnSync(process.execPath, argv, {
    cwd: root,
    env: { ...process.env, CARGO: cargo },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (p.error) throw p.error;
  return {
    command: [process.execPath, ...argv],
    cwd: root,
    exit: p.status,
    stdout: p.stdout,
    stderr: p.stderr,
  };
}
function validateControls(controls) {
  assert.equal(controls.length, 9, "All nine existing controls are required");
  assert.equal(new Set(controls.map((c) => c.id)).size, 9);
  for (const c of controls) {
    assert.equal(
      c.compileExit,
      0,
      `${c.id}: compilation failure is not detection`,
    );
    assert(
      [1, 101].includes(c.resultExit),
      `${c.id}: behavioral failure required`,
    );
    assert(c.witness);
    assert.equal(
      hash(c.binary.path),
      c.binary.sha256,
      `${c.id}: actual saved control binary differs`,
    );
  }
}
export async function pbtPropertyChecks(
  cargo = process.env.CARGO ?? "cargo",
  options = {},
) {
  assertPbtRuntime();
  if (options.binary !== undefined)
    assert(options.binary.length > 0, "Explicit binary path must not be empty");
  const reportFile = path.resolve(
    options.reportFile ??
      path.join(root, "target/parity/pbt-property-parent-checks.json"),
  );
  mkdirSync(path.dirname(reportFile), { recursive: true });
  assert(
    !options.binary || options.cargoArtifacts,
    "--binary needs explicit --cargo-artifacts from actual feature Cargo JSON; no warm-deps scan or implicit build",
  );
  assert(
    !options.controlsReceipt || options.binary,
    "Retained-controls audit requires an explicit independently built baseline binary",
  );
  const built = options.binary
      ? undefined
      : buildPbtExample(cargo, `${reportFile}.baseline`),
    binary = path.resolve(options.binary ?? built.binary),
    baselineSha256 = hash(binary),
    artifacts =
      built?.artifacts ??
      readPbtCargoArtifacts(path.resolve(options.cargoArtifacts));
  const typeFile = `${reportFile}.types.json`,
    typesCommand = command(
      "pbt-property-type-probes.mjs",
      [
        "--rlib",
        artifacts.libraries.demlik_tea.path,
        "--proptest-rlib",
        artifacts.libraries.proptest.path,
        "--report",
        typeFile,
      ],
      cargo,
    );
  assert.equal(
    typesCommand.exit,
    0,
    `${typesCommand.stdout}\n${typesCommand.stderr}`,
  );
  const types = JSON.parse(readFileSync(typeFile, "utf8"));
  assert.equal(types.results.length, 4);
  assert.equal(types.results.filter((p) => p.ok).length, 1);
  assert.deepEqual(
    types.results
      .filter((p) => !p.ok)
      .map((p) => p.code)
      .sort(),
    ["E0271", "E0277", "E0308"],
  );
  for (const p of types.results) {
    assert.equal(p.exit === 0, p.ok);
    if (!p.ok) assert(p.stderr.includes(`error[${p.code}]`));
  }
  for (const [name, item] of [
    ["demlik_tea", types.rlib],
    ["proptest", types.proptestRlib],
  ]) {
    assert.equal(item.path, artifacts.libraries[name].path);
    assert.equal(item.sha256, artifacts.libraries[name].sha256);
    assert.equal(hash(item.path), item.sha256);
  }
  let controls, originalControls, controlsCommand, mode;
  if (options.controlsReceipt) {
    // Audit already-executed proof when testing adapters without cold targets.
    // This route never labels retained controls as newly executed checks/cases.
    const file = path.resolve(options.controlsReceipt),
      receipt = JSON.parse(readFileSync(file, "utf8"));
    for (const source of receipt.sourceFiles)
      assert.equal(
        hash(path.join(root, source.path)),
        source.sha256,
        `Retained control source changed: ${source.path}`,
      );
    assert.equal(
      receipt.proof.sourceArchive.baselineBinary.sha256,
      baselineSha256,
      "Retained baseline must be tied to the executed control receipt",
    );
    controls = receipt.controls.faults;
    validateControls(controls);
    originalControls = {
      path: file,
      sha256: hash(file),
      controls: receipt.controls,
    };
    mode = "retained-controls-audit";
  } else {
    const file = `${reportFile}.controls.json`;
    controlsCommand = command(
      "pbt-property-mutations.mjs",
      ["--native-bin", binary, "--report", file],
      cargo,
    );
    assert.equal(
      controlsCommand.exit,
      0,
      `${controlsCommand.stdout}\n${controlsCommand.stderr}`,
    );
    const original = JSON.parse(readFileSync(file, "utf8"));
    assert(original.activeSourceUnchanged);
    assert.equal(original.baseline.compared, 52);
    assert.equal(original.baseline.passed, 52);
    assert.equal(original.baseline.binary.sha256, baselineSha256);
    controls = original.controls.map((c) => {
      assert(c.compiled && c.detectedIds.includes(c.witness));
      return {
        id: c.id,
        witness: c.witness,
        compileExit: c.build.exit,
        resultExit: (c.result.command ?? c.result.run).exit,
        binary: c.binary,
      };
    });
    validateControls(controls);
    originalControls = original;
    mode = "executed-controls";
  }
  assert.equal(
    hash(binary),
    baselineSha256,
    "Baseline binary changed during checks",
  );
  const report = {
    descriptor: pbtPropertyDescriptor,
    mode,
    controlsFreshlyExecuted: mode === "executed-controls",
    semanticCases: 0,
    cases: 0,
    passed: 0,
    failures: [],
    nativeEvidence: {},
    baselineBinary: { path: binary, sha256: baselineSha256 },
    cargoArtifacts: artifacts,
    build: built?.build,
    typeProbes: types,
    controls,
    commands: [typesCommand, ...(controlsCommand ? [controlsCommand] : [])],
    originalControls,
    qualifications: [
      "Type probes and fault controls are checks, not additional semantic cases or bindings.",
      ...(mode === "retained-controls-audit"
        ? [
            "Control results are explicitly audited retained evidence, not a fresh mutation execution.",
          ]
        : []),
    ],
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      binary: { type: "string" },
      "cargo-artifacts": { type: "string" },
      "controls-receipt": { type: "string" },
      report: { type: "string" },
    },
    strict: true,
  });
  const report = await pbtPropertyChecks(process.env.CARGO ?? "cargo", {
    binary: values.binary,
    cargoArtifacts: values["cargo-artifacts"],
    controlsReceipt: values["controls-receipt"],
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      mode: report.mode,
      semanticCases: 0,
      positiveTypeProbes: report.typeProbes.results.filter((p) => p.ok).length,
      expectedRefusals: report.typeProbes.results.filter((p) => !p.ok).length,
      controls: report.controls.length,
      controlsFreshlyExecuted: report.controlsFreshlyExecuted,
    }),
  );
}
