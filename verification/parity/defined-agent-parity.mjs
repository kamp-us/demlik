import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const scope = read(path.join(root, "verification/parity/scope.json"));
const fixturePins = read(
  path.join(root, "verification/parity/defined-agent-fixture-pins.json"),
);

export function definedAgentCheckpointParity(cargo, options = {}) {
  for (const name of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[name], undefined, `${name} must be unset`);
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  execFileSync(
    "git",
    [
      "diff",
      "--exit-code",
      scope.reference,
      "--",
      "packages/tea/src",
      "packages/tea/package.json",
    ],
    { cwd: root },
  );
  assert.equal(
    execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", "packages/tea/src"],
      { cwd: root, encoding: "utf8" },
    ),
    "",
  );
  for (const [file, expected] of Object.entries(fixturePins.files))
    assert.equal(hash(path.join(root, file)), expected, file);
  const target = path.join(root, "target");
  fs.mkdirSync(path.join(target, "parity"), { recursive: true });
  assertCheckPath(target, root);
  const proof = fs.mkdtempSync(path.join(target, "parity/defined-agent-"));
  assertCheckPath(proof, target);
  const source = path.join(proof, "source");
  const steps = [];
  function execute(name, executable, args, cwd = root) {
    const result = spawnSync(executable, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    const directory = path.join(proof, name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "stdout"), result.stdout ?? "");
    fs.writeFileSync(path.join(directory, "stderr"), result.stderr ?? "");
    const receipt = {
      command: [executable, ...args],
      exit: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
    };
    fs.writeFileSync(
      path.join(directory, "process.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    steps.push({ name, ...receipt });
    assert.equal(receipt.error, null, name);
    assert.equal(receipt.signal, null, name);
    assert.equal(receipt.exit, 0, `${name}: ${result.stderr}`);
    assert.equal(result.stderr, "", `${name}: unexpected stderr`);
    return result.stdout;
  }
  const cases = read(
    path.join(root, "verification/parity/define-agent-source-cases.json"),
  );
  for (const { id } of cases)
    execute(`source/${id}`, process.execPath, [
      "--import",
      path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
      path.join(root, "verification/parity/define-agent-source.mts"),
      id,
      path.join(source, id, "files"),
    ]);
  const producer = buildTeaExample(
    cargo,
    "defined_agent_invoice",
    path.join(proof, "producer"),
  );
  const binary = options.binary
    ? path.resolve(options.binary)
    : producer.binary;
  const before = hash(binary);
  assert.equal(
    before,
    producer.binarySha256,
    "use a byte-identical Cargo-selected public consumer",
  );
  const stdout = execute("native", binary, [path.join(proof, "native/files")]);
  const nativePath = path.join(proof, "native/stdout");
  const comparisonPath = path.join(proof, "comparison.json");
  execute("comparison", process.execPath, [
    path.join(root, "verification/parity/defined-agent-checks.mjs"),
    source,
    nativePath,
    comparisonPath,
  ]);
  assert.equal(hash(binary), before, "executed binary must remain unchanged");
  const compared = read(comparisonPath);
  const native = stdout.trim().split("\n").map(JSON.parse);
  const qualifiedNativeEvidence = {};
  for (const [index, row] of compared.rows.entries()) {
    const id = `tea.defined-agent.${row.id}`;
    assert.equal(native[index].scenario, row.nativeScenario);
    qualifiedNativeEvidence[id] = native[index].phases.flatMap(
      (phase) => phase.nativeTrace,
    );
    assert(
      qualifiedNativeEvidence[id].includes("demlik_tea::agent::define_agent"),
    );
    row.id = id;
    row.passed = true;
    row.sourceProcess = steps[index];
    row.nativeProcess = steps.find((step) => step.name === "native");
  }
  const result = {
    reference: scope.reference,
    engine: scope.referenceEngine,
    cases: 6,
    passed: 0,
    qualifiedPassed: 6,
    qualifiedEvidenceCases: 6,
    failures: [],
    nativeEvidence: {},
    qualifiedNativeEvidence,
    rows: compared.rows,
    phases: compared.phases,
    producer,
    executionBinary: binary,
    rustBinarySha256: before,
    sourceExecutions: 6,
    nativeExecutions: 1,
    steps,
    rawRecords: { proof, comparisonPath, nativePath },
    limitations: compared.limitations,
    qualification:
      "Only the explicit native ToolContext.host versus TypeScript context-wrapper identity profile differs; all77 Store wire strings and complete prompts, events, hooks, final states and report files match.",
  };
  const reportFile = path.resolve(
    options.reportFile ?? path.join(target, "parity/defined-agent.json"),
  );
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
