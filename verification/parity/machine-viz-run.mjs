import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourcePins = {
  "packages/tea/src/machine-viz/index.ts":
    "686677bfee4f86a53ea91fd60e158d97df89dae1e58f5fb3719c4ed3de23f69f",
  "packages/tea/src/machine-viz/mermaid-id.ts":
    "b53c47128659ca41d2ab781164f2e46d16f0d074e530ecd42cc45cba6f8fdd38",
  "packages/tea/src/pure/core.ts":
    "b11c54a5fe51fb6b9a33f575878cf6e04a506edcf7ef455297731dbb6500bf17",
  "verification/parity/machine-viz-cases.json.fixture":
    "c870c08352593247dfab00c53651ff03ca1ebb870af1612d6142d7c4607fd345",
};
const qualifiedIds = new Set([
  "machine-viz.caught-cell-failure",
  "machine-viz.init-failure",
]);

export function assertMachineVizFrame(row, actual) {
  if (actual.error) throw actual.error;
  assert.equal(actual.status, 0, actual.stderr);
  // JSON permits raw NEL/LS/PS inside strings; split only by the protocol newline.
  assert.equal(actual.stdout.trimEnd().split("\n").length, 1);
  const frame = JSON.parse(actual.stdout);
  assert.deepEqual(Object.keys(frame).sort(), ["comparison", "id"]);
  assert.equal(frame.id, row.id);
  assert.deepEqual(
    frame.comparison,
    row.comparison,
    "whole diagram and callback order",
  );
  if (qualifiedIds.has(row.id)) {
    const message =
      row.id === "machine-viz.init-failure" ? "init refused" : "cell refused";
    assert.match(
      actual.stderr,
      new RegExp(
        `^\\nthread 'main' \\(\\d+\\) panicked at crates/tea/examples/machine_viz_driver\\.rs:\\d+:\\d+:\\n${message}\\nnote: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace\\n$`,
      ),
    );
  } else assert.equal(actual.stderr, "", "unexpected native diagnostics");
  return frame;
}

export function machineVizParity({ binary, reportFile }) {
  reportFile = path.resolve(reportFile);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const before = hash(fs.readFileSync(binary));
  for (const [name, expected] of Object.entries(sourcePins))
    assert.equal(
      hash(fs.readFileSync(path.join(root, name))),
      expected,
      `Source pin: ${name}`,
    );
  const sourceFile = `${reportFile}.source.json`;
  const source = spawnSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(root, "verification/parity/machine-viz-source.mjs"),
      sourceFile,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 8 << 20 },
  );
  fs.writeFileSync(`${reportFile}.source.stdout`, source.stdout ?? "");
  fs.writeFileSync(`${reportFile}.source.stderr`, source.stderr ?? "");
  if (source.error) throw source.error;
  assert.equal(source.status, 0, source.stderr);
  assert.equal(
    hash(fs.readFileSync(sourceFile)),
    "299d5b405816d6b53d65af017e5a16774bff5823ec3c61b8933fc2b0148d6ba1",
    "Source-first whole views changed",
  );
  const reference = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  assert.equal(reference.node, "v22.21.1");
  assert.equal(reference.v8, "12.4.254.21-node.33");
  assert.equal(reference.cases.length, 18);
  const observations = [];
  for (const row of reference.cases) {
    const actual = spawnSync(binary, [], {
      cwd: root,
      input: `${JSON.stringify(row.input)}\n`,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 << 20,
    });
    fs.writeFileSync(`${reportFile}.${row.id}.stdout`, actual.stdout ?? "");
    fs.writeFileSync(`${reportFile}.${row.id}.stderr`, actual.stderr ?? "");
    let failure;
    let frame;
    try {
      frame = assertMachineVizFrame(row, actual);
    } catch (error) {
      failure = String(error);
    }
    observations.push({
      id: row.id,
      qualified: qualifiedIds.has(row.id),
      equal: failure === undefined,
      ...(failure === undefined ? {} : { failure }),
      source: row.comparison,
      native: frame,
      nativeStderr: actual.stderr,
    });
  }
  assert.equal(
    hash(fs.readFileSync(binary)),
    before,
    "selected binary changed during comparison",
  );
  const failures = observations
    .filter((row) => !row.equal)
    .map(({ id, failure }) => ({ id, failure }));
  const report = {
    cases: 18,
    observations,
    passed: observations.filter((row) => row.equal && !row.qualified).length,
    qualifiedEvidenceCases: observations.filter(
      (row) => row.equal && row.qualified,
    ).length,
    failures,
    binarySha256: before,
    sourcePins,
    nativeEvidence: Object.fromEntries(
      observations
        .filter((row) => row.equal && !row.qualified)
        .map((row) => [
          row.id,
          {
            source:
              row.id === "machine-viz.sanitizers"
                ? ["safeId", "safeLabel"]
                : ["toMermaid"],
            rust:
              row.id === "machine-viz.sanitizers"
                ? [
                    "demlik_tea::machine_viz::safe_id",
                    "demlik_tea::machine_viz::safe_label",
                  ]
                : ["demlik_tea::machine_viz::to_mermaid"],
            binarySha256: before,
          },
        ]),
    ),
    qualifiedNativeEvidence: Object.fromEntries(
      observations
        .filter((row) => row.equal && row.qualified)
        .map((row) => [
          row.id,
          {
            qualification:
              "Native panic hook diagnostics differ from JavaScript throw/catch. Whole diagram/error and callback order remain exact.",
            fields: ["nativeStderr"],
            binarySha256: before,
          },
        ]),
    ),
    openGaps: [
      "Arbitrary JS getters/prototypes/invalid object shapes and raw non-scalar table/tag names remain unproved.",
      "Opaque projection closures do not expose a declared-empty table; only SubscriptionEntries owns this metadata.",
      "Native panic hooks are not the JavaScript error/throw channel.",
      "This module renders text; browser Mermaid rendering and other UI adapters remain unimplemented.",
    ],
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function machineVizCheckpointParity(cargo, options = {}) {
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/machine-viz.json"),
  );
  const producer = options.binary
    ? null
    : buildTeaExample(cargo, "machine_viz_driver", reportFile);
  const report = {
    ...machineVizParity({
      binary: options.binary ?? producer.binary,
      reportFile,
    }),
    producer,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [binary, reportFile] = process.argv.slice(2);
  assert.ok(binary && reportFile && process.argv.length === 4);
  const report = machineVizParity({ binary, reportFile });
  console.log(
    JSON.stringify({
      cases: report.cases,
      strict: report.passed,
      qualified: report.qualifiedEvidenceCases,
      failures: report.failures,
    }),
  );
  if (report.failures.length > 0) process.exitCode = 1;
}
