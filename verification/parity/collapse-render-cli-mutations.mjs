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

const [
  renderBinary,
  renderReport,
  cliBinary,
  cliReport,
  reportFile,
  evidenceDirectory,
] = process.argv.slice(2);
assert.ok(
  renderBinary &&
    renderReport &&
    cliBinary &&
    cliReport &&
    reportFile &&
    evidenceDirectory,
);
for (const key of [
  "CARGO_TARGET_DIR",
  "CARGO_BUILD_TARGET_DIR",
  "CARGO_BUILD_BUILD_DIR",
  "DEMLIK_MUTATION_TARGET_DIR",
])
  assert.equal(process.env[key], undefined, key);
const root = fileURLToPath(new URL("../..", import.meta.url)),
  evidence = path.resolve(evidenceDirectory),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const baselines = {
    render: JSON.parse(fs.readFileSync(renderReport, "utf8")),
    cli: JSON.parse(fs.readFileSync(cliReport, "utf8")),
  },
  binaries = { render: renderBinary, cli: cliBinary },
  baselineHashes = Object.fromEntries(
    Object.entries(binaries).map(([kind, file]) => [
      kind,
      hash(fs.readFileSync(file)),
    ]),
  );
assert.equal(baselines.render.passed, 36);
assert.equal(baselines.render.attempted, 36);
assert.equal(baselines.render.binary.sha256, baselineHashes.render);
assert.equal(baselines.cli.passed, 49);
assert.equal(baselines.cli.attempted, 49);
assert.equal(baselines.cli.strictPairs, 35);
assert.equal(baselines.cli.qualifiedPairs, 10);
assert.equal(baselines.cli.nativeOnlyCases, 4);
assert.equal(baselines.cli.driverSha256, baselineHashes.cli);
for (const b of Object.values(baselines)) assert.deepEqual(b.failures, []);
const render = "crates/code-graph/src/collapse/render.rs",
  front = "crates/code-graph/src/cli/frontdoor.rs",
  io = "crates/code-graph/src/cli/io.rs",
  partial = "crates/code-graph/src/collapse/partial.rs";
