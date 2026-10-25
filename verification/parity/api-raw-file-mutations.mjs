import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseline = process.argv[2];
assert.ok(baseline);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "demlik-api-raw-faults-"),
);
const workspace = path.join(directory, "workspace"),
  target = path.join(root, "target/parity/shape-judgment-mutation-build");
const binary = path.join(target, "debug/examples/api_view_driver"),
  file = "crates/code-graph/src/engine/tsgo/mod.rs";
const original = fs.readFileSync(path.join(root, file), "utf8");
const hash = createHash("sha256")
  .update(fs.readFileSync(baseline))
  .digest("hex");
const environment = {
  ...process.env,
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
  CARGO_TARGET_DIR: target,
};
const controls = [];
function pairs(executable, label) {
  const report = path.join(directory, `${label}.json`);
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(root, "verification/parity/graph-api-raw-file.mts"),
      executable,
      report,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: environment,
    },
  );
  assert.ok(fs.existsSync(report), run.stdout + run.stderr);
  return { run, report: JSON.parse(fs.readFileSync(report, "utf8")) };
}
function cargo(args) {
  return spawnSync(process.env.CARGO ?? "cargo", args, {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: environment,
  });
}
try {
  const before = pairs(baseline, "baseline");
  assert.equal(before.run.status, 0, before.run.stdout + before.run.stderr);
  assert.equal(before.report.passed, 14);
  assert.equal(before.report.rejectedInvalidInputs, 3);
  fs.mkdirSync(workspace);
  for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
    fs.cpSync(path.join(root, entry), path.join(workspace, entry), {
      recursive: true,
    });
  fs.mkdirSync(path.join(workspace, "packages/code-graph"), {
    recursive: true,
  });
  fs.symlinkSync(
    path.join(root, "packages/code-graph/node_modules"),
    path.join(workspace, "packages/code-graph/node_modules"),
    "dir",
  );
  const nativeBefore = cargo([
    "test",
    "--offline",
    "-p",
    "demlik-code-graph",
    "--test",
    "api_view",
    "text_roots_sort_by_utf16",
  ]);
  assert.equal(
    nativeBefore.status,
    0,
    nativeBefore.stdout + nativeBefore.stderr,
  );
  const mutations = [
    {
      name: "raw-filename-replaced-at-request",
      before: "self.source_data_request(file.clone(), file)",
      after: "self.source_data_request(file.clone(), file.to_lossy())",
      witness: "raw-high-entry",
    },
    {
      name: "raw-filename-cache-key-replaced",
      before: "self.source_data_request(file.clone(), file)",
      after: "self.source_data_request(JsString::from(file.to_lossy()), file)",
      witness: "literal-cache-does-not-hide-high",
    },
    {
      name: "text-root-list-replaced-before-json",
      before:
        "files.extend_from_slice(input.root_files);\n        files.sort();",
      after:
        "files.extend(input.root_files.iter().map(|file| JsString::from(file.to_lossy())));\n        files.sort();",
      witness: "raw-only-roots",
    },
    {
      name: "text-root-list-uses-utf8-order",
      before: "files.sort();",
      after:
        "files.sort_by(|left, right| left.to_lossy().cmp(&right.to_lossy()));",
      native: true,
    },
  ];
  for (const mutation of mutations) {
    assert.equal(original.split(mutation.before).length, 2, mutation.name);
    fs.writeFileSync(
      path.join(workspace, file),
      original.replace(mutation.before, mutation.after),
    );
    if (mutation.native) {
      const run = cargo([
        "test",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--test",
        "api_view",
        "text_roots_sort_by_utf16",
      ]);
      assert.equal(run.status, 101, run.stdout + run.stderr);
      assert.match(run.stdout, /text_roots_sort_by_utf16.*FAILED/);
      assert.match(run.stdout, /assertion `left == right` failed/);
      controls.push({
        ...mutation,
        detected: true,
        stdout: run.stdout,
        stderr: run.stderr,
        sourceProbe:
          "/private/tmp/demlik-api-text-root-order-source-01a16c9d.json",
      });
    } else {
      const build = cargo([
        "build",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "api_view_driver",
      ]);
      assert.equal(build.status, 0, build.stdout + build.stderr);
      const result = pairs(binary, mutation.name);
      assert.notEqual(result.run.status, 0, mutation.name);
      assert.ok(
        result.report.failures.some((row) => row.id === mutation.witness),
        JSON.stringify(result.report.failures),
      );
      controls.push({
        ...mutation,
        detected: true,
        failures: result.report.failures,
        sourceCases: result.report.cases,
      });
    }
    process.stdout.write(`${JSON.stringify({ detected: mutation.name })}\n`);
  }
  assert.equal(
    createHash("sha256").update(fs.readFileSync(baseline)).digest("hex"),
    hash,
  );
  const report = {
    detected: controls.length,
    escaped: 0,
    baselineCases: 14,
    invalidInputs: 3,
    baselineMatchesSourceContract: true,
    baselineNativeOrderPassed: true,
    backendOffsetsQualified: true,
    baselineDriverUnchanged: true,
    baselineDriverSha256: hash,
    buildProfile: {
      devDebug: 0,
      testDebug: 0,
      incremental: false,
      jobs: 1,
      target,
    },
    reference: { node: process.version, v8: process.versions.v8 },
    controls,
  };
  if (process.argv[3])
    fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ detected: report.detected, escaped: report.escaped })}\n`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
