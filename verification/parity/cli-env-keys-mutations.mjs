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
    path.join(os.tmpdir(), "demlik-env-key-cli-faults-"),
  ),
  workspace = path.join(directory, "workspace");
const target = path.join(root, "target/parity/cli-env-keys-mutation-build"),
  binary = path.join(target, "debug/examples/env_keys_cli_driver");
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
    name: "inactive-env-runs",
    file: "cli/frontdoor.rs",
    before: "if self.prepared.options.env_keys() != Some(true) {",
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
    witness: "second-root-read",
    scope: true,
  },
  {
    name: "json-ignored",
    file: "cli/frontdoor.rs",
    before: "self.prepared.options.json() == Some(true),",
    after: "false,",
    witness: "workers-json",
    scope: true,
  },
  {
    name: "pretty-ignored",
    file: "cli/frontdoor.rs",
    before: "self.prepared.options.pretty() == Some(true),",
    after: "false,",
    witness: "workers-pretty-json",
    scope: true,
  },
  {
    name: "newline-dropped",
    file: "cli/frontdoor.rs",
    before: 'payload.push_str("\\n");',
    after: 'payload.push_str("");',
    witness: "workers-text",
    scope: true,
  },
  {
    name: "out-ignored",
    file: "cli/frontdoor.rs",
    before: "output_to(self.prepared.options.out())",
    after: "output_to(None)",
    witness: "out-json",
    scope: true,
  },
  {
    name: "env-assigns-zero-exit",
    file: "cli/frontdoor.rs",
    before: "Ok(EnvKeyDispatch::Complete(report))",
    after:
      "host.assign_exit(0.0).map_err(FrontdoorError::ExitCode)?; Ok(EnvKeyDispatch::Complete(report))",
    witness: "zero-preserves-initial",
    scope: true,
  },
  {
    name: "pending-stdio-dropped",
    file: "cli/frontdoor.rs",
    before: "Ok(EnvKeyDispatch::Complete(report))",
    after:
      "let _=host.take_stdio_failures(); Ok(EnvKeyDispatch::Complete(report))",
    witness: "stdout-bad",
    scope: true,
  },
  {
    name: "env-type-error-name-erased",
    file: "cli/frontdoor.rs",
    before: "Self::EnvKeys(error) => error.name(),",
    after: 'Self::EnvKeys(error) => {let _=error; "Error"},',
    witness: "catalog-type-error",
  },
  {
    name: "catalog-type-error-name-erased",
    file: "extract/wrangler_config/mod.rs",
    before: "Self::Record(error) => error.name(),",
    after: 'Self::Record(error) => {let _=error; "Error"},',
    witness: "catalog-type-error",
  },
  {
    name: "optional-process-classified-semantically",
    file: "env_keys/extract.rs",
    before: 'if text == "process.env" || text.ends_with(".process.env") {',
    after:
      'if text == "process.env" || text == "process?.env" || text.ends_with(".process.env") {',
    witness: "scan-destructure",
  },
  {
    name: "computed-literal-reads-dropped",
    file: "env_keys/extract.rs",
    before: 'if property.kind() != "Literal" {',
    after: "if true {",
    witness: "scan-raw-keys",
  },
  {
    name: "rest-binding-ignored",
    file: "env_keys/extract.rs",
    before: 'return element.node("argument").map(identifier_text);',
    after: "return None;",
    witness: "scan-destructure",
  },
  {
    name: "env-type-word-boundaries-dropped",
    file: "env_keys/extract.rs",
    before: 'r"\\bEnv\\b"',
    after: 'r"Env"',
    witness: "scan-env-type-boundary",
  },
  {
    name: "candidate-occurrences-ignored",
    file: "env_keys/extract.rs",
    before: "candidates.contains(&value).then_some(value)",
    after: "(false && candidates.contains(&value)).then_some(value)",
    witness: "scan-literal-occurrences",
  },
  {
    name: "private-name-prefix-dropped",
    file: "env_keys/extract.rs",
    before: 'let mut value = JsString::from("#");',
    after: 'let mut value = JsString::from("");',
    witness: "scan-literal-occurrences",
  },
  {
    name: "read-dedupe-ignores-line",
    file: "env_keys/extract.rs",
    before: 'format!("\\t{line}\\t{}", via.as_str())',
    after: 'format!("\\t{}", via.as_str())',
    witness: "scan-duplicate-lines",
  },
  {
    name: "tab-key-collision-normalized-away",
    file: "env_keys/query.rs",
    before: 'key.push_str("\\t");',
    after: 'key.push_str("\\n");',
    witness: "tab-declaration-collision",
  },
  {
    name: "binding-names-not-known",
    file: "env_keys/query.rs",
    before: ".chain(&manifest.binding_names),",
    after: ",",
    witness: "dev-vars-bindings",
  },
  {
    name: "process-env-creates-undeclared-findings",
    file: "env_keys/query.rs",
    before: "if read.via != EnvReadVia::Env || known.contains(&read.name) {",
    after: "if known.contains(&read.name) {",
    witness: "scan-process-read-settles",
  },
  {
    name: "read-prefix-forces-lossy-text",
    file: "env_keys/query.rs",
    before:
      "read.file = to_repo_relative(repo, join_path_text(root, &read.file));",
    after:
      "read.file = to_repo_relative(repo, join_path_text(&JsString::from(root.to_lossy()), &read.file));",
    witness: "raw-ancestor",
  },
  {
    name: "unparsed-wins-directory-tie",
    file: "env_keys/read_site_owner.rs",
    before: "dir.units().len() > w.dir.encode_utf16().count()",
    after: "dir.units().len() >= w.dir.encode_utf16().count()",
    witness: "ownership-5",
  },
  {
    name: "unparsed-loses-deeper-ownership",
    file: "env_keys/read_site_owner.rs",
    before: "dir.units().len() > w.dir.encode_utf16().count()",
    after: "dir.units().len() < w.dir.encode_utf16().count()",
    witness: "ownership-2",
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
  const start = text.indexOf("    pub fn dispatch_env_keys("),
    end = text.indexOf("    pub fn dispatch_boundaries(", start);
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
        path.join(root, "verification/parity/graph-cli-env-keys.mjs"),
        executable,
        report,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...environment, DEMLIK_ENV_KEY_CASES: ids.join(",") },
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
        "env_keys_cli_driver",
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
          row.target.name === "env_keys_cli_driver" &&
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
        path.join(root, "verification/parity/graph-cli-env-keys.mjs"),
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
