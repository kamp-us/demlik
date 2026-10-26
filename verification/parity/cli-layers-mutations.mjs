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
assert.ok(baseline, "provide compiled baseline layer_cli_driver");
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "demlik-layer-cli-faults-"),
);
const workspace = path.join(directory, "workspace");
const target = path.join(root, "target/parity/shape-judgment-mutation-build");
const binary = path.join(target, "debug/examples/layer_cli_driver");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baselineHash = hash(fs.readFileSync(baseline));
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
    name: "inactive-layers-run-the-gate",
    file: "cli/frontdoor.rs",
    before: "if self.prepared.options.layers() != Some(true) {",
    after: "if false {",
    witness: "inactive",
    matches: 1,
  },
  {
    name: "prepared-root-reused-instead-of-second-read",
    file: "cli/frontdoor.rs",
    before:
      "let repo_root = find_repo_root_text(&self.prepared.root_absolute);",
    after: "let repo_root = self.repo_root.clone();",
    witness: "second-root-read",
    matches: 1,
  },
  {
    name: "layer-refusal-report-dropped",
    file: "cli/frontdoor.rs",
    before:
      "for message in &result.reports {\n            clean_exit(host, message);\n        }",
    after: "for message in &result.reports { let _ = message; }",
    witness: "default-rules",
    matches: 1,
  },
  {
    name: "layer-payload-dropped",
    file: "cli/frontdoor.rs",
    before:
      "for payload in &result.emitted {\n            output_to(self.prepared.options.out())\n                .emit(host, payload)\n                .map_err(FrontdoorError::LayerEmit)?;\n        }",
    after: "for payload in &result.emitted { let _=payload; }",
    witness: "json",
    matches: 1,
  },
  {
    name: "exit-code-assigned-before-file-output",
    file: "cli/frontdoor.rs",
    before: "for message in &result.reports {",
    after:
      "exit_with(host,f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;\n        for message in &result.reports {",
    witness: "out-directory-initial",
    matches: 1,
  },
  {
    name: "zero-exit-overwrites-existing-code",
    file: "cli/frontdoor.rs",
    before:
      "exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    after:
      "host.assign_exit(f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    witness: "allowed-initial",
    matches: 1,
  },
  {
    name: "output-failure-caught-as-clean-refusal",
    file: "cli/frontdoor.rs",
    before:
      "for payload in &result.emitted {\n            output_to(self.prepared.options.out())\n                .emit(host, payload)\n                .map_err(FrontdoorError::LayerEmit)?;\n        }",
    after:
      "for payload in &result.emitted {if let Err(error)=output_to(self.prepared.options.out()).emit(host,payload){clean_exit(host,&error.message());return Ok(LayerDispatch::Complete(result));}}",
    witness: "out-directory",
    matches: 1,
  },
  {
    name: "gate-newline-duplicated",
    file: "layers/gate.rs",
    before: 'payload.push_str("\\n");',
    after: 'payload.push_str("\\n\\n");',
    witness: "out-pretty-unicode",
    matches: 1,
  },
  {
    name: "logical-source-unit-root-loses-utf16",
    file: "layers/analyze.rs",
    before: "&join_path_text(root, &unit.file.as_str().into())",
    after:
      "&join_path_text(&JsString::from(root.to_lossy()), &unit.file.as_str().into())",
    witness: "raw-root",
    matches: 1,
  },
  {
    name: "text-gate-uses-path-analyzer",
    file: "layers/gate.rs",
    before:
      "Some((root, repo)) => analyze_layers_text(&loaded, root, repo, &rules),",
    after:
      "Some((root, repo)) => {let _=(root,repo);analyze_layers(&loaded,args.repo_root,&rules)},",
    witness: "raw-root",
    matches: 1,
  },
  {
    name: "text-real-root-forces-filesystem-spelling",
    file: "layers/resolve_target.rs",
    before: "ResolverRoot::Text(text) => real_path(text)?,",
    after:
      "ResolverRoot::Text(text) => fs::canonicalize(Path::new(&text.to_lossy()))?.to_string_lossy().as_ref().into(),",
    witness: "raw-self-alias",
    matches: 1,
  },
  {
    name: "text-relative-root-forces-filesystem-spelling",
    file: "layers/resolve_target.rs",
    before:
      "ResolverRoot::Text(text) => (PathBuf::from(text.to_lossy()), text.clone()),",
    after:
      "ResolverRoot::Text(text) => (PathBuf::from(text.to_lossy()), JsString::from(text.to_lossy())),",
    witness: "raw-relative-root-collision",
    matches: 1,
  },
  {
    name: "layer-json-option-ignored",
    file: "cli/frontdoor.rs",
    before: "json: self.prepared.options.json() == Some(true),",
    after: "json: false,",
    witness: "pretty-json",
    matches: 1,
  },
  {
    name: "layer-pretty-option-ignored",
    file: "cli/frontdoor.rs",
    before: "pretty: self.prepared.options.pretty() == Some(true),",
    after: "pretty: false,",
    witness: "pretty-json",
    matches: 1,
  },
  {
    name: "layer-rules-file-ignored",
    file: "cli/frontdoor.rs",
    before: "layer_rules_file: self.prepared.options.layer_rules(),",
    after: "layer_rules_file: None,",
    witness: "text",
    matches: 1,
  },
  {
    name: "layer-file-destination-ignored",
    file: "cli/frontdoor.rs",
    before: "output_to(self.prepared.options.out())",
    after: "output_to(None)",
    witness: "out-text",
    matches: 1,
  },
  {
    name: "pending-banner-failure-erased",
    file: "cli/frontdoor.rs",
    before:
      "exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    after:
      "let _=host.take_stdio_failures();\n        exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    witness: "out-banner-bad",
    matches: 1,
  },
];
const original = new Map(
  [...new Set(mutations.map((row) => row.file))].map((file) => [
    file,
    fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
  ]),
);
for (const row of mutations)
  assert.equal(
    original.get(row.file).split(row.before).length,
    row.matches + 1,
    row.name,
  );
function pairs(executable, name, ids) {
  const report = path.join(directory, `${name}.json`);
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(root, "verification/parity/graph-cli-layers.mjs"),
      executable,
      report,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...environment, DEMLIK_LAYER_CASES: ids.join(",") },
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
    fs.writeFileSync(
      path.join(workspace, "crates/code-graph/src", mutation.file),
      original.get(mutation.file).replace(mutation.before, mutation.after),
    );
    const build = spawnSync(
      process.env.CARGO ?? "cargo",
      [
        "build",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "layer_cli_driver",
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: environment,
      },
    );
    assert.equal(build.status, 0, mutation.name + build.stdout + build.stderr);
    const result = pairs(binary, mutation.name, [mutation.witness]);
    assert.notEqual(result.run.status, 0, mutation.name);
    assert.equal(result.report.rejectedInvalidInputs, 7, mutation.name);
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
        path.join(root, "verification/parity/graph-cli-layers.mjs"),
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
      `${JSON.stringify({ incomplete: true, detected: controls.length, planned: mutations.length, failure: String(error), baseline: before?.report, controls }, null, 2)}\n`,
    );
  throw error;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
