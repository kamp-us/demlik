import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTeaLibrary } from "./tea-library.mjs";
import { testingHelpersParity } from "./testing-helpers-run.mjs";
import { testingHelperTypeProbes } from "./testing-helpers-type-probes.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const typesOnly = process.argv.includes("--types-only");
assert.equal(process.argv.length, typesOnly ? 3 : 2);
const built = buildTeaLibrary();
const types = testingHelperTypeProbes({
  rlib: built.library,
  dependencyDirectory: built.dependencyDirectory,
  reportFile: path.join(root, "target/parity/testing-helpers-type-probes.json"),
});
console.log(
  JSON.stringify({ positive: types.positive, negative: types.negative }),
);
if (!typesOnly) {
  const baseline = await testingHelpersParity(process.env.CARGO ?? "cargo");
  assert.deepEqual(baseline.failures, []);
  execFileSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(root, "verification/parity/testing-helpers-mutations.mjs"),
      "--native-bin",
      path.join(
        process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
        "debug/examples/testing_helpers_driver",
      ),
    ],
    { cwd: root, stdio: "inherit" },
  );
}
