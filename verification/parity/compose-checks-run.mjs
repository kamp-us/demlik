import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeInterfaceProbes } from "./compose-interface-probes.mjs";
import { composeMutations } from "./compose-mutations.mjs";
import { composeCheckpointParity } from "./compose-run.mjs";
import { buildTeaLibrary } from "./tea-library.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
process.chdir(root);
const baseline = await composeCheckpointParity(process.env.CARGO ?? "cargo");
assert.equal(baseline.cases, 119);
assert.deepEqual(baseline.failures, []);
const built = buildTeaLibrary();
const sha = createHash("sha256")
  .update(readFileSync(built.library))
  .digest("hex");
const pinned = path.join(
  root,
  "target/parity",
  `libdemlik_tea-compose-types-${sha}.rlib`,
);
mkdirSync(path.dirname(pinned), { recursive: true });
copyFileSync(built.library, pinned);
const types = composeInterfaceProbes({
  rlib: pinned,
  dependencies: built.dependencyDirectory,
  reportFile: "target/parity/compose-parent-type-probes.json",
});
assert.equal(types.results.length, 8);
assert.deepEqual(types.failures, []);
const controls = composeMutations({
  binary: baseline.binary,
  reportFile: "target/parity/compose-parent-controls.json",
});
assert.equal(controls.controls.length, 8);
for (const control of controls.controls) {
  assert.equal(control.build.exit, 0);
  assert.equal(control.result.run.exit, 1);
  assert.ok(control.detectedIds.includes(control.witness));
}
