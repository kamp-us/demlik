import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  hash,
  restore,
  snapshot,
  sourcePins,
} from "./icu77-env-keys-reference.mjs";

const [fixture, cli, frozenFile, reportFile] = process.argv.slice(2);
assert(fixture && cli && frozenFile && reportFile && process.argv.length === 6);
const frozen = JSON.parse(fs.readFileSync(frozenFile, "utf8"));
assert(frozen.complete && !frozen.NativeProjectionStarted);
assert.deepEqual(frozen.sourceHashes, sourcePins());
const initialHashes = {
  fixture: hash(fs.readFileSync(fixture)),
  cli: hash(fs.readFileSync(cli)),
};
const directory = `${reportFile}.processes`;
fs.mkdirSync(directory, { recursive: true });
const report = {
  attempted: 18,
  passed: 0,
  failures: [],
  cases: [],
  sourceHashes: frozen.sourceHashes,
  sourceReportSha256: hash(fs.readFileSync(frozenFile)),
  binaryHashes: initialHashes,
  SourceOnly: frozen.SourceOnly,
  newCaseCredit: 0,
};
const save = () =>
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
function recordProcess(prefix, child, command, input) {
  assert.ifError(child.error);
  const out = `${prefix}.stdout`,
    err = `${prefix}.stderr`;
  fs.writeFileSync(out, child.stdout ?? "");
  fs.writeFileSync(err, child.stderr ?? "");
  return {
    command,
    status: child.status,
    signal: child.signal,
    stdout: out,
    stdoutSha256: hash(fs.readFileSync(out)),
    stderr: err,
    stderrSha256: hash(fs.readFileSync(err)),
    ...(input
      ? {
          input: `${prefix}.request.json`,
          inputSha256: hash(fs.readFileSync(`${prefix}.request.json`)),
        }
      : {}),
  };
}
try {
  for (const row of frozen.observations) {
    const { input } = row,
      calls = [],
      processes = [];
    let actual;
    try {
      if (input.mode === "cli") {
        actual = { ok: true, output: [] };
        let state = row.before;
        for (const action of input.actions) {
          restore(row.directory, state);
          const before = snapshot(row.directory);
          const prefix = path.join(directory, `${row.id}.${action.id}`),
            trace = `${prefix}.trace.json`;
          const request = {
            id: `${row.id}.${action.id}`,
            trace,
            argv: [row.directory, "--env-keys", ...action.flags],
            compiler: path.join(row.directory, "no-compiler"),
            ...(action.initial === undefined
              ? {}
              : { initial: action.initial }),
          };
          const text = JSON.stringify(request);
          fs.writeFileSync(`${prefix}.request.json`, text);
          const child = spawnSync(cli, [], {
            input: text,
            cwd: row.directory,
            encoding: "utf8",
            env: {
              ...process.env,
              TMPDIR: "/private/tmp",
              PATH: "/nonexistent",
            },
            maxBuffer: 16 << 20,
          });
          processes.push(recordProcess(prefix, child, [cli], true));
          assert.equal(child.signal, null);
          const frame = JSON.parse(fs.readFileSync(trace, "utf8"));
          assert.equal(frame.id, request.id);
          assert(frame.observedCalls.length > 0);
          calls.push(...frame.observedCalls);
          assert.equal(frame.exitCode, child.status);
          const after = snapshot(row.directory);
          actual.output.push({
            id: action.id,
            process: {
              status: child.status,
              signal: child.signal,
              stdout: child.stdout,
              stderr: child.stderr,
            },
            before,
            after,
          });
          state = after;
        }
      } else {
        restore(row.directory, row.before);
        const prefix = path.join(directory, row.id),
          response = `${prefix}.response.json`;
        const request = {
          id: row.id,
          mode: input.mode,
          directory: row.directory,
          units: input.units,
          candidates: input.candidates,
        };
        fs.writeFileSync(`${prefix}.request.json`, JSON.stringify(request));
        const args = [
          "--exact",
          "env_keys::query::icu77_probe::paired",
          "--include-ignored",
          "--nocapture",
          "--test-threads=1",
        ];
        const child = spawnSync(fixture, args, {
          cwd: row.directory,
          encoding: "utf8",
          maxBuffer: 16 << 20,
          env: {
            ...process.env,
            TMPDIR: "/private/tmp",
            DEMLIK_ENV_KEYS_REQUEST: `${prefix}.request.json`,
            DEMLIK_ENV_KEYS_RESPONSE: response,
          },
        });
        processes.push(recordProcess(prefix, child, [fixture, ...args], true));
        assert.equal(child.signal, null);
        assert.equal(child.status, 0, child.stderr || child.stdout);
        const frame = JSON.parse(fs.readFileSync(response, "utf8"));
        assert.equal(frame.id, row.id);
        assert.deepEqual(
          Object.keys(frame).sort(),
          (frame.ok
            ? ["id", "ok", "output", "observedCalls"]
            : ["id", "ok", "error", "observedCalls"]
          ).sort(),
        );
        assert(
          Array.isArray(frame.observedCalls) && frame.observedCalls.length > 0,
        );
        calls.push(...frame.observedCalls);
        actual = frame.ok
          ? { ok: true, output: frame.output }
          : { ok: false, error: frame.error };
        assert.deepEqual(
          snapshot(row.directory),
          row.before,
          "pure scan/query/load changed files",
        );
      }
      assert.deepEqual(actual, row.expected);
      report.passed++;
      report.cases.push({
        id: row.id,
        input,
        passed: true,
        expected: row.expected,
        actual,
        observedCalls: calls,
        processes,
      });
    } catch (error) {
      const failure = {
        id: row.id,
        name: error.name,
        message: error.message,
        expected: row.expected,
        actual,
        observedCalls: calls,
        processes,
      };
      report.failures.push(failure);
      report.cases.push({ ...failure, passed: false });
    }
    save();
  }
} finally {
  const finalHashes = {
    fixture: hash(fs.readFileSync(fixture)),
    cli: hash(fs.readFileSync(cli)),
  };
  report.finalBinaryHashes = finalHashes;
  save();
  assert.deepEqual(finalHashes, initialHashes);
}
console.log(
  JSON.stringify({
    attempted: report.attempted,
    passed: report.passed,
    failures: report.failures.map((f) => f.id),
  }),
);
if (report.failures.length) process.exitCode = 1;
