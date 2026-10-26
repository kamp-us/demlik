import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pbtFinalMutations } from "./pbt-final-mutations.mjs";
import { pbtFinalParity } from "./pbt-final-run.mjs";
import { pbtFinalTypeProbes } from "./pbt-final-type-probes.mjs";
import { pbtPropertyChecks } from "./pbt-property-checks-run.mjs";

const cargo = process.env.CARGO ?? "cargo";
const baseline = await pbtFinalParity(cargo, {
  reportFile: "target/parity/pbt-final-control-baseline.json",
});
assert.equal(baseline.cases, 108);
assert.deepEqual(baseline.failures, []);
const libraries = baseline.cargoArtifacts.libraries;
const types = pbtFinalTypeProbes({
  rlib: libraries.demlik_tea.path,
  proptestRlib: libraries.proptest.path,
});
assert.equal(types.results.length, 4);
for (const result of types.results) {
  assert.equal(result.exit === 0, result.ok);
  if (!result.ok) assert.ok(result.stderr.includes(result.code));
}
const legacy = await pbtPropertyChecks(cargo, {
  binary: baseline.binary,
  cargoArtifacts: baseline.cargoArtifacts.file,
  reportFile: "target/parity/pbt-final-existing-checks.json",
});
const controls = pbtFinalMutations({ binary: baseline.binary });
assert.equal(controls.controls.length, 7);
for (const control of controls.controls) {
  assert.equal(control.compiled, true);
  assert.equal(control.build.exit, 0);
  assert.ok(control.detectedIds.includes(control.witness));
  assert.ok(
    [1, 101].includes((control.result.command ?? control.result.run).exit),
  );
}
assert.equal(legacy.controlsFreshlyExecuted, true);
assert.equal(legacy.controls.length, 9);
await writeFile(
  "target/parity/pbt-final-checks.json",
  `${JSON.stringify({ status: "passed", semanticCases: 0, newTypes: types, legacy, newControls: controls, newDetected: 7, existingDetected: 9, escaped: 0 }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    newTypes: 4,
    existingTypes: 4,
    newFaults: 7,
    existingFaults: 9,
  }),
);
