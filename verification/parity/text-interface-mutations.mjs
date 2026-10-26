import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseline = process.argv[2],
  reportFile = process.argv[3];
assert.ok(
  baseline && reportFile,
  "usage: text-interface-mutations.mjs <pinned-driver> <report>",
);
assert.equal(process.argv.length, 4);
assert.equal(process.version, "v22.21.1");
const root = fileURLToPath(new URL("../..", import.meta.url));
const directory = fs.mkdtempSync(
  path.join(path.dirname(reportFile), "text-interface-faults-"),
);
const workspace = path.join(directory, "workspace");
const target = path.join(root, "target/parity/comments-mutation-build");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const baselineHash = hash(fs.readFileSync(baseline));
const environment = {
  ...process.env,
  CARGO_TARGET_DIR: target,
  CARGO_NET_OFFLINE: "true",
  CARGO_PROFILE_DEV_DEBUG: "0",
  CARGO_PROFILE_TEST_DEBUG: "0",
  CARGO_INCREMENTAL: "0",
  CARGO_BUILD_JOBS: "1",
  TSX_DISABLE_CACHE: "1",
};
const mutations = [
  {
    name: "config-text-replaced-before-rpc",
    file: "checker/context.rs",
    before: "Some(config) => open_type_session_text(binary, config)?,",
    after:
      "Some(config) => open_type_session(binary, Path::new(&config.to_lossy()))?,",
    witness: "raw-config.context-text",
  },
  {
    name: "root-files-replaced-before-rpc",
    file: "checker/context.rs",
    before: ".map(|unit| join_path_text(root, &unit.file.as_str().into()))",
    after:
      ".map(|unit| JsString::from(join_path_text(root, &unit.file.as_str().into()).to_lossy()))",
    witness: "raw-source.context-text",
  },
  {
    name: "source-lookup-replaced-before-rpc",
    file: "checker/context.rs",
    before: "Some(roots) => program.source_file_text(&roots[index])?,",
    after:
      "Some(roots) => program.source_file(Path::new(&roots[index].to_lossy()))?,",
    witness: "raw-source.context-text",
  },
  {
    name: "assembly-uses-native-context",
    file: "extract/assemble.rs",
    before: "Some(root) => with_type_context_text(binary, input, root, read),",
    after:
      "Some(root) => { let _=root; with_type_context(binary, input, read) },",
    witness: "raw-config.assembly-text",
  },
  {
    name: "provenance-uses-native-spelling",
    file: "extract/assemble.rs",
    before:
      "crate::project::selected_config_text(root, &loaded.ts_config_path).to_lossy()",
    after:
      "{ let _=root; loaded.ts_config_path.to_string_lossy().into_owned() }",
    witness: "raw-normalized-away.assembly-text",
  },
  {
    name: "assembly-erases-error-name",
    file: "extract/assemble.rs",
    before: "Self::Analysis(error) => error.name(),",
    after: 'Self::Analysis(error) => { let _=error; "Error" },',
    witness: "catalog-type-error.assembly-text",
  },
  {
    name: "assembly-erases-raw-message",
    file: "extract/assemble.rs",
    before: "Self::Analysis(error) => error.message(),",
    after: "Self::Analysis(error) => error.message().to_lossy().into(),",
    witness: "raw-glob.high",
  },
  {
    name: "analysis-erases-original-cause",
    file: "extract/analysis.rs",
    before:
      "Some(match self {\n            Self::Catalog(error) => error,\n            Self::Compiler(error) => error,\n            Self::Pattern(error) => error,\n            Self::Convention(error) => error,\n            Self::WorkingDirectory(error) => error,\n            Self::ExportPatterns(error) => error,\n        })",
    after: "None",
    witness: "catalog-type-error.assembly-text",
  },
];
const originals = new Map(
  [...new Set(mutations.map((x) => x.file))].map((file) => [
    file,
    fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
  ]),
);
for (const row of mutations)
  assert.equal(originals.get(row.file).split(row.before).length, 2, row.name);
