import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  checkEvidenceDirectory,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = [
  "verification/parity/check-worktree.mjs",
  "verification/parity/compose-checks-run.mjs",
  "verification/parity/compose-mutations.mjs",
  "verification/parity/compose-interface-probes.mjs",
  "verification/parity/tea-example.mjs",
  "verification/parity/compose-run.mjs",
  "verification/parity/compiled-traces.mjs",
  "verification/parity/compose.mts",
  "verification/parity/compose-cases.mts",
  "verification/parity/compose-reference.mts",
  "crates/tea/src/compose.rs",
  "crates/tea/examples/compose_driver.rs",
  "crates/tea/examples/compose_interface.rs",
];
function logicalBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += logicalBytes(file);
    else if (entry.isFile()) bytes += fs.statSync(file).size;
  }
  return bytes;
}
export async function composeChecks({ directory } = {}) {
  const scope = JSON.parse(
    fs.readFileSync(new URL("./scope.json", import.meta.url), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const base = directory ?? checkEvidenceDirectory(root, "compose");
  fs.mkdirSync(base, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(path.resolve(base), "suite-"));
  const reportFile = path.join(evidence, "report.json");
  const started = performance.now();
  const sourceHashes = Object.fromEntries(
    sources.map((file) => [file, hash(fs.readFileSync(path.join(root, file)))]),
  );
  const environment = cargoCheckEnvironment({
    CARGO_NET_OFFLINE: "true",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    CARGO_INCREMENTAL: "0",
    CARGO_BUILD_JOBS: "1",
  });
  const report = {
    evidence,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    sourceHashes,
    complete: false,
    semanticPairs: 0,
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
    },
    profile: { defaultTarget: true, cacheCopies: false, sequentialSuite: true },
    resourceSamples: [],
  };
  let check;
  let operationError;
  let cleanupError;
  try {
    check = createCheckWorktree(root, "compose", evidence);
    report.check = { root: check.root, target: check.target };
    const observeTarget = () => {
      report.resourceSamples.push({
        elapsedMs: performance.now() - started,
        logicalTargetBytes: logicalBytes(check.target),
      });
    };
    for (const [file, digest] of Object.entries(sourceHashes))
      assert.equal(
        hash(fs.readFileSync(path.join(check.root, file))),
        digest,
        `${file}: committed check source must match the invoking source`,
      );
    for (const name of [
      "node_modules",
      "packages/tea/node_modules",
      "verification/parity/node_modules",
    ])
      fs.symlinkSync(
        fs.realpathSync(path.join(root, name)),
        path.join(check.root, name),
        "dir",
      );
    fs.mkdirSync(check.target, { recursive: true });
    const prefix = path.join(evidence, "baseline");
    const bootstrap = `import { buildTeaExample } from ${JSON.stringify(pathToFileURL(path.join(check.root, "verification/parity/tea-example.mjs")).href)};\nbuildTeaExample(process.env.CARGO ?? "cargo", "compose_driver", process.argv[2]);\n`;
    const bootstrapFile = path.join(check.target, "compose-baseline.mjs");
    fs.writeFileSync(bootstrapFile, bootstrap);
    fs.writeFileSync(path.join(evidence, "baseline-bootstrap.mjs"), bootstrap);
    const build = spawnSync(process.execPath, [bootstrapFile, prefix], {
      cwd: check.root,
      env: environment,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(
      path.join(evidence, "bootstrap.stdout"),
      build.stdout ?? "",
    );
    fs.writeFileSync(
      path.join(evidence, "bootstrap.stderr"),
      build.stderr ?? "",
    );
    report.bootstrap = {
      command: [process.execPath, bootstrapFile, prefix],
      cwd: check.root,
      sourceSha256: hash(bootstrap),
      exit: build.status,
      signal: build.signal,
      error: build.error?.message,
    };
    observeTarget();
    assert.equal(build.error, undefined);
    assert.equal(build.signal, null);
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const built = JSON.parse(
      fs.readFileSync(`${prefix}.artifacts.json`, "utf8"),
    );
    const events = fs
      .readFileSync(built.cargoJson, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const library = compiledCheckLibrary(
      events,
      "demlik_tea",
      check.root,
      check.target,
    );
    const drivers = events.filter(
      (event) =>
        event.reason === "compiler-artifact" &&
        event.target.name === "compose_driver" &&
        event.executable,
    );
    assert.equal(drivers.length, 1);
    assert.equal(drivers[0].fresh, false);
    assertCheckPath(drivers[0].target.src_path, check.root);
    assertCheckPath(drivers[0].manifest_path, check.root);
    assertCheckPath(built.actualArtifact, check.target);
    assert.equal(hash(fs.readFileSync(built.binary)), built.binarySha256);
    assert.equal(
      hash(fs.readFileSync(library.path)),
      built.libraries.demlik_tea.sha256,
    );
    const pinnedLibrary = path.join(
      evidence,
      `libdemlik_tea-${built.libraries.demlik_tea.sha256}.rlib`,
    );
    fs.copyFileSync(library.path, pinnedLibrary);
    report.baselineBuild = {
      ...built,
      library: {
        path: pinnedLibrary,
        sha256: hash(fs.readFileSync(pinnedLibrary)),
        actualArtifact: library.path,
        fresh: library.artifact.fresh,
      },
      driverArtifact: drivers[0],
    };
    const { composeComparison, composeMutations } = await import(
      pathToFileURL(
        path.join(check.root, "verification/parity/compose-mutations.mjs"),
      )
    );
    const baseline = composeComparison(
      check,
      built.binary,
      path.join(evidence, "baseline-comparison.json"),
      undefined,
      environment,
    );
    assert.equal(baseline.run.exit, 0);
    assert.equal(baseline.report.compared, 119);
    assert.equal(baseline.report.passed, 119);
    assert.deepEqual(baseline.report.failures, []);
    report.baseline = {
      cases: baseline.report.compared,
      passed: baseline.report.passed,
      file: path.join(evidence, "baseline-comparison.json"),
    };
    const { composeInterfaceProbes } = await import(
      pathToFileURL(
        path.join(
          check.root,
          "verification/parity/compose-interface-probes.mjs",
        ),
      )
    );
    const types = composeInterfaceProbes({
      check,
      rlib: pinnedLibrary,
      dependencies: path.dirname(library.path),
      reportFile: path.join(evidence, "type-probes.json"),
    });
    assert.equal(types.results.length, 8);
    assert.deepEqual(types.failures, []);
    report.types = { probes: types.results.length, failures: types.failures };
    const controls = composeMutations({
      check,
      binary: built.binary,
      baseline,
      reportFile: path.join(evidence, "controls.json"),
      observeTarget,
    });
    assert.equal(controls.controls.length, 8);
    assert.equal(controls.complete, true);
    assert.equal(controls.activeSourceUnchanged, true);
    assert.equal(controls.baselineArtifactUnchanged, true);
    assert.equal(
      hash(fs.readFileSync(pinnedLibrary)),
      report.baselineBuild.library.sha256,
    );
    report.controls = {
      detected: controls.controls.length,
      complete: true,
      file: path.join(evidence, "controls.json"),
    };
    report.complete = true;
  } catch (error) {
    operationError = error;
    report.operationFailure = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } finally {
    try {
      check?.remove();
    } catch (error) {
      cleanupError = error;
      report.cleanupFailure = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }
    report.elapsedMs = performance.now() - started;
    report.sampledPeakLogicalTargetBytes = Math.max(
      0,
      ...report.resourceSamples.map((sample) => sample.logicalTargetBytes),
    );
    report.sourceUnchanged = Object.entries(sourceHashes).every(
      ([file, digest]) =>
        hash(fs.readFileSync(path.join(root, file))) === digest,
    );
    report.worktreeRemoved = check ? !fs.existsSync(check.root) : true;
    report.defaultTargetRemoved = check ? !fs.existsSync(check.target) : true;
    report.complete &&=
      !cleanupError &&
      report.sourceUnchanged &&
      report.worktreeRemoved &&
      report.defaultTargetRemoved;
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (operationError || cleanupError)
    throw new AggregateError(
      [operationError, cleanupError].filter(Boolean),
      `Compose suite failed; retained proof: ${reportFile}`,
    );
  assert.equal(
    report.complete,
    true,
    `Incomplete Compose check: ${reportFile}`,
  );
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const report = await composeChecks();
  console.log(
    JSON.stringify({
      reportFile: report.reportFile,
      cases: report.baseline.cases,
      types: report.types.probes,
      detected: report.controls.detected,
      worktreeRemoved: report.worktreeRemoved,
    }),
  );
}