const warning = `        if options.plan() != Some(true)
            && let Some(by) = options.by().filter(|by| *by != "rot")
        {
            let mut warning = JsString::from("warning: --by ");
            warning.extend(by);
            warning.push_str(" has no effect without --plan.\\n");
            host.write_stderr(&warning);
        }
`;
const ack = `        let mut line = JsString::from(format!("code-graph: wrote {} bytes to ", bytes.len()));\n        line.extend(destination);\n        line.push_str("\\n");\n        host.write_stderr(&line);\n`;
const faults = [
  {
    name: "cheap-pass-does-work",
    kind: "render",
    file: render,
    witness: "cheap-diagnostic",
    edits: [
      [
        "    if !matches!(graph.provenance, Provenance::Edges { .. }) {",
        "    if !matches!(graph.provenance, Provenance::Edges { .. }) {\n        let _ = discover_package_roots(Path::new(&root_absolute.to_lossy()), None);",
      ],
    ],
  },
  {
    name: "human-limit-off-by-one",
    kind: "render",
    file: render,
    witness: "clusters-limit-21",
    edits: [
      ["const HUMAN_LIMIT: usize = 20;", "const HUMAN_LIMIT: usize = 21;"],
    ],
  },
  {
    name: "json-truncated-like-human",
    kind: "render",
    file: render,
    witness: "json-not-human-truncated",
    edits: [
      [
        "stable_stringify(&report, pretty).map(Into::into)",
        "{ let mut report = report; report.clusters.truncate(HUMAN_LIMIT); stable_stringify(&report, pretty).map(Into::into) }",
      ],
    ],
  },
  {
    name: "skipped-limit-off-by-one",
    kind: "render",
    file: render,
    witness: "skipped-many",
    edits: [
      ["const SKIPPED_SHOWN: usize = 5;", "const SKIPPED_SHOWN: usize = 6;"],
    ],
  },
  {
    name: "block-remainder-lost",
    kind: "render",
    file: render,
    witness: "partial-long-block",
    edits: [
      [
        "if twin.shared_block.len() > BLOCK_SHOWN {",
        "if false && twin.shared_block.len() > BLOCK_SHOWN {",
      ],
    ],
  },
  {
    name: "also-members-lost",
    kind: "render",
    file: render,
    witness: "cluster-also",
    edits: [["if !rest.is_empty() {", "if false && !rest.is_empty() {"]],
  },
  {
    name: "callee-units-replaced",
    kind: "render",
    file: render,
    witness: "short.raw-high",
    edits: [
      [
        "let units = callee_id.units();",
        "let encoded = JsString::from(callee_id.to_lossy().as_str()); let units = encoded.units();",
      ],
    ],
  },
  {
    name: "renderer-adds-newline",
    kind: "render",
    file: render,
    witness: "pair-human",
    edits: [
      [
        "Ok(render_human(&report))",
        '{ let mut text = render_human(&report); text.push_str("\\n"); Ok(text) }',
      ],
    ],
  },
  {
    name: "selected-b-offset-replaced-by-prefix",
    kind: "render",
    file: partial,
    witness: "partial-repeated-b-prefix",
    edits: [["calls(self.b)[self.b_start].line", "calls(self.b)[0].line"]],
  },
  {
    name: "by-warning-after-load",
    kind: "cli",
    file: front,
    witness: "warning-before-load-refusal",
    edits: [
      [warning, ""],
      [
        "        let graph = assemble_graph_with_analysis_text_and_warning(\n",
        `${warning}        let graph = assemble_graph_with_analysis_text_and_warning(\n`,
      ],
    ],
  },
  {
    name: "loader-catch-swallows-assembly",
    kind: "cli",
    file: front,
    witness: "data-catalog-failure",
    edits: [
      [
        "        let graph = assemble_graph_with_analysis_text_and_warning(\n",
        "        let graph = match assemble_graph_with_analysis_text_and_warning(\n",
      ],
      [
        "        .map_err(FrontdoorError::Assembly)?;",
        '        { Ok(graph) => graph, Err(_) => { clean_exit(host, &JsString::from("no tsconfig found")); return Ok(PlainCollapseDispatch::Complete); } };',
      ],
    ],
  },
  {
    name: "optional-data-omitted",
    kind: "cli",
    file: front,
    witness: "data-in-graph",
    edits: [
      [
        "            data,\n            TextAssembly {",
        "            None,\n            TextAssembly {",
      ],
    ],
  },
  {
    name: "graph-does-not-preempt",
    kind: "cli",
    file: front,
    witness: "headers-graph-priority",
    edits: [
      [
        "let mut payload = if options.graph() == Some(true) {",
        "let mut payload = if false && options.graph() == Some(true) {",
      ],
    ],
  },
  {
    name: "initial-exit-cleared",
    kind: "cli",
    file: front,
    witness: "initial-exit-preserved",
    edits: [
      [
        "        Ok(PlainCollapseDispatch::Complete)",
        "        host.assign_exit(0.0).map_err(FrontdoorError::ExitCode)?;\n        Ok(PlainCollapseDispatch::Complete)",
      ],
    ],
  },
  {
    name: "output-ack-before-write",
    kind: "cli",
    file: io,
    witness: "out-file",
    edits: [
      [ack, ""],
      [
        "        fs::write(destination.to_lossy(), &bytes).map_err(|source| {",
        `${ack}        fs::write(destination.to_lossy(), &bytes).map_err(|source| {`,
      ],
    ],
  },
  {
    name: "pending-warning-erased",
    kind: "cli",
    file: io,
    witness: "warning-stdio-failure",
    edits: [
      [
        "        if let Err(source) = result {",
        "        if let Err(source) = result && stream != StdioStream::Stderr {",
      ],
    ],
  },
];
const originals = new Map(
  faults.map((f) => [f.file, fs.readFileSync(path.join(root, f.file), "utf8")]),
);
for (const f of faults) {
  let source = originals.get(f.file);
  for (const [before, after] of f.edits) {
    assert.equal(source.split(before).length, 2, f.name);
    source = source.replace(before, after);
  }
  assert.ok(
    baselines[f.kind].cases.some((c) => c.id === f.witness && c.passed),
  );
}
fs.mkdirSync(evidence, { recursive: true });
const environment = cargoCheckEnvironment({
  CARGO_NET_OFFLINE: "true",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
});
const command = (file, args, cwd, env = environment) =>
  spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
