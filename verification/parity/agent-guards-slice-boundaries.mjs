import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentGuardsCases } from "./agent-guards-cases.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url);
assert.equal(process.version, "v22.21.1");
const binary = path.join(
  process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
  "debug/examples/agent_guards_driver",
);
const base = agentGuardsCases().find(
  (test) => test.id === "agent-guards.fold-two",
);
const values = [
  -0.999,
  -0.5,
  -Number.MIN_VALUE,
  { $value: "-0" },
  0,
  { $value: "NaN" },
  { $value: "Infinity" },
  { $value: "-Infinity" },
  -1.5,
  1.5,
  3,
  1e300,
];
const cases = values.map((folding, index) => ({
  ...base,
  id: `agent-slice-boundary.${index}`,
  input: { ...base.input, folding },
}));
const input = `${cases.map((test) => JSON.stringify(test)).join("\n")}\n`;
function run(program, args) {
  const result = spawnSync(program, args, {
    cwd: root,
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
const source = run(process.execPath, [
    "--import",
    require.resolve("tsx"),
    path.join(root, "verification/parity/agent-guards-reference.mts"),
  ]),
  native = run(binary, []);
assert.equal(source.length, cases.length);
assert.equal(native.length, cases.length);
const results = cases.map((test, index) => {
  assert.equal(source[index].id, test.id);
  assert.equal(native[index].id, test.id);
  assert.equal(source[index].ok, true);
  assert.equal(native[index].ok, true);
  assert.deepEqual(native[index].observedCalls, [
    "demlik_tea::agent::conversation::fold_summary",
  ]);
  assert.deepEqual(native[index].output, source[index].output);
  if (index < 5)
    assert.deepEqual(source[index].output.turnIndices, [-1, 0, 1, 2]);
  return {
    id: test.id,
    folding: test.input.folding,
    turnIndices: source[index].output.turnIndices,
    source: source[index].output,
    native: native[index].output,
  };
});
const report = {
  node: process.version,
  v8: process.versions.v8,
  scope:
    "Focused public fold probe of the canonical slice-start repair; actual frozen Source foldSummary uses Array.slice. These 12 edge probes are separate from the158-case central corpus and have no inventory evidence aliases.",
  passed: results.length,
  results,
  binarySha256: createHash("sha256")
    .update(fs.readFileSync(binary))
    .digest("hex"),
};
fs.writeFileSync(
  path.join(root, "target/parity/agent-guards-slice-boundaries.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify({ passed: report.passed, scope: report.scope }));
