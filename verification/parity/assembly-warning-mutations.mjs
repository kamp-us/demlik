import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [
  unitBaseline,
  textBaseline,
  warningBaselineReport,
  textBaselineReport,
  reportFile,
] = process.argv.slice(2);
assert.equal(
  process.argv.length,
  7,
  "usage: assembly-warning-mutations.mjs <unit-baseline> <text-baseline> <warning-baseline-report> <text-baseline-report> <report>",
);
assert.equal(process.version, "v22.21.1");
assert.equal(
  process.env.CARGO_TARGET_DIR,
  undefined,
  "one registered worktree, default target, no cache copies",
);
const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = fs.mkdtempSync(
  path.join(path.dirname(reportFile), "assembly-warning-faults-"),
);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const owner = (name) => path.join(root, "crates/code-graph/src", name);
const baselineHashes = [unitBaseline, textBaseline].map((file) =>
  hash(fs.readFileSync(file)),
);
for (const [index, report] of [
  warningBaselineReport,
  textBaselineReport,
].entries()) {
  const baseline = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(baseline.failures.length, 0);
  if (index === 0)
    assert.equal(baseline.nativeExecutable.sha256, baselineHashes[0]);
}
const assembly = fs.readFileSync(owner("extract/assemble.rs"), "utf8");
const functionWarning = assembly.slice(
  assembly.indexOf("        report_unjoined(\n"),
  assembly.indexOf("        Ok((|| -> Result<_, AnalysisError>"),
);
const declarationStart = assembly.indexOf("            report_unjoined(\n");
const declarationWarning = assembly.slice(
  declarationStart,
  assembly.indexOf("            let analysis =", declarationStart),
);
assert.ok(functionWarning.includes("function(s)"));
assert.ok(declarationWarning.includes("declaration(s)"));
const mutations = [
  {
    name: "callback-is-discarded",
    witness: "declarations.callback",
    mode: "warning",
    file: "extract/assemble.rs",
    before: "Some(warning) => warning(&line),",
    after: "Some(warning) => { let _ = warning; },",
  },
  {
    name: "function-warning-after-analysis-preparation",
    witness: "function-before-error.callback",
    mode: "warning",
    file: "extract/assemble.rs",
    transform: (s) =>
      s
        .replace(functionWarning, "")
        .replace(
          "                .unwrap_or_else(AnalysisPrep::default);",
          `                .unwrap_or_else(AnalysisPrep::default);\n${functionWarning}`,
        ),
  },
  {
    name: "declaration-warning-after-analysis-completion",
    witness: "declaration-before-kind-error",
    mode: "warning",
    file: "extract/assemble.rs",
    transform: (s) =>
      s
        .replace(declarationWarning, "")
        .replace(
          "            Ok((result, uses.uses_by_id, analysis))",
          `${declarationWarning}            Ok((result, uses.uses_by_id, analysis))`,
        ),
  },
  {
    name: "function-warning-delivered-after-declaration",
    witness: "both.callback",
    mode: "warning",
    file: "extract/assemble.rs",
    transform: (s) =>
      s
        .replace(functionWarning, "")
        .replace(declarationWarning, `${declarationWarning}${functionWarning}`),
  },
  {
    name: "warning-newline-lost",
    witness: "declarations.callback",
    mode: "warning",
    file: "extract/assemble.rs",
    before: '"code-graph: warning: {} {what}: {shown}{more}\\n",',
    after: '"code-graph: warning: {} {what}: {shown}{more}",',
  },
  {
    name: "five-item-preview-truncated-to-four",
    witness: "function-count-5",
    mode: "warning",
    file: "extract/assemble.rs",
    before: ".take(5)",
    after: ".take(4)",
  },
  {
    name: "exactly-five-abbreviated",
    witness: "declaration-count-5",
    mode: "warning",
    file: "extract/assemble.rs",
    before: "unjoined.len() > 5",
    after: "unjoined.len() >= 5",
  },
  {
    name: "empty-warning-emitted",
    witness: "quiet.callback",
    mode: "warning",
    file: "extract/assemble.rs",
    before: "    if unjoined.is_empty() {\n        return;\n    }",
    after: "",
  },
  {
    name: "text-root-replaced-by-native-context",
    witness: "raw-config",
    mode: "warning",
    file: "extract/assemble.rs",
    before: "let root_text = text.as_ref().map(|text| text.root);",
    after: "let root_text: Option<&JsString> = None;",
  },
  // Same eight sites/witnesses as the existing text-interface controls, using this check's default target.
  {
    name: "legacy.config-text-replaced-before-rpc",
    mode: "text",
    file: "checker/context.rs",
    before: "Some(config) => open_type_session_text(binary, config)?,",
    after:
      "Some(config) => open_type_session(binary, Path::new(&config.to_lossy()))?,",
    witness: "raw-config.context-text",
  },
  {
    name: "legacy.root-files-replaced-before-rpc",
    mode: "text",
    file: "checker/context.rs",
    before: ".map(|unit| join_path_text(root, &unit.file.as_str().into()))",
    after:
      ".map(|unit| JsString::from(join_path_text(root, &unit.file.as_str().into()).to_lossy()))",
    witness: "raw-source.context-text",
  },
  {
    name: "legacy.source-lookup-replaced-before-rpc",
    mode: "text",
    file: "checker/context.rs",
    before: "Some(roots) => program.source_file_text(&roots[index])?,",
    after:
      "Some(roots) => program.source_file(Path::new(&roots[index].to_lossy()))?,",
    witness: "raw-source.context-text",
  },
  {
    name: "legacy.assembly-uses-native-context",
    mode: "text",
    file: "extract/assemble.rs",
    before: "Some(root) => with_type_context_text(binary, input, root, read),",
    after:
      "Some(root) => { let _=root; with_type_context(binary, input, read) },",
    witness: "raw-config.assembly-text",
  },
  {
    name: "legacy.provenance-uses-native-spelling",
    mode: "text",
    file: "extract/assemble.rs",
    before:
      "crate::project::selected_config_text(root, &loaded.ts_config_path).to_lossy()",
    after:
      "{ let _=root; loaded.ts_config_path.to_string_lossy().into_owned() }",
    witness: "raw-normalized-away.assembly-text",
  },
  {
    name: "legacy.assembly-erases-error-name",
    mode: "text",
    file: "extract/assemble.rs",
    before: "Self::Analysis(error) => error.name(),",
    after: 'Self::Analysis(error) => { let _=error; "Error" },',
    witness: "catalog-type-error.assembly-text",
  },
  {
    name: "legacy.assembly-erases-raw-message",
    mode: "text",
    file: "extract/assemble.rs",
    before: "Self::Analysis(error) => error.message(),",
    after: "Self::Analysis(error) => error.message().to_lossy().into(),",
    witness: "raw-glob.high",
  },
  {
    name: "legacy.analysis-erases-original-cause",
    mode: "text",
    file: "extract/analysis.rs",
    before:
      "Some(match self {\n            Self::Catalog(error) => error,\n            Self::Compiler(error) => error,\n            Self::Pattern(error) => error,\n            Self::Convention(error) => error,\n            Self::WorkingDirectory(error) => error,\n            Self::ExportPatterns(error) => error,\n        })",
    after: "None",
    witness: "catalog-type-error.assembly-text",
  },
];
const originals = new Map(
  [...new Set(mutations.map((row) => row.file))].map((file) => [
    file,
    fs.readFileSync(owner(file), "utf8"),
  ]),
);
for (const row of mutations) {
  const original = originals.get(row.file);
  if (row.before !== undefined)
    assert.equal(original.split(row.before).length, 2, row.name);
  else assert.notEqual(row.transform(original), original, row.name);
}
const restore = () => {
  for (const [file, source] of originals) fs.writeFileSync(owner(file), source);
};
const results = [];
let infrastructure;
try {
  for (const [index, row] of mutations.entries()) {
    restore();
    const original = originals.get(row.file);
    const changed = row.transform
      ? row.transform(original)
      : original.replace(row.before, row.after);
    assert.notEqual(changed, original);
    fs.writeFileSync(owner(row.file), changed);
    const folder = path.join(directory, `${index + 1}-${row.name}`);
    fs.mkdirSync(folder);
    const args =
      row.mode === "warning"
        ? [
            "test",
            "-p",
            "demlik-code-graph",
            "--lib",
            "--no-run",
            "--message-format=json",
          ]
        : [
            "build",
            "-p",
            "demlik-code-graph",
            "--example",
            "text_assembly_driver",
            "--message-format=json",
          ];
    const build = spawnSync(process.env.CARGO ?? "cargo", args, {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(folder, "cargo.jsonl"), build.stdout);
    fs.writeFileSync(path.join(folder, "cargo.stderr"), build.stderr);
    assert.equal(
      build.status,
      0,
      `${row.name}: compile failure is infrastructure, never a caught fault`,
    );
    const messages = build.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const artifacts = messages.filter(
      (message) => message.reason === "compiler-artifact",
    );
    const executable = artifacts.find(
      (artifact) =>
        artifact.executable &&
        (row.mode === "warning"
          ? artifact.target.name === "demlik_code_graph" &&
            artifact.profile.test
          : artifact.target.name === "text_assembly_driver"),
    );
    const library = artifacts.find(
      (artifact) =>
        artifact.target.name === "demlik_code_graph" &&
        (row.mode === "warning"
          ? artifact.profile.test
          : !artifact.profile.test),
    );
    assert.ok(executable && library);
    assert.equal(executable.fresh, false);
    assert.equal(library.fresh, false);
    assert.ok(
      path
        .resolve(executable.executable)
        .startsWith(path.join(root, "target") + path.sep),
    );
    const selected = path.join(
      folder,
      row.mode === "warning" ? "unit-executable" : "text-executable",
    );
    fs.copyFileSync(executable.executable, selected);
    fs.chmodSync(selected, 0o755);
    const pairs = path.join(folder, "pairs.json");
    const script =
      row.mode === "warning"
        ? "graph-assembly-warning.mts"
        : "graph-text-interface.mts";
    const command = [
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      path.join(root, "verification/parity", script),
      selected,
      pairs,
      "--ids",
      row.witness,
    ];
    const run = spawnSync(process.execPath, command, {
      cwd: root,
      env: { ...process.env, TSX_DISABLE_CACHE: "1" },
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(folder, "pairs.stdout"), run.stdout);
    fs.writeFileSync(path.join(folder, "pairs.stderr"), run.stderr);
    assert.equal(
      run.status,
      1,
      `${row.name}: expected a reported semantic mismatch`,
    );
    const report = JSON.parse(fs.readFileSync(pairs, "utf8"));
    assert.ok(
      report.failures.some((failure) => failure.id === row.witness),
      `${row.name}: intended witness missing`,
    );
    const observation = report.cases.find((test) => test.id === row.witness);
    assert.ok(
      observation &&
        (observation.native !== undefined || observation.actual !== undefined),
    );
    results.push({
      name: row.name,
      witness: row.witness,
      mode: row.mode,
      compileExit: build.status,
      pairsExit: run.status,
      protocolValid: true,
      semanticMismatch: observation,
      owner: row.file,
      ownerBaselineSha256: hash(original),
      ownerMutantSha256: hash(changed),
      command: [process.env.CARGO ?? "cargo", ...args],
      nativeCommand: [process.execPath, ...command],
      selectedExecutable: {
        path: selected,
        sha256: hash(fs.readFileSync(selected)),
      },
      library,
      executable,
      pairReport: pairs,
    });
    fs.writeFileSync(
      path.join(folder, "control.json"),
      `${JSON.stringify(results.at(-1), null, 2)}\n`,
    );
    console.log(JSON.stringify({ name: row.name, caught: true }));
  }
} catch (error) {
  infrastructure = String(error);
} finally {
  restore();
}
for (const [file, source] of originals)
  assert.equal(fs.readFileSync(owner(file), "utf8"), source);
assert.deepEqual(
  [unitBaseline, textBaseline].map((file) => hash(fs.readFileSync(file))),
  baselineHashes,
);
const report = {
  status: infrastructure
    ? "incomplete; infrastructure never counted"
    : "all controls compiled, protocol-valid and caught by their named semantic witness",
  checkWorktree: root,
  defaultTarget: path.join(root, "target"),
  noTargetOverride: true,
  originalsRestored: true,
  baselinesUnchanged: true,
  legacyCanonicalScript: {
    path: path.join(root, "verification/parity/text-interface-mutations.mjs"),
    sha256: hash(
      fs.readFileSync(
        path.join(root, "verification/parity/text-interface-mutations.mjs"),
      ),
    ),
  },
  planned: mutations.length,
  caught: results.length,
  newControls: results.filter((row) => row.mode === "warning").length,
  affectedLegacyControls: results.filter((row) => row.mode === "text").length,
  infrastructure,
  controls: results,
};
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
if (infrastructure) {
  console.error(infrastructure);
  process.exitCode = 1;
}
