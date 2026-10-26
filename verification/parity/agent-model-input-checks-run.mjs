import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentModelInputMutations } from "./agent-model-input-mutations.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = path.join(root, "target/parity/model-input-baselines");
fs.mkdirSync(directory, { recursive: true });
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const artifacts = {};
for (const entry of [
  {
    id: "driver",
    name: "agent_model_driver",
    args: ["build", "--example", "agent_model_driver"],
  },
  {
    id: "owner",
    name: "agent_model_input",
    args: ["test", "--no-run", "--test", "agent_model_input"],
  },
]) {
  const cargo = process.env.CARGO ?? "cargo";
  const args = [
    ...entry.args,
    "--locked",
    "--offline",
    "--message-format=json",
    "-p",
    "demlik-tea",
  ];
  const build = spawnSync(cargo, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  fs.writeFileSync(
    path.join(directory, `${entry.id}.cargo.jsonl`),
    build.stdout,
  );
  fs.writeFileSync(
    path.join(directory, `${entry.id}.cargo.stderr`),
    build.stderr,
  );
  assert.equal(build.status, 0, build.stderr);
  const messages = build.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const selected = messages.filter(
    (message) =>
      message.reason === "compiler-artifact" &&
      message.target.name === entry.name &&
      message.executable,
  );
  assert.equal(selected.length, 1);
  const actual = selected[0].executable;
  const binary = path.join(directory, `${entry.id}-${hash(actual)}.bin`);
  fs.copyFileSync(actual, binary);
  const libraries = messages
    .filter(
      (message) =>
        message.reason === "compiler-artifact" &&
        message.target.name === "demlik_tea",
    )
    .flatMap((message) =>
      message.filenames
        .filter((file) => file.endsWith(".rlib"))
        .map((file) => ({
          path: file,
          sha256: hash(file),
          features: message.features,
        })),
    );
  assert.equal(libraries.length, 1);
  artifacts[entry.id] = {
    binary,
    actualArtifact: actual,
    binarySha256: hash(binary),
    libraries,
    command: [cargo, ...args],
  };
}
fs.writeFileSync(
  path.join(directory, "artifacts.json"),
  `${JSON.stringify(artifacts, null, 2)}\n`,
);
const positive = spawnSync(artifacts.owner.binary, [], {
  cwd: root,
  encoding: "utf8",
});
fs.writeFileSync(
  path.join(directory, "owner.run.log"),
  positive.stdout + positive.stderr,
);
assert.equal(positive.status, 0, positive.stdout + positive.stderr);
const report = await agentModelInputMutations({
  binary: artifacts.driver.binary,
  ownerBinary: artifacts.owner.binary,
});
assert.equal(report.detected, 3);
assert.equal(report.escaped, 0);
console.log(
  JSON.stringify({
    detected: report.detected,
    sourceNativeControls: report.sourceNativeControls,
    nativeOwnerControls: report.nativeOwnerControls,
  }),
);
