import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compiledTraceParity } from "./compiled-traces.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);

export async function pbtConstructorsCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ??
      path.join(root, "target/parity/pbt-constructors.json"),
  );
  const built = options.binary
    ? undefined
    : buildTeaExample(cargo, "pbt_constructors_driver", reportFile, ["pbt"]);
  const binary = path.resolve(options.binary ?? built.binary);
  const result = await compiledTraceParity(cargo, "pbt-constructors", {
    ...options,
    format: "input",
    binary,
    reportFile,
  });
  const nativeReportFile = `${reportFile}.native-laws.json`;
  execFileSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(root, "verification/parity/pbt-constructors.mts"),
      "--native-bin",
      binary,
      "--native-only",
      "--report",
      nativeReportFile,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const native = JSON.parse(await readFile(nativeReportFile, "utf8"));
  assert.equal(native.nativeCases, 3);
  assert.equal(native.passed, 3);
  assert.equal(native.semanticPairs, 0);
  assert.deepEqual(native.failures, []);
  assert.equal(native.binary.sha256, result.binarySha256);
  return { ...result, cargoArtifacts: built, nativeLaws: 3, nativeReportFile };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { binary: { type: "string" }, report: { type: "string" } },
  });
  const result = await pbtConstructorsCheckpointParity(
    process.env.CARGO ?? "cargo",
    { binary: values.binary, reportFile: values.report },
  );
  console.log(
    JSON.stringify({
      cases: result.cases,
      passed: result.passed,
      failures: result.failures,
      nativeLaws: result.nativeLaws,
    }),
  );
  if (result.failures.length) process.exitCode = 1;
}
