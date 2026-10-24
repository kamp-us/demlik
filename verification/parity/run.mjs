import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoverage } from "./coverage.mjs";
import { checkGraphContract, generatedCases } from "./generated.mjs";
import { POLICY_SEED, policyCases } from "./policies-generated.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = process.argv.slice(2);
const binaryArgument = args.indexOf("--rust-bin");
const reportArgument = args.indexOf("--report");
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
function run(command, commandArgs) {
  const output = execFileSync(command, commandArgs, {
    cwd: root,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
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
const report = {
  scope: "implemented operations only; full port is incomplete",
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
  cases: cases.length,
  passed: cases.length - failures.length,
  failures,
  operations: [...new Set(cases.map((test) => test.operation))],
  rustBinarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  generatedSeed: 0x5eed1234,
  policyGeneratedSeed: POLICY_SEED,
  nativeEvidence: Object.fromEntries(
    cases.map((test, index) => [
      test.id,
      failures.some((failure) => failure.id === test.id)
        ? []
        : (rust[index].observedCalls ?? []),
    ]),
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
  `${JSON.stringify({ ...report, nativeEvidence: { cases: Object.keys(report.nativeEvidence).length }, coverage: report.coverage && { ...report.coverage, gaps: report.coverage.gaps.slice(0, 5), gapCount: report.coverage.gaps.length }, failures: report.failures.slice(0, 5), failureCount: failures.length, reportFile }, null, 2)}\n`,
);
if (failures.length) process.exitCode = 1;
