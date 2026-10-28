import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hash,
  processEnvironment,
  receiptView,
  snapshot,
} from "./hotspots-fixtures.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
export function hotspotsParity(
  binary,
  proof,
  output,
  { supplement = false } = {},
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  binary = path.resolve(binary);
  const binarySHA = hash(fs.readFileSync(binary));
  const frozen = path.join(
    proof,
    supplement ? "source-supplement2.json" : "source-first/source-first.json",
  );
  const expectedSHA = supplement
    ? "4ea31bf8a22283ff27588628bd9b67e522d8e3ffc5f55090c47f6bde6be403c6"
    : "7ecc56ba559999ffdae8bd5263904245589db49edc33d55ae894164b6eed9f5d";
  assert.equal(hash(fs.readFileSync(frozen)), expectedSHA);
  const source = JSON.parse(fs.readFileSync(frozen, "utf8"));
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(proof, "source-first/fixture-setup.json"),
      "utf8",
    ),
  );
  const directory = path.dirname(output);
  fs.mkdirSync(directory, { recursive: true });
  const rows = [],
    processes = [],
    failures = [];
  for (const row of source.rows) {
    const prefix = output + "." + row.id + ".native",
      receipt = prefix + ".git.jsonl",
      captures = prefix + ".captures";
    fs.mkdirSync(captures, { recursive: true });
    const env = processEnvironment(fixture, row.input, receipt, "native");
    const input = JSON.stringify(row.input) + "\n";
    const before = snapshot(fixture.repo);
    const result = spawnSync(binary, [captures], {
      cwd: root,
      env,
      input,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const stdout = result.stdout ?? "",
      stderr = result.stderr ?? "";
    fs.writeFileSync(prefix + ".stdin", input);
    fs.writeFileSync(prefix + ".stdout", stdout);
    fs.writeFileSync(prefix + ".stderr", stderr);
    const process = {
      id: row.id,
      command: binary,
      args: [captures],
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdin: prefix + ".stdin",
      stdinSHA: hash(Buffer.from(input)),
      stdout: prefix + ".stdout",
      stdoutSHA: hash(Buffer.from(stdout)),
      stderr: prefix + ".stderr",
      stderrSHA: hash(Buffer.from(stderr)),
      binarySHA,
    };
    processes.push(process);
    const errors = [];
    const nativeCaptureFacts = [];
    let frame = null,
      git = null,
      protocolValid = false;
    try {
      assert.equal(result.status, 0, stderr);
      assert.equal(result.signal, null);
      assert.equal(result.error, undefined);
      frame = JSON.parse(stdout);
      assert.deepEqual(Object.keys(frame).sort(), [
        "id",
        "nativeOnlyFailures",
        "nativeTrace",
        "ok",
        "output",
      ]);
      assert.equal(frame.id, row.id);
      assert.equal(frame.ok, true);
      assert.ok(frame.nativeTrace.length > 0);
      assert.ok(
        frame.nativeTrace.every((call) =>
          call.startsWith("demlik_code_graph::hotspots::"),
        ),
      );
      git = receiptView(receipt);
      protocolValid = true;
    } catch (error) {
      errors.push({
        kind: "protocol-or-process",
        message: error.message,
        stack: error.stack,
      });
    }
    if (protocolValid) {
      for (const [field, actual, expected] of [
        ["output", frame.output, row.frame.output],
        ["Git argument/cwd order", git.attempts, row.gitAttempts],
        ["repository bytes/modes", snapshot(fixture.repo), before],
        [
          "stderr bytes",
          Buffer.from(stderr).toString("hex"),
          row.sourceStderrHex ??
            fs.readFileSync(row.process.stderr).toString("hex"),
        ],
      ]) {
        try {
          assert.deepEqual(actual, expected, `${row.id}: ${field}`);
        } catch (error) {
          errors.push({
            kind: "semantic",
            field,
            message: error.message,
            stack: error.stack,
          });
        }
      }
      for (const failure of frame.nativeOnlyFailures) {
        const data = failure.data;
        for (const stream of ["stdout", "stderr"])
          if (data[stream]) {
            nativeCaptureFacts.push({
              stage: failure.stage,
              stream,
              path: data[stream],
              sha256: hash(fs.readFileSync(data[stream])),
              bytes: fs.statSync(data[stream]).size,
            });
            assert.equal(
              fs.statSync(data[stream]).size,
              data[stream + "Bytes"],
            );
          }
      }
    }
    rows.push({
      id: row.id,
      input: row.input,
      source: row.frame,
      native: frame,
      git: git?.attempts ?? null,
      protocolValid,
      equal: errors.length === 0,
      errors,
      process,
      rawControlledGit: git,
      nativeCaptureFacts,
    });
    if (errors.length) failures.push({ id: row.id, errors });
    fs.writeFileSync(
      prefix + ".process.json",
      JSON.stringify({ ...process, git }, null, 2) + "\n",
    );
    fs.writeFileSync(
      output,
      JSON.stringify(
        {
          cases: rows.length,
          passed: rows.filter((r) => r.equal).length,
          failures,
          rows,
          processes,
          complete: false,
        },
        null,
        2,
      ) + "\n",
    );
  }
  assert.equal(hash(fs.readFileSync(binary)), binarySHA);
  const report = {
    cases: source.rows.length,
    passed: rows.filter((r) => r.equal).length,
    failures,
    rows,
    processes,
    binary: { path: binary, sha256: binarySHA },
    sourceReport: { path: frozen, sha256: expectedSHA },
    SourcePackageEdits: 0,
    DateOwnerCredit: 0,
    CLICredit: 0,
    supplement,
    extraSharedCredit: supplement ? 0 : null,
    complete: true,
    limits: [
      "Typed native failure data is separate from Source null.",
      "Raw host PID/write-error profiles are not universal process equivalence.",
    ],
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  return report;
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const [binary, proof, output, ...flags] = process.argv.slice(2);
  assert.ok(binary && proof && output);
  assert.ok(
    flags.length === 0 ||
      JSON.stringify(flags) === JSON.stringify(["--supplement"]),
  );
  const report = hotspotsParity(binary, proof, output, {
    supplement: flags[0] === "--supplement",
  });
  console.log(
    JSON.stringify({
      cases: report.cases,
      passed: report.passed,
      failures: report.failures.length,
      supplement: report.supplement,
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
