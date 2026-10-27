import assert from "node:assert/strict";
import path from "node:path";
import { reportsMutations } from "./cli-reports-mutations.mjs";

const [cliBinary, tailReport, cliReport, evidence, sourceArchive] =
  process.argv.slice(2);
assert.ok(
  cliBinary &&
    tailReport &&
    cliReport &&
    evidence &&
    sourceArchive &&
    process.argv.length === 7,
);
const result = reportsMutations({
  cliBinary,
  tailReport,
  cliReport,
  evidence: path.resolve(evidence),
  sourceArchive,
});
console.log(
  JSON.stringify({
    detected: result.controls.length,
    complete: result.complete,
    removed: result.worktreeRemoved,
  }),
);
