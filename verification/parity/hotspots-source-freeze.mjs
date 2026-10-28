import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hash,
  prepare,
  processEnvironment,
  receiptView,
  snapshot,
} from "./hotspots-fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const node = "/Users/cansirin/.volta/tools/image/node/22.21.1/bin/node";
assert.equal(process.execPath, node);
assert.equal(process.version, "v22.21.1");
const proof = process.argv[2];
assert.ok(proof);
fs.mkdirSync(proof, { recursive: true });
const runtime = path.join(proof, "runtime");
const fixture = prepare(runtime);
fs.writeFileSync(
  path.join(proof, "fixture-setup.json"),
  JSON.stringify(fixture, null, 2) + "\n",
);
const sourceFiles = [
  "packages/code-graph/src/hotspots/churn.ts",
  "packages/code-graph/src/hotspots/render.ts",
  "packages/code-graph/src/extract/project.ts",
  "packages/code-graph/src/extract/assemble.ts",
  "packages/code-graph/src/schema/core.ts",
  "packages/code-graph/src/schema/graph.ts",
  "packages/code-graph/src/render/json.ts",
];
const localFiles = [
  "hotspots-cases.mjs",
  "hotspots-reference.mjs",
  "hotspots-fixtures.mjs",
  "hotspots-git-fixture.py",
  "hotspots-source-freeze.mjs",
];
const pins = () =>
  Object.fromEntries(
    [
      ...sourceFiles.map((p) => [p, path.join(root, p)]),
      ...localFiles.map((p) => [
        "verification/parity/" + p,
        path.join(here, p),
      ]),
    ].map(([name, p]) => [name, hash(fs.readFileSync(p))]),
  );
const before = pins();
fs.writeFileSync(
  path.join(proof, "before-source-freeze.json"),
  JSON.stringify(
    {
      beforeAnyRustProjection: true,
      engine: {
        node: process.version,
        v8: process.versions.v8,
        icu: process.versions.icu,
      },
      files: before,
      inputs: fixture.inputs,
    },
    null,
    2,
  ) + "\n",
);
const rows = [];
for (const input of fixture.inputs) {
  const prefix = path.join(proof, input.id + ".source");
  const receipt = prefix + ".git.jsonl";
  const env = processEnvironment(fixture, input, receipt, "source");
  const result = spawnSync(
    node,
    [
      "--import",
      path.join(here, "node_modules/tsx/dist/loader.mjs"),
      path.join(here, "hotspots-reference.mjs"),
    ],
    {
      cwd: root,
      env,
      input: JSON.stringify(input) + "\n",
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  fs.writeFileSync(prefix + ".stdin", JSON.stringify(input) + "\n");
  fs.writeFileSync(prefix + ".stdout", result.stdout ?? "");
  fs.writeFileSync(prefix + ".stderr", result.stderr ?? "");
  const processes = {
    command: node,
    args: [
      "--import",
      path.join(here, "node_modules/tsx/dist/loader.mjs"),
      path.join(here, "hotspots-reference.mjs"),
    ],
    cwd: root,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdin: prefix + ".stdin",
    stdinSHA: hash(Buffer.from(JSON.stringify(input) + "\n")),
    stdout: prefix + ".stdout",
    stdoutSHA: hash(Buffer.from(result.stdout ?? "")),
    stderr: prefix + ".stderr",
    stderrSHA: hash(Buffer.from(result.stderr ?? "")),
  };
  const git = receiptView(receipt);
  fs.writeFileSync(
    prefix + ".process.json",
    JSON.stringify({ ...processes, controlledGit: git }, null, 2) + "\n",
  );
  assert.equal(result.status, 0, `${input.id}: ${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  const frame = JSON.parse(result.stdout);
  assert.equal(frame.id, input.id);
  assert.equal(frame.ok, true);
  const expectedPhases = input.controlled
    ? input.controlled.bytes > 64 * 1024 * 1024
      ? ["top", "head", "tracked"]
      : input.controlled.fail
        ? ["top", "head", "tracked", "log"].slice(
            0,
            ["top", "head", "tracked", "log"].indexOf(input.controlled.fail) +
              1,
          )
        : ["top", "head", "tracked", "log"]
    : [];
  assert.deepEqual(
    git.attempts.map((r) => r.phase),
    expectedPhases,
    input.id,
  );
  rows.push({
    id: input.id,
    input,
    frame,
    gitAttempts: git.attempts,
    allControlledChildrenExited: git.allExited,
    process: processes,
  });
  fs.writeFileSync(
    path.join(proof, "source-first.partial.json"),
    JSON.stringify({ cases: rows.length, rows, complete: false }, null, 2) +
      "\n",
  );
  console.log(input.id, "PASS");
}
assert.equal(rows.length, 24);
assert.deepEqual(snapshot(fixture.repo), fixture.before);
assert.deepEqual(pins(), before);
const report = {
  cases: 24,
  passed: 24,
  rows,
  fixtureBytesBefore: fixture.before,
  fixtureBytesAfter: snapshot(fixture.repo),
  sourcePins: before,
  SourceFirstBeforeNativeProjection: true,
  DateOwnerCalls: 0,
  CLIExecutions: 0,
  NativeOrCargoExecutions: 0,
  newSharedCredit: 0,
  limits: [
    "Manual parts are separate from canonical Graph.",
    "Git native failure data/OS process metadata are not fabricated Source errors.",
    "Date and CLI remain open.",
  ],
};
fs.writeFileSync(
  path.join(proof, "source-first.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({ cases: 24, SourceOnly: true, newSharedCredit: 0 }),
);
