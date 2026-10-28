import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { restore, snapshot } from "./report-ordering-reference.mjs";

const [driverArg, cliArg, manifestArg, sourceArg, reportArg, selectedArg] =
  process.argv.slice(2);
assert.ok(driverArg && cliArg && manifestArg && sourceArg && reportArg);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
assert.equal(process.versions.icu, "77.1");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const driver = fs.realpathSync(driverArg);
const cli = fs.realpathSync(cliArg);
const reportFile = path.resolve(reportArg);
const saved = path.join(
  path.dirname(reportFile),
  `${path.basename(reportFile)}-processes`,
);
const source = JSON.parse(fs.readFileSync(sourceArg));
assert.equal(source.complete, true);
assert.equal(source.NativeProjectionStarted, false);
assert.equal(source.rows.length, 23);
const selected = selectedArg?.split(",");
if (selected)
  assert.ok(selected.every((id) => source.rows.some((row) => row.id === id)));
fs.mkdirSync(saved, { recursive: true });
const beforeBinary = {
  driver: hash(fs.readFileSync(driver)),
  cli: hash(fs.readFileSync(cli)),
};
const report = {
  reference: {
    sourceFile: path.resolve(sourceArg),
    sourceSha256: hash(fs.readFileSync(sourceArg)),
    Source: source.SourceGit,
    sourceTree: source.sourceTree,
    sourceHashes: source.sourceHashes,
    node: process.version,
    v8: process.versions.v8,
    icu: process.versions.icu,
  },
  rustBinary: driver,
  rustBinarySha256: beforeBinary.driver,
  cliBinary: cli,
  cliBinarySha256: beforeBinary.cli,
  attempted: 0,
  passed: 0,
  unqualifiedPairs: 0,
  qualifiedPairs: 0,
  cases: [],
  failures: [],
  scope:
    "Five report-ordering sites. Existing usize/String authored profiles only; malformed/nonfinite/raw model strings and preexisting PlanRow smell-array alias differences remain open. Matrices/workflow actions are wholeviews, not extra cases. No CLI capability closure.",
};
function save() {
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
}
function run(binary, argv, cwd, input, directory, env = process.env) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "request.json"), input);
  const child = spawnSync(binary, argv, {
    cwd,
    env: { ...env, TMPDIR: "/private/tmp" },
    input,
    maxBuffer: 64 << 20,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  fs.writeFileSync(path.join(directory, "stdout"), child.stdout);
  fs.writeFileSync(path.join(directory, "stderr"), child.stderr);
  const record = {
    command: [binary, ...argv],
    cwd,
    status: child.status,
    signal: child.signal,
    requestSha256: hash(input),
    stdoutSha256: hash(child.stdout),
    stderrSha256: hash(child.stderr),
    requestFile: path.join(directory, "request.json"),
    stdoutFile: path.join(directory, "stdout"),
    stderrFile: path.join(directory, "stderr"),
    requestBase64: Buffer.from(input).toString("base64"),
    stdoutBase64: child.stdout.toString("base64"),
    stderrBase64: child.stderr.toString("base64"),
  };
  fs.writeFileSync(
    path.join(directory, "process.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return {
    record,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}
try {
  for (const row of source.rows.filter(
    (row) => !selected || selected.includes(row.id),
  )) {
    const directory = path.join(saved, row.id);
    fs.mkdirSync(directory, { recursive: true });
    restore(row.directory, row.before);
    report.attempted++;
    const result = {
      id: row.id,
      input: row.input,
      before: snapshot(row.directory),
      expected: row.expected.output,
      sourceProcess: row.process,
      passed: false,
      qualifications: [],
    };
    try {
      if (row.input.mode === "cli") {
        result.actual = [];
        result.nativeTrace = { observedCalls: [], actions: [] };
        for (const action of row.input.actions) {
          const actionDir = path.join(directory, action.id);
          fs.mkdirSync(actionDir, { recursive: true });
          const trace = path.join(actionDir, "trace.json");
          const before = snapshot(row.directory);
          const request = JSON.stringify({
            id: action.id,
            trace,
            argv: [row.directory, ...action.flags],
            compiler: "/nonexistent/explicit-no-go",
            plain: true,
            lateReports: true,
            ...(action.initial === undefined
              ? {}
              : { initial: action.initial }),
          });
          const child = run(cli, [], row.directory, request, actionDir, {
            ...process.env,
            PATH: "/nonexistent",
          });
          const frame = JSON.parse(fs.readFileSync(trace));
          assert.equal(frame.id, action.id);
          assert.equal(frame.exitCode, child.record.status);
          assert.ok(frame.observedCalls.length > 0);
          result.nativeTrace.observedCalls.push(...frame.observedCalls);
          result.nativeTrace.actions.push({
            id: action.id,
            process: child.record,
            trace: frame,
          });
          result.actual.push({
            id: action.id,
            process: {
              status: child.record.status,
              signal: child.record.signal,
              stdout: child.stdout,
              stderr: child.stderr,
            },
            before,
            after: snapshot(row.directory),
          });
        }
      } else {
        const request = `${JSON.stringify({ input: row.input, root: row.directory })}\n`;
        const child = run(
          driver,
          [path.resolve(manifestArg)],
          source.cwd,
          request,
          directory,
        );
        result.nativeProcess = child.record;
        assert.equal(child.record.status, 0);
        const lines = child.stdout.trim().split("\n");
        assert.equal(lines.length, 1);
        const frame = JSON.parse(lines[0]);
        assert.equal(frame.ok, true, frame.error);
        assert.ok(frame.observedCalls.length > 0);
        assert.deepEqual(Object.keys(frame).sort(), [
          "observedCalls",
          "ok",
          "output",
        ]);
        result.actual = frame.output;
        result.nativeTrace = frame;
        assert.equal(
          child.stderr,
          fs.readFileSync(
            path.join(
              path.dirname(sourceArg),
              "source-processes",
              row.id,
              "stderr",
            ),
            "utf8",
          ),
        );
      }
      result.after = snapshot(row.directory);
      assert.deepEqual(result.before, row.before);
      assert.deepEqual(result.after, row.after);
      assert.deepEqual(result.actual, result.expected);
      result.passed = true;
      report.passed++;
      report.unqualifiedPairs++;
    } catch (error) {
      result.error = String(error?.stack ?? error);
      report.failures.push({ id: row.id, error: result.error });
    }
    report.cases.push(result);
    save();
    console.log(`${row.id}: ${result.passed ? "pass" : "FAIL"}`);
  }
} finally {
  assert.equal(
    hash(fs.readFileSync(driver)),
    beforeBinary.driver,
    "driver bytes changed",
  );
  assert.equal(
    hash(fs.readFileSync(cli)),
    beforeBinary.cli,
    "CLI bytes changed",
  );
  report.binaryHashesUnchanged = true;
  save();
}
assert.equal(
  report.failures.length,
  0,
  report.failures.map((r) => r.id).join(","),
);
