import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  assertCheckPath,
  cargoCheckEnvironment,
  compiledCheckLibrary,
  createCheckWorktree,
} from "./check-worktree.mjs";
import { cliUnreachableFaults } from "./cli-unreachable-faults.mjs";
import { collapseRenderCliFaults } from "./collapse-render-cli-faults.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(import.meta.url);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const faults = [
  ...cliUnreachableFaults,
  ...collapseRenderCliFaults.filter((f) => f.kind === "cli"),
];
assert.equal(faults.length, 15);
const run = (file, args, cwd, env) => {
  const r = spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  return {
    command: [file, ...args],
    cwd,
    exit: r.status,
    signal: r.signal,
    error: r.error?.message,
    stdout: r.stdout,
    stderr: r.stderr,
  };
};
function logicalBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .reduce(
      (n, e) =>
        n +
        (e.isDirectory()
          ? logicalBytes(path.join(dir, e.name))
          : e.isFile()
            ? fs.statSync(path.join(dir, e.name)).size
            : 0),
      0,
    );
}
export function cliUnreachableMutations({
  cliBinary,
  cliReport,
  renderBinary,
  renderReport,
  oldCliReport,
  evidence,
}) {
  fs.mkdirSync(evidence, { recursive: true });
  const cli = JSON.parse(fs.readFileSync(cliReport, "utf8")),
    render = JSON.parse(fs.readFileSync(renderReport, "utf8")),
    old = JSON.parse(fs.readFileSync(oldCliReport, "utf8"));
  assert.deepEqual(cli.failures, []);
  assert.deepEqual(render.failures, []);
  assert.deepEqual(old.failures, []);
  assert.equal(render.passed, 10);
  assert.equal(old.passed, 49);
  const baselines = {
    cli: { path: cliBinary, sha256: hash(fs.readFileSync(cliBinary)) },
    render: { path: renderBinary, sha256: hash(fs.readFileSync(renderBinary)) },
  };
  assert.equal(cli.driverSha256, baselines.cli.sha256);
  assert.equal(old.driverSha256, baselines.cli.sha256);
  assert.equal(render.binary.sha256, baselines.render.sha256);
  const owners = [...new Set(faults.map((f) => f.file))];
  const originals = Object.fromEntries(
    owners.map((f) => [f, fs.readFileSync(path.join(root, f), "utf8")]),
  );
  for (const f of faults) {
    let s = originals[f.file];
    for (const [a, b] of f.edits) {
      assert.equal(s.split(a).length, 2, f.name);
      s = s.replace(a, b);
    }
  }
  const env = cargoCheckEnvironment({
    CARGO_NET_OFFLINE: "true",
    CARGO_BUILD_JOBS: "1",
    CARGO_INCREMENTAL: "0",
    CARGO_PROFILE_DEV_DEBUG: "0",
    CARGO_PROFILE_TEST_DEBUG: "0",
  });
  const report = {
    planned: 15,
    newPlanned: 8,
    affectedOldPlanned: 7,
    controls: [],
    cargoSelections: 0,
    baselines,
    complete: false,
    semanticPairs: 0,
    resourceSamples: [],
  };
  const output = path.join(evidence, "controls.json");
  const save = () =>
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  const t = performance.now();
  let check, operationError, cleanupError;
  try {
    check = createCheckWorktree(root, "cli-unreachable-controls", evidence);
    fs.mkdirSync(path.join(check.target, "parity"), { recursive: true });
    for (const d of [
      "node_modules",
      "packages/code-graph/node_modules",
      "packages/tea/node_modules",
      "verification/parity/node_modules",
    ]) {
      const from = path.join(root, d),
        to = path.join(check.root, d);
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.symlinkSync(fs.realpathSync(from), to);
      }
    }
    for (const f of faults) {
      for (const [o, s] of Object.entries(originals))
        fs.writeFileSync(path.join(check.root, o), s);
      let text = originals[f.file];
      for (const [a, b] of f.edits) text = text.replace(a, b);
      fs.writeFileSync(path.join(check.root, f.file), text);
      const dir = path.join(evidence, f.name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "mutant.rs"), text);
      const example =
        f.kind === "unreachable-render"
          ? "unreachable_driver"
          : "collapse_cli_driver";
      const built = run(
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
        env,
      );
      report.cargoSelections++;
      fs.writeFileSync(path.join(dir, "cargo.jsonl"), built.stdout);
      fs.writeFileSync(path.join(dir, "cargo.stderr"), built.stderr);
      fs.writeFileSync(
        path.join(dir, "build.json"),
        `${JSON.stringify({ ...built, stdout: undefined, stderr: undefined }, null, 2)}\n`,
      );
      save();
      assert.equal(built.error, undefined);
      assert.equal(built.signal, null);
      assert.equal(
        built.exit,
        0,
        `${f.name}: compile failure is zero semantic credit`,
      );
      const events = built.stdout.split("\n").filter(Boolean).map(JSON.parse);
      const library = compiledCheckLibrary(
        events,
        "demlik_code_graph",
        check.root,
        check.target,
      );
      const exes = events.filter(
        (r) =>
          r.reason === "compiler-artifact" &&
          r.target.name === example &&
          r.executable,
      );
      assert.equal(exes.length, 1);
      assert.equal(exes[0].fresh, false);
      assertCheckPath(exes[0].target.src_path, check.root);
      const executable = assertCheckPath(exes[0].executable, check.target);
      const preserve = (file, name) => {
        const data = fs.readFileSync(file),
          blob = path.join(dir, `${name}.gz`);
        fs.writeFileSync(blob, gzipSync(data));
        return {
          actual: file,
          path: blob,
          sha256: hash(data),
          gzipSha256: hash(fs.readFileSync(blob)),
          bytes: data.length,
        };
      };
      const binary = preserve(executable, "executed-driver"),
        lib = preserve(library.path, "actual-library");
      const scriptName =
        f.kind === "unreachable-render"
          ? "graph-unreachable-render.mts"
          : f.kind === "cli"
            ? "graph-cli-plain-collapse.mjs"
            : "graph-cli-unreachable.mjs";
      const script = assertCheckPath(
          path.join(check.root, "verification/parity", scriptName),
          check.root,
        ),
        pairs = path.join(dir, "pairs.json");
      const selection =
        f.kind === "unreachable-render"
          ? { DEMLIK_UNREACHABLE_RENDER_CASES: f.witness }
          : f.kind === "cli"
            ? { DEMLIK_PLAIN_COLLAPSE_CASES: f.witness }
            : { DEMLIK_UNREACHABLE_CLI_CASES: f.witness };
      const comparisonRun = run(
        globalThis.process.execPath,
        ["--import", require.resolve("tsx"), script, executable, pairs],
        check.root,
        { ...env, ...selection },
      );
      fs.writeFileSync(
        path.join(dir, "run.json"),
        `${JSON.stringify(comparisonRun, null, 2)}\n`,
      );
      assert.equal(comparisonRun.error, undefined);
      assert.equal(comparisonRun.signal, null);
      assert.equal(comparisonRun.exit, 1);
      const observed = JSON.parse(fs.readFileSync(pairs, "utf8"));
      const witness = observed.cases.find((r) => r.id === f.witness);
      assert.ok(witness);
      assert.ok(
        observed.failures.some(
          (r) => r.id === f.witness && r.kind === "semantic",
        ),
      );
      assert.equal(witness.passed, false);
      if (f.kind === "unreachable-render") {
        assert.equal(witness.process.status, 0);
        assert.ok(witness.actual);
        assert.equal(observed.binary.sha256, binary.sha256);
      } else {
        assert.ok(witness.native.length > 0 && witness.source.length > 0);
        for (const n of witness.native) {
          assert.equal(n.output.signal, null);
          assert.ok([0, 1, 2, 7].includes(n.output.status));
          assert.ok(n.trace.observedCalls.length > 0);
        }
        assert.equal(observed.driverSha256, binary.sha256);
      }
      report.controls.push({
        id: f.name,
        kind: f.kind,
        owner: f.file,
        witness: f.witness,
        sourceSha256: hash(text),
        compileExit: 0,
        protocolValid: true,
        semanticMismatch: true,
        library: { ...lib, artifact: library.artifact },
        consumer: { ...binary, artifact: exes[0] },
        comparison: pairs,
      });
      report.resourceSamples.push({
        after: f.name,
        logicalTargetBytes: logicalBytes(check.target),
      });
      for (const [o, s] of Object.entries(originals))
        fs.writeFileSync(path.join(check.root, o), s);
      for (const b of Object.values(baselines))
        assert.equal(hash(fs.readFileSync(b.path)), b.sha256);
      save();
    }
    assert.equal(report.cargoSelections, 15);
    assert.equal(report.controls.length, 15);
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
      for (const [o, s] of Object.entries(originals))
        fs.writeFileSync(path.join(check.root, o), s);
      report.checkOwnersRestored = owners.every(
        (o) =>
          fs.readFileSync(path.join(check.root, o), "utf8") === originals[o],
      );
      try {
        check.remove();
      } catch (error) {
        cleanupError = error;
        report.cleanupFailure = { name: error.name, message: error.message };
      }
    }
    report.elapsedMs = performance.now() - t;
    report.worktreeRemoved = !check || !fs.existsSync(check.root);
    report.defaultTargetRemoved = !check || !fs.existsSync(check.target);
    report.originalOwnersUnchanged = owners.every(
      (o) => fs.readFileSync(path.join(root, o), "utf8") === originals[o],
    );
    report.baselinesUnchanged = Object.values(baselines).every(
      (b) => hash(fs.readFileSync(b.path)) === b.sha256,
    );
    report.complete &&=
      !operationError &&
      !cleanupError &&
      report.worktreeRemoved &&
      report.defaultTargetRemoved &&
      report.originalOwnersUnchanged &&
      report.baselinesUnchanged;
    save();
  }
  if (operationError || cleanupError)
    throw new AggregateError(
      [operationError, cleanupError].filter(Boolean),
      `Unreachable CLI controls failed: ${evidence}`,
    );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [
    cliBinary,
    cliReport,
    renderBinary,
    renderReport,
    oldCliReport,
    evidence,
  ] = process.argv.slice(2);
  assert.ok(evidence);
  const r = cliUnreachableMutations({
    cliBinary,
    cliReport,
    renderBinary,
    renderReport,
    oldCliReport,
    evidence: path.resolve(evidence),
  });
  console.log(
    JSON.stringify({
      detected: r.controls.length,
      complete: r.complete,
      removed: r.worktreeRemoved,
    }),
  );
}
