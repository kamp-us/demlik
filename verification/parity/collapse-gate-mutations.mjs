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

const [baseline, baselineReport, reportFile, evidenceDirectory] =
  process.argv.slice(2);
assert.ok(baseline && baselineReport && reportFile && evidenceDirectory);
assert.equal(process.argv.length, 6);
assert.equal(process.version, "v22.21.1");
for (const key of [
  "CARGO_TARGET_DIR",
  "CARGO_BUILD_TARGET_DIR",
  "CARGO_BUILD_BUILD_DIR",
  "DEMLIK_MUTATION_TARGET_DIR",
])
  assert.equal(process.env[key], undefined, key);
const root = fileURLToPath(new URL("../..", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baselineHash = hash(fs.readFileSync(baseline));
const checked = JSON.parse(fs.readFileSync(baselineReport, "utf8"));
assert.deepEqual(checked.failures, []);
assert.equal(checked.passed, 69);
assert.equal(checked.rejectedInvalidInputs, 5);
assert.equal(checked.responseGuards, 4);
assert.equal(checked.driverSha256, baselineHash);
const evidence = path.resolve(evidenceDirectory);
fs.mkdirSync(evidence, { recursive: true });
const owner = (file) => path.join(root, "crates/code-graph/src", file);
const gate = fs.readFileSync(owner("collapse/gate.rs"), "utf8");
const writeStart = gate.indexOf("        fs::write(file.to_lossy(), bytes)");
const writeEnd = gate.indexOf("        let mut acknowledgement =", writeStart);
assert.ok(writeStart >= 0 && writeEnd > writeStart);
const mutations = [
  {
    name: "inactive-collapse-is-entered",
    file: "cli/frontdoor.rs",
    region: true,
    before: "if options.collapse() != Some(true)",
    after: "if false",
    witness: "ci-without-collapse-continues",
  },
  {
    name: "second-root-lookup-is-cached",
    file: "cli/frontdoor.rs",
    region: true,
    before:
      "let repo_root = find_repo_root_text(&self.prepared.root_absolute);",
    after: "let repo_root = self.repo_root.clone();",
    witness: "second-root-record",
  },
  {
    name: "write-request-is-ignored",
    file: "cli/frontdoor.rs",
    region: true,
    before: "write_ceilings: options.write_ceilings() == Some(true),",
    after: "write_ceilings: false,",
    witness: "write-new",
  },
  {
    name: "ci-overrides-write",
    file: "cli/frontdoor.rs",
    region: true,
    before: "write_ceilings: options.write_ceilings() == Some(true),",
    after:
      "write_ceilings: options.write_ceilings() == Some(true) && options.ci() != Some(true),",
    witness: "write-wins-ci-existing",
  },
  {
    name: "policy-refusal-starts-measurement",
    file: "collapse/gate.rs",
    before: "    let ceilings: ScopeCountCeilings =",
    after:
      '    let _ = measure(&[".".into()], &args, binary, warning)?;\n    let ceilings: ScopeCountCeilings =',
    witness: "ci-malformed",
  },
  {
    name: "partial-count-is-zeroed",
    file: "collapse/gate.rs",
    before:
      "count: find_partial_twins(&candidates, args.settings).len() as f64,",
    after:
      "count: { let _ = find_partial_twins(&candidates, args.settings); 0.0 },",
    witness: "retry-workflow",
  },
  {
    name: "configured-prefix-is-ignored",
    file: "collapse/gate.rs",
    before: "find_partial_twins(&candidates, args.settings)",
    after: "find_partial_twins(&candidates, &CollapseSettings::default())",
    witness: "config-changes-count",
  },
  {
    name: "only-first-recorded-scope-is-measured",
    file: "collapse/gate.rs",
    before: "    if scopes.is_empty() {",
    after:
      "    let scopes = scopes.into_iter().take(1).collect::<Vec<_>>();\n    if scopes.is_empty() {",
    witness: "ci-two-scopes",
  },
  {
    name: "warning-is-dropped-before-later-error",
    file: "cli/frontdoor.rs",
    region: true,
    before: "&mut |line| host.write_stderr(line),",
    after: "&mut |_line| {},",
    witness: "warning-before-later-failure",
  },
  {
    name: "policy-write-is-skipped",
    file: "collapse/gate.rs",
    before: gate.slice(writeStart, writeEnd),
    after: "        let _ = &bytes;\n",
    witness: "write-new",
  },
  {
    name: "output-is-probed-before-policy-write",
    file: "cli/frontdoor.rs",
    region: true,
    before: "        let result = run_collapse_gate(",
    after:
      "        output_to(options.out()).emit(host, &JsString::default()).map_err(FrontdoorError::CollapseEmit)?;\n        let result = run_collapse_gate(",
    witness: "write-out-missing",
  },
  {
    name: "exit-is-assigned-before-emission",
    file: "cli/frontdoor.rs",
    region: true,
    before: "        for message in &result.reports {",
    after:
      "        exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;\n        for message in &result.reports {",
    witness: "ci-out-missing-initial",
  },
  {
    name: "zero-clears-prior-exit",
    file: "cli/frontdoor.rs",
    region: true,
    before:
      "exit_with(host, f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    after:
      "host.assign_exit(f64::from(result.exit_code)).map_err(FrontdoorError::ExitCode)?;",
    witness: "zero-preserves-initial",
  },
  {
    name: "output-destination-is-ignored",
    file: "cli/frontdoor.rs",
    region: true,
    before: "output_to(options.out())",
    after: "output_to(None)",
    witness: "write-out",
  },
  {
    name: "slack-advice-is-lost",
    file: "collapse/ceilings.rs",
    before: "if has_direction(verdict, CeilingDirection::Slack) {",
    after: "if false {",
    witness: "ci-slack",
  },
  {
    name: "historical-prototype-ack-becomes-a-number",
    file: "collapse/gate.rs",
    before: "&recorded.ceiling_of(&scope).text()",
    after: "&crate::ratchet::scope_count::CeilingValue::Number(0.0).text()",
    witness: "historical-proto-record",
  },
  {
    name: "logical-policy-path-is-replaced",
    file: "collapse/gate.rs",
    before: "read_scope_ceilings(&file)",
    after: "read_scope_ceilings(&JsString::from(file.to_lossy()))",
    witness: "raw-policy-refusal",
  },
  {
    name: "original-record-type-error-name-is-erased",
    file: "cli/frontdoor.rs",
    before: "Self::Collapse(error) => error.name(),",
    after: 'Self::Collapse(error) => { let _ = error; "Error" },',
    witness: "ci-record-constructor-null",
  },
  {
    name: "pretty-json-is-ignored",
    file: "cli/frontdoor.rs",
    region: true,
    before: "pretty: options.pretty() == Some(true),",
    after: "pretty: false,",
    witness: "ci-pass-pretty",
  },
  {
    name: "pending-stdio-is-erased",
    file: "cli/frontdoor.rs",
    region: true,
    before: "Ok(CollapseDispatch::Complete(result))",
    after:
      "let _ = host.take_stdio_failures(); Ok(CollapseDispatch::Complete(result))",
    witness: "write-banner-bad",
  },
  {
    name: "active-gate-returns-continuation-after-emission",
    file: "cli/frontdoor.rs",
    region: true,
    before: "Ok(CollapseDispatch::Complete(result))",
    after: "let _=result; Ok(CollapseDispatch::Continue(self))",
    witness: "write-new",
  },
  {
    name: "legacy.slack-count-is-accepted",
    file: "ratchet/scope_count.rs",
    before: "if delta == 0.0 {",
    after: "if delta <= 0.0 {",
    witness: "ci-slack",
  },
  {
    name: "legacy.recorded-scope-sort-is-skipped",
    file: "ratchet/scope_count.rs",
    before:
      "out.sort_by(|left, right| crate::project::locale_compare_units(left.units(), right.units()));",
    after: "let _ = &out;",
    witness: "ci-first-sorted-load-failure",
  },
];
assert.equal(new Set(mutations.map((m) => m.name)).size, mutations.length);
const original = new Map(
  [...new Set([...mutations.map((m) => m.file), "collapse.rs"])].map((file) => [
    file,
    fs.readFileSync(owner(file), "utf8"),
  ]),
);
function region(text, m) {
  if (!m.region) return { prefix: "", body: text, suffix: "" };
  const start = text.indexOf("    pub fn dispatch_collapse_gate("),
    end = text.indexOf("    pub fn dispatch_comments(", start);
  assert.ok(start >= 0 && end > start);
  return {
    prefix: text.slice(0, start),
    body: text.slice(start, end),
    suffix: text.slice(end),
  };
}
for (const m of mutations) {
  assert.equal(
    region(original.get(m.file), m).body.split(m.before).length,
    2,
    m.name,
  );
  assert.ok(
    checked.cases.some((c) => c.id === m.witness && c.passed),
    m.witness,
  );
}
const environment = cargoCheckEnvironment({
  CARGO_NET_OFFLINE: "true",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
});
delete environment.CARGO_BUILD_TARGET_DIR;
delete environment.CARGO_BUILD_BUILD_DIR;
function command(executable, args, cwd, env = environment) {
  return spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
function preserve(file, name) {
  const bytes = fs.readFileSync(file),
    packed = gzipSync(bytes, { level: 6 }),
    destination = path.join(evidence, `${name}.gz`);
  fs.writeFileSync(destination, packed);
  return {
    path: destination,
    sha256: hash(bytes),
    bytes: bytes.length,
    gzipSha256: hash(packed),
    gzipBytes: packed.length,
  };
}
function cargo(worktree, args, name) {
  const r = command(
    process.env.CARGO ?? "cargo",
    [...args, "--message-format=json"],
    worktree,
  );
  fs.writeFileSync(path.join(evidence, `${name}.cargo.jsonl`), r.stdout);
  fs.writeFileSync(path.join(evidence, `${name}.cargo.stderr`), r.stderr);
  assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  return {
    exit: r.status,
    rows: r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}
const controls = [];
let check, interfaceReplay;
try {
  check = createCheckWorktree(root, "collapse-gate-faults", evidence);
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
  // Reproduce the original interface red with retained library bytes; the first red's consumed rlib was not copied before its next build.
  const base = "6f3c9b0eceb83e195cfb4f338b08e9997580ee20";
  const paths = [
    "Cargo.toml",
    "Cargo.lock",
    "crates/code-graph/Cargo.toml",
    "crates/code-graph/src",
  ];
  const inputArchive = spawnSync(
    "git",
    ["archive", "--format=tar", base, ...paths],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(inputArchive.status, 0);
  const archived = gzipSync(inputArchive.stdout, { level: 6 });
  const archivePath = path.join(evidence, "interface-replay-inputs.tar.gz");
  fs.writeFileSync(archivePath, archived);
  fs.rmSync(path.join(check.root, "crates/code-graph/src"), {
    recursive: true,
    force: true,
  });
  const extracted = spawnSync("tar", ["-xf", "-", "-C", check.root], {
    input: inputArchive.stdout,
  });
  assert.equal(extracted.status, 0);
  const list = command(
    "git",
    ["ls-tree", "-r", "--name-only", base, ...paths],
    root,
  );
  assert.equal(list.status, 0);
  const restoredHashes = {};
  for (const file of list.stdout.trim().split("\n")) {
    const expected = spawnSync("git", ["show", `${base}:${file}`], {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(expected.status, 0);
    const actual = fs.readFileSync(path.join(check.root, file));
    assert.equal(hash(actual), hash(expected.stdout), file);
    restoredHashes[file] = hash(actual);
  }
  const redBuild = cargo(
    check.root,
    ["build", "--locked", "--offline", "-p", "demlik-code-graph", "--lib"],
    "interface-replay",
  );
  const redLib = compiledCheckLibrary(
    redBuild.rows,
    "demlik_code_graph",
    check.root,
    check.target,
  );
  interfaceReplay = {
    base,
    restoredHashes,
    inputArchive: {
      path: archivePath,
      sha256: hash(archived),
      format: "Git archive of complete exact-base CG src and Cargo inputs",
    },
    library: preserve(redLib.path, "interface-replay-library"),
    artifact: redLib.artifact,
    producer: {
      cwd: check.root,
      cargo: process.env.CARGO ?? "cargo",
      rustc: process.env.RUSTC ?? "rustc",
      rustupToolchain: process.env.RUSTUP_TOOLCHAIN,
      defaultTarget: check.target,
    },
  };
  const redCommand = [
    "--edition=2024",
    "-Cdebuginfo=0",
    "--error-format=json",
    path.join(
      check.root,
      "verification/parity/fixtures/collapse-gate-borrowed.rs",
    ),
    "--extern",
    `demlik_code_graph=${redLib.path}`,
    "-L",
    `dependency=${path.join(check.target, "debug/deps")}`,
    "-o",
    path.join(check.target, "interface-red"),
  ];
  const red = command(process.env.RUSTC ?? "rustc", redCommand, check.root);
  fs.writeFileSync(
    path.join(evidence, "interface-replay.stderr.jsonl"),
    red.stderr,
  );
  const diagnostics = red.stderr
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((d) => d.level === "error" && d.code);
  assert.notEqual(red.status, 0);
  assert.deepEqual(
    diagnostics.map((d) => d.code.code),
    ["E0599"],
  );
  const depInfoCandidates = [
    redLib.path.replace(/\.rlib$/, ".d"),
    path.join(
      path.dirname(redLib.path),
      path
        .basename(redLib.path)
        .replace(/^lib/, "")
        .replace(/\.rlib$/, ".d"),
    ),
  ];
  const depInfo = depInfoCandidates.find((p) => fs.existsSync(p));
  assert.ok(depInfo, "Cargo library dep-info");
  const depInfoCopy = path.join(evidence, "interface-replay.d");
  fs.copyFileSync(depInfo, depInfoCopy);
  Object.assign(interfaceReplay, {
    depInfo: {
      path: depInfoCopy,
      sha256: hash(fs.readFileSync(depInfoCopy)),
      selectedFromArtifact: redLib.path,
    },
    command: redCommand,
    compileExit: red.status,
    errorCodes: diagnostics.map((d) => d.code.code),
    qualification:
      "This is a new exact-base reproduction, not recovery of original rlib bytes. The first baseline red retained Cargo/hash/diagnostics but its consumed rlib bytes are unavailable. Complete exact-base CG src and Cargo inputs were restored and retained; current CG src is restored only after this type proof. Zero semantic-control credit.",
  });
  fs.rmSync(path.join(check.root, "crates/code-graph/src"), {
    recursive: true,
    force: true,
  });
  fs.cpSync(
    path.join(root, "crates/code-graph/src"),
    path.join(check.root, "crates/code-graph/src"),
    { recursive: true },
  );
  for (const mutation of mutations) {
    for (const [file, text] of original)
      fs.writeFileSync(
        path.join(check.root, "crates/code-graph/src", file),
        text,
      );
    const area = region(original.get(mutation.file), mutation),
      modified =
        area.prefix +
        area.body.replace(mutation.before, mutation.after) +
        area.suffix;
    fs.writeFileSync(
      path.join(check.root, "crates/code-graph/src", mutation.file),
      modified,
    );
    const modifiedCopy = path.join(evidence, `${mutation.name}.rs`);
    fs.writeFileSync(modifiedCopy, modified);
    const built = cargo(
      check.root,
      [
        "build",
        "--locked",
        "--offline",
        "-p",
        "demlik-code-graph",
        "--example",
        "collapse_cli_driver",
      ],
      mutation.name,
    );
    const library = compiledCheckLibrary(
      built.rows,
      "demlik_code_graph",
      check.root,
      check.target,
    );
    const artifacts = built.rows.filter(
      (r) =>
        r.reason === "compiler-artifact" &&
        r.target.name === "collapse_cli_driver" &&
        r.executable,
    );
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].fresh, false);
    const executable = assertCheckPath(artifacts[0].executable, check.target);
    const savedLibrary = preserve(library.path, `${mutation.name}-library`),
      savedExecutable = preserve(executable, `${mutation.name}-executable`);
    const pairFile = path.join(evidence, `${mutation.name}.pairs.json`),
      env = { ...environment, DEMLIK_COLLAPSE_CASES: mutation.witness };
    const run = command(
      process.execPath,
      [
        path.join(check.root, "verification/parity/graph-cli-collapse.mjs"),
        executable,
        pairFile,
      ],
      check.root,
      env,
    );
    fs.writeFileSync(
      path.join(evidence, `${mutation.name}.stdout`),
      run.stdout,
    );
    fs.writeFileSync(
      path.join(evidence, `${mutation.name}.stderr`),
      run.stderr,
    );
    assert.ok(fs.existsSync(pairFile), mutation.name + run.stderr);
    const report = JSON.parse(fs.readFileSync(pairFile, "utf8"));
    assert.equal(report.driverSha256, savedExecutable.sha256);
    assert.equal(report.rejectedInvalidInputs, 5);
    assert.notEqual(run.status, 0, mutation.name);
    assert.ok(
      report.failures.some(
        (f) => f.id === mutation.witness && f.kind === "semantic",
      ),
      mutation.name + JSON.stringify(report.failures),
    );
    assert.deepEqual(
      report.reference.sourceHashes,
      checked.reference.sourceHashes,
    );
    for (const [file, text] of original)
      assert.equal(fs.readFileSync(owner(file), "utf8"), text);
    assert.equal(hash(fs.readFileSync(baseline)), baselineHash);
    const control = {
      ...mutation,
      buildExit: built.exit,
      libraryArtifact: library.artifact,
      driverArtifact: artifacts[0],
      library: savedLibrary,
      executable: savedExecutable,
      modifiedSourceSha256: hash(modified),
      modifiedSourceCopy: modifiedCopy,
      driverSourceSha256: hash(
        fs.readFileSync(
          path.join(
            check.root,
            "crates/code-graph/examples/collapse_cli_driver.rs",
          ),
        ),
      ),
      reportFile: pairFile,
      reportSha256: hash(fs.readFileSync(pairFile)),
      failures: report.failures,
      detected: true,
    };
    controls.push(control);
    fs.writeFileSync(
      path.join(evidence, "progress.json"),
      JSON.stringify(
        { detected: controls.length, planned: mutations.length, controls },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        detected: mutation.name,
        completed: controls.length,
        total: mutations.length,
      }),
    );
  }
  const report = {
    detected: controls.length,
    newControls: 21,
    affectedLegacyControls: 2,
    escaped: 0,
    baselineDriverSha256: baselineHash,
    baselineReportSha256: hash(fs.readFileSync(baselineReport)),
    baselineFullCases: checked.passed,
    reference: checked.reference,
    sourceHashes: Object.fromEntries(
      [...original].map(([p, s]) => [p, hash(s)]),
    ),
    interfaceReplay,
    controls,
    buildProfile: {
      defaultTarget: true,
      worktree: check.root,
      target: check.target,
      debug: 0,
      incremental: false,
      jobs: 1,
    },
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ incomplete: true, detected: controls.length, planned: mutations.length, failure: String(error), interfaceReplay, controls, noBuildOrProtocolFailureCredit: true }, null, 2)}\n`,
  );
  throw error;
} finally {
  if (check) check.remove();
}
