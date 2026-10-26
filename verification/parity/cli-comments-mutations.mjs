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
assert.ok(baseline);
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
const root = fileURLToPath(new URL("../..", import.meta.url)),
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "demlik-comment-cli-faults-"),
  ),
  workspace = path.join(directory, "workspace");
const target = path.join(root, "target/parity/comments-mutation-build"),
  binary = path.join(target, "debug/examples/comment_cli_driver");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  baselineHash = hash(fs.readFileSync(baseline));
const environment = {
  ...process.env,
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
  CARGO_NET_OFFLINE: "true",
  CARGO_TARGET_DIR: target,
};
assert.notEqual(
  path.resolve(baseline),
  path.resolve(binary),
  "baseline and mutant executables must differ",
);
const controls = [];
const mutations = [
  {
    name: "inactive-comments-run",
    file: "cli/frontdoor.rs",
    before: "if self.prepared.options.comments() != Some(true) {",
    after: "if false {",
    witness: "inactive",
    scope: true,
  },
  {
    name: "prepared-root-replaces-second-lookup",
    file: "cli/frontdoor.rs",
    before:
      "let repo_root = find_repo_root_text(&self.prepared.root_absolute);",
    after: "let repo_root = self.repo_root.clone();",
    witness: "second-root-write",
    scope: true,
  },
  {
    name: "ci-ignored",
    file: "cli/frontdoor.rs",
    before: "ci: options.ci() == Some(true),",
    after: "ci: false,",
    witness: "ci-pass-json",
    scope: true,
  },
  {
    name: "write-ignored",
    file: "cli/frontdoor.rs",
    before: "write_ceilings: options.write_ceilings() == Some(true),",
    after: "write_ceilings: false,",
    witness: "write-new",
    scope: true,
  },
  {
    name: "json-ignored",
    file: "cli/frontdoor.rs",
    before: "json: options.json() == Some(true),",
    after: "json: false,",
    witness: "census-json",
    scope: true,
  },
  {
    name: "pretty-ignored",
    file: "cli/frontdoor.rs",
    before: "pretty: options.pretty() == Some(true),",
    after: "pretty: false,",
    witness: "census-pretty-json",
    scope: true,
  },
  {
    name: "output-destination-ignored",
    file: "cli/frontdoor.rs",
    before: "output_to(options.out())",
    after: "output_to(None)",
    witness: "write-out",
    scope: true,
  },
  {
    name: "refusal-report-dropped",
    file: "cli/frontdoor.rs",
    before: "clean_exit(host, message);",
    after: "let _=message;",
    witness: "ci-missing",
    scope: true,
  },
  {
    name: "zero-clears-prior-exit",
    file: "cli/frontdoor.rs",
    before:
      "exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    after:
      "host.assign_exit(f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    witness: "zero-preserves-initial",
    scope: true,
  },
  {
    name: "exit-assigned-before-emission",
    file: "cli/frontdoor.rs",
    before: "for message in &result.reports {",
    after:
      "exit_with(host,f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?; for message in &result.reports {",
    witness: "ci-out-missing-initial",
    scope: true,
  },
  {
    name: "pending-stdio-erased",
    file: "cli/frontdoor.rs",
    before: "Ok(CommentDispatch::Complete(result))",
    after:
      "let _=host.take_stdio_failures(); Ok(CommentDispatch::Complete(result))",
    witness: "write-stdout-bad",
    scope: true,
  },
  {
    name: "type-error-name-erased",
    file: "cli/frontdoor.rs",
    before: "Self::Comments(error) => error.name(),",
    after: 'Self::Comments(error) => {let _=error; "Error"},',
    witness: "ci-type-error",
  },
  {
    name: "output-probed-before-policy-write",
    file: "cli/frontdoor.rs",
    before: "let result = run_comment_gate_text(CommentGateTextArgs {",
    after:
      "output_to(options.out()).emit(host,&JsString::default()).map_err(FrontdoorError::CommentEmit)?; let result = run_comment_gate_text(CommentGateTextArgs {",
    witness: "write-out-missing",
    scope: true,
  },
  {
    name: "logical-config-filename-lost",
    file: "comments/gate.rs",
    before:
      "Some(_) => resolve_comment_ceilings_text(requested.then_some(&text)),",
    after:
      "Some(_) => resolve_comment_ceilings(requested.then_some(file.as_path())),",
    witness: "raw-self-ci-missing",
  },
  {
    name: "logical-acknowledgement-filename-lost",
    file: "comments/gate.rs",
    before: "acknowledgement.extend(&text);",
    after: "acknowledgement.extend(&JsString::from(text.to_lossy()));",
    witness: "raw-self-write",
  },
  {
    name: "ci-missing-policy-uses-defaults",
    file: "comments/gate.rs",
    before: "let requested = file.exists() || args.ci;",
    after: "let requested = file.exists();",
    witness: "ci-missing",
  },
  {
    name: "ci-overrides-requested-recording",
    file: "comments/gate.rs",
    before: "if args.write_ceilings {",
    after: "if args.write_ceilings && !args.ci {",
    witness: "ci-and-write-existing",
  },
  {
    name: "recording-acknowledges-without-writing",
    file: "comments/gate.rs",
    before:
      "        fs::write(&file, bytes).map_err(|source| CommentGateError::Write {\n            file: file.clone(),\n            source,\n        })?;",
    after: "let _=&bytes;",
    witness: "record-repeat-ci-out",
  },
];
const original = new Map(
  [...new Set(mutations.map((row) => row.file))].map((file) => [
    file,
    fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
  ]),
);
function region(mutation) {
  const text = original.get(mutation.file);
  if (!mutation.scope) return { prefix: "", body: text, suffix: "" };
  const start = text.indexOf("    pub fn dispatch_comments("),
    end = text.indexOf("    pub fn dispatch_env_keys(", start);
  assert.ok(start >= 0 && end > start);
  return {
    prefix: text.slice(0, start),
    body: text.slice(start, end),
    suffix: text.slice(end),
  };
}
for (const mutation of mutations) {
  assert.equal(
    region(mutation).body.split(mutation.before).length,
    2,
    mutation.name,
  );
}
function pairs(executable, name, ids) {
  const report = path.join(directory, `${name}.json`),
    run = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        path.join(root, "verification/parity/graph-cli-comments.mjs"),
        executable,
        report,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...environment, DEMLIK_COMMENT_CASES: ids.join(",") },
      },
    );
  assert.ok(fs.existsSync(report), run.stdout + run.stderr);
  return { run, report: JSON.parse(fs.readFileSync(report, "utf8")) };
}
let before;
try {
  const ids = [...new Set(mutations.map((row) => row.witness))];
  before = pairs(baseline, "baseline", ids);
  assert.equal(before.run.status, 0, before.run.stdout + before.run.stderr);
  assert.equal(before.report.passed, ids.length);
  assert.equal(before.report.rejectedInvalidInputs, 7);
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
    const area = region(mutation);
    fs.writeFileSync(
      path.join(workspace, "crates/code-graph/src", mutation.file),
      area.prefix +
        area.body.replace(mutation.before, mutation.after) +
        area.suffix,
    );
    const build = spawnSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "comment_cli_driver",
        "--message-format=json",
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: environment,
      },
    );
    assert.equal(build.status, 0, mutation.name + build.stdout + build.stderr);
    const artifacts = build.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (row) =>
          row.reason === "compiler-artifact" &&
          row.target.name === "comment_cli_driver" &&
          row.executable,
      );
    assert.equal(artifacts.length, 1, "one actual compiled executable");
    assert.equal(artifacts[0].executable, binary);
    const result = pairs(binary, mutation.name, [mutation.witness]);
    assert.notEqual(result.run.status, 0, mutation.name);
    assert.equal(result.report.rejectedInvalidInputs, 7);
    assert.ok(
      result.report.failures.some(
        (row) => row.id === mutation.witness && row.kind === "semantic",
      ),
      mutation.name + JSON.stringify(result.report.failures),
    );
    controls.push({
      ...mutation,
      detected: true,
      mutantBinarySha256: hash(fs.readFileSync(binary)),
      build,
      artifact: artifacts[0],
      failures: result.report.failures,
      witness: result.report.cases.find((row) => row.id === mutation.witness),
    });
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
    baselineMatchesSource: true,
    baselineDriverUnchanged: true,
    baselineDriverSha256: baselineHash,
    reference: before.report.reference,
    verifierSha256: hash(
      fs.readFileSync(
        path.join(root, "verification/parity/graph-cli-comments.mjs"),
      ),
    ),
    scriptSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
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
  console.log(JSON.stringify({ detected: report.detected, escaped: 0 }));
} catch (error) {
  if (reportFile)
    fs.writeFileSync(
      reportFile,
      `${JSON.stringify(
        {
          incomplete: true,
          detected: controls.length,
          planned: mutations.length,
          failure: String(error),
          baseline: before?.report,
          controls,
        },
        null,
        2,
      )}\n`,
    );
  throw error;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
