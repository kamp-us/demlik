import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

export const faults = [
  {
    id: "reverse-read-name",
    owner: "crates/code-graph/src/env_keys/extract.rs",
    needle: ".compare(an, bn)",
    replacement: ".compare(bn, an)",
    witness: "scan-raw-name-order",
  },
  {
    id: "reverse-occurrence-files",
    owner: "crates/code-graph/src/env_keys/extract.rs",
    needle: "keyed.sort_by(|(_, a), (_, b)| collation.compare(a, b));",
    replacement: "keyed.sort_by(|(_, a), (_, b)| collation.compare(b, a));",
    witness: "scan-occurrence-entries",
  },
  {
    id: "reverse-withheld-key",
    owner: "crates/code-graph/src/env_keys/query.rs",
    needle:
      "collation\n            .compare(ak, bk)\n            .then_with(|| a.reason",
    replacement:
      "collation\n            .compare(bk, ak)\n            .then_with(|| a.reason",
    witness: "query-withheld-merge",
  },
  {
    id: "initialize-before-admission",
    owner: "crates/code-graph/src/env_keys/query.rs",
    needle: "    let source =\n        load_cheap_project",
    replacement:
      "    let _ = request().map_err(EnvKeyError::Collation)?;\n    let source =\n        load_cheap_project",
    witness:
      "env_keys::query::icu77_probe::catalog_refusal_precedes_initialization_after_source_parse_failure",
    nativeOnly: true,
  },
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function main() {
  const [
    baselineFixture,
    baselineCli,
    baselineReport,
    frozenSource,
    archive,
    output,
  ] = process.argv.slice(2);
  assert.equal(process.argv.length, 8);
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  assert.equal(fs.realpathSync(os.tmpdir()), "/private/tmp");
  const root = fs.realpathSync(
    fileURLToPath(new URL("../..", import.meta.url)),
  );
  const evidence = path.resolve(output);
  fs.mkdirSync(evidence, { recursive: true });
  assert.ok(fs.statSync(archive).isFile());
  assert.ok(fs.statSync(process.env.DEMLIK_ICU77_PYTHON).isFile());
  const trusted = JSON.parse(fs.readFileSync(baselineReport, "utf8"));
  const baselineHashes = {
    fixture: hash(fs.readFileSync(baselineFixture)),
    cli: hash(fs.readFileSync(baselineCli)),
  };
  assert.deepEqual(trusted.binaryHashes, baselineHashes);
  assert.deepEqual(trusted.finalBinaryHashes, baselineHashes);
  assert.equal(trusted.passed, 18);
  assert.equal(trusted.attempted, 18);
  assert.deepEqual(trusted.failures, []);
  assert.equal(trusted.sourceReportSha256, hash(fs.readFileSync(frozenSource)));
  const originals = Object.fromEntries(
    [...new Set(faults.map((row) => row.owner))].map((owner) => [
      owner,
      fs.readFileSync(path.join(root, owner), "utf8"),
    ]),
  );
  for (const fault of faults) {
    assert.equal(
      originals[fault.owner].split(fault.needle).length,
      2,
      fault.id,
    );
    assert.notEqual(fault.needle, fault.replacement);
    if (!fault.nativeOnly)
      assert.equal(
        trusted.cases.find((row) => row.id === fault.witness)?.passed,
        true,
      );
  }
  const report = {
    sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim(),
    baselineHashes,
    baselineReport,
    frozenSource,
    originalSources: Object.fromEntries(
      Object.entries(originals).map(([file, text]) => [file, hash(text)]),
    ),
    planned: 4,
    cargoSelections: 0,
    nativePreparations: 0,
    controls: [],
    complete: false,
  };
  const save = () =>
    fs.writeFileSync(
      path.join(evidence, "controls.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  function invoke(name, program, args, cwd, env) {
    const start = Date.now();
    const child = spawnSync(program, args, { cwd, env, maxBuffer: 128 << 20 });
    const stdout = path.join(evidence, `${name}.stdout`);
    const stderr = path.join(evidence, `${name}.stderr`);
    fs.writeFileSync(stdout, child.stdout ?? "");
    fs.writeFileSync(stderr, child.stderr ?? "");
    const record = {
      command: [program, ...args],
      cwd,
      exit: child.status,
      signal: child.signal,
      error: child.error?.message,
      milliseconds: Date.now() - start,
      stdout,
      stdoutSha256: hash(fs.readFileSync(stdout)),
      stderr,
      stderrSha256: hash(fs.readFileSync(stderr)),
      environment: Object.fromEntries(
        Object.entries(env).filter(([key]) =>
          [
            "PATH",
            "RUSTUP_HOME",
            "CARGO_HOME",
            "RUSTUP_TOOLCHAIN",
            "CARGO_NET_OFFLINE",
            "CARGO_BUILD_JOBS",
            "CARGO_INCREMENTAL",
            "CARGO_PROFILE_DEV_DEBUG",
            "CARGO_PROFILE_TEST_DEBUG",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "TZ",
            "DEMLIK_ICU77_PYTHON",
            "RUST_ICU_MAJOR_VERSION_NUMBER",
            "RUST_ICU_LINK_SEARCH_DIR",
            "DEMLIK_ICU77_PREPARED",
          ].includes(key),
        ),
      ),
    };
    fs.writeFileSync(
      path.join(evidence, `${name}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    return {
      ...record,
      text: child.stdout?.toString("utf8") ?? "",
      errorText: child.stderr?.toString("utf8") ?? "",
    };
  }
  function retain(file) {
    const bytes = fs.readFileSync(file),
      sha256 = hash(bytes),
      retained = path.join(evidence, `${sha256}.gz`);
    if (!fs.existsSync(retained)) fs.writeFileSync(retained, gzipSync(bytes));
    return {
      actual: file,
      retained,
      sha256,
      gzipSha256: hash(fs.readFileSync(retained)),
      bytes: bytes.length,
    };
  }
  let check, runtime, operationError, cleanupError;
  function restore() {
    for (const [owner, text] of Object.entries(originals)) {
      fs.writeFileSync(path.join(check.root, owner), text);
      assert.equal(
        hash(fs.readFileSync(path.join(check.root, owner))),
        report.originalSources[owner],
      );
    }
  }
  save();
  try {
    check = createCheckWorktree(root, "icu77-env-keys-controls", evidence);
    runtime = path.join(path.dirname(check.root), "runtime");
    fs.mkdirSync(runtime);
    for (const dir of [
      "node_modules",
      "packages/code-graph/node_modules",
      "packages/tea/node_modules",
      "verification/parity/node_modules",
    ])
      if (fs.existsSync(path.join(root, dir)))
        fs.symlinkSync(
          fs.realpathSync(path.join(root, dir)),
          path.join(check.root, dir),
        );
    fs.mkdirSync(path.join(check.target, "tmp"), { recursive: true });
    const env = cargoCheckEnvironment({
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      CARGO_BUILD_JOBS: "1",
      CARGO_INCREMENTAL: "0",
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TZ: "UTC",
      TMPDIR: path.join(check.target, "tmp"),
      RUST_ICU_MAJOR_VERSION_NUMBER: "77",
      RUST_ICU_LINK_SEARCH_DIR: path.join(check.target, "icu77/install/lib"),
      DEMLIK_ICU77_PREPARED: path.join(check.target, "icu77/prepared.json"),
    });
    for (const key of [
      "CARGO_TARGET_DIR",
      "DEMLIK_MUTATION_TARGET_DIR",
      "CARGO_BUILD_TARGET_DIR",
      "CARGO_BUILD_BUILD_DIR",
    ])
      assert.equal(env[key], undefined);
    const preparation = invoke(
      "native-prepare",
      env.DEMLIK_ICU77_PYTHON,
      [
        "tools/icu77/prepare.py",
        "prepare",
        "--host",
        "aarch64-apple-darwin",
        "--target",
        "aarch64-apple-darwin",
        "--source-archive",
        path.resolve(archive),
      ],
      check.root,
      env,
    );
    report.nativePreparations++;
    save();
    assert.equal(preparation.exit, 0, "preparation failures earn no credit");
    fs.copyFileSync(
      env.DEMLIK_ICU77_PREPARED,
      path.join(evidence, "native-prepared.json"),
    );
    for (const fault of faults) {
      restore();
      const changed = originals[fault.owner].replace(
        fault.needle,
        fault.replacement,
      );
      fs.writeFileSync(path.join(check.root, fault.owner), changed);
      fs.writeFileSync(path.join(evidence, `${fault.id}.rs`), changed);
      const build = invoke(
        `${fault.id}-cargo`,
        env.CARGO,
        [
          "test",
          "--locked",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--lib",
          "--test",
          "cli_env_keys",
          "--no-run",
          "--message-format=json",
        ],
        check.root,
        env,
      );
      report.cargoSelections++;
      save();
      assert.equal(build.exit, 0, "compiler failures earn no semantic credit");
      const events = build.text.split("\n").filter(Boolean).map(JSON.parse);
      const library = compiledCheckLibrary(
        events,
        "demlik_code_graph",
        check.root,
        check.target,
      );
      const consumers = events.filter(
        (event) =>
          event.reason === "compiler-artifact" &&
          event.target.name === "demlik_code_graph" &&
          event.executable &&
          event.profile.test,
      );
      assert.equal(consumers.length, 1);
      const consumer = consumers[0];
      assert.equal(consumer.fresh, false);
      const executable = assertCheckPath(consumer.executable, check.target);
      const selected = {
        library: {
          event: library.artifact,
          ...retain(library.path),
          linkedIntoExecutedLibtest: false,
        },
        consumer: {
          event: consumer,
          ...retain(executable),
          sameModifiedOwnerCompiledAsLibtest: true,
        },
      };
      fs.writeFileSync(
        path.join(evidence, `${fault.id}-selection.json`),
        `${JSON.stringify(selected, null, 2)}\n`,
      );
      const runtimeEnv = cargoCheckEnvironment({ ...env, TMPDIR: runtime });
      let observation;
      if (fault.nativeOnly) {
        const run = invoke(
          `${fault.id}-run`,
          executable,
          [fault.witness, "--exact", "--nocapture", "--test-threads=1"],
          check.root,
          runtimeEnv,
        );
        assert.equal(run.exit, 101);
        assert.ok(run.text.includes(`${fault.witness} ... FAILED`));
        assert.ok(run.text.includes("0 passed; 1 failed"));
        assert.ok(
          run.errorText.includes("catalog refusal precedes initialization"),
        );
        observation = {
          nativeOnly: true,
          sourceCredit: 0,
          namedAssertion: fault.witness,
          process: run,
        };
      } else {
        const pairs = path.join(evidence, `${fault.id}-pairs.json`);
        const run = invoke(
          `${fault.id}-run`,
          process.execPath,
          [
            "--import",
            fs.realpathSync(
              path.join(
                check.root,
                "verification/parity/node_modules/tsx/dist/loader.mjs",
              ),
            ),
            path.join(check.root, "verification/parity/icu77-env-keys.mjs"),
            executable,
            path.resolve(baselineCli),
            path.resolve(frozenSource),
            pairs,
          ],
          check.root,
          runtimeEnv,
        );
        assert.equal(run.exit, 1);
        const observed = JSON.parse(fs.readFileSync(pairs, "utf8"));
        assert.equal(observed.attempted, 18);
        assert.equal(observed.sourceReportSha256, trusted.sourceReportSha256);
        assert.equal(observed.binaryHashes.fixture, selected.consumer.sha256);
        assert.equal(observed.binaryHashes.cli, baselineHashes.cli);
        const witness = observed.cases.find((row) => row.id === fault.witness),
          baseline = trusted.cases.find((row) => row.id === fault.witness);
        assert.equal(witness.passed, false);
        assert.equal(witness.actual.ok, true);
        assert.deepEqual(witness.input, baseline.input);
        assert.deepEqual(witness.expected, baseline.expected);
        assert.notDeepEqual(witness.actual, witness.expected);
        assert.ok(witness.observedCalls.length);
        assert.ok(
          witness.processes.every(
            (process) => process.status === 0 && process.signal === null,
          ),
        );
        assert.ok(observed.failures.some((row) => row.id === fault.witness));
        observation = {
          nativeOnly: false,
          sourceCredit: 0,
          strictSemanticDetection: true,
          witness: fault.witness,
          pairs,
          process: run,
        };
      }
      report.controls.push({
        id: fault.id,
        owner: fault.owner,
        modifiedSourceSha256: hash(changed),
        compileExit: 0,
        selected,
        observation,
      });
      assert.equal(
        hash(fs.readFileSync(baselineFixture)),
        baselineHashes.fixture,
      );
      assert.equal(hash(fs.readFileSync(baselineCli)), baselineHashes.cli);
      save();
      console.log(
        JSON.stringify({
          id: fault.id,
          detected: true,
          nativeOnly: Boolean(fault.nativeOnly),
        }),
      );
    }
    report.complete = report.controls.length === 4;
    save();
  } catch (error) {
    operationError = error;
    report.operationFailure = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    save();
  } finally {
    if (check) {
      try {
        restore();
        report.sourcesRestored = true;
        if (runtime) fs.rmSync(runtime, { recursive: true, force: true });
        check.remove();
      } catch (error) {
        cleanupError = error;
        report.cleanupFailure = {
          name: error.name,
          message: error.message,
          stack: error.stack,
        };
      }
    }
    save();
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
