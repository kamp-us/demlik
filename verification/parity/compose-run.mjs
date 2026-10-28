import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compiledTraceParity } from "./compiled-traces.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
export async function composeCheckpointParity(cargo, options = {}) {
  const result = await compiledTraceParity(cargo, "compose", {
    ...options,
    format: "input",
    example: { package: "demlik-tea", name: "compose_driver" },
  });
  return {
    ...result,
    binary: path.resolve(result.binary),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { binary: { type: "string" }, report: { type: "string" } },
  });
  const result = await composeCheckpointParity(process.env.CARGO ?? "cargo", {
    binary: values.binary,
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      cases: result.cases,
      passed: result.passed,
      failures: result.failures,
    }),
  );
  if (result.failures.length) process.exitCode = 1;
}
