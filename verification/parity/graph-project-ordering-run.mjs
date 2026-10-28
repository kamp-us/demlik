import assert from "node:assert/strict";
import { projectOrderingCheckpointParity } from "./project-ordering-parity.mjs";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile && process.argv.length === 4);
const report = projectOrderingCheckpointParity(process.env.CARGO ?? "cargo", {
  binary,
  reportFile,
});
console.log(
  JSON.stringify({ passed: report.passed, failures: report.failures.length }),
);
