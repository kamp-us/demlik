import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";
import { hotspotsParity } from "./hotspots-run.mjs";

const [baseline, proof, evidence] = process.argv.slice(2);
assert.equal(process.argv.length, 5);
assert.equal(process.version, "v22.21.1");
const root = fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = Object.fromEntries(
  ["churn", "render"].map((name) => {
    const owner = `crates/code-graph/src/hotspots/${name}.rs`;
    return [owner, fs.readFileSync(path.join(root, owner), "utf8")];
  }),
);
const faults = [
  {
    id: "tracked-zero-becomes-missing",
    owner: "crates/code-graph/src/hotspots/churn.rs",
    before: "Some(churn.commits_by_file.get(file).copied().unwrap_or(0.0))",
    after: "churn.commits_by_file.get(file).copied()",
    witness: "repo-window-repeat",
  },
  {
    id: "duplicate-file-counted-twice",
    owner: "crates/code-graph/src/hotspots/churn.rs",
    before: "&& files_in_commit.insert(file.clone())",
    after: "&& { let _ = files_in_commit.insert(file.clone()); true }",
    witness: "git-duplicates-raw-paths",
  },
  {
    id: "equal-product-file-order-reversed",
    owner: "crates/code-graph/src/hotspots/render.rs",
    before:
      "numeric.then_with(|| collation.compare(&inputs[left], &inputs[right]))",
    after:
      "numeric.then_with(|| collation.compare(&inputs[right], &inputs[left]))",
    witness: "pure-order-owners",
  },
  {
    id: "json-incorrectly-applies-limit",
    owner: "crates/code-graph/src/hotspots/render.rs",
    before:
      "if json {\n        return stable_stringify(&report, pretty).map(Into::into);\n    }",
    after:
      "if json {\n        let report = Report { rows: &rows[..slice_end(limit, rows.len())], ..report };\n        return stable_stringify(&report, pretty).map(Into::into);\n    }",
    witness: "pure-order-owners",
  },
];
for (const fault of faults)
  assert.equal(original[fault.owner].split(fault.before).length, 2, fault.id);
