import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedSpawnSync as spawnSync } from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

export function buildTeaLibrary() {
  const buildCommand = [
    "build",
    "--locked",
    "-p",
    "demlik-tea",
    "--lib",
    "--message-format=json",
  ];
  const built = spawnSync(process.env.CARGO ?? "cargo", buildCommand, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (built.error) throw built.error;
  assert.equal(built.status, 0, built.stderr);
  const artifacts = built.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const libraries = artifacts
    .filter(
      (item) =>
        item.reason === "compiler-artifact" &&
        item.target.name === "demlik_tea" &&
        item.target.kind.includes("lib"),
    )
    .flatMap((item) => item.filenames.filter((file) => file.endsWith(".rlib")));
  assert.equal(
    libraries.length,
    1,
    "Cargo must identify the actual tested library",
  );
  const library = libraries[0];
  return {
    library,
    dependencyDirectory: path.join(path.dirname(library), "deps"),
    buildCommand,
    compiler: process.env.RUSTC ?? "rustc",
  };
}
