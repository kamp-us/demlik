import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseline = process.argv[2],
  reportFile = process.argv[3];
assert.ok(baseline, "provide the compiled baseline cli_frontdoor_driver");
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "demlik-cli-frontdoor-faults-"),
);
const workspace = path.join(directory, "workspace");
const target = path.join(root, "target/parity/cli-frontdoor-mutation-build");
const binary = path.join(target, "debug/examples/cli_frontdoor_driver");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baselineHash = hash(fs.readFileSync(baseline));
const original = new Map(
  ["cli/io.rs", "cli/frontdoor.rs"].map((file) => [
    file,
    fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
  ]),
);
const environment = {
  ...process.env,
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
  CARGO_TARGET_DIR: target,
};
const controls = [];
const mutations = [
  {
    name: "threshold-refusal-skipped",
    file: "cli/frontdoor.rs",
    before: "resolve_thresholds(options.thresholds())",
    after: "resolve_thresholds(None)",
    witness: "preflight.8",
  },
  {
    name: "node-kind-refusal-skipped",
    file: "cli/frontdoor.rs",
    before: "resolve_node_kind_rules(options.node_kinds())",
    after: "resolve_node_kind_rules(None)",
    witness: "preflight.9",
  },
  {
    name: "entry-preset-refusal-skipped",
    file: "cli/frontdoor.rs",
    before: "with_entry_presets(rules, options.entry_preset())",
    after: "with_entry_presets(rules, &[])",
    witness: "preflight.10",
  },
  {
    name: "collapse-refusal-skipped",
    file: "cli/frontdoor.rs",
    before: "resolve_collapse_settings(options.collapse_config())",
    after: "resolve_collapse_settings(None)",
    witness: "preflight.11",
  },
  {
    name: "stat-refusal-loses-resolved-path",
    file: "cli/frontdoor.rs",
    before:
      "PreflightRefusal::NoSuchPath {\n                    path: resolved,",
    after:
      "PreflightRefusal::NoSuchPath {\n                    path: target.clone(),",
    witness: "preflight.4",
  },
  {
    name: "ordinary-file-accepted-as-directory",
    file: "cli/frontdoor.rs",
    before: "if !stat.is_dir() {",
    after: "if false && !stat.is_dir() {",
    witness: "preflight.5",
  },
  {
    name: "prepared-root-keeps-symlink",
    file: "cli/frontdoor.rs",
    before:
      "let root_absolute = real_path(&resolved).map_err(|source| FrontdoorError::Realpath {\n        path: resolved,\n        source,\n    })?;",
    after: "let _ = real_path;\n    let root_absolute = resolved;",
    witness: "continue.symlink-root",
  },
  {
    name: "default-options-incorrectly-given",
    scope: "api",
    file: "cli/frontdoor.rs",
    before: ".given()",
    after: ".keys()",
    witness: "api.relative",
  },
  {
    name: "explicit-given-order-reversed",
    scope: "api",
    file: "cli/frontdoor.rs",
    edits: [
      ["let given = self", "let mut given = self"],
      [
        ".collect::<Vec<_>>();\n        let result = {",
        ".collect::<Vec<_>>();\n        given.reverse();\n        let result = {",
      ],
    ],
    witness: "preflight.16",
  },
  {
    name: "out-file-opened-before-api-preconditions",
    scope: "api",
    file: "cli/frontdoor.rs",
    before: "let output = output_to(self.options.out());",
    after:
      'let output = output_to(self.options.out());\n            if let Some(destination) = self.options.out() { let _ = std::fs::write(destination.to_lossy(), b""); }',
    witness: "api.stray-does-not-open-out",
  },
  {
    name: "immediate-parser-help-drains-pending-stdio",
    file: "cli/frontdoor.rs",
    before: "Self::Parser(exit) => i32::from(exit.exit_code),",
    after: "Self::Parser(exit) => {let _ = exit; host.normal_exit_code()},",
    witness: "help.stdout-bad",
  },
  {
    name: "pending-stdio-failure-ignored",
    file: "cli/io.rs",
    before: "if self.pending.is_empty() {",
    after: "if true {",
    witness: "api.stdout-bad",
  },
  {
    name: "empty-write-does-not-reach-writer",
    file: "cli/io.rs",
    before: "writer.write(&[]).map(|_| ())",
    after: "Ok(())",
    witness: "helper.empty-stdout-bad",
  },
  {
    name: "file-banner-counts-utf16-units",
    file: "cli/io.rs",
    before: "bytes.len()));",
    after: "payload.units().len()));",
    witness: "helper.out",
  },
  {
    name: "exit-zero-check-after-int32-wrap",
    file: "cli/io.rs",
    before: "if code != 0.0 {",
    after: "if (code as i64) as i32 != 0 {",
    witness: "exit.6",
  },
  {
    name: "unsafe-exit-code-accepted",
    file: "cli/io.rs",
    before: "requested.abs() > 9_007_199_254_740_991.0",
    after: "requested.abs() > 18_014_398_509_481_982.0",
    witness: "exit.8",
  },
  {
    name: "exit-code-saturates-instead-of-int32-wrap",
    file: "cli/io.rs",
    before: "Some((requested as i64) as i32)",
    after: "Some(requested as i32)",
    witness: "exit.5",
  },
  {
    name: "warning-newline-lost",
    scope: "api",
    file: "cli/frontdoor.rs",
    before: 'line.push_str("\\n");',
    after: 'line.push_str("");',
    witness: "api.warning",
  },
  {
    name: "pending-stream-notification-order-reversed",
    file: "cli/io.rs",
    before: "self.pending.push(StdioFailure {",
    after: "self.pending.insert(0, StdioFailure {",
    witness: "api.warning-both-bad",
  },
  {
    name: "clean-exit-requests-wrong-code",
    file: "cli/io.rs",
    before: "host.exit.assign(2.0)",
    after: "host.exit.assign(1.0)",
    witness: "preflight.4",
  },
  {
    name: "stdio-refusal-reclassified-as-api-catch",
    file: "cli/io.rs",
    before: "host.write_stdout(payload);\n            return Ok(());",
    after:
      'host.write_stdout(payload);\n            if !host.pending_stdio_failures().is_empty() {return Err(ApiError::Io {path: "stdout".into(),source:io::Error::new(io::ErrorKind::BrokenPipe,"wrong synchronous catch")});}\n            return Ok(());',
    witness: "api.stdout-bad",
  },
  {
    name: "empty-api-value-incorrectly-inactive",
    scope: "api",
    file: "cli/frontdoor.rs",
    before: "api: self.options.api(),",
    after: "api: self.options.api().filter(|value| !value.is_empty()),",
    witness: "preflight.19",
  },
  {
    name: "pretty-option-not-forwarded",
    scope: "api",
    file: "cli/frontdoor.rs",
    before: "pretty: self.options.pretty() == Some(true),",
    after: "pretty: false,",
    witness: "api.pretty",
  },
  {
    name: "file-refusal-emits-a-premature-banner",
    file: "cli/io.rs",
    before: "fs::write(destination.to_lossy(), &bytes).map_err(|source| {",
    after:
      'host.write_stderr(&"premature banner\\n".into());\n        fs::write(destination.to_lossy(), &bytes).map_err(|source| {',
    witness: "helper.out-missing",
  },
  {
    name: "draining-does-not-reset-pending-state",
    file: "cli/io.rs",
    before: "std::mem::take(&mut self.pending)",
    after: "Vec::new()",
    nativeTest:
      "empty_stdio_write_calls_the_sink_and_pending_failures_reset_only_on_drain",
  },
  {
    name: "same-stream-writes-not-coalesced",
    file: "cli/io.rs",
    before: ".find(|failure| failure.stream == stream)",
    after: ".find(|failure| {let _ = failure; false})",
    nativeTest:
      "empty_stdio_write_calls_the_sink_and_pending_failures_reset_only_on_drain",
  },
];
function changedSource(mutation) {
  const full = original.get(mutation.file);
  let start = 0;
  let end = full.length;
  if (mutation.scope === "api") {
    start = full.indexOf("    pub fn dispatch_api_blocking(");
    end = full.indexOf("\n}\n\nimpl PreparedGatesCli", start);
    assert.ok(
      start >= 0 && end > start,
      "API controls belong to the API method",
    );
  }
  let text = full.slice(start, end);
  for (const [before, after] of mutation.edits ?? [
    [mutation.before, mutation.after],
  ]) {
    assert.equal(text.split(before).length, 2, mutation.name);
    text = text.replace(before, after);
  }
  return full.slice(0, start) + text + full.slice(end);
}
for (const mutation of mutations) changedSource(mutation);
function pairs(executable, name, ids) {
  const report = path.join(directory, `${name}.json`);
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(root, "verification/parity/graph-cli-frontdoor.mts"),
      executable,
      report,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...environment, DEMLIK_CLI_FRONTDOOR_CASES: ids.join(",") },
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
let before;
try {
  const ids = [
    ...new Set(
      mutations.flatMap((mutation) =>
        mutation.witness ? [mutation.witness] : [],
      ),
    ),
  ];
  before = pairs(baseline, "baseline", ids);
  assert.equal(before.run.status, 0, before.run.stdout + before.run.stderr);
  assert.equal(before.report.passed, ids.length);
  assert.equal(before.report.rejectedInvalidInputs, 10);
  for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
    fs.cpSync(path.join(root, entry), path.join(workspace, entry), {
      recursive: true,
    });
  for (const mutation of mutations) {
    for (const [file, text] of original)
      fs.writeFileSync(
        path.join(workspace, "crates/code-graph/src", file),
        text,
      );
    const source = changedSource(mutation);
    fs.writeFileSync(
      path.join(workspace, "crates/code-graph/src", mutation.file),
      source,
    );
    const build = cargo([
      "build",
      "--offline",
      "-p",
      "demlik-code-graph",
      "--example",
      "cli_frontdoor_driver",
    ]);
    assert.equal(build.status, 0, mutation.name + build.stdout + build.stderr);
    let evidence;
    if (mutation.nativeTest) {
      const run = cargo([
        "test",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--test",
        "cli_io",
        mutation.nativeTest,
        "--",
        "--exact",
      ]);
      assert.equal(run.status, 101, mutation.name + run.stdout + run.stderr);
      assert.ok(
        run.stdout.includes(`test ${mutation.nativeTest} ... FAILED`),
        run.stdout + run.stderr,
      );
      evidence = {
        nativeConsumer: mutation.nativeTest,
        stdout: run.stdout,
        stderr: run.stderr,
      };
    } else {
      const result = pairs(binary, mutation.name, [mutation.witness]);
      assert.notEqual(result.run.status, 0, mutation.name);
      assert.equal(result.report.rejectedInvalidInputs, 10, mutation.name);
      assert.ok(
        result.report.failures.some((row) => row.id === mutation.witness),
        mutation.name + JSON.stringify(result.report.failures),
      );
      evidence = {
        failures: result.report.failures,
        witness: result.report.cases.find((row) => row.id === mutation.witness),
      };
    }
    controls.push({ ...mutation, detected: true, build, evidence });
    assert.equal(hash(fs.readFileSync(baseline)), baselineHash);
    for (const [file, text] of original)
      assert.equal(
        fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
        text,
      );
    process.stdout.write(
      `${JSON.stringify({ detected: mutation.name, completed: controls.length, total: mutations.length })}\n`,
    );
  }
  const report = {
    detected: controls.length,
    escaped: 0,
    baselineCases: before.report.passed,
    baselineSourceMatches: true,
    baselineDriverUnchanged: true,
    baselineDriverSha256: baselineHash,
    reference: before.report.reference,
    sourceHashes: Object.fromEntries(
      [...original].map(([file, text]) => [file, hash(text)]),
    ),
    buildProfile: {
      devDebug: 0,
      testDebug: 0,
      incremental: false,
      jobs: 1,
      target,
    },
    controls,
  };
  if (reportFile)
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ detected: report.detected, escaped: 0 })}\n`,
  );
} catch (error) {
  if (reportFile)
    fs.writeFileSync(
      reportFile,
      `${JSON.stringify({ incomplete: true, detected: controls.length, planned: mutations.length, failure: String(error), baseline: before?.report, controls }, null, 2)}\n`,
    );
  throw error;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
