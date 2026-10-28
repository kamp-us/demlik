import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { assertCheckPath } from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const packages = {
  "demlik-tea": { crate: "tea", libraries: ["demlik_tea"] },
  "demlik-code-graph": {
    crate: "code-graph",
    libraries: ["demlik_code_graph"],
  },
  "demlik-parity": {
    crate: "parity",
    libraries: ["demlik_tea", "demlik_code_graph"],
  },
};

export function buildExample(
  cargo,
  packageName,
  example,
  reportFile,
  features = [],
  env = {},
) {
  return buildArtifact(
    cargo,
    packageName,
    "example",
    example,
    reportFile,
    features,
    env,
  );
}

export function buildTeaExample(cargo, example, reportFile, features = []) {
  return buildExample(cargo, "demlik-tea", example, reportFile, features);
}

export function buildTeaTest(cargo, test, reportFile) {
  return buildArtifact(cargo, "demlik-tea", "test", test, reportFile, []);
}

export function buildParityBinary(cargo, name, reportFile) {
  return buildArtifact(cargo, "demlik-parity", "bin", name, reportFile, []);
}

function buildArtifact(
  cargo,
  packageName,
  kind,
  example,
  reportFile,
  features,
  env = {},
) {
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ]) {
    assert.equal(
      process.env[key],
      undefined,
      `${key} must be unset for a default-target build`,
    );
    assert.equal(env[key], undefined, `${key} must be unset`);
  }
  assert.ok(Object.hasOwn(packages, packageName), "known parity package");
  const packageSpec = packages[packageName];
  const manifest = path.join(root, "crates", packageSpec.crate, "Cargo.toml");
  reportFile = path.resolve(reportFile);
  const args = [
    kind === "test" ? "test" : "build",
    "--locked",
    "--offline",
    "-p",
    packageName,
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
    env: { ...process.env, ...env },
  });
  mkdirSync(path.dirname(reportFile), { recursive: true });
  const cargoJson = `${reportFile}.cargo.jsonl`;
  writeFileSync(cargoJson, result.stdout ?? "");
  const cargoStderr = `${reportFile}.cargo.stderr`;
  writeFileSync(cargoStderr, result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const artifacts = result.stdout
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((event) => event.reason === "compiler-artifact");
  const drivers = artifacts.filter(
    (event) =>
      event.manifest_path === manifest &&
      event.target.name === example &&
      event.target.kind.includes(kind) &&
      event.executable,
  );
  assert.equal(
    drivers.length,
    1,
    `one actual Cargo-selected ${kind} from ${manifest}`,
  );
  const driver = drivers[0];
  assertCheckPath(driver.target.src_path, root);
  assertCheckPath(driver.executable, path.join(root, "target"));
  for (const feature of features)
    assert.ok(
      driver.features.includes(feature),
      `selected target requires ${feature}`,
    );
  const binarySha256 = hash(driver.executable);
  const binary = `${reportFile}.${binarySha256}.bin`;
  copyFileSync(driver.executable, binary);
  assert.equal(hash(binary), binarySha256);
  const libraries = {};
  for (const name of [
    ...packageSpec.libraries,
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
    const ownPackage = Object.values(packages).find(
      (spec) => spec.libraries.length === 1 && spec.libraries[0] === name,
    );
    if (ownPackage)
      assert.equal(
        artifact.manifest_path,
        path.join(root, "crates", ownPackage.crate, "Cargo.toml"),
      );
    const file = artifact.filenames.find((name) => name.endsWith(".rlib"));
    assertCheckPath(file, path.join(root, "target"));
    const bytes = readFileSync(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const retained = path.join(
      path.dirname(reportFile),
      "cargo-artifacts",
      sha256,
      `${path.basename(file)}.gz`,
    );
    mkdirSync(path.dirname(retained), { recursive: true });
    if (!existsSync(retained)) writeFileSync(retained, gzipSync(bytes));
    assert.equal(
      createHash("sha256")
        .update(gunzipSync(readFileSync(retained)))
        .digest("hex"),
      sha256,
    );
    libraries[name] = {
      path: file,
      sha256,
      features: artifact.features,
      packageId: artifact.package_id,
      artifact,
      retainedPath: retained,
      retainedSha256: hash(retained),
      retainedEncoding: "gzip",
      source: {
        path: artifact.target.src_path,
        sha256: hash(artifact.target.src_path),
      },
      manifest: {
        path: artifact.manifest_path,
        sha256: hash(artifact.manifest_path),
      },
    };
  }
  const sourceDiff = `${reportFile}.source.diff`;
  writeFileSync(
    sourceDiff,
    execFileSync("git", ["diff", "--binary", "HEAD", "--", "crates"], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  const proof = {
    command: [cargo, ...args],
    cargoJson,
    cargoJsonSha256: hash(cargoJson),
    cargoStderr,
    cargoStderrSha256: hash(cargoStderr),
    driver,
    actualArtifact: driver.executable,
    binary,
    binarySha256,
    libraries,
    source: {
      path: driver.target.src_path,
      sha256: hash(driver.target.src_path),
    },
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceDiff,
    sourceDiffSha256: hash(sourceDiff),
  };
  writeFileSync(
    `${reportFile}.artifacts.json`,
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  return proof;
}
