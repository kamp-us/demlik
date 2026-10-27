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
  "verification/parity/pbt-constructors-checks-run.mjs",
  "verification/parity/pbt-constructors-mutations.mjs",
  "verification/parity/pbt-constructors-interface-probes.mjs",
  "verification/parity/pbt-property-mutations.mjs",
  "verification/parity/pbt-final-mutations.mjs",
  "verification/parity/check-worktree.mjs",
  "verification/parity/pbt-constructors.mts",
  "verification/parity/pbt-constructors-cases.mts",
  "verification/parity/pbt-constructors-reference.mts",
  "verification/parity/pbt-constructors-invoice.mts",
  "verification/parity/pbt-property-run.mjs",
  "verification/parity/pbt-property.mts",
  "verification/parity/pbt-property-cases.mts",
  "verification/parity/pbt-property-reference.mts",
  "verification/parity/pbt-property-files.mts",
  "verification/parity/pbt-final.mts",
  "verification/parity/pbt-final-cases.mts",
  "verification/parity/pbt-final-reference.mts",
  "verification/parity/scope.json",
  "Cargo.toml",
  "Cargo.lock",
  "crates/tea/Cargo.toml",
  "crates/tea/src/pbt/proptest.rs",
  "crates/tea/examples/pbt_constructors_driver.rs",
  "crates/tea/examples/pbt_constructors_driver/invoice.rs",
  "crates/tea/examples/pbt_constructors_driver/native.rs",
  "crates/tea/examples/pbt_constructors_interface.rs",
  "crates/tea/examples/pbt_property_driver.rs",
  "crates/tea/tests/pbt_fold.rs",
  "crates/tea/tests/pbt_proptest.rs",
  "crates/tea/tests/pbt_final.rs",
  "crates/tea/tests/pbt_final_invoice.rs",
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
export async function pbtConstructorChecks({ directory } = {}) {
  const scope = JSON.parse(
    fs.readFileSync(new URL("./scope.json", import.meta.url), "utf8"),
  );
  assert.equal(process.version, scope.referenceEngine.node);
  assert.equal(process.versions.v8, scope.referenceEngine.v8);
  const base = directory ?? checkEvidenceDirectory(root, "pbt-constructors");
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
    profile: {
      defaultTarget: true,
      cacheCopies: false,
      sequentialSuite: true,
      inheritedTargetAliasesCleared: true,
    },
    resourceSamples: [],
    cargoSelections: 0,
  };
  let check, operationError, cleanupError;
  try {
    check = createCheckWorktree(root, "pbt-constructors", evidence);
    report.check = { root: check.root, target: check.target };
    const observeTarget = () =>
      report.resourceSamples.push({
        elapsedMs: performance.now() - started,
        logicalTargetBytes: logicalBytes(check.target),
      });
    for (const [file, digest] of Object.entries(sourceHashes))
      assert.equal(
        hash(fs.readFileSync(path.join(check.root, file))),
        digest,
        `${file}: committed check must match invoking source`,
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
    const run = (program, args, prefix) => {
      const result = spawnSync(program, args, {
        cwd: check.root,
        env: environment,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      fs.writeFileSync(`${prefix}.stdout`, result.stdout ?? "");
      fs.writeFileSync(`${prefix}.stderr`, result.stderr ?? "");
      const recorded = {
        command: [program, ...args],
        cwd: check.root,
        exit: result.status,
        signal: result.signal,
        error: result.error?.message,
        stdout: { path: `${prefix}.stdout`, sha256: hash(result.stdout ?? "") },
        stderr: { path: `${prefix}.stderr`, sha256: hash(result.stderr ?? "") },
      };
      fs.writeFileSync(
        `${prefix}.run.json`,
        `${JSON.stringify(recorded, null, 2)}\n`,
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      return { result, recorded };
    };
    const cargo = (args, name) => {
      report.cargoSelections++;
      const output = run(
        process.env.CARGO ?? "cargo",
        args,
        path.join(evidence, name),
      );
      observeTarget();
      return {
        ...output,
        rows: output.result.stdout
          .split("\n")
          .filter(Boolean)
          .map((s) => JSON.parse(s)),
      };
    };
    const built = cargo(
      [
        "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-tea",
        "--features",
        "pbt",
        "--example",
        "pbt_constructors_driver",
        "--example",
        "pbt_property_driver",
        "--message-format=json",
      ],
      "baseline-drivers",
    );
    const lib = compiledCheckLibrary(
      built.rows,
      "demlik_tea",
      check.root,
      check.target,
    );
    assert(lib.artifact.features.includes("pbt"));
    const { readPbtCargoArtifacts } = await import(
      pathToFileURL(
        path.join(check.root, "verification/parity/pbt-property-run.mjs"),
      )
    );
    const selected = readPbtCargoArtifacts(
      path.join(evidence, "baseline-drivers.stdout"),
    );
    const preserve = (file, name, artifact) => {
      const actualPath = assertCheckPath(file, check.target);
      const digest = hash(fs.readFileSync(actualPath));
      const saved = path.join(
        evidence,
        `${actualPath.endsWith(".rlib") ? "lib" : ""}${name}-${digest}${actualPath.endsWith(".rlib") ? ".rlib" : ".bin"}`,
      );
      fs.copyFileSync(actualPath, saved);
      assert.equal(hash(fs.readFileSync(saved)), digest);
      return { path: saved, sha256: digest, actualPath, artifact };
    };
    const selectExecutable = (rows, name, kind) => {
      const chosen = rows.filter(
        (r) =>
          r.reason === "compiler-artifact" &&
          r.target.name === name &&
          r.target.kind.includes(kind) &&
          r.executable,
      );
      assert.equal(chosen.length, 1);
      assert.equal(chosen[0].fresh, false);
      assert(chosen[0].features.includes("pbt"));
      assertCheckPath(chosen[0].target.src_path, check.root);
      assertCheckPath(chosen[0].manifest_path, check.root);
      return preserve(chosen[0].executable, name, chosen[0]);
    };
    const libraries = {};
    for (const [key, name] of [
      ["tea", "demlik_tea"],
      ["proptest", "proptest"],
    ]) {
      const items = built.rows.filter(
        (r) =>
          r.reason === "compiler-artifact" &&
          r.target.name === name &&
          r.target.kind.includes("lib") &&
          r.filenames.some((f) => f.endsWith(".rlib")),
      );
      assert.equal(items.length, 1);
      const artifact = items[0];
      libraries[key] = {
        ...preserve(selected.libraries[name].path, name, artifact),
        source: {
          path: artifact.target.src_path,
          sha256: hash(fs.readFileSync(artifact.target.src_path)),
        },
        manifest: {
          path: artifact.manifest_path,
          sha256: hash(fs.readFileSync(artifact.manifest_path)),
        },
      };
    }
    const baseline = {
      binaries: {
        constructors: selectExecutable(
          built.rows,
          "pbt_constructors_driver",
          "example",
        ),
        property: selectExecutable(
          built.rows,
          "pbt_property_driver",
          "example",
        ),
      },
      libraries,
      nativeTests: {},
      reports: {},
    };
    report.baselineBuild = {
      cargo: built.recorded,
      baseline,
      dependencyDirectory: path.dirname(lib.path),
      selectedLibraries: selected.libraries,
    };
    const names = [
      "pbt_fold",
      "pbt_proptest",
      "pbt_final",
      "pbt_final_invoice",
    ];
    const tests = cargo(
      [
        "test",
        "--locked",
        "--offline",
        "-p",
        "demlik-tea",
        "--features",
        "pbt",
        "--no-run",
        ...names.flatMap((name) => ["--test", name]),
        "--message-format=json",
      ],
      "baseline-tests",
    );
    for (const name of names)
      baseline.nativeTests[name] = selectExecutable(tests.rows, name, "test");
    report.nativeTestBuild = tests.recorded;
    const worker = await import(
      pathToFileURL(
        path.join(
          check.root,
          "verification/parity/pbt-constructors-mutations.mjs",
        ),
      )
    );
    const shared = worker.pbtConstructorComparison({
      check,
      binary: baseline.binaries.constructors.path,
      reportFile: path.join(evidence, "baseline90.json"),
    });
    assert.equal(shared.run.exit, 0);
    assert.equal(shared.report.compared, 90);
    assert.equal(shared.report.passed, 90);
    assert.deepEqual(shared.report.failures, []);
    baseline.reports.constructors = shared.report;
    const native = worker.pbtConstructorComparison({
      check,
      binary: baseline.binaries.constructors.path,
      reportFile: path.join(evidence, "baseline-native-laws.json"),
      nativeOnly: true,
    });
    assert.equal(native.run.exit, 0);
    assert.equal(native.report.nativeCases, 3);
    assert.equal(native.report.passed, 3);
    assert.deepEqual(native.report.failures, []);
    assert.equal(native.report.semanticPairs, 0);
    baseline.reports.native = native.report;
    const { pbtConstructorsInterfaceProbes } = await import(
      pathToFileURL(
        path.join(
          check.root,
          "verification/parity/pbt-constructors-interface-probes.mjs",
        ),
      )
    );
    const types = pbtConstructorsInterfaceProbes({
      check,
      teaLibrary: libraries.tea.path,
      proptestLibrary: libraries.proptest.path,
      dependencies: path.dirname(lib.path),
      reportFile: path.join(evidence, "types.json"),
    });
    assert.equal(types.results.length, 5);
    assert.deepEqual(types.failures, []);
    report.types = {
      count: 5,
      file: path.join(evidence, "types.json"),
      failures: types.failures,
    };
    report.nativeTests = [];
    let nativePassed = 0;
    for (const [name, binary] of Object.entries(baseline.nativeTests)) {
      const result = run(
        binary.path,
        ["--test-threads=1"],
        path.join(evidence, `native-${name}`),
      );
      const totals =
        /test result: ok\. (\d+) passed; 0 failed; 0 ignored;/.exec(
          result.result.stdout,
        );
      assert(totals, result.result.stdout);
      nativePassed += Number(totals[1]);
      report.nativeTests.push({
        name,
        passed: Number(totals[1]),
        run: result.recorded,
      });
    }
    assert.equal(nativePassed, 19);
    const tsx = path.join(
      check.root,
      "verification/parity/node_modules/tsx/dist/loader.mjs",
    );
    for (const [family, script, count] of [
      ["property", "pbt-property.mts", 52],
      ["files", "pbt-property-files.mts", 1],
      ["final", "pbt-final.mts", 108],
    ]) {
      const file = path.join(evidence, `affected-${family}.json`);
      run(
        process.execPath,
        [
          "--import",
          tsx,
          assertCheckPath(
            path.join(check.root, "verification/parity", script),
            check.root,
          ),
          "--native-bin",
          baseline.binaries.property.path,
          "--report",
          file,
        ],
        path.join(evidence, `affected-${family}`),
      );
      const compared = JSON.parse(fs.readFileSync(file, "utf8"));
      if (family === "files") assert.equal(compared.equal, true);
      else {
        assert.equal(compared.compared, count);
        assert.equal(compared.passed, count);
        assert.deepEqual(compared.failures, []);
      }
      baseline.reports[family] = compared;
    }
    const baselineFile = path.join(evidence, "immutable-baseline.json");
    fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
    report.baselineFile = baselineFile;
    const controls = worker.pbtConstructorMutations({
      check,
      baseline,
      reportFile: path.join(evidence, "controls.json"),
      observeTarget: () => {
        report.cargoSelections++;
        observeTarget();
        assert(report.cargoSelections <= 21);
      },
    });
    assert.equal(controls.controls.length, 19);
    assert.equal(controls.detected, 19);
    assert.equal(controls.complete, true);
    assert.equal(controls.activeSourceUnchanged, true);
    assert.equal(controls.baselineArtifactsUnchanged, true);
    report.controls = {
      detected: 19,
      constructors: 3,
      affectedProperty: 9,
      affectedFinal: 7,
      file: path.join(evidence, "controls.json"),
    };
    assert.equal(report.cargoSelections, 21);
    report.observations = {
      constructorShared: 90,
      nativeConstructorLaws: 3,
      typeProbes: 5,
      nativeTests: nativePassed,
      affectedObservations: 161,
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
      ...report.resourceSamples.map((s) => s.logicalTargetBytes),
    );
    report.peakQualification =
      "Post-build samples only, not a continuously measured peak.";
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
      `PBT constructor suite failed; retained evidence: ${reportFile}`,
    );
  assert.equal(report.complete, true, `Incomplete check: ${reportFile}`);
  return { ...report, reportFile };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const report = await pbtConstructorChecks();
  console.log(
    JSON.stringify({
      reportFile: report.reportFile,
      ...report.observations,
      detected: report.controls.detected,
      worktreeRemoved: report.worktreeRemoved,
    }),
  );
}
