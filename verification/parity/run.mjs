import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandFamiliesParity } from "./command-families-run.mjs";
import { checkCoverage } from "./coverage.mjs";
import { flowParity } from "./flow-run.mjs";
import { checkGraphContract, generatedCases } from "./generated.mjs";
import { graphParity } from "./graph.mjs";
import { monitoredRunParity } from "./monitored-run-run.mjs";
import { paginateQueueParity } from "./paginate-queue-run.mjs";
import { POLICY_SEED, policyCases } from "./policies-generated.mjs";
import { resilientCallParity } from "./resilient-call-run.mjs";
import { runtimeParity } from "./runtime.mjs";
import { runtimeContractParity } from "./runtime-contracts.mjs";
import { runtimeDeadlineParity } from "./runtime-deadline-run.mjs";
import { runtimeHooksParity } from "./runtime-hooks.mjs";
import { timingParity } from "./timing-run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = process.argv.slice(2);
const binaryArgument = args.indexOf("--rust-bin");
const runtimeBinaryArgument = args.indexOf("--runtime-bin");
const timingBinaryArgument = args.indexOf("--timing-bin");
const contractBinaryArgument = args.indexOf("--contract-bin");
const familiesBinaryArgument = args.indexOf("--command-families-bin");
const flowBinaryArgument = args.indexOf("--flow-bin");
const resilientCallBinaryArgument = args.indexOf("--resilient-call-bin");
const monitoredRunBinaryArgument = args.indexOf("--monitored-run-bin");
const hooksBinaryArgument = args.indexOf("--hooks-bin");
const deadlineBinaryArgument = args.indexOf("--deadline-bin");
const paginateQueueBinaryArgument = args.indexOf("--paginate-queue-bin");
const reportArgument = args.indexOf("--report");
const mutationArgument = args.indexOf("--mutation-suite");
const mutationSuite =
  mutationArgument === -1 ? undefined : args[mutationArgument + 1];
if (mutationArgument !== -1) {
  assert.ok(
    ["base", "runtime"].includes(mutationSuite),
    "unknown mutation suite",
  );
  assert.ok(
    binaryArgument !== -1,
    "mutation suites require a separately built source-copy binary",
  );
  assert.ok(
    !args.includes("--complete"),
    "the completion gate requires every suite",
  );
}
const reportFile =
  reportArgument === -1
    ? path.join(root, "target/parity/report.json")
    : path.resolve(args[reportArgument + 1]);
const binary =
  binaryArgument === -1
    ? path.join(root, "target/debug/demlik-parity")
    : path.resolve(args[binaryArgument + 1]);
const require = createRequire(import.meta.url);
const cargo = process.env.CARGO ?? "cargo";
const scope = JSON.parse(await readFile(path.join(here, "scope.json"), "utf8"));
assert.equal(
  process.version,
  scope.referenceEngine.node,
  "run the pinned Node reference engine (pnpm selects the repository toolchain)",
);
assert.equal(
  process.versions.v8,
  scope.referenceEngine.v8,
  "the strict numeric reference requires the recorded V8 implementation",
);
const referenceChanges = execFileSync(
  "git",
  [
    "diff",
    "--name-only",
    scope.reference,
    "--",
    "packages/tea",
    "packages/code-graph",
  ],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);
