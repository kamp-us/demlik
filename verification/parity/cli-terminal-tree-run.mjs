import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkedExecFileSync as execFileSync,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export async function cliTerminalTreeParity(cargo, options = {}) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const frozenTS = "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d";
  const sourceDiff = execFileSync(
    "git",
    [
      "diff",
      frozenTS,
      "--",
      "packages/code-graph/src",
      "packages/code-graph/package.json",
      "packages/code-graph/tsup.config.ts",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(sourceDiff, "", "Source product must match frozen TS75de");
  assert.equal(options.binary, undefined, "binary override is unsupported");
  const sourceEvidence =
    options.sourceEvidence ??
    process.env.DEMLIK_CLI_TERMINAL_TREE_SOURCE_EVIDENCE;
  const reportFile = path.resolve(
    options.reportFile ??
      path.join(root, "target/parity/cli-terminal-tree.json"),
  );
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const output = fs.mkdtempSync(`${reportFile}.artifacts-`);
  const source = sourceEvidence ? path.resolve(sourceEvidence) : output;
  const python = options.python ?? process.env.DEMLIK_ICU77_PYTHON ?? "python3";
  if (!sourceEvidence) {
    const require = createRequire(
      path.join(root, "packages/code-graph/package.json"),
    );
    const sourceDist = path.join(output, "source-dist");
    const sourceBuild = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {createRequire} from "node:module"; const require=createRequire(process.cwd()+"/package.json"); await require("tsup").build({config:"tsup.config.ts",outDir:process.argv[1],dts:false});',
        sourceDist,
      ],
      {
        cwd: path.join(root, "packages/code-graph"),
        encoding: "utf8",
        maxBuffer: 32 << 20,
      },
    );
    fs.writeFileSync(
      path.join(output, "source-build.stdout"),
      sourceBuild.stdout ?? "",
    );
    fs.writeFileSync(
      path.join(output, "source-build.stderr"),
      sourceBuild.stderr ?? "",
    );
    assert.ifError(sourceBuild.error);
    assert.equal(sourceBuild.status, 0, sourceBuild.stderr);
    fs.writeFileSync(
      path.join(sourceDist, "package.json"),
      '{"type":"module"}\n',
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(path.dirname(require.resolve("chalk")), "../package.json"),
          "utf8",
        ),
      ).version,
      "5.6.2",
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(path.dirname(require.resolve("commander")), "package.json"),
          "utf8",
        ),
      ).version,
      "11.1.0",
    );
    fs.symlinkSync(
      fs.realpathSync(path.join(root, "packages/code-graph/node_modules")),
      path.join(sourceDist, "node_modules"),
    );
    execFileSync(
      python,
      [
        path.join(here, "cli-terminal-tree-process.py"),
        "source",
        source,
        process.execPath,
        path.join(sourceDist, "index.js"),
      ],
      { cwd: root, maxBuffer: 32 << 20 },
    );
  }
  const sourceReport = path.join(source, "source-processes.json");
  const sourceHash = hash(sourceReport);
  const reference = JSON.parse(fs.readFileSync(sourceReport, "utf8"));
  assert.equal(reference.length, 18);
  execFileSync(
    process.execPath,
    [
      path.join(here, "cli-terminal-tree-build.mjs"),
      output,
      "candidate",
      cargo,
    ],
    { cwd: root, maxBuffer: 64 << 20 },
  );
  const artifactFile = path.join(output, "candidate.artifacts.json");
  const producer = JSON.parse(fs.readFileSync(artifactFile, "utf8"));
  const binary = producer.artifacts.find((item) =>
    item.event.target.kind.includes("bin"),
  );
  assert.ok(binary);
  assert.equal(hash(binary.retained), binary.sha256);
  const label = `adapter-${path.basename(output)}`;
  execFileSync(
    python,
    [
      path.join(here, "cli-terminal-tree-process.py"),
      "native",
      "--label",
      label,
      source,
      binary.retained,
    ],
    { cwd: root, maxBuffer: 32 << 20 },
  );
  assert.equal(hash(sourceReport), sourceHash, "frozen Source receipt changed");
  const nativeReport = path.join(source, `${label}-processes.json`);
  const native = JSON.parse(fs.readFileSync(nativeReport, "utf8"));
  assert.deepEqual(native, reference);
  const report = {
    cases: reference.length,
    passed: reference.length,
    qualifiedPassed: 0,
    failures: [],
    rows: reference.map((row, index) => ({
      id: `cli-terminal-tree.${row.id}`,
      passed: true,
      source: row,
      native: native[index],
    })),
    nativeEvidence: {},
    qualifiedNativeEvidence: {},
    publicBindingClaim:
      "None: the normal CLI has no compiled-public-call trace channel. Empty evidence maps are intentional.",
    scope:
      "Darwin/Unix terminal-tree process profiles only. Frozen TS75de source receipts, exact stdout/stderr/exit/output-file bytes, real stdout PTY with OPOST disabled and separately piped stderr. Automatic help width, raw OS argv, Windows and distribution remain open.",
    sourceExecutions: sourceEvidence ? 0 : reference.length,
    frozenSourceExecutions: sourceEvidence ? reference.length : 0,
    frozenTS,
    sourceProductDiff: sourceDiff,
    node: process.version,
    v8: process.versions.v8,
    nativeExecutions: native.length,
    sourceReport,
    sourceReportSha256: sourceHash,
    sourceRawProcesses: path.join(source, "source"),
    sourceInvocation: path.join(source, "source-invocation.json"),
    sourceBuildStdout: sourceEvidence
      ? null
      : path.join(output, "source-build.stdout"),
    sourceBuildStderr: sourceEvidence
      ? null
      : path.join(output, "source-build.stderr"),
    nativeReport,
    nativeReportSha256: hash(nativeReport),
    rawProcesses: path.join(source, label),
    invocation: path.join(source, `${label}-invocation.json`),
    artifactFile,
    artifactFileSha256: hash(artifactFile),
    cargoJson: path.join(output, "candidate.cargo.jsonl"),
    cargoStderr: path.join(output, "candidate.cargo.stderr"),
    producer,
    driverSha256: binary.sha256,
  };
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
