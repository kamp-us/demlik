import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTeaExample } from "./tea-example.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
export async function runtimeContractParity(cargo, options = {}) {
  const reportFile =
    options.reportFile ??
    path.join(root, "target/parity/runtime-contract.json");
  const producer = options.binary
    ? null
    : buildTeaExample(cargo, "runtime_contract_driver", reportFile);
  const binary = options.binary ?? producer.binary;
  await mkdir(path.dirname(reportFile), { recursive: true });
  await rm(reportFile, { force: true });
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(here, "runtime-contract.mts"),
      "--report",
      reportFile,
      "--native-binary",
      binary,
      ...(options.mutation ? ["--mutation-check"] : []),
    ],
    {
      cwd: root,
      env: { ...process.env, CARGO: cargo },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  assert.ok(
    result.status === 0 || result.status === 1,
    `contract verifier failed: ${result.stderr}`,
  );
  let report;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch (error) {
    throw new Error(
      `contract verifier did not produce a report: ${result.stderr}`,
      { cause: error },
    );
  }
  assert.equal(report.cases.length, report.comparisonCount);
  assert.equal(report.passed, report.cases.filter((item) => item.equal).length);
  assert.equal(result.status, report.failures.length ? 1 : 0);
  if (producer) assert.equal(report.binarySha256, producer.binarySha256);
  report.producer = producer;
  report.binarySource = options.binary
    ? "external override; local Cargo producer unproved"
    : "actual Cargo JSON selection";
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const nativeEvidence = Object.fromEntries(
    report.cases
      .filter((item) => item.equal)
      .map((item) => {
        assert.ok(
          item.observedRustCalls.length > 0,
          `${item.id}: no compiled native calls`,
        );
        return [`runtime-contract.${item.id}`, item.observedRustCalls];
      }),
  );
  return {
    cases: report.comparisonCount,
    passed: report.passed,
    failures: report.failures,
    nativeEvidence,
    binarySha256: report.binarySha256,
    producer,
    binarySource: report.binarySource,
    scriptStepsPerImplementation: report.scriptStepsPerImplementation,
    appliedTransitionsPerImplementation:
      report.appliedTransitionsPerImplementation,
    controls: report.controls,
    scope: report.scope,
    reportFile,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const mutation = process.argv.includes("--mutation-check");
  const report = await runtimeContractParity(process.env.CARGO ?? "cargo", {
    mutation,
    reportFile: mutation
      ? path.join(root, "target/parity/runtime-contract-mutation.json")
      : undefined,
  });
  process.stdout.write(
    `${JSON.stringify({ ...report, nativeEvidence: { cases: Object.keys(report.nativeEvidence).length } }, null, 2)}\n`,
  );
  if (report.failures.length) process.exitCode = 1;
}
