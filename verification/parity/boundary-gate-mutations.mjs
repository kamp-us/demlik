import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseline = process.argv[2];
assert.ok(baseline, "provide the baseline boundary gate driver");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const require = createRequire(import.meta.url);
const directory = await mkdtemp(
  path.join(tmpdir(), "demlik-boundary-gate-faults-"),
);
const workspace = path.join(directory, "workspace");
const target = path.join(root, "target/parity/boundary-gate-mutation-build");
const baselineTarget = path.resolve(
  process.env.CARGO_TARGET_DIR ?? path.join(root, "target"),
);
assert.notEqual(
  path.resolve(target),
  baselineTarget,
  "baseline and mutation Cargo targets must differ",
);
const owner = "crates/code-graph/src/boundaries/gate.rs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const controls = [
  {
    name: "raw-project-root-is-replaced-before-refusal",
    file: "crates/code-graph/src/project.rs",
    before: "let display = root_text\n            .cloned()",
    after: "let display = None::<&JsString>\n            .cloned()",
    witness: "refusal.raw-scope-root",
    nativeTest:
      "missing_configuration_retains_the_declared_root_after_the_input_is_dropped",
  },
  {
    name: "inherited-folder-precheck-is-unconditional",
    file: "crates/code-graph/src/boundaries/rules.rs",
    before:
      "Self::Inherited if held.iter().any(is_port_folder) => Err(ZoningError::ListedFolders)",
    after: "Self::Inherited if true => Err(ZoningError::ListedFolders)",
    witness: "inherited.feature-folders.non-port.toString",
  },
  {
    name: "inherited-folder-refusal-runs-too-late",
    file: "crates/code-graph/src/boundaries/rules.rs",
    before:
      "Self::Inherited if held.iter().any(is_port_folder) => Err(ZoningError::ListedFolders)",
    after: "Self::Inherited if held.iter().any(is_port_folder) => Ok(None)",
    witness: "inherited.feature-folders.toString",
  },
  {
    name: "migration-measures-only-requested-scope",
    before: '&scopes_under(&declared, &".".into()),',
    after:
      "&scopes_under(&declared, &scope_of(&args.repo_root.to_string_lossy().as_ref().into(), &args.root_absolute.to_string_lossy().as_ref().into()).map_err(BoundaryGateError::Io)?),",
    witness: "workflow.migrate.true.false",
  },

  {
    name: "retired-mode-reads-config",
    before: "if flags.write_ceilings {",
    after: "if false && flags.write_ceilings {",
    witness: "flags.2.absent",
  },
  {
    name: "accept-reason-is-not-trimmed",
    before: "flags.reason.map(JsString::trim_js).unwrap_or_default()",
    after: "flags.reason.cloned().unwrap_or_default()",
    witness: 'reason." \\t\\r\\n"',
  },
  {
    name: "scope-skips-source-files",
    before: "let loaded = if reads_files {",
    after: "let loaded = if false && reads_files {",
    witness: "report.false.false..",
  },
  {
    name: "unlisted-port-folder-ignored",
    before: "if folders.is_defined()",
    after: "if false && folders.is_defined()",
    witness: "refusal.unlistedPort",
  },
  {
    name: "unknown-driven-file-is-accepted",
    before: "if !unread.is_empty() {",
    after: "if false && !unread.is_empty() {",
    witness: "refusal.unknownDriven",
  },
  {
    name: "worker-graph-leaks-into-narrow-scope",
    before: '&& under == "."',
    after: "&& true",
    witness: "workers.true.false.services/a",
  },
  {
    name: "gate-keeps-pruned-ledger-bytes",
    before: "if !result.pruned.is_empty() {",
    after: "if false && !result.pruned.is_empty() {",
    witness: "workflow.accept-prune.true.false",
  },
  {
    name: "accept-drops-unrecorded-crossings",
    before: "&with_accepted(&result.kept, &result.unrecorded, &reason),",
    after: "&result.kept,",
    witness: "workflow.accept-prune.true.false",
  },
  {
    name: "migration-retains-legacy-file",
    before: "fs::remove_file(&legacy_file).map_err(BoundaryGateError::Io)?;",
    after: "let _ = &legacy_file;",
    witness: "workflow.migrate.true.false",
  },
  {
    name: "boundary-config-skips-declarations",
    file: "crates/code-graph/src/boundaries/config.rs",
    before:
      "match super::declaration::declaration_issue(&rules).map_err(BoundaryConfigError::Declaration)?",
    after: "match Ok::<_, BoundaryConfigError>(None)?",
    witness: "config.duplicate",
  },
];
async function compare(binary, name) {
  const reportFile = path.join(
    root,
    `target/parity/boundary-gate-${name}.json`,
  );
  await rm(reportFile, { force: true });
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(root, "verification/parity/graph-boundary-gate.mts"),
      binary,
      reportFile,
    ],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 240000,
    },
  );
  if (run.error) throw run.error;
  assert.ok(
    run.status === 0 || run.status === 1,
    `${name}: verifier process failed`,
  );
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(
    run.status,
    report.failures.length ? 1 : 0,
    `${name}: unreported verifier failure`,
  );
  return { report, reportFile };
}
try {
  await mkdir(path.join(root, "target/parity"), { recursive: true });
  const baselineHash = hash(await readFile(baseline));
  const clean = await compare(baseline, "baseline");
  assert.equal(
    clean.report.failures.length,
    0,
    "baseline must match source before fault injection",
  );
  await mkdir(workspace);
  for (const item of [
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "crates",
  ])
    await cp(path.join(root, item), path.join(workspace, item), {
      recursive: true,
    });
  const originals = new Map();
  for (const control of controls) {
    const file = control.file ?? owner;
    if (!originals.has(file))
      originals.set(file, await readFile(path.join(root, file), "utf8"));
  }
  const results = [];
  for (const control of controls) {
    for (const [file, original] of originals)
      await writeFile(path.join(workspace, file), original);
    const file = control.file ?? owner,
      original = originals.get(file);
    assert.equal(
      original.split(control.before).length,
      2,
      `${control.name}: unique fault site`,
    );
    const changed = original.replace(control.before, control.after);
    await writeFile(path.join(workspace, file), changed);
    execFileSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "boundary_gate_driver",
      ],
      {
        cwd: workspace,
        stdio: "pipe",
        timeout: 240000,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: target,
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      },
    );
    const result = await compare(
      path.join(target, "debug/examples/boundary_gate_driver"),
      control.name,
    );
    const witness = result.report.failures.find(
      (failure) => failure.id === control.witness,
    );
    assert.ok(witness, `${control.name}: intended behavior witness escaped`);
    assert.ok(
      witness.native.every(
        (step) => step.answer?.error?.kind !== "driver-error",
      ),
      `${control.name}: a protocol refusal is not a behavioral witness`,
    );
    let nativeConsumer;
    if (control.nativeTest) {
      const checked = spawnSync(
        process.env.CARGO ?? "cargo",
        [
          "test",
          "--locked",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--test",
          "project",
          control.nativeTest,
          "--",
          "--exact",
        ],
        {
          cwd: workspace,
          encoding: "utf8",
          timeout: 240000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            CARGO_TARGET_DIR: target,
            CARGO_PROFILE_DEV_DEBUG: "0",
            CARGO_PROFILE_TEST_DEBUG: "0",
            CARGO_INCREMENTAL: "0",
            CARGO_BUILD_JOBS: "1",
          },
        },
      );
      assert.equal(
        checked.status,
        101,
        `${control.name}: a real native assertion must fail`,
      );
      assert.match(checked.stdout, /test result: FAILED\. 0 passed; 1 failed/);
      assert.doesNotMatch(checked.stderr, /could not compile/);
      const log = `${checked.stdout}\n${checked.stderr}`;
      const logFile = path.join(
        root,
        "target/parity/boundary-gate-raw-owner-mutant.log",
      );
      await writeFile(logFile, log);
      nativeConsumer = {
        test: control.nativeTest,
        compiled: true,
        assertionDetected: true,
        logFile,
        sha256: hash(log),
      };
    }
    results.push({
      name: control.name,
      witness: control.witness,
      buildSucceeded: true,
      detected: true,
      changedCases: result.report.failures.length,
      reportFile: result.reportFile,
      sourceSha256: hash(original),
      mutantSha256: hash(changed),
      ...(nativeConsumer ? { nativeConsumer } : {}),
    });
    process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
  }
  assert.equal(hash(await readFile(baseline)), baselineHash);
  for (const [file, original] of originals)
    assert.equal(await readFile(path.join(root, file), "utf8"), original);
  const receipt = {
    baselineDriverUnchanged: true,
    baselineDriverHash: baselineHash,
    baselineMatchesSource: true,
    detected: results.length,
    escaped: 0,
    controls: results,
  };
  if (process.argv[3])
    await writeFile(process.argv[3], `${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