fs.mkdirSync(evidence, { recursive: true });
const baselineHash = hash(fs.readFileSync(baseline));
const trusted = JSON.parse(
  fs.readFileSync(path.join(proof, "first-native24.json")),
);
assert.equal(trusted.binary.sha256, baselineHash);
assert.equal(trusted.cases, 24);
assert.equal(trusted.passed, 24);
assert.deepEqual(trusted.failures, []);
const env = cargoCheckEnvironment({
  CARGO_NET_OFFLINE: "true",
  CARGO_BUILD_JOBS: "1",
  CARGO_INCREMENTAL: "0",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
});
const cargo = process.env.CARGO ?? "cargo";
const report = {
  sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).stdout.trim(),
  baseline: { path: baseline, sha256: baselineHash },
  planned: 4,
  cargoSelections: 0,
  nativePreparations: 0,
  controls: [],
  complete: false,
  newComparisonCredit: 0,
};
let check, attempt, operationError, cleanupError;
function save(name, value) {
  fs.writeFileSync(
    path.join(evidence, name),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}
function invoke(name, argv, cwd, environment) {
  const began = performance.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: environment,
    maxBuffer: 128 << 20,
    timeout: 1_500_000,
  });
  const stdout = result.stdout ?? Buffer.alloc(0),
    stderr = result.stderr ?? Buffer.alloc(0);
  fs.writeFileSync(path.join(evidence, `${name}.stdout`), stdout);
  fs.writeFileSync(path.join(evidence, `${name}.stderr`), stderr);
  const record = {
    argv,
    cwd,
    exit: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    durationSeconds: (performance.now() - began) / 1000,
    stdout: `${name}.stdout`,
    stdoutSHA: hash(stdout),
    stderr: `${name}.stderr`,
    stderrSHA: hash(stderr),
  };
  save(`${name}.process.json`, record);
  return { ...record, text: stdout.toString("utf8") };
}
function retain(file, name) {
  const bytes = fs.readFileSync(file),
    sha256 = hash(bytes);
  const retained = path.join(evidence, `${name}-${sha256}.gz`);
  const compressed = gzipSync(bytes, { level: 1 });
  fs.writeFileSync(retained, compressed);
  return {
    path: file,
    sha256,
    bytes: bytes.length,
    retained,
    retainedSHA: hash(compressed),
  };
}
function retainEvents(events, directory) {
  return events
    .filter(
      (event) =>
        event.reason === "compiler-artifact" &&
        ["demlik_code_graph", "hotspots_driver"].includes(event.target.name),
    )
    .flatMap((event) => {
      const files =
        event.target.name === "demlik_code_graph"
          ? event.filenames.filter((p) => p.endsWith(".rlib"))
          : event.executable
            ? [event.executable]
            : [];
      return files.map((file) => {
        assertCheckPath(file, check.target);
        return {
          event,
          ...retain(file, `${directory}.${event.target.name}`),
          actualExecutionClaimed: false,
        };
      });
    });
}
try {
  check = createCheckWorktree(root, "hotspots-controls", evidence);
  const environment = {
    ...env,
    DEMLIK_ICU77_PREPARED: path.join(check.target, "icu77/prepared.json"),
    RUST_ICU_LINK_SEARCH_DIR: path.join(check.target, "icu77/install/lib"),
    RUST_ICU_MAJOR_VERSION_NUMBER: "77",
  };
  assert.ok(process.env.DEMLIK_ICU77_SOURCE_ARCHIVE);
  assert.ok(process.env.DEMLIK_ICU77_PYTHON);
  report.nativePreparations++;
  const prepared = invoke(
    "icu-prepare",
    [
      process.env.DEMLIK_ICU77_PYTHON,
      "tools/icu77/prepare.py",
      "prepare",
      "--host",
      "aarch64-apple-darwin",
      "--target",
      "aarch64-apple-darwin",
      "--source-archive",
      process.env.DEMLIK_ICU77_SOURCE_ARCHIVE,
      "--cargo",
      cargo,
    ],
    check.root,
    environment,
  );
  report.preparation = { ...prepared, text: undefined };
  save("controls.json", report);
  assert.equal(prepared.exit, 0);
  assert.equal(prepared.signal, null);
  assert.equal(prepared.error, null);
  for (const fault of faults) {
    attempt = { ...fault, phase: "source", detected: false };
    const modified = original[fault.owner].replace(fault.before, fault.after);
    const file = path.join(check.root, fault.owner);
    fs.writeFileSync(file, modified);
    fs.writeFileSync(
      path.join(evidence, `${fault.id}.original.rs`),
      original[fault.owner],
    );
    fs.writeFileSync(path.join(evidence, `${fault.id}.modified.rs`), modified);
    attempt.sourceSHA = hash(Buffer.from(modified));
    attempt.phase = "compile";
    report.cargoSelections++;
    const build = invoke(
      `${fault.id}.cargo`,
      [
        cargo,
        "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "hotspots_driver",
        "--message-format=json",
      ],
      check.root,
      environment,
    );
    attempt.build = { ...build, text: undefined };
    const events = [],
      eventErrors = [];
    for (const line of build.text.split("\n").filter(Boolean)) {
      try {
        events.push(JSON.parse(line));
      } catch (error) {
        eventErrors.push({ line, message: error.message });
      }
    }
    save(`${fault.id}.events.json`, events);
    attempt.eventErrors = eventErrors;
    attempt.artifacts = retainEvents(events, fault.id);
    save("current-attempt.json", attempt);
    assert.equal(build.exit, 0, "compilation failure is not detection");
    assert.equal(build.signal, null);
    assert.equal(build.error, null);
    assert.deepEqual(eventErrors, []);
    const library = compiledCheckLibrary(
      events,
      "demlik_code_graph",
      check.root,
      check.target,
    );
    attempt.library = attempt.artifacts.find((a) => a.path === library.path);
    assert.ok(attempt.library);
    attempt.library.sourceSHA = hash(fs.readFileSync(library.sourcePath));
    attempt.library.manifestSHA = hash(fs.readFileSync(library.manifestPath));
    const drivers = events.filter(
      (e) =>
        e.reason === "compiler-artifact" &&
        e.target.name === "hotspots_driver" &&
        e.target.kind.includes("example") &&
        e.executable,
    );
    assert.equal(drivers.length, 1);
    const driver = drivers[0];
    assert.equal(driver.fresh, false);
    assertCheckPath(driver.target.src_path, check.root);
    assertCheckPath(driver.manifest_path, check.root);
    assertCheckPath(driver.executable, check.target);
    const effective = path.join(evidence, `${fault.id}.driver`);
    fs.copyFileSync(driver.executable, effective);
    fs.chmodSync(effective, 0o755);
    attempt.driver = attempt.artifacts.find(
      (a) => a.path === driver.executable,
    );
    assert.equal(hash(fs.readFileSync(effective)), attempt.driver.sha256);
    attempt.driver.executedCopy = effective;
    attempt.phase = "compare";
    save("current-attempt.json", attempt);
    const output = path.join(evidence, `${fault.id}.comparison.json`);
    const compared = hotspotsParity(effective, proof, output);
    attempt.comparison = {
      path: output,
      sha256: hash(fs.readFileSync(output)),
      cases: compared.cases,
      passed: compared.passed,
      failures: compared.failures,
    };
    attempt.driver.actualExecutionClaimed = true;
    assert.equal(compared.binary.sha256, attempt.driver.sha256);
    assert.equal(compared.cases, 24);
    assert.ok(
      compared.rows.every(
        (r) =>
          r.protocolValid &&
          r.process.status === 0 &&
          r.process.signal === null &&
          r.process.error === null,
      ),
    );
    const witness = compared.rows.find((r) => r.id === fault.witness);
    assert.ok(witness && !witness.equal);
    assert.ok(
      witness.errors.some((e) => e.kind === "semantic" && e.field === "output"),
    );
    assert.ok(witness.errors.every((e) => e.kind === "semantic"));
    attempt.witness = {
      id: witness.id,
      source: witness.source,
      native: witness.native,
      errors: witness.errors,
      process: witness.process,
    };
    attempt.detected = true;
    attempt.phase = "detected";
    report.controls.push(attempt);
    fs.writeFileSync(file, original[fault.owner]);
    attempt.sourceRestored =
      hash(fs.readFileSync(file)) === hash(Buffer.from(original[fault.owner]));
    assert.equal(attempt.sourceRestored, true);
    save("controls.json", report);
    attempt = null;
  }
  report.allPassed =
    report.controls.length === 4 && report.controls.every((c) => c.detected);
  report.complete = true;
} catch (error) {
  operationError = error;
  report.operationFailure = { message: error.message, stack: error.stack };
  report.incompleteAttempt = attempt;
} finally {
  if (check) {
    try {
      for (const [owner, bytes] of Object.entries(original))
        fs.writeFileSync(path.join(check.root, owner), bytes);
      report.sourceRestored = Object.entries(original).every(
        ([owner, bytes]) =>
          fs.readFileSync(path.join(check.root, owner), "utf8") === bytes,
      );
      const preparation = path.join(check.target, "icu77");
      for (const name of ["attempt.json", "prepared.json"])
        if (fs.existsSync(path.join(preparation, name)))
          fs.copyFileSync(
            path.join(preparation, name),
            path.join(evidence, `icu-${name}`),
          );
      if (fs.existsSync(path.join(preparation, "logs")))
        fs.cpSync(
          path.join(preparation, "logs"),
          path.join(evidence, "icu-logs"),
          { recursive: true },
        );
    } catch (error) {
      operationError ??= error;
      report.retentionFailure = { message: error.message, stack: error.stack };
    }
    try {
      check.remove();
    } catch (error) {
      cleanupError = error;
      report.cleanupFailure = { message: error.message, stack: error.stack };
    }
  }
  report.baselineUnchanged = hash(fs.readFileSync(baseline)) === baselineHash;
  save("controls.json", report);
}
if (operationError) throw operationError;
if (cleanupError) throw cleanupError;
assert.equal(report.allPassed, true);
assert.equal(report.baselineUnchanged, true);
assert.equal(report.sourceRestored, true);
console.log(
  JSON.stringify({
    controls: report.controls.length,
    detected: report.controls.filter((r) => r.detected).length,
    cargoSelections: report.cargoSelections,
    newComparisonCredit: 0,
  }),
);
