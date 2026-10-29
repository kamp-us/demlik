import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectToolPolicyComparison } from "./defined-agent-tool-policy-parity.mjs";

const evidence = path.resolve(process.argv[2]);
const selected = path.join(evidence, "selected/policy");
const report = JSON.parse(fs.readFileSync(path.join(selected, "report.json")));
const rows = (name) =>
  fs
    .readFileSync(path.join(selected, `${name}.stdout`), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const artifacts = [
  report.producer.binary,
  report.producer.actualArtifact,
  ...Object.values(report.producer.libraries).flatMap((library) => [
    library.path,
    library.retainedPath,
  ]),
];
const before = Object.fromEntries(artifacts.map((file) => [file, hash(file)]));
assert.equal(before[report.producer.binary], report.producer.binarySha256);
assert.equal(
  before[report.producer.actualArtifact],
  report.producer.binarySha256,
);
for (const library of Object.values(report.producer.libraries)) {
  assert.equal(before[library.path], library.sha256);
  assert.equal(before[library.retainedPath], library.retainedSha256);
}
const frozen = path.join(
  evidence,
  "frozen/resume-hook-extension/tool-policy-source-resume.jsonl",
);
assert.equal(hash(frozen), hash(path.join(selected, "source.stdout")));
const manifestBefore = hash(path.join(evidence, "manifest.json"));
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
let wires = 0;
const changes = [];
let sample;
function check(sourceWire, nativeWire, label) {
  const source = freeze(JSON.parse(sourceWire)),
    native = freeze(JSON.parse(nativeWire));
  const sourceBefore = JSON.stringify(source);
  assert.equal(
    sourceBefore,
    sourceWire,
    `${label}: retained Source is canonical`,
  );
  const projected = projectToolPolicyComparison(source, native, label, changes);
  assert.equal(
    JSON.stringify(source),
    sourceBefore,
    `${label}: projection does not mutate Source`,
  );
  assert.equal(
    nativeWire,
    JSON.stringify(projected),
    `${label}: exact Source wire order and format after numeric projection`,
  );
  sample ??= { sourceWire, nativeWire };
  wires++;
}
const source = rows("source"),
  native = rows("native");
assert.equal(native.length, source.length);
source.forEach((row, i) => {
  assert.equal(native[i].id, row.id);
  row.phases.forEach((phase, j) => {
    const candidate = native[i].phases[j];
    assert.equal(candidate.saveWires.length, phase.saveWires.length);
    phase.saveWires.forEach((wire, k) => {
      check(
        wire,
        candidate.saveWires[k],
        `${row.id}.phases[${j}].saveWires[${k}]`,
      );
    });
    check(
      phase.finalWire,
      candidate.finalWire,
      `${row.id}.phases[${j}].finalWire`,
    );
  });
});
assert.equal(wires, 149);
assert.equal(changes.length, 470);
const parsed = JSON.parse(sample.nativeWire);
const controls = [
  {
    id: "reordered",
    wire: JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse())),
  },
  { id: "whitespace", wire: JSON.stringify(parsed, null, 2) },
];
for (const control of controls) {
  const changes = [];
  // Parsed value comparison admits both controls, just as the old adapter did.
  const projected = projectToolPolicyComparison(
    JSON.parse(sample.sourceWire),
    JSON.parse(control.wire),
    control.id,
    changes,
  );
  assert.deepEqual(JSON.parse(control.wire), JSON.parse(sample.nativeWire));
  assert.throws(
    () => assert.equal(control.wire, JSON.stringify(projected)),
    assert.AssertionError,
  );
}
const after = Object.fromEntries(artifacts.map((file) => [file, hash(file)]));
assert.deepEqual(after, before);
assert.equal(hash(path.join(evidence, "manifest.json")), manifestBefore);
console.log(
  JSON.stringify({
    status: "passed",
    rows: source.length,
    wires,
    numericWireLeafDifferences: changes.length,
    controls: controls.map((c) => ({
      id: c.id,
      oldParsedComparisonAdmits: true,
      wireGuardRejects: true,
    })),
    artifacts: artifacts.map((file) => ({
      path: file,
      beforeSha256: before[file],
      afterSha256: after[file],
    })),
    frozenSourceSha256: hash(frozen),
    originalManifestSha256: manifestBefore,
    additionalSourceCases: 0,
    additionalCompiledFaultCredit: 0,
  }),
);
