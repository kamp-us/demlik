import assert from "node:assert/strict";
import { hotspotsCheckpointParity } from "./hotspots-parity.mjs";

const [binary, reportFile] = process.argv.slice(2);
assert.ok(binary && reportFile && process.argv.length === 4);
const report = hotspotsCheckpointParity(process.env.CARGO ?? "cargo", {
  binary,
  reportFile,
});
console.log(
  JSON.stringify({
    cases: report.cases.length,
    passed: report.passed,
    failures: report.failures.length,
  }),
);
