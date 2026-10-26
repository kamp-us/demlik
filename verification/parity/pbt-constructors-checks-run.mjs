import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pbtConstructorMutations } from "./pbt-constructors-mutations.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const built = buildTeaExample(
  process.env.CARGO ?? "cargo",
  "pbt_constructors_driver",
  path.join(root, "target/parity/pbt-constructors-baselines/driver"),
  ["pbt"],
);
process.chdir(root);
const report = pbtConstructorMutations({
  binary: built.binary,
  warmTarget: process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
  reportFile: path.join(root, "target/parity/pbt-constructors-controls.json"),
});
assert.equal(report.controls.length, 3);
assert.equal(report.activeSourceUnchanged, true);
console.log(
  JSON.stringify({
    detected: report.controls.length,
    activeSourceUnchanged: report.activeSourceUnchanged,
  }),
);
