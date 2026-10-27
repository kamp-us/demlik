import { fileURLToPath } from "node:url";
import { agentSnapshotGridParity } from "./agent-snapshot-grid-run.mjs";

export function agentSnapshotMessagesParity(options = {}) {
  return agentSnapshotGridParity({ ...options, messages: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    get = (key) => {
      const index = args.indexOf(key);
      return index < 0 ? undefined : args[index + 1];
    };
  const report = agentSnapshotMessagesParity({
    binary: get("--binary"),
    output: get("--output"),
    only: get("--only"),
    sourceOnly: args.includes("--source-only"),
    allowFailures: args.includes("--allow-failures"),
  });
  console.log(
    JSON.stringify({
      cases: report.cases,
      qualifiedPassed: report.qualifiedPassed,
      strictTypedParityCredit: 0,
      openCases: report.openCases,
      comparisonFailures: report.failures.length,
      literalFailures: report.literalFailures.length,
    }),
  );
}
