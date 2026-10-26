import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compiledTraceParity } from "./compiled-traces.mjs";
import { assertPbtRuntime, buildPbtExample } from "./pbt-property-run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

export async function pbtFinalParity(cargo, options = {}) {
  assertPbtRuntime();
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/pbt-final.json"),
  );
  const built = options.binary ? undefined : buildPbtExample(cargo, reportFile);
  const binary = path.resolve(options.binary ?? built.binary);
  const result = await compiledTraceParity(cargo, "pbt-final", {
    ...options,
    format: "input",
    binary,
    reportFile,
  });
  const diagnosticsFile = `${reportFile}.open-diagnostics.json`;
  execFileSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(here, "pbt-final-diagnostics.mts"),
      "--native-bin",
      binary,
      "--report",
      diagnosticsFile,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const diagnostics = JSON.parse(await readFile(diagnosticsFile, "utf8"));
  assert.equal(diagnostics.status, "OPEN");
  assert.equal(diagnostics.semanticCases, 0);
  assert.equal(diagnostics.observations.length, 4);
  assert.equal(diagnostics.binary.sha256, result.binarySha256);
  for (const row of diagnostics.observations) {
    assert.equal(row.strictlyCompared, false);
    assert.ok(!Object.hasOwn(result.nativeEvidence, row.id));
  }
  return {
    ...result,
    binary,
    cargoArtifacts: built?.artifacts,
    openObservations: diagnostics.observations,
    diagnosticsFile,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { binary: { type: "string" }, report: { type: "string" } },
  });
  const result = await pbtFinalParity(process.env.CARGO ?? "cargo", {
    binary: values.binary,
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      cases: result.cases,
      passed: result.passed,
      failures: result.failures,
      openObservations: result.openObservations.length,
      reportFile: result.reportFile,
    }),
  );
  if (result.failures.length) process.exitCode = 1;
}
