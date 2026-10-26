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
    path.join(os.tmpdir(), "demlik-boundary-cli-faults-"),
  ),
  workspace = path.join(directory, "workspace");
const target = path.join(root, "target/parity/cli-boundaries-mutation-build"),
  binary = path.join(target, "debug/examples/boundary_cli_driver");
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
    name: "inactive-boundaries-run-the-gate",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "if self.prepared.options.boundaries() != Some(true) {",
    after: "if false {",
    witness: "inactive",
  },
  {
    name: "prepared-root-replaces-second-lookup",
    file: "cli/frontdoor.rs",
    scope: true,
    before:
      "let repo_root = find_repo_root_text(&self.prepared.root_absolute);",
    after: "let repo_root = self.repo_root.clone();",
    witness: "second-root-read",
  },
  {
    name: "boundary-refusal-report-dropped",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "clean_exit(host, message);",
    after: "let _=message;",
    witness: "missing-rules",
  },
  {
    name: "boundary-payload-dropped",
    file: "cli/frontdoor.rs",
    scope: true,
    before: `for payload in &result.emitted {
            output_to(options.out())
                .emit(host, payload)
                .map_err(FrontdoorError::BoundaryEmit)?;
        }`,
    after: "for payload in &result.emitted {let _=payload;}",
    witness: "report-json",
  },
  {
    name: "exit-assigned-before-file-output",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "for message in &result.reports {",
    after:
      "exit_with(host,f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;\n        for message in &result.reports {",
    witness: "out-directory-initial",
  },
  {
    name: "zero-exit-clears-existing-state",
    file: "cli/frontdoor.rs",
    scope: true,
    before:
      "exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    after:
      "host.assign_exit(f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    witness: "zero-preserves-initial",
  },
  {
    name: "file-output-destination-ignored",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "output_to(options.out())",
    after: "output_to(None)",
    witness: "out-ci",
  },
  {
    name: "ci-flag-ignored",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "ci: options.ci() == Some(true),",
    after: "ci: false,",
    witness: "ci-json",
  },
  {
    name: "retired-write-ceilings-ignored",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "write_ceilings: options.write_ceilings() == Some(true),",
    after: "write_ceilings: false,",
    witness: "retired-before-rules",
  },
  {
    name: "accept-flag-ignored",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "accept_crossings: options.accept_crossings() == Some(true),",
    after: "accept_crossings: false,",
    witness: "accept-json",
  },
  {
    name: "accept-reason-dropped",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "reason: options.reason(),",
    after: "reason: None,",
    witness: "accept-json",
  },
  {
    name: "migration-flag-ignored",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "migrate_ceilings: options.migrate_ceilings() == Some(true),",
    after: "migrate_ceilings: false,",
    witness: "migrate-json",
  },
  {
    name: "json-flag-ignored",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "json: options.json() == Some(true),",
    after: "json: false,",
    witness: "report-json",
  },
  {
    name: "pretty-flag-ignored",
    file: "cli/frontdoor.rs",
    scope: true,
    before: "pretty: options.pretty() == Some(true),",
    after: "pretty: false,",
    witness: "report-pretty-json",
  },
  {
    name: "logical-scope-comparison-forces-filesystem-text",
    file: "boundaries/gate.rs",
    before: "Some((root, repo_root)) => scope_of(repo_root, root),",
    after:
      "Some((root, repo_root)) => scope_of(&JsString::from(repo_root.to_lossy()), &JsString::from(root.to_lossy())),",
    witness: "raw-scope-no-tsconfig",
  },
  {
    name: "logical-scope-join-forces-filesystem-text",
    file: "boundaries/gate.rs",
    before: "Some((_, repo_root)) => join_path_text(repo_root, scope),",
    after:
      "Some((_, repo_root)) => join_path_text(&JsString::from(repo_root.to_lossy()), scope),",
    witness: "raw-self-no-tsconfig",
  },
  {
    name: "ledger-diagnostic-forces-filesystem-text",
    file: "boundaries/gate.rs",
    before: "scope_root(input, &LEDGER_FILENAME.into()),",
    after: "ledger_file.to_string_lossy().as_ref().into(),",
    witness: "raw-self-invalid-ledger",
  },
  {
    name: "ceilings-diagnostic-forces-filesystem-text",
    file: "boundaries/gate.rs",
    before: "scope_root(input, &LEGACY_CEILINGS_FILENAME.into()),",
    after: "legacy_file.to_string_lossy().as_ref().into(),",
    witness: "raw-self-malformed-ceilings",
  },
  {
    name: "import-direct-root-comparison-loses-utf16",
    file: "syntax/imports.rs",
    before: "relative_path_text_from(logical, &resolved)?",
    after:
      "relative_path_text_from(&JsString::from(logical.to_lossy()), &resolved)?",
    witness: "raw-self-root",
  },
  {
    name: "import-real-root-comparison-loses-utf16",
    file: "syntax/imports.rs",
    before: "real: real_path(root).unwrap_or_else(|_| root.clone()),",
    after:
      "real: fs::canonicalize(Path::new(&root.to_lossy())).unwrap().to_string_lossy().as_ref().into(),",
    witness: "raw-self-root",
  },
  {
    name: "boundary-type-error-erased",
    file: "cli/frontdoor.rs",
    before: "Self::Boundaries(error) => error.name(),",
    after: 'Self::Boundaries(error) => {let _=error; "Error"},',
    witness: "schema-type-error",
  },
  {
    name: "pending-banner-failure-erased",
    file: "cli/frontdoor.rs",
    scope: true,
    before:
      "exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    after:
      "let _=host.take_stdio_failures();\n        exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    witness: "out-banner-bad",
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
  const start = text.indexOf("    pub fn dispatch_boundaries("),
    end = text.indexOf("    pub fn dispatch_layers(", start);
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
        path.join(root, "verification/parity/graph-cli-boundaries.mjs"),
        executable,
        report,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { ...environment, DEMLIK_BOUNDARY_CASES: ids.join(",") },
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
        "boundary_cli_driver",
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
        path.join(root, "verification/parity/graph-cli-boundaries.mjs"),
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
