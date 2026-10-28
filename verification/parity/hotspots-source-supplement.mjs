import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hash, processEnvironment, receiptView } from "./hotspots-fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, "../..");
const node = "/Users/cansirin/.volta/tools/image/node/22.21.1/bin/node";
assert.equal(process.execPath, node);
const proof = process.argv[2],
  first = JSON.parse(
    fs.readFileSync(path.join(proof, "source-first/source-first.json"), "utf8"),
  ),
  fixture = JSON.parse(
    fs.readFileSync(
      path.join(proof, "source-first/fixture-setup.json"),
      "utf8",
    ),
  );
const base = first.rows.find((r) => r.id === "git-duplicates-raw-paths").input;
const inputs = ["text", "invalid"].map((stderr) => ({
  ...base,
  id: `git-stderr-${stderr}`,
  controlled: { fail: null, stderr },
}));
const files = [
  "hotspots-reference.mjs",
  "hotspots-fixtures.mjs",
  "hotspots-git-fixture.py",
  "hotspots-source-supplement.mjs",
];
const pins = Object.fromEntries(
  files.map((f) => [f, hash(fs.readFileSync(path.join(here, f)))]),
);
fs.writeFileSync(
  path.join(proof, "supplement-before.json"),
  JSON.stringify(
    {
      beforeAnyNativeProjection: true,
      original24ReportSHA: hash(
        fs.readFileSync(path.join(proof, "source-first/source-first.json")),
      ),
      files: pins,
      inputs,
    },
    null,
    2,
  ) + "\n",
);
const rows = [];
for (const input of inputs) {
  const prefix = path.join(proof, input.id + ".source"),
    receipt = prefix + ".git.jsonl";
  const env = processEnvironment(fixture, input, receipt, "source");
  const args = [
    "--import",
    path.join(here, "node_modules/tsx/dist/loader.mjs"),
    path.join(here, "hotspots-reference.mjs"),
  ];
  const result = spawnSync(node, args, {
    cwd: root,
    env,
    input: JSON.stringify(input) + "\n",
    encoding: "utf8",
    timeout: 30000,
  });
  fs.writeFileSync(prefix + ".stdin", JSON.stringify(input) + "\n");
  fs.writeFileSync(prefix + ".request.json", JSON.stringify(input) + "\n");
  fs.writeFileSync(prefix + ".stdout", result.stdout ?? "");
  fs.writeFileSync(prefix + ".stderr", result.stderr ?? "");
  const git = receiptView(receipt);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  const frame = JSON.parse(result.stdout);
  assert.notEqual(frame.output.loaded, null);
  assert.deepEqual(
    frame.output,
    first.rows.find((r) => r.id === "git-duplicates-raw-paths").frame.output,
  );
  const expected = git.records
    .filter((r) => r.event === "stderr")
    .map((r) => Buffer.from(r.hex, "hex").toString("utf8"))
    .join("");
  assert.equal(result.stderr, expected);
  assert.equal(git.records.filter((r) => r.event === "stderr").length, 4);
  rows.push({
    id: input.id,
    input,
    frame,
    gitAttempts: git.attempts,
    allControlledChildrenExited: git.allExited,
    sourceStderrUTF8: result.stderr,
    sourceStderrHex: Buffer.from(result.stderr).toString("hex"),
    process: {
      command: node,
      args,
      status: result.status,
      signal: result.signal,
      stdout: prefix + ".stdout",
      stdoutSHA: hash(Buffer.from(result.stdout)),
      stderr: prefix + ".stderr",
      stderrSHA: hash(Buffer.from(result.stderr)),
    },
    git,
  });
}
fs.writeFileSync(
  path.join(proof, "source-supplement2.json"),
  JSON.stringify(
    {
      SourceOnly: true,
      cases: 2,
      rows,
      sourcePins: pins,
      beforeAnyNativeProjection: true,
      original24Unchanged: true,
      newSharedCredit: 0,
      reason:
        "Node22 execFileSync forwards decoded stderr before checking success/error; raw Git bytes remain separate.",
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ cases: 2, SourceOnly: true, newSharedCredit: 0 }));