function pairs(binary, name, ids) {
  const report = path.join(directory, `${name}.json`);
  const command = [
    "--import",
    createRequire(import.meta.url).resolve("tsx"),
    path.join(root, "verification/parity/graph-text-interface.mts"),
    binary,
    report,
    "--ids",
    ids.join(","),
  ];
  const run = spawnSync(process.execPath, command, {
    cwd: root,
    env: environment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  fs.writeFileSync(
    path.join(directory, `${name}.log`),
    run.stdout + run.stderr,
  );
  assert.ok(
    fs.existsSync(report),
    `missing comparer report: ${run.stdout}${run.stderr}`,
  );
  return {
    command: [process.execPath, ...command],
    status: run.status,
    reportFile: report,
    report: JSON.parse(fs.readFileSync(report, "utf8")),
  };
}
const controls = [];
let before;
try {
  const witnesses = [...new Set(mutations.map((row) => row.witness))];
  before = pairs(baseline, "baseline", witnesses);
  assert.equal(before.status, 0, JSON.stringify(before.report.failures));
  assert.equal(before.report.passed, witnesses.length);
  assert.equal(before.report.rejectedInvalidInputs, 6);
  for (const entry of ["Cargo.toml", "Cargo.lock", "crates"])
    fs.cpSync(path.join(root, entry), path.join(workspace, entry), {
      recursive: true,
    });
  for (const mutation of mutations) {
    for (const [file, original] of originals)
      fs.writeFileSync(
        path.join(workspace, "crates/code-graph/src", file),
        original,
      );
    fs.writeFileSync(
      path.join(workspace, "crates/code-graph/src", mutation.file),
      originals.get(mutation.file).replace(mutation.before, mutation.after),
    );
    const command = [
      "build",
      "--offline",
      "-p",
      "demlik-code-graph",
      "--example",
      "text_assembly_driver",
      "--message-format=json",
    ];
    const build = spawnSync(process.env.CARGO ?? "cargo", command, {
      cwd: workspace,
      env: environment,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const cargoJson = path.join(directory, `${mutation.name}.build.jsonl`),
      cargoLog = path.join(directory, `${mutation.name}.build.log`);
    fs.writeFileSync(cargoJson, build.stdout);
    fs.writeFileSync(cargoLog, build.stderr);
    assert.equal(
      build.status,
      0,
      `${mutation.name}: compile failure is not a semantic detection\n${build.stderr}`,
    );
    const rows = build.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      rows.some(
        (row) => row.reason === "build-finished" && row.success === true,
      ),
    );
    const artifacts = rows.filter(
      (row) =>
        row.reason === "compiler-artifact" &&
        row.target.name === "text_assembly_driver" &&
        row.executable,
    );
    assert.equal(artifacts.length, 1);
    const artifact = artifacts[0];
    assert.notEqual(path.resolve(artifact.executable), path.resolve(baseline));
    const effective = path.join(directory, `${mutation.name}.driver`);
    fs.copyFileSync(
      artifact.executable,
      effective,
      fs.constants.COPYFILE_FICLONE,
    );
    const binaryHash = hash(fs.readFileSync(effective));
    assert.equal(binaryHash, hash(fs.readFileSync(artifact.executable)));
    const result = pairs(effective, mutation.name, [mutation.witness]);
    assert.notEqual(result.status, 0, mutation.name);
    assert.equal(result.report.attempted, 1);
    assert.equal(result.report.rejectedInvalidInputs, 6);
    assert.ok(result.report.failures.length > 0);
    assert.ok(
      result.report.failures.every((row) => row.kind === "semantic"),
      "protocol/harness failures cannot count",
    );
    assert.ok(
      result.report.failures.some((row) => row.id === mutation.witness),
      mutation.name,
    );
    controls.push({
      ...mutation,
      detected: true,
      build: {
        command: [process.env.CARGO ?? "cargo", ...command],
        cwd: workspace,
        status: build.status,
        cargoJson,
        cargoLog,
        artifact,
      },
      effectiveExecutable: {
        path: effective,
        sha256: binaryHash,
        bytes: fs.statSync(effective).size,
      },
      comparison: result,
    });
    assert.equal(hash(fs.readFileSync(baseline)), baselineHash);
    for (const [file, original] of originals)
      assert.equal(
        fs.readFileSync(path.join(root, "crates/code-graph/src", file), "utf8"),
        original,
      );
    process.stdout.write(
      `${JSON.stringify({ detected: mutation.name, completed: controls.length, total: mutations.length })}\n`,
    );
  }
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ detected: controls.length, escaped: 0, baseline: before, baselineDriverSha256: baselineHash, baselineDriverUnchanged: true, reference: before.report.reference, verifierSha256: hash(fs.readFileSync(path.join(root, "verification/parity/graph-text-interface.mts"))), scriptSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))), sourceHashes: Object.fromEntries([...originals].map(([file, text]) => [file, hash(text)])), buildProfile: { target, offline: true, devDebug: 0, testDebug: 0, incremental: false, jobs: 1, note: "Existing dedicated warm mutation target; Cargo aliases are temporary, effectiveExecutable copies are authoritative." }, controls }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ detected: controls.length, escaped: 0 }));
} catch (error) {
  fs.writeFileSync(
    reportFile,
    `${JSON.stringify({ incomplete: true, planned: mutations.length, detected: controls.length, failure: String(error), baseline: before, controls }, null, 2)}\n`,
  );
  throw error;
}