if (binaryArgument === -1) {
  execFileSync(cargo, ["build", "--locked", "--package", "demlik-parity"], {
    cwd: root,
    stdio: "inherit",
  });
}
const cases = [];
for (const file of (await readdir(path.join(here, "cases"))).sort()) {
  if (!file.endsWith(".json")) continue;
  const corpus = JSON.parse(
    await readFile(path.join(here, "cases", file), "utf8"),
  );
  assert.equal(corpus.version, 1, `unsupported corpus version in ${file}`);
  cases.push(...corpus.cases);
}
cases.push(...generatedCases(), ...policyCases());
assert.ok(
  cases.length > 0,
  "the parity corpus must exercise at least one operation",
);
assert.equal(
  new Set(cases.map((test) => test.id)).size,
  cases.length,
  "case IDs must be unique",
);
const input = `${cases.map((test) => JSON.stringify({ id: test.id, operation: test.operation, input: test.input })).join("\n")}\n`;
const driverDiagnostics = [];
function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `driver failed: ${result.stderr}`);
  if (result.stderr)
    driverDiagnostics.push({
      language: command === binary ? "Rust" : "TypeScript",
      stderr: result.stderr,
    });
  const output = result.stdout;
  const responses = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    responses.length,
    cases.length,
    `${command} returned an incomplete response stream`,
  );
  return responses;
}
const typescript = run(process.execPath, [
  "--import",
  require.resolve("tsx"),
  path.join(here, "typescript.mts"),
]);
const rust = run(binary, []);
const failures = [];
for (let index = 0; index < cases.length; index++) {
  const test = cases[index];
  try {
    for (const [language, response] of [
      ["TypeScript", typescript[index]],
      ["Rust", rust[index]],
    ]) {
      assert.equal(response.id, test.id, `${language} response order`);
      assert.equal(
        response.ok,
        true,
        `${language}: ${JSON.stringify(response.error)}`,
      );
      if (Object.hasOwn(test, "expected"))
        assert.deepStrictEqual(
          response.output,
          test.expected,
          `${language} independent expectation`,
        );
      if (test.operation === "code_graph.scc")
        checkGraphContract(test.input, response.output);
    }
    assert.deepStrictEqual(
      rust[index].output,
      typescript[index].output,
      "cross-language result",
    );
  } catch (error) {
    failures.push({
      id: test.id,
      operation: test.operation,
      input: test.input,
      message: error.message,
      typescript: typescript[index],
      rust: rust[index],
    });
  }
}
const differentialFailures = failures.length;
let suiteFailures = 0;
let storageProcesses = null;
if (!mutationSuite) {
  try {
    const processReport = path.join(
      path.dirname(reportFile),
      reportArgument === -1
        ? "storage-process.json"
        : `${path.basename(reportFile, ".json")}-storage-process.json`,
    );
    execFileSync(process.execPath, [path.join(here, "storage-process.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PARITY_RUST_BIN: binary,
        PARITY_STORAGE_REPORT: processReport,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 45_000,
    });
    storageProcesses = {
      ...JSON.parse(await readFile(processReport, "utf8")),
      reportFile: processReport,
    };
    assert.equal(storageProcesses.results.length, 2);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "storage.process-verification",
      operation: "tea.storage.processes",
      message: error.message,
    });
  }
}
let runtime = { cases: 0, passed: 0, nativeEvidence: {} };
if (!mutationSuite || mutationSuite === "runtime") {
  try {
    runtime = await runtimeParity(cargo, {
      binary:
        runtimeBinaryArgument === -1
          ? undefined
          : path.resolve(args[runtimeBinaryArgument + 1]),
      reportFile:
        reportArgument === -1
          ? undefined
          : path.join(
              path.dirname(reportFile),
              `${path.basename(reportFile, ".json")}-runtime.json`,
            ),
    });
    failures.push(...runtime.failures);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "runtime.verification",
      operation: "tea.runtime",
      message: error.message,
    });
  }
}
let runtimeContracts = { cases: 0, passed: 0, nativeEvidence: {} };
if (!mutationSuite) {
  try {
    runtimeContracts = await runtimeContractParity(cargo, {
      binary:
        contractBinaryArgument === -1
          ? undefined
          : path.resolve(args[contractBinaryArgument + 1]),
      reportFile:
        reportArgument === -1
          ? undefined
          : path.join(
              path.dirname(reportFile),
              `${path.basename(reportFile, ".json")}-runtime-contract.json`,
            ),
    });
    failures.push(...runtimeContracts.failures);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "runtime-contract.verification",
      operation: "tea.runtime.contracts",
      message: error.message,
    });
  }
}
let commandFamilies = { cases: 0, passed: 0, nativeEvidence: {} };
if (!mutationSuite) {
  try {
    commandFamilies = await commandFamiliesParity(cargo, {
      binary:
        familiesBinaryArgument === -1
          ? undefined
          : path.resolve(args[familiesBinaryArgument + 1]),
      reportFile:
        reportArgument === -1
          ? undefined
          : path.join(
              path.dirname(reportFile),
              `${path.basename(reportFile, ".json")}-command-families.json`,
            ),
    });
    failures.push(...commandFamilies.failures);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "command-families.verification",
      operation: "tea.command.families",
      message: error.message,
    });
  }
}
let resilientCall = { cases: 0, passed: 0, nativeEvidence: {} };
if (!mutationSuite) {
  try {
    resilientCall = await resilientCallParity(cargo, {
      binary:
        resilientCallBinaryArgument === -1
          ? undefined
          : path.resolve(args[resilientCallBinaryArgument + 1]),
      reportFile:
        reportArgument === -1
          ? undefined
          : path.join(
              path.dirname(reportFile),
              `${path.basename(reportFile, ".json")}-resilient-call.json`,
            ),
    });
    failures.push(...resilientCall.failures);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "resilient-call.verification",
      operation: "tea.resilience.resilient-call",
      message: error.message,
    });
  }
}
let flow = { cases: 0, passed: 0, nativeEvidence: {} };
if (!mutationSuite) {
  try {
    flow = await flowParity(cargo, {
      binary:
        flowBinaryArgument === -1
          ? undefined
          : path.resolve(args[flowBinaryArgument + 1]),
      reportFile:
        reportArgument === -1
          ? undefined
          : path.join(
              path.dirname(reportFile),
              `${path.basename(reportFile, ".json")}-flow.json`,
            ),
    });
    failures.push(...flow.failures);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "flow.verification",
      operation: "tea.flow",
      message: error.message,
    });
  }
}
let monitoredRun = { cases: 0, passed: 0, nativeEvidence: {} };
if (!mutationSuite) {
  try {
    monitoredRun = await monitoredRunParity(cargo, {
      binary:
        monitoredRunBinaryArgument === -1
          ? undefined
          : path.resolve(args[monitoredRunBinaryArgument + 1]),
      reportFile:
        reportArgument === -1
          ? undefined
          : path.join(
              path.dirname(reportFile),
              `${path.basename(reportFile, ".json")}-monitored-run.json`,
            ),
    });
    failures.push(...monitoredRun.failures);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "monitored-run.verification",
      operation: "tea.monitored-run",
      message: error.message,
    });
  }
}
let runtimeHooks = { cases: 0, passed: 0, nativeEvidence: {} };
if (!mutationSuite) {
  try {
    runtimeHooks = await runtimeHooksParity(cargo, {
      binary:
        hooksBinaryArgument === -1
          ? undefined
          : path.resolve(args[hooksBinaryArgument + 1]),
      reportFile:
        reportArgument === -1
          ? undefined
          : path.join(
              path.dirname(reportFile),
              `${path.basename(reportFile, ".json")}-runtime-hooks.json`,
            ),
    });
    failures.push(...runtimeHooks.failures);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "runtime-hooks.verification",
      operation: "tea.runtime.hooks",
      message: error.message,
    });
  }
}
let runtimeDeadline = { cases: 0, passed: 0, nativeEvidence: {} };
if (!mutationSuite) {
  try {
    runtimeDeadline = await runtimeDeadlineParity(cargo, {
      binary:
        deadlineBinaryArgument === -1
          ? undefined
          : path.resolve(args[deadlineBinaryArgument + 1]),
      reportFile:
        reportArgument === -1
          ? undefined
          : path.join(
              path.dirname(reportFile),
              `${path.basename(reportFile, ".json")}-runtime-deadline.json`,
            ),
    });
    failures.push(...runtimeDeadline.failures);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "runtime-deadline.verification",
      operation: "tea.runtime.deadline",
      message: error.message,
    });
  }
}
let timing = { cases: 0, passed: 0, nativeEvidence: {} };
if (!mutationSuite) {
  try {
    timing = await timingParity(cargo, {
      binary:
        timingBinaryArgument === -1
          ? undefined
          : path.resolve(args[timingBinaryArgument + 1]),
      reportFile:
        reportArgument === -1
          ? undefined
          : path.join(
              path.dirname(reportFile),
              `${path.basename(reportFile, ".json")}-timing.json`,
            ),
    });
    failures.push(...timing.failures);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "timing.verification",
      operation: "tea.timing",
      message: error.message,
    });
  }
}
let paginateQueue = { cases: 0, passed: 0, nativeEvidence: {} };
if (!mutationSuite) {
  try {
    paginateQueue = await paginateQueueParity(cargo, {
      binary:
        paginateQueueBinaryArgument === -1
          ? undefined
          : path.resolve(args[paginateQueueBinaryArgument + 1]),
      reportFile:
        reportArgument === -1
          ? undefined
          : path.join(
              path.dirname(reportFile),
              `${path.basename(reportFile, ".json")}-paginate-queue.json`,
            ),
    });
    failures.push(...paginateQueue.failures);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "paginate-queue.verification",
      operation: "tea.paginate-and-queue",
      message: error.message,
    });
  }
}
let graph = {
  passed: 0,
  rejectedInvalidInputs: 0,
  suites: [],
  nativeEvidence: {},
};
if (!mutationSuite) {
  try {
    graph = await graphParity(cargo);
  } catch (error) {
    suiteFailures++;
    failures.push({
      id: "graph.verification",
      operation: "code_graph.project-and-semantics",
      message: error.message,
    });
  }
}
const report = {
  scope: "implemented operations only; full port is incomplete",
  selection: mutationSuite ? `mutation:${mutationSuite}` : "all",
  reference: scope.reference,
  referenceChanges,
  node: process.version,
  v8: process.versions.v8,
  platform: process.platform,
  architecture: process.arch,
  cargo: execFileSync(cargo, ["--version"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  pnpmLockSha256: createHash("sha256")
    .update(await readFile(path.join(root, "pnpm-lock.yaml")))
    .digest("hex"),
  cargoLockSha256: createHash("sha256")
    .update(await readFile(path.join(root, "Cargo.lock")))
    .digest("hex"),
  cases:
    cases.length +
    graph.passed +
    runtime.cases +
    timing.cases +
    runtimeContracts.cases +
    commandFamilies.cases +
    resilientCall.cases +
    flow.cases +
    monitoredRun.cases +
    runtimeHooks.cases +
    runtimeDeadline.cases +
    paginateQueue.cases +
    suiteFailures,
  passed:
    cases.length +
    graph.passed +
    runtime.passed +
    timing.passed +
    runtimeContracts.passed +
    commandFamilies.passed +
    resilientCall.passed +
    flow.passed +
    monitoredRun.passed +
    runtimeHooks.passed +
    runtimeDeadline.passed +
    paginateQueue.passed -
    differentialFailures,
  failures,
  operations: [
    ...new Set([
      ...cases.map((test) => test.operation),
      ...(runtime.passed ? ["tea.runtime"] : []),
      ...(timing.passed ? ["tea.timing"] : []),
      ...(runtimeContracts.passed ? ["tea.runtime.contracts"] : []),
      ...(commandFamilies.passed ? ["tea.command.families"] : []),
      ...(resilientCall.passed ? ["tea.resilience.resilient-call"] : []),
      ...(flow.passed ? ["tea.flow"] : []),
      ...(monitoredRun.passed ? ["tea.monitored-run"] : []),
      ...(runtimeHooks.passed ? ["tea.runtime.hooks"] : []),
      ...(runtimeDeadline.passed ? ["tea.runtime.deadline"] : []),
      ...(paginateQueue.passed ? ["tea.paginate-and-queue"] : []),
      ...graph.suites.map((suite) => `code_graph.${suite.name}`),
    ]),
  ],
  graph: { ...graph, nativeEvidence: undefined },
  runtime: { ...runtime, nativeEvidence: undefined },
  timing: { ...timing, nativeEvidence: undefined, failures: undefined },
  runtimeContracts: {
    ...runtimeContracts,
    nativeEvidence: undefined,
    failures: undefined,
  },
  commandFamilies: {
    ...commandFamilies,
    nativeEvidence: undefined,
    failures: undefined,
  },
  resilientCall: {
    ...resilientCall,
    nativeEvidence: undefined,
    failures: undefined,
  },
  flow: { ...flow, nativeEvidence: undefined, failures: undefined },
  monitoredRun: {
    ...monitoredRun,
    nativeEvidence: undefined,
    failures: undefined,
  },
  paginateQueue: {
    ...paginateQueue,
    nativeEvidence: undefined,
    failures: undefined,
  },
  runtimeHooks: {
    ...runtimeHooks,
    nativeEvidence: undefined,
    failures: undefined,
  },
  runtimeDeadline: {
    ...runtimeDeadline,
    nativeEvidence: undefined,
    failures: undefined,
  },
  storageProcesses,
  rustBinarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  generatedSeed: 0x5eed1234,
  policyGeneratedSeed: POLICY_SEED,
  driverDiagnostics,
  nativeEvidence: {
    ...Object.fromEntries(
      cases.map((test, index) => [
        test.id,
        failures.some((failure) => failure.id === test.id)
          ? []
          : (rust[index].observedCalls ?? []),
      ]),
    ),
    ...graph.nativeEvidence,
    ...runtime.nativeEvidence,
    ...timing.nativeEvidence,
    ...runtimeContracts.nativeEvidence,
    ...commandFamilies.nativeEvidence,
    ...resilientCall.nativeEvidence,
    ...flow.nativeEvidence,
    ...monitoredRun.nativeEvidence,
    ...runtimeHooks.nativeEvidence,
    ...runtimeDeadline.nativeEvidence,
    ...paginateQueue.nativeEvidence,
  },
  infrastructureDiagnostics: Object.fromEntries(
    cases.flatMap((test, index) => {
      const reference = typescript[index].observedDiagnostics ?? [];
      const native = rust[index].observedDiagnostics ?? [];
      return reference.length || native.length
        ? [[test.id, { reference, native }]]
        : [];
    }),
  ),
};
await mkdir(path.dirname(reportFile), { recursive: true });
if (args.includes("--complete")) {
  report.coverage = await checkCoverage(
    new Map(
      Object.entries(report.nativeEvidence).map(([id, calls]) => [
        id,
        new Set(calls),
      ]),
    ),
  );
  if (report.coverage.gaps.length || referenceChanges.length)
    process.exitCode = 1;
}
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ ...report, driverDiagnostics: { streams: driverDiagnostics.length }, timing: { ...report.timing, driverDiagnostics: { streams: report.timing.driverDiagnostics?.length ?? 0 } }, paginateQueue: { ...report.paginateQueue, driverDiagnostics: { streams: report.paginateQueue.driverDiagnostics?.length ?? 0 } }, nativeEvidence: { cases: Object.keys(report.nativeEvidence).length }, infrastructureDiagnostics: { cases: Object.keys(report.infrastructureDiagnostics).length }, coverage: report.coverage && { ...report.coverage, gaps: report.coverage.gaps.slice(0, 5), gapCount: report.coverage.gaps.length }, failures: report.failures.slice(0, 5), failureCount: failures.length, reportFile }, null, 2)}\n`,
);
if (failures.length) process.exitCode = 1;
