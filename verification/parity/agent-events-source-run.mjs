import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentEventCases, authoringGate } from "./agent-events-cases.mjs";

const proof = path.resolve(process.argv[2]);
assert.equal(process.versions.node, "22.21.1");
const fixture = fileURLToPath(
  new URL("./agent-events-reference.mts", import.meta.url),
);
const tsx = fileURLToPath(
  new URL("./node_modules/tsx/dist/loader.mjs", import.meta.url),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [
  fixture,
  fileURLToPath(new URL("./agent-events-cases.mjs", import.meta.url)),
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("./tsconfig.agent-events.json", import.meta.url)),
];
fs.mkdirSync(proof, { recursive: true });
const freeze = path.join(proof, "before-source-execution");
assert.ok(!fs.existsSync(freeze), "preserve every previous Source freeze");
fs.mkdirSync(freeze);
const sourcePins = files.map((file) => {
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(path.join(freeze, path.basename(file)), bytes);
  return { path: file, sha256: digest(bytes) };
});
fs.writeFileSync(
  path.join(freeze, "inputs.json"),
  `${JSON.stringify(agentEventCases, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(freeze, "authoring-gate.json"),
  `${JSON.stringify(authoringGate, null, 2)}\n`,
);
const processes = [];
const rows = [];
for (const input of agentEventCases) {
  const own = path.join(proof, "processes", input.id);
  fs.mkdirSync(own, { recursive: true });
  const args = [
    "--import",
    tsx,
    fixture,
    JSON.stringify(input),
    path.join(own, "invoice"),
  ];
  const env = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
  };
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    delete env[key];
  fs.writeFileSync(
    path.join(own, "request.json"),
    `${JSON.stringify({ input, executable: process.execPath, args }, null, 2)}\n`,
  );
  const run = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(own, "stdout"), run.stdout ?? "");
  fs.writeFileSync(path.join(own, "stderr"), run.stderr ?? "");
  const actual = {
    id: input.id,
    status: run.status,
    signal: run.signal,
    error: run.error ? String(run.error) : null,
    stdoutSha256: digest(run.stdout ?? ""),
    stderrSha256: digest(run.stderr ?? ""),
  };
  fs.writeFileSync(
    path.join(own, "process.json"),
    `${JSON.stringify(actual, null, 2)}\n`,
  );
  processes.push(actual);
  if (run.status === 0 && run.stderr === "") {
    const response = JSON.parse(run.stdout);
    assert.deepEqual(response.input, input);
    rows.push(response);
  }
}
const report = {
  sourceOnly: true,
  NativeExecutions: 0,
  Cargo: 0,
  sharedCredit: 0,
  sourcePins,
  engine: process.versions,
  logicalInputs: agentEventCases.length,
  validRows: rows.length,
  processes,
  rows,
};
fs.writeFileSync(
  path.join(proof, "source-first.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    logicalInputs: report.logicalInputs,
    validRows: report.validRows,
    failed: processes.filter((p) => p.status !== 0),
    sourceOnly: true,
    sharedCredit: 0,
  }),
);
if (rows.length !== agentEventCases.length) process.exitCode = 1;
