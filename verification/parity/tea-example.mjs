import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

export function buildTeaExample(cargo, example, reportFile, features = []) {
  return buildTeaArtifact(cargo, "example", example, reportFile, features);
}

export function buildTeaTest(cargo, test, reportFile) {
  return buildTeaArtifact(cargo, "test", test, reportFile, []);
}

function buildTeaArtifact(cargo, kind, example, reportFile, features) {
  const args = [
    kind === "test" ? "test" : "build",
    "--locked",
    "--offline",
    "-p",
    "demlik-tea",
    `--${kind}`,
    example,
    "--message-format=json",
    ...(kind === "test" ? ["--no-run"] : []),
    ...(features.length ? ["--features", features.join(",")] : []),
  ];
  const result = spawnSync(cargo, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  mkdirSync(path.dirname(reportFile), { recursive: true });
  const cargoJson = `${reportFile}.cargo.jsonl`;
  writeFileSync(cargoJson, result.stdout ?? "");
  writeFileSync(`${reportFile}.cargo.stderr`, result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const artifacts = result.stdout
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((event) => event.reason === "compiler-artifact");
  const drivers = artifacts.filter(
    (event) =>
      event.target.name === example &&
      event.target.kind.includes(kind) &&
      event.executable,
  );
  assert.equal(drivers.length, 1, "one actual Cargo-selected example");
  const driver = drivers[0];
  for (const feature of features) assert.ok(driver.features.includes(feature));
  const binarySha256 = hash(driver.executable);
  const binary = `${reportFile}.${binarySha256}.bin`;
  copyFileSync(driver.executable, binary);
  assert.equal(hash(binary), binarySha256);
  const libraries = {};
  for (const name of [
    "demlik_tea",
    ...(features.includes("pbt") ? ["proptest"] : []),
  ]) {
    const selected = artifacts.filter(
      (event) =>
        event.target.name === name &&
        event.target.kind.includes("lib") &&
        event.filenames.some((file) => file.endsWith(".rlib")),
    );
    assert.equal(
      selected.length,
      1,
      `one actual Cargo-selected ${name} library`,
    );
    const artifact = selected[0];
    const file = artifact.filenames.find((name) => name.endsWith(".rlib"));
    libraries[name] = {
      path: file,
      sha256: hash(file),
      features: artifact.features,
      packageId: artifact.package_id,
    };
  }
  const proof = {
    command: [cargo, ...args],
    cargoJson,
    cargoJsonSha256: hash(cargoJson),
    actualArtifact: driver.executable,
    binary,
    binarySha256,
    libraries,
  };
  writeFileSync(
    `${reportFile}.artifacts.json`,
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  return proof;
}
