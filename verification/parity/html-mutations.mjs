import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";

const [baselineDirectory, sourceArchive, output] = process.argv.slice(2);
assert.ok(
  baselineDirectory && sourceArchive && output && process.argv.length === 5,
);
assert.ok(
  fs.statSync(sourceArchive).isFile(),
  "explicit ICU77 source archive is required before any check starts",
);
assert.equal(process.version, "v22.21.1");
assert.equal(fs.realpathSync(os.tmpdir()), "/private/tmp");
const root = fileURLToPath(new URL("../..", import.meta.url));
const evidence = path.resolve(output);
fs.mkdirSync(evidence, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const frontdoor = "crates/code-graph/src/cli/frontdoor.rs",
  model = "crates/code-graph/src/render/html/model.rs";
const faults = [
  {
    id: "html-priority-lost",
    owner: frontdoor,
    needle:
      "} else if options.html() == Some(true) {\n            ConsoleOutput::Html",
    fault:
      "} else if options.html() == Some(true) {\n            ConsoleOutput::Graph",
    driver: "collapse_cli_driver",
    witness: "html-wins-late-modes",
    cli: true,
  },
  {
    id: "fan-in-counts-distinct-callers",
    owner: model,
    needle: "edges.called_by.len()",
    fault:
      "crate::extract::edges::distinct_external_callers(&function.id, &edges.called_by)",
    driver: "html_driver",
    witness: "hub-sites-one-hop",
  },
  {
    id: "non-target-neighbors-included",
    owner: model,
    needle:
      "for function in &targets {\n        if let Some(edges) = &function.edges {",
    fault:
      "for function in &graph.functions {\n        if let Some(edges) = &function.edges {",
    driver: "html_driver",
    witness: "hub-sites-one-hop",
  },
  {
    id: "html-extra-newline",
    owner: frontdoor,
    needle:
      "let payload = crate::render::html::render_html(&graph, &collation)\n                .map_err(FrontdoorError::ReportRender)?;",
    fault:
      'let mut payload = crate::render::html::render_html(&graph, &collation)\n                .map_err(FrontdoorError::ReportRender)?;\n            payload.push_str("\\n");',
    driver: "collapse_cli_driver",
    witness: "html-real-file-overwrite-workflow",
    cli: true,
  },
];
const originals = Object.fromEntries(
  [frontdoor, model].map((file) => [
    file,
    fs.readFileSync(path.join(root, file), "utf8"),
  ]),
);
for (const fault of faults)
  assert.equal(originals[fault.owner].split(fault.needle).length, 2, fault.id);
const selected = JSON.parse(
  fs.readFileSync(path.join(baselineDirectory, "green-selected.json"), "utf8"),
);
const baselineHashes = {};
for (const name of ["html_driver", "collapse_cli_driver"]) {
  const entry = selected[name],
    bytes = gunzipSync(
      fs.readFileSync(path.join(baselineDirectory, entry.retained)),
    );
  assert.equal(hash(bytes), entry.sha256);
  baselineHashes[name] = entry.sha256;
}
const pureBaseline = JSON.parse(
  fs.readFileSync(path.join(baselineDirectory, "pure-pairs.json"), "utf8"),
);
const cliBaseline = JSON.parse(
  fs.readFileSync(path.join(baselineDirectory, "cli-pairs.json"), "utf8"),
);
assert.equal(pureBaseline.passed, 14);
assert.equal(cliBaseline.passed, 20);
assert.deepEqual(pureBaseline.failures, []);
assert.deepEqual(cliBaseline.failures, []);
const report = {
  planned: 4,
  cargoSelections: 0,
  nativePreparations: 0,
  baselineHashes,
  controls: [],
  complete: false,
};
const save = () =>
  fs.writeFileSync(
    path.join(evidence, "controls.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
function invoke(name, program, args, cwd, env) {
  const started = Date.now(),
    result = spawnSync(program, args, { cwd, env, maxBuffer: 64 << 20 });
  fs.writeFileSync(path.join(evidence, `${name}.stdout`), result.stdout ?? "");
  fs.writeFileSync(path.join(evidence, `${name}.stderr`), result.stderr ?? "");
  const recorded = {
    argv: [program, ...args],
    cwd,
    exit: result.status,
    signal: result.signal,
    error: result.error?.message,
    milliseconds: Date.now() - started,
    runtimeTMPDIR: env.TMPDIR,
  };
  fs.writeFileSync(
    path.join(evidence, `${name}.json`),
    `${JSON.stringify(recorded, null, 2)}\n`,
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...recorded, text: result.stdout.toString("utf8") };
}
function retain(file, name) {
  const bytes = fs.readFileSync(file),
    retained = `${name}.gz`;
  fs.writeFileSync(path.join(evidence, retained), gzipSync(bytes));
  return {
    path: file,
    bytes: bytes.length,
    sha256: hash(bytes),
    retained,
    gzipSha256: hash(fs.readFileSync(path.join(evidence, retained))),
  };
}
let check, runtime, operationError, cleanupError;
try {
  check = createCheckWorktree(root, "html-controls", evidence);
  runtime = path.join(path.dirname(check.root), "runtime");
  fs.mkdirSync(runtime);
  fs.mkdirSync(path.join(check.target, "tmp"), { recursive: true });
  fs.mkdirSync(path.join(check.target, "parity"));
  for (const dir of [
    "node_modules",
    "packages/code-graph/node_modules",
    "packages/tea/node_modules",
    "verification/parity/node_modules",
  ]) {
    const from = path.join(root, dir);
    if (fs.existsSync(from))
      fs.symlinkSync(fs.realpathSync(from), path.join(check.root, dir));
  }
  const environment = cargoCheckEnvironment({
    PATH: `/private/tmp/demlik-rust-toolchain-01a16c9d/cargo/bin:${process.env.PATH}`,
    RUSTUP_HOME: "/private/tmp/demlik-rust-toolchain-01a16c9d/rustup",
    CARGO_HOME: "/private/tmp/demlik-pbt-cargo-home-01a16c9d",
    RUSTUP_TOOLCHAIN: "stable",
    CARGO_NET_OFFLINE: "true",
    CARGO_BUILD_JOBS: "1",
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
    DEMLIK_ICU77_PYTHON: "/opt/homebrew/bin/python3",
    RUST_ICU_MAJOR_VERSION_NUMBER: "77",
    RUST_ICU_LINK_SEARCH_DIR: path.join(check.target, "icu77/install/lib"),
    DEMLIK_ICU77_PREPARED: path.join(check.target, "icu77/prepared.json"),
    TMPDIR: path.join(check.target, "tmp"),
  });
  const prepared = invoke(
    "native-prepare",
    environment.DEMLIK_ICU77_PYTHON,
    [
      "tools/icu77/prepare.py",
      "prepare",
      "--host",
      "aarch64-apple-darwin",
      "--target",
      "aarch64-apple-darwin",
      "--source-archive",
      path.resolve(sourceArchive),
      "--cargo",
      process.env.CARGO ??
        "/private/tmp/demlik-rust-toolchain-01a16c9d/cargo/bin/cargo",
    ],
    check.root,
    environment,
  );
  report.nativePreparations++;
  save();
  assert.equal(
    prepared.exit,
    0,
    "preparation failure earns zero semantic credit",
  );
  fs.copyFileSync(
    path.join(check.target, "icu77/prepared.json"),
    path.join(evidence, "native-prepared.json"),
  );
  for (const fault of faults) {
    for (const [owner, original] of Object.entries(originals))
      fs.writeFileSync(path.join(check.root, owner), original);
    const modified = originals[fault.owner].replace(fault.needle, fault.fault);
    fs.writeFileSync(path.join(check.root, fault.owner), modified);
    fs.writeFileSync(path.join(evidence, `${fault.id}.rs`), modified);
    const build = invoke(
      `${fault.id}-cargo`,
      process.env.CARGO ??
        "/private/tmp/demlik-rust-toolchain-01a16c9d/cargo/bin/cargo",
      [
        "build",
        "-p",
        "demlik-code-graph",
        "--example",
        fault.driver,
        "--locked",
        "--offline",
        "--message-format=json",
      ],
      check.root,
      environment,
    );
    report.cargoSelections++;
    save();
    assert.equal(build.exit, 0, "compiler failure earns zero semantic credit");
    const events = build.text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
      library = compiledCheckLibrary(
        events,
        "demlik_code_graph",
        check.root,
        check.target,
      );
    const artifacts = events.filter(
      (event) =>
        event.reason === "compiler-artifact" &&
        event.target.name === fault.driver &&
        event.executable,
    );
    assert.equal(artifacts.length, 1);
    const consumer = artifacts[0];
    assert.equal(consumer.fresh, false);
    const binary = assertCheckPath(consumer.executable, check.target);
    const keptLibrary = retain(library.path, `${fault.id}-library`),
      keptConsumer = retain(binary, `${fault.id}-executed`),
      pairs = path.join(evidence, `${fault.id}-pairs.json`);
    const runtimeEnvironment = {
      ...environment,
      TMPDIR: runtime,
      ...(fault.cli ? { DEMLIK_REPORT_CLI_CASES: fault.witness } : {}),
    };
    const args = fault.cli
      ? [
          path.join(check.root, "verification/parity/graph-cli-reports.mjs"),
          binary,
          pairs,
          "html",
        ]
      : [
          "--import",
          fs.realpathSync(
            path.join(
              check.root,
              "verification/parity/node_modules/tsx/dist/loader.mjs",
            ),
          ),
          path.join(check.root, "verification/parity/graph-html.mjs"),
          binary,
          pairs,
        ];
    const run = invoke(
      `${fault.id}-run`,
      process.execPath,
      args,
      check.root,
      runtimeEnvironment,
    );
    assert.equal(run.exit, 1);
    const observed = JSON.parse(fs.readFileSync(pairs, "utf8")),
      witness = observed.cases.find((row) => row.id === fault.witness),
      baseline = (fault.cli ? cliBaseline : pureBaseline).cases.find(
        (row) => row.id === fault.witness,
      );
    assert.ok(witness && baseline.passed && !baseline.qualifications.length);
    assert.equal(witness.passed, false);
    assert.deepEqual(witness.qualifications, []);
    assert.ok(
      observed.failures.some((failure) => failure.id === fault.witness),
    );
    if (fault.cli) {
      assert.equal(witness.failure.kind, "semantic");
      for (const step of witness.native) {
        assert.equal(step.output.status, 0);
        assert.equal(step.trace.outcome.kind, "reports");
        assert.ok(
          step.trace.observedCalls
            .at(-1)
            .endsWith("::dispatch_reports_blocking"),
        );
      }
    } else {
      assert.equal(witness.process.status, 0);
      assert.equal(witness.actual.ok, true);
      assert.deepEqual(witness.input, baseline.input);
      assert.deepEqual(witness.expected, baseline.expected);
      assert.deepEqual(witness.actual.observedCalls, [
        "demlik_code_graph::render::html::build_html_model",
        "demlik_code_graph::render::html::render_html",
      ]);
      assert.notDeepEqual(witness.actual.output, witness.expected);
    }
    report.controls.push({
      id: fault.id,
      witness: fault.witness,
      owner: fault.owner,
      modifiedSha256: hash(modified),
      compileExit: 0,
      library: { event: library.artifact, retained: keptLibrary },
      consumer,
      executed: keptConsumer,
      comparison: pairs,
      protocolValid: true,
      semanticMismatch: true,
      strict: true,
    });
    save();
  }
  assert.equal(report.cargoSelections, 4);
  assert.equal(report.controls.length, 4);
  report.complete = true;
} catch (error) {
  operationError = error;
  report.operationFailure = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
} finally {
  if (check) {
    for (const [owner, original] of Object.entries(originals))
      fs.writeFileSync(path.join(check.root, owner), original);
    report.checkOwnersRestored = Object.entries(originals).every(
      ([owner, original]) =>
        fs.readFileSync(path.join(check.root, owner), "utf8") === original,
    );
    fs.rmSync(runtime, { recursive: true, force: true });
    try {
      check.remove();
    } catch (error) {
      cleanupError = error;
      report.cleanupFailure = String(error);
    }
  }
  report.worktreeRemoved = !check || !fs.existsSync(check.root);
  report.defaultTargetRemoved = !check || !fs.existsSync(check.target);
  report.originalOwnersUnchanged = Object.entries(originals).every(
    ([owner, original]) =>
      fs.readFileSync(path.join(root, owner), "utf8") === original,
  );
  report.complete &&=
    !operationError &&
    !cleanupError &&
    report.worktreeRemoved &&
    report.defaultTargetRemoved &&
    report.originalOwnersUnchanged;
  save();
}
if (operationError || cleanupError)
  throw new AggregateError(
    [operationError, cleanupError].filter(Boolean),
    `HTML controls failed: ${evidence}`,
  );
console.log(
  JSON.stringify({
    detected: report.controls.length,
    complete: report.complete,
  }),
);