function preserve(file, name) {
  const bytes = fs.readFileSync(file),
    packed = gzipSync(bytes),
    saved = path.join(evidence, `${name}.gz`);
  fs.writeFileSync(saved, packed);
  return {
    path: saved,
    sha256: hash(bytes),
    bytes: bytes.length,
    gzipSha256: hash(packed),
    gzipBytes: packed.length,
  };
}
const controls = [];
let check;
try {
  check = createCheckWorktree(root, "collapse-render-cli-faults", evidence);
  fs.mkdirSync(path.join(check.target, "parity"), { recursive: true });
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
  for (const fault of faults) {
    for (const [file, source] of originals)
      fs.writeFileSync(path.join(check.root, file), source);
    for (const [file, source] of originals)
      assert.equal(
        hash(fs.readFileSync(path.join(check.root, file))),
        hash(source),
      );
    let modified = originals.get(fault.file);
    for (const [before, after] of fault.edits)
      modified = modified.replace(before, after);
    const modifiedFile = path.join(check.root, fault.file),
      copy = path.join(evidence, `${fault.name}.rs`);
    fs.writeFileSync(modifiedFile, modified);
    fs.writeFileSync(copy, modified);
    const example =
        fault.kind === "render"
          ? "collapse_render_driver"
          : "collapse_cli_driver",
      build = command(
        process.env.CARGO ?? "cargo",
        [
          "build",
          "--locked",
          "--offline",
          "-p",
          "demlik-code-graph",
          "--example",
          example,
          "--message-format=json",
        ],
        check.root,
      );
    fs.writeFileSync(
      path.join(evidence, `${fault.name}.cargo.jsonl`),
      build.stdout,
    );
    fs.writeFileSync(
      path.join(evidence, `${fault.name}.cargo.stderr`),
      build.stderr,
    );
    assert.equal(build.status, 0, fault.name + build.stderr);
    const events = build.stdout.split("\n").filter(Boolean).map(JSON.parse),
      lib = compiledCheckLibrary(
        events,
        "demlik_code_graph",
        check.root,
        check.target,
      ),
      drivers = events.filter(
        (e) =>
          e.reason === "compiler-artifact" &&
          e.target.name === example &&
          e.executable,
      );
    assert.equal(drivers.length, 1);
    assert.equal(drivers[0].fresh, false);
    const executable = assertCheckPath(drivers[0].executable, check.target),
      depInfoFile = path.join(
        path.dirname(lib.path),
        path
          .basename(lib.path)
          .replace(/^lib/, "")
          .replace(/\.rlib$/, ".d"),
      ),
      depInfo = fs.readFileSync(depInfoFile),
      depInfoCopy = path.join(evidence, `${fault.name}.d`);
    fs.writeFileSync(depInfoCopy, depInfo);
    assert.ok(
      depInfo
        .toString()
        .includes(
          path.relative(
            fs.realpathSync(check.root),
            assertCheckPath(modifiedFile, check.root),
          ),
        ),
      `${fault.name} actual modified-library dependency`,
    );
    const library = preserve(lib.path, `${fault.name}-library`),
      driver = preserve(executable, `${fault.name}-driver`),
      pairsFile = path.join(evidence, `${fault.name}.pairs.json`),
      script =
        fault.kind === "render"
          ? "graph-collapse-render.mts"
          : "graph-cli-plain-collapse.mjs",
      run = command(
        process.execPath,
        [
          "--import",
          path.join(
            check.root,
            "verification/parity/node_modules/tsx/dist/loader.mjs",
          ),
          path.join(check.root, "verification/parity", script),
          executable,
          pairsFile,
        ],
        check.root,
        {
          ...environment,
          [fault.kind === "render"
            ? "DEMLIK_COLLAPSE_RENDER_CASES"
            : "DEMLIK_PLAIN_COLLAPSE_CASES"]: fault.witness,
        },
      );
    fs.writeFileSync(path.join(evidence, `${fault.name}.stdout`), run.stdout);
    fs.writeFileSync(path.join(evidence, `${fault.name}.stderr`), run.stderr);
    assert.ok(fs.existsSync(pairsFile), fault.name + run.stderr);
    const pairs = JSON.parse(fs.readFileSync(pairsFile, "utf8"));
    assert.equal(pairs.attempted, 1);
    assert.notEqual(run.status, 0);
    assert.equal(pairs.rejectedInvalidInputs, fault.kind === "render" ? 4 : 5);
    assert.equal(
      fault.kind === "render" ? pairs.binary.sha256 : pairs.driverSha256,
      driver.sha256,
    );
    assert.ok(
      pairs.failures.some(
        (f) => f.id === fault.witness && f.kind === "semantic",
      ),
      fault.name + JSON.stringify(pairs.failures),
    );
    assert.deepEqual(
      pairs.reference.sourceHashes,
      baselines[fault.kind].reference.sourceHashes,
    );
    for (const [kind, file] of Object.entries(binaries))
      assert.equal(hash(fs.readFileSync(file)), baselineHashes[kind]);
    for (const [file, source] of originals)
      assert.equal(fs.readFileSync(path.join(root, file), "utf8"), source);
    const control = {
      ...fault,
      buildExit: build.status,
      runExit: run.status,
      libraryArtifact: lib.artifact,
      driverArtifact: drivers[0],
      library,
      driver,
      depInfo: { path: depInfoCopy, sha256: hash(depInfo) },
      modifiedSource: { path: copy, sha256: hash(modified) },
      driverSourceSha256: hash(
        fs.readFileSync(
          path.join(check.root, "crates/code-graph/examples", `${example}.rs`),
        ),
      ),
      reportFile: pairsFile,
      reportSha256: hash(fs.readFileSync(pairsFile)),
      failures: pairs.failures,
      detected: true,
    };
    controls.push(control);
    fs.writeFileSync(
      path.join(evidence, "progress.json"),
      `${JSON.stringify({ detected: controls.length, planned: faults.length, controls }, null, 2)}\n`,
    );
    console.log(
      JSON.stringify({
        detected: fault.name,
        completed: controls.length,
        total: faults.length,
      }),
    );
  }
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ detected: controls.length, escaped: 0, baselineReports: { render: { sha256: hash(fs.readFileSync(renderReport)), cases: 36 }, cli: { sha256: hash(fs.readFileSync(cliReport)), cases: 49, strict: 35, qualified: 10, nativeOnly: 4 } }, baselineHashes, sourceHashes: Object.fromEntries([...originals].map(([file, source]) => [file, hash(source)])), controls, buildProfile: { defaultTarget: true, worktree: check.root, target: check.target, jobs: 1, debug: 0, incremental: false }, noBuildOrProtocolFailureCredit: true }, null, 2)}\n`,
  );
} catch (error) {
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ incomplete: true, detected: controls.length, planned: faults.length, error: String(error), controls, noBuildOrProtocolFailureCredit: true }, null, 2)}\n`,
  );
  throw error;
} finally {
  if (check) check.remove();
}
