import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
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
import { cliReportsFaults } from "./cli-reports-faults.mjs";
import { cliSmellFaults } from "./cli-smell-faults.mjs";
import { collapseRenderCliFaults } from "./collapse-render-cli-faults.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  require = createRequire(import.meta.url),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const faults = [
  ...cliReportsFaults.map((f) => ({ ...f, suite: "reports" })),
  ...collapseRenderCliFaults
    .filter((f) => f.kind === "cli")
    .map((f) => ({ ...f, suite: "plain" })),
  {
    ...cliSmellFaults.find((f) => f.name === "cheap-mode-forces-edge-load"),
    suite: "smell",
  },
];
assert.equal(cliReportsFaults.length, 18);
assert.equal(faults.length, 26);
assert.equal(
  new Set(
    faults.map((f) => JSON.stringify([f.file, f.scope, f.edits, f.witness])),
  ).size,
  faults.length,
);
function changedOwner(original, fault) {
  let start = 0,
    end = original.length;
  if (fault.scope) {
    start = original.indexOf(fault.scope[0]);
    assert.ok(start >= 0);
    if (fault.scope[1]) {
      end = original.indexOf(fault.scope[1], start + fault.scope[0].length);
      assert.ok(end > start);
    }
  }
  let body = original.slice(start, end);
  for (const [before, after] of fault.edits) {
    assert.equal(
      body.split(before).length - 1,
      1,
      `${fault.name}: one intended site`,
    );
    body = body.replace(before, after);
  }
  return original.slice(0, start) + body + original.slice(end);
}
function run(command, args, cwd, env) {
  const r = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return {
    command: [command, ...args],
    cwd,
    exit: r.status,
    signal: r.signal,
    error: r.error?.message,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}
export function reportsMutations({
  cliBinary,
  cliReport,
  oldCliReport,
  oldSmellReport,
  evidence,
  sourceArchive,
  python = process.env.DEMLIK_ICU77_PYTHON,
}) {
  assert.ok(
    sourceArchive,
    "explicit ICU77 source archive is required before Cargo",
  );
  assert.ok(
    python,
    "scoped DEMLIK_ICU77_PYTHON (Python >=3.12) is required before Cargo",
  );
  const archive = fs.realpathSync(sourceArchive),
    pythonExecutable = fs.realpathSync(python);
  assert.ok(
    fs.statSync(archive).isFile(),
    "ICU77 source archive must be a file",
  );
  assert.ok(
    fs.statSync(pythonExecutable).isFile(),
    "ICU77 Python must be an executable file",
  );
  fs.accessSync(archive, fs.constants.R_OK);
  fs.accessSync(pythonExecutable, fs.constants.X_OK);
  assert.equal(
    fs.realpathSync(os.tmpdir()),
    "/private/tmp",
    "call this suite with scoped TMPDIR=/private/tmp, outside Git ignores",
  );
  fs.mkdirSync(evidence, { recursive: true });
  assert.equal(
    execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: root,
      encoding: "utf8",
    }),
    "",
  );
  const baselines = {
    reports: JSON.parse(fs.readFileSync(cliReport, "utf8")),
    plain: JSON.parse(fs.readFileSync(oldCliReport, "utf8")),
    smell: JSON.parse(fs.readFileSync(oldSmellReport, "utf8")),
  };
  assert.equal(baselines.reports.passed, 82);
  assert.equal(baselines.reports.strictPairs, 72);
  assert.equal(baselines.reports.qualifiedPairs, 5);
  assert.equal(baselines.reports.nativeOnlyCases, 5);
  assert.equal(baselines.plain.passed, 49);
  assert.equal(baselines.smell.passed, 50);
  const baseline = {
    path: fs.realpathSync(cliBinary),
    sha256: hash(fs.readFileSync(cliBinary)),
  };
  for (const r of Object.values(baselines)) {
    assert.deepEqual(r.failures, []);
    assert.equal(r.driverSha256, baseline.sha256);
  }
  const owners = [...new Set(faults.map((f) => f.file))],
    originals = Object.fromEntries(
      owners.map((file) => [
        file,
        fs.readFileSync(path.join(root, file), "utf8"),
      ]),
    );
  const audit = faults.map((f) => ({
    name: f.name,
    file: f.file,
    witness: f.witness,
    suite: f.suite,
    scope: f.scope ?? null,
    sourceSha256: hash(originals[f.file]),
    mutantSourceSha256: hash(changedOwner(originals[f.file], f)),
  }));
  fs.writeFileSync(
    path.join(evidence, "sites.json"),
    `${JSON.stringify(audit, null, 2)}\n`,
  );
  const env = cargoCheckEnvironment({
    TMPDIR: "/private/tmp",
    CARGO_NET_OFFLINE: "true",
    CARGO_BUILD_JOBS: "1",
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    DEMLIK_ICU77_PYTHON: pythonExecutable,
    RUST_ICU_MAJOR_VERSION_NUMBER: "77",
  });
  const report = {
    planned: 26,
    newPlanned: 18,
    affectedOldPlanned: 8,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    cargoSelections: 0,
    nativePreparations: 0,
    baseline,
    controls: [],
    complete: false,
    tmpdir: env.TMPDIR,
    mutantLibraryRetention:
      "hash/Cargo producer only; library bytes NOT retained",
    consumerRetention:
      "actual executed control drivers retained gzip before overwrite",
  };
  const save = () =>
    fs.writeFileSync(
      path.join(evidence, "controls.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  const start = performance.now();
  let check, operationError, cleanupError;
  try {
    check = createCheckWorktree(root, "cli-reports-controls", evidence);
    fs.mkdirSync(path.join(check.target, "parity"), { recursive: true });
    for (const relative of [
      "node_modules",
      "packages/code-graph/node_modules",
      "verification/parity/node_modules",
    ]) {
      const from = path.join(root, relative),
        to = path.join(check.root, relative);
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.symlinkSync(fs.realpathSync(from), to);
      }
    }
    env.RUST_ICU_LINK_SEARCH_DIR = path.join(check.target, "icu77/install/lib");
    env.DEMLIK_ICU77_PREPARED = path.join(check.target, "icu77/prepared.json");
    report.active = { status: "native-preparation" };
    report.nativePreparations++;
    save();
    const prepared = run(
      pythonExecutable,
      [
        "tools/icu77/prepare.py",
        "prepare",
        "--host",
        "aarch64-apple-darwin",
        "--target",
        "aarch64-apple-darwin",
        "--source-archive",
        archive,
        "--cargo",
        process.env.CARGO ?? "cargo",
      ],
      check.root,
      env,
    );
    fs.writeFileSync(
      path.join(evidence, "native-preparation.stdout"),
      prepared.stdout ?? "",
    );
    fs.writeFileSync(
      path.join(evidence, "native-preparation.stderr"),
      prepared.stderr ?? "",
    );
    report.nativePreparation = {
      ...prepared,
      stdout: undefined,
      stderr: undefined,
      sourceArchive: archive,
      python: pythonExecutable,
      stamp: env.DEMLIK_ICU77_PREPARED,
      linkSearch: env.RUST_ICU_LINK_SEARCH_DIR,
      major: env.RUST_ICU_MAJOR_VERSION_NUMBER,
      semanticCredit: 0,
    };
    save();
    assert.equal(prepared.error, undefined);
    assert.equal(prepared.signal, null);
    assert.equal(
      prepared.exit,
      0,
      "native preparation failure earns no mutation credit",
    );
    delete report.active;
    for (const fault of faults) {
      for (const [file, text] of Object.entries(originals))
        fs.writeFileSync(path.join(check.root, file), text);
      const changed = changedOwner(originals[fault.file], fault);
      fs.writeFileSync(path.join(check.root, fault.file), changed);
      const folder = path.join(evidence, fault.name);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, "mutated-owner.rs"), changed);
      report.active = {
        id: fault.name,
        file: fault.file,
        witness: fault.witness,
        status: "building",
      };
      save();
      try {
        console.log(`building ${fault.name}`);
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
        fs.writeFileSync(path.join(folder, "cargo.jsonl"), built.stdout ?? "");
        fs.writeFileSync(path.join(folder, "cargo.stderr"), built.stderr ?? "");
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
          `${fault.name}: compiler/setup failure is zero credit`,
        );
        const events = built.stdout.split("\n").filter(Boolean).map(JSON.parse),
          library = compiledCheckLibrary(
            events,
            "demlik_code_graph",
            check.root,
            check.target,
          ),
          consumers = events.filter(
            (r) =>
              r.reason === "compiler-artifact" &&
              r.target.name === "collapse_cli_driver" &&
              r.executable,
          );
        assert.equal(consumers.length, 1);
        const consumer = consumers[0];
        assert.equal(consumer.fresh, false);
        assertCheckPath(consumer.target.src_path, check.root);
        assertCheckPath(consumer.manifest_path, check.root);
        const executable = assertCheckPath(consumer.executable, check.target),
          bytes = fs.readFileSync(executable),
          retained = path.join(folder, "executed-driver.gz");
        fs.writeFileSync(retained, gzipSync(bytes));
        const binary = {
            actual: executable,
            sha256: hash(bytes),
            bytes: bytes.length,
            retainedCompressed: retained,
            compressedSha256: hash(fs.readFileSync(retained)),
            artifact: consumer,
          },
          libraryBinding = {
            actual: library.path,
            sha256: hash(fs.readFileSync(library.path)),
            bytes: fs.statSync(library.path).size,
            artifact: library.artifact,
            bytesRetained: false,
          };
        report.active = {
          ...report.active,
          status: "comparing",
          library: libraryBinding,
          consumer: binary,
        };
        save();
        const spec = {
          reports: ["graph-cli-reports.mjs", "DEMLIK_REPORT_CLI_CASES"],
          plain: [
            "graph-cli-plain-collapse.mjs",
            "DEMLIK_PLAIN_COLLAPSE_CASES",
          ],
          smell: ["graph-cli-smell.mjs", "DEMLIK_SMELL_CLI_CASES"],
        }[fault.suite];
        const script = assertCheckPath(
            path.join(check.root, "verification/parity", spec[0]),
            check.root,
          ),
          paired = path.join(folder, "pairs.json");
        const compared = run(
          process.execPath,
          ["--import", require.resolve("tsx"), script, executable, paired],
          check.root,
          { ...env, [spec[1]]: fault.witness },
        );
        fs.writeFileSync(
          path.join(folder, "comparison.json"),
          `${JSON.stringify(compared, null, 2)}\n`,
        );
        assert.equal(compared.error, undefined);
        assert.equal(compared.signal, null);
        assert.equal(compared.exit, 1, "semantic comparer must fail visibly");
        const result = JSON.parse(fs.readFileSync(paired, "utf8")),
          witness = result.cases.find((row) => row.id === fault.witness),
          baselineRow = baselines[fault.suite].cases.find(
            (row) => row.id === fault.witness,
          );
        assert.ok(baselineRow?.passed && !baselineRow.nativeOnly);
        assert.ok(witness && !witness.passed);
        assert.ok(
          result.failures.some(
            (row) => row.id === fault.witness && row.kind === "semantic",
          ),
        );
        assert.equal(result.driverSha256, binary.sha256);
        assert.ok(witness.native.length && witness.source.length);
        assert.equal(hash(fs.readFileSync(executable)), binary.sha256);
        for (const n of witness.native) {
          assert.equal(n.output.signal, null);
          assert.ok([0, 1, 2, 7].includes(n.output.status));
          assert.ok(n.trace.observedCalls.length);
        }
        const qualifications = baselineRow.qualifications ?? [];
        report.controls.push({
          id: fault.name,
          owner: fault.file,
          witness: fault.witness,
          contract: fault.contract ?? "preserved inherited CLI contract",
          suite: fault.suite,
          compileExit: 0,
          protocolValid: true,
          semanticMismatch: true,
          baselineQualifications: qualifications,
          strictCredit: qualifications.length === 0,
          library: libraryBinding,
          consumer: binary,
          comparison: paired,
        });
        delete report.active;
        console.log(`detected ${fault.name}`);
        save();
      } finally {
        for (const [file, text] of Object.entries(originals))
          fs.writeFileSync(path.join(check.root, file), text);
        assert.ok(
          owners.every(
            (file) =>
              fs.readFileSync(path.join(check.root, file), "utf8") ===
              originals[file],
          ),
        );
      }
    }
    report.complete = report.controls.length === 26;
  } catch (error) {
    operationError = error;
    report.operationFailure = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  } finally {
    if (check) {
      try {
        const native = path.join(check.target, "icu77");
        for (const file of [
          "prepared.json",
          "attempt.json",
          "metadata.stdout",
          "metadata.stderr",
        ]) {
          const from = path.join(native, file);
          if (fs.existsSync(from))
            fs.copyFileSync(from, path.join(evidence, `native-${file}`));
        }
        if (fs.existsSync(path.join(native, "logs")))
          fs.cpSync(
            path.join(native, "logs"),
            path.join(evidence, "native-preparation-logs"),
            { recursive: true },
          );
      } catch (error) {
        report.preparationProvenanceFailure = {
          name: error.name,
          message: error.message,
        };
        operationError ??= error;
      }
      try {
        for (const [file, text] of Object.entries(originals))
          fs.writeFileSync(path.join(check.root, file), text);
        report.checkOwnersRestored = owners.every(
          (file) =>
            fs.readFileSync(path.join(check.root, file), "utf8") ===
            originals[file],
        );
      } catch (error) {
        report.ownerRestoreFailure = {
          name: error.name,
          message: error.message,
        };
        operationError ??= error;
      }
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
      `Console report controls failed: ${evidence}`,
    );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [
    cliBinary,
    cliReport,
    oldCliReport,
    oldSmellReport,
    evidence,
    sourceArchive,
  ] = process.argv.slice(2);
  assert.ok(
    evidence && sourceArchive && process.argv.length === 8,
    "usage: cli-reports-mutations.mjs <binary> <report> <old-cli-report> <old-smell-report> <evidence> <icu77-source-archive>; set DEMLIK_ICU77_PYTHON",
  );
  const r = reportsMutations({
    cliBinary,
    cliReport,
    oldCliReport,
    oldSmellReport,
    evidence: path.resolve(evidence),
    sourceArchive,
  });
  console.log(
    JSON.stringify({
      detected: r.controls.length,
      complete: r.complete,
      removed: r.worktreeRemoved,
    }),
  );
}
