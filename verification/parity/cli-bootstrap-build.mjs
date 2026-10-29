import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../..", import.meta.url));
const [directory, label = "native", cargo = "cargo"] = process.argv.slice(2);
const evidence = path.resolve(directory);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const key of [
  "CARGO_TARGET_DIR",
  "DEMLIK_MUTATION_TARGET_DIR",
  "CARGO_BUILD_TARGET_DIR",
  "CARGO_BUILD_BUILD_DIR",
])
  assert.equal(process.env[key], undefined);
const args = [
  "build",
  "--locked",
  "--offline",
  "-p",
  "demlik-code-graph",
  "--bin",
  "code-graph",
  "--message-format=json",
];
const result = spawnSync(cargo, args, {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(
  path.join(evidence, `${label}.cargo.jsonl`),
  result.stdout ?? "",
);
fs.writeFileSync(
  path.join(evidence, `${label}.cargo.stderr`),
  result.stderr ?? "",
);
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr);
const events = result.stdout
  .trim()
  .split("\n")
  .map(JSON.parse)
  .filter((row) => row.reason === "compiler-artifact");
const manifest = path.join(root, "crates/code-graph/Cargo.toml");
const select = (name, kind) => {
  const rows = events.filter(
    (row) =>
      row.manifest_path === manifest &&
      row.target.name === name &&
      row.target.kind.includes(kind),
  );
  assert.equal(rows.length, 1);
  return rows[0];
};
const binary = select("code-graph", "bin");
const library = select("demlik_code_graph", "lib");
const artifacts = [];
for (const [event, file, compressed] of [
  [binary, binary.executable, false],
  [library, library.filenames.find((file) => file.endsWith(".rlib")), true],
]) {
  assert.ok(
    fs
      .realpathSync(file)
      .startsWith(fs.realpathSync(path.join(root, "target")) + path.sep),
  );
  const bytes = fs.readFileSync(file);
  const retained = path.join(
    evidence,
    `${label}-${hash(bytes)}-${path.basename(file)}${compressed ? ".gz" : ""}`,
  );
  const output = compressed ? gzipSync(bytes) : bytes;
  fs.writeFileSync(retained, output, { mode: compressed ? 0o644 : 0o755 });
  artifacts.push({
    event,
    actual: file,
    retained,
    sha256: hash(bytes),
    retainedSha256: hash(output),
    encoding: compressed ? "gzip" : "raw",
    target: "aarch64-apple-darwin",
    profile: event.profile,
  });
}
const sources = Object.fromEntries(
  [
    "crates/code-graph/src/bin/code-graph.rs",
    "crates/code-graph/src/engine/tsgo/mod.rs",
    "crates/code-graph/src/cli.rs",
    "crates/code-graph/src/cli/terminal.rs",
    "crates/code-graph/src/cli/frontdoor.rs",
    "crates/code-graph/Cargo.toml",
    "Cargo.lock",
  ].map((file) => [file, hash(fs.readFileSync(path.join(root, file)))]),
);
fs.writeFileSync(
  path.join(evidence, `${label}.artifacts.json`),
  `${JSON.stringify(
    { root, command: [cargo, ...args], artifacts, sources },
    null,
    2,
  )}\n`,
);
console.log(artifacts[0].retained);
