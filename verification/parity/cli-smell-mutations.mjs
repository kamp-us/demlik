import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";
import { cliSmellFaults } from "./cli-smell-faults.mjs";
import { collapseRenderCliFaults } from "./collapse-render-cli-faults.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const faults = [
  ...cliSmellFaults,
  ...collapseRenderCliFaults.filter((row) => row.kind === "cli"),
];
assert.equal(faults.length, 14);
assert.equal(
  new Set(
    faults.map((row) => JSON.stringify([row.file, row.edits, row.witness])),
  ).size,
  faults.length,
);
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return {
    command: [command, ...args],
    cwd,
    exit: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
export function cliSmellMutations({
  cliBinary,
  cliReport,
  oldCliReport,
  evidence,
}) {
  fs.mkdirSync(evidence, { recursive: true });
  const current = JSON.parse(fs.readFileSync(cliReport, "utf8")),
    old = JSON.parse(fs.readFileSync(oldCliReport, "utf8"));
  assert.deepEqual(current.failures, []);
  assert.deepEqual(old.failures, []);
  assert.equal(old.passed, 49);
  const baseline = {
    path: fs.realpathSync(cliBinary),
    sha256: hash(fs.readFileSync(cliBinary)),
  };
  assert.equal(current.driverSha256, baseline.sha256);
  assert.equal(old.driverSha256, baseline.sha256);
  const owners = [...new Set(faults.map((row) => row.file))],
    originals = Object.fromEntries(
      owners.map((file) => [
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
      ]),
    );
  for (const fault of faults) {
    let text = originals[fault.file];
    for (const [before, after] of fault.edits) {
      assert.equal(text.split(before).length, 2, fault.name);
      text = text.replace(before, after);
    }
    const row = (fault.kind === "cli" ? old : current).cases.find(
      (row) => row.id === fault.witness,
    );
    assert.ok(row?.passed && !row.nativeOnly, fault.witness);
  }
  const env = cargoCheckEnvironment({
    CARGO_NET_OFFLINE: "true",
    CARGO_BUILD_JOBS: "1",
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
  });
  const report = {
    planned: faults.length,
    newPlanned: cliSmellFaults.length,
    affectedOldPlanned: faults.length - cliSmellFaults.length,
    cargoSelections: 0,
    controls: [],
    baseline,
    semanticPairs: 0,
    complete: false,
  };
  const save = () =>
    fs.writeFileSync(
      path.join(evidence, "controls.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  const start = performance.now();
  let check, operationError, cleanupError;
  try {
    check = createCheckWorktree(root, "cli-smell-controls", evidence);
    fs.mkdirSync(path.join(check.target, "parity"), { recursive: true });
    for (const relative of [
      "node_modules",
      "packages/code-graph/node_modules",
      "packages/tea/node_modules",
      "verification/parity/node_modules",
    ]) {
      const from = path.join(root, relative),
        to = path.join(check.root, relative);
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.symlinkSync(fs.realpathSync(from), to);
      }
    }
    for (const fault of faults) {
      for (const [file, text] of Object.entries(originals))
        fs.writeFileSync(path.join(check.root, file), text);
      let text = originals[fault.file];
      for (const [before, after] of fault.edits)
        text = text.replace(before, after);
      fs.writeFileSync(path.join(check.root, fault.file), text);
      const folder = path.join(evidence, fault.name);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, "mutated-owner.rs"), text);
      const built = run(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--example",
          "collapse_cli_driver",
          "--message-format=json",
        ],
        check.root,
        env,
      );
      report.cargoSelections++;
      fs.writeFileSync(path.join(folder, "cargo.jsonl"), built.stdout);
      fs.writeFileSync(path.join(folder, "cargo.stderr"), built.stderr);
      fs.writeFileSync(
        path.join(folder, "build.json"),
        `${JSON.stringify({ ...built, stdout: undefined, stderr: undefined }, null, 2)}\n`,
      );
      save();
      assert.equal(built.error, undefined);
      assert.equal(built.signal, null);
      assert.equal(
        built.exit,
        0,
        `${fault.name}: compiler failures get zero semantic credit`,
      );
      const events = built.stdout.split("\n").filter(Boolean).map(JSON.parse),
        library = compiledCheckLibrary(
          events,
          "demlik_code_graph",
          check.root,
          check.target,
        );
      const consumers = events.filter(
        (row) =>
          row.reason === "compiler-artifact" &&
          row.target.name === "collapse_cli_driver" &&
          row.executable,
      );
      assert.equal(consumers.length, 1);
      assert.equal(consumers[0].fresh, false);
      assertCheckPath(consumers[0].target.src_path, check.root);
      assertCheckPath(consumers[0].manifest_path, check.root);
      const executable = assertCheckPath(consumers[0].executable, check.target),
        bytes = fs.readFileSync(executable),
        retained = path.join(folder, "executed-driver.gz");
      fs.writeFileSync(retained, gzipSync(bytes));
      const binary = {
        actual: executable,
        sha256: hash(bytes),
        bytes: bytes.length,
        retainedCompressed: retained,
        compressedSha256: hash(fs.readFileSync(retained)),
        artifact: consumers[0],
      };
      const libraryBinding = {
        actual: library.path,
        sha256: hash(fs.readFileSync(library.path)),
        bytes: fs.statSync(library.path).size,
        artifact: library.artifact,
        bytesRetained: false,
      };
      const oldCase = fault.kind === "cli",
        script = assertCheckPath(
          path.join(
            check.root,
            "verification/parity",
            oldCase ? "graph-cli-plain-collapse.mjs" : "graph-cli-smell.mjs",
          ),
          check.root,
        ),
        paired = path.join(folder, "pairs.json");
      const compared = run(
        process.execPath,
        ["--import", require.resolve("tsx"), script, executable, paired],
        check.root,
        {
          ...env,
          [oldCase ? "DEMLIK_PLAIN_COLLAPSE_CASES" : "DEMLIK_SMELL_CLI_CASES"]:
            fault.witness,
        },
      );
      fs.writeFileSync(
        path.join(folder, "comparison.json"),
        `${JSON.stringify(compared, null, 2)}\n`,
      );
      assert.equal(compared.error, undefined);
      assert.equal(compared.signal, null);
      assert.equal(compared.exit, 1);
      const result = JSON.parse(fs.readFileSync(paired, "utf8")),
        witness = result.cases.find((row) => row.id === fault.witness);
      assert.ok(witness && !witness.passed);
      assert.ok(
        result.failures.some(
          (row) => row.id === fault.witness && row.kind === "semantic",
        ),
      );
      assert.equal(result.driverSha256, binary.sha256);
      assert.ok(witness.native.length && witness.source.length);
      for (const observed of witness.native) {
        assert.equal(observed.output.signal, null);
        assert.ok([0, 1, 2, 7].includes(observed.output.status));
        assert.ok(observed.trace.observedCalls.length);
      }
      const qualified = (oldCase ? old : current).cases.find(
        (row) => row.id === fault.witness,
      ).qualifications;
      report.controls.push({
        id: fault.name,
        owner: fault.file,
        witness: fault.witness,
        kind: fault.kind,
        compileExit: 0,
        protocolValid: true,
        semanticMismatch: true,
        baselineQualifications: qualified,
        strictCredit: qualified.length === 0,
        library: libraryBinding,
        consumer: binary,
        comparison: paired,
      });
      for (const [file, original] of Object.entries(originals))
        fs.writeFileSync(path.join(check.root, file), original);
      assert.equal(hash(fs.readFileSync(baseline.path)), baseline.sha256);
      save();
    }
    report.complete = report.controls.length === faults.length;
  } catch (error) {
    operationError = error;
    report.operationFailure = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } finally {
    if (check) {
      for (const [file, text] of Object.entries(originals))
        fs.writeFileSync(path.join(check.root, file), text);
      report.checkOwnersRestored = owners.every(
        (file) =>
          fs.readFileSync(path.join(check.root, file), "utf8") ===
          originals[file],
      );
      try {
        check.remove();
      } catch (error) {
        cleanupError = error;
        report.cleanupFailure = { name: error.name, message: error.message };
      }
    }
    report.elapsedMs = performance.now() - start;
    report.worktreeRemoved = !check || !fs.existsSync(check.root);
    report.defaultTargetRemoved = !check || !fs.existsSync(check.target);
    report.originalOwnersUnchanged = owners.every(
      (file) =>
        fs.readFileSync(path.join(root, file), "utf8") === originals[file],
    );
    report.baselineUnchanged =
      hash(fs.readFileSync(baseline.path)) === baseline.sha256;
    report.complete &&=
      !operationError &&
      !cleanupError &&
      report.worktreeRemoved &&
      report.defaultTargetRemoved &&
      report.originalOwnersUnchanged &&
      report.baselineUnchanged;
    save();
  }
  if (operationError || cleanupError)
    throw new AggregateError(
      [operationError, cleanupError].filter(Boolean),
      `Prepared smell controls failed: ${evidence}`,
    );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [cliBinary, cliReport, oldCliReport, evidence] = process.argv.slice(2);
  assert.ok(evidence);
  const report = cliSmellMutations({
    cliBinary,
    cliReport,
    oldCliReport,
    evidence: path.resolve(evidence),
  });
  console.log(
    JSON.stringify({
      detected: report.controls.length,
      complete: report.complete,
      removed: report.worktreeRemoved,
    }),
  );
}
