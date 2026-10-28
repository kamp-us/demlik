import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentEventsParity,
  compareAgentEvents,
  compareAgentEventsProfile,
} from "./agent-events-run.mjs";
import { assertCheckPath } from "./check-worktree.mjs";
import { buildTeaExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const node = process.execPath;
const scope = JSON.parse(
  fs.readFileSync(new URL("./scope.json", import.meta.url)),
);
const expected = JSON.parse(
  fs.readFileSync(new URL("./agent-events-admission.json", import.meta.url)),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (file) => hash(fs.readFileSync(file));
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const record = (file) => ({ path: path.resolve(file), sha256: hashFile(file) });
const ordered = (value) =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === "object"
      ? Object.keys(value)
          .sort()
          .map((key) => [key, ordered(value[key])])
      : value;
const digest = (value) => hash(JSON.stringify(ordered(value)));
const qualifiedIds = [
  "promise-listener",
  "promise-save",
  "effect-listener",
  "effect-save",
];
function guards() {
  assert.deepEqual(
    { node: process.version, v8: process.versions.v8 },
    scope.referenceEngine,
  );
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, `${key} must be unset`);
}
function read(entry) {
  assert.ok(path.isAbsolute(entry.path));
  assert.equal(hashFile(entry.path), entry.sha256, entry.path);
  return json(entry.path);
}
function stream(file, sha) {
  const bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), sha, file);
  return bytes.toString("utf8");
}
export function normalizeAgentEventsReport(envelope, producer = null) {
  guards();
  assert.equal(envelope.version, 1);
  for (const [file, sha] of Object.entries({
    ...expected.sourcePins,
    ...expected.fixturePins,
  }))
    assert.equal(hashFile(path.join(root, file)), sha, file);
  const raw = read(envelope.worker),
    source = read(envelope.source),
    usage = read(envelope.usage),
    binaryCheck = read(envelope.binaryCheck);
  assert.equal(source.validRows, 14);
  assert.equal(source.logicalInputs, 14);
  assert.equal(source.rows.length, 14);
  assert.equal(source.processes.length, 14);
  assert.equal(source.engine.node, scope.referenceEngine.node.slice(1));
  assert.equal(source.engine.v8, scope.referenceEngine.v8);
  assert.equal(source.engine.icu, "77.1");
  assert.equal(raw.cases, 15);
  assert.equal(raw.wholeViewMatches, 11);
  assert.deepEqual(
    raw.failures,
    qualifiedIds,
    "raw mismatches remain preserved, not relabeled",
  );
  assert.equal(raw.rows.length, 15);
  assert.match(raw.binary.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(binaryCheck, {
    before: raw.binary.sha256,
    after: raw.binary.sha256,
    unchanged: true,
  });
  assert.deepEqual(raw.sourceInputs, [envelope.source, envelope.usage]);
  const sourceRows = [...source.rows, usage];
  const ids = expected.rows.map((row) => row.id);
  assert.equal(new Set(ids).size, 15);
  assert.deepEqual(
    raw.rows.map((row) => row.id),
    ids,
  );
  const nativeEvidence = {},
    qualifiedNativeEvidence = {},
    qualifications = {},
    observations = [];
  for (let index = 0; index < ids.length; index++) {
    const row = raw.rows[index],
      pin = expected.rows[index],
      reference = sourceRows[index];
    assert.deepEqual(row.input, pin.input);
    assert.deepEqual(reference.input, pin.input);
    assert.deepEqual(row.expected, reference.output);
    const sourceView = structuredClone(reference.output);
    if (["promise-listener", "effect-listener"].includes(row.id))
      delete sourceView.reports[0].error.stack;
    assert.equal(
      digest(sourceView),
      pin.viewSha256,
      `${row.id}: frozen whole Source view`,
    );
    if (index < 14) {
      const process = source.processes[index];
      assert.equal(process.id, row.id);
      assert.equal(process.status, 0);
      assert.equal(process.signal, null);
      assert.equal(process.error, null);
      const folder = path.join(
        path.dirname(envelope.source.path),
        "processes",
        row.id,
      );
      assert.deepEqual(json(path.join(folder, "process.json")), process);
      const request = json(path.join(folder, "request.json"));
      assert.deepEqual(request.input, pin.input);
      assert.equal(request.executable, node);
      assert.equal(request.args.length, 5);
      assert.equal(request.args[0], "--import");
      assert.ok(request.args[1].endsWith("/tsx/dist/loader.mjs"));
      assert.ok(
        request.args[2].endsWith(
          "/verification/parity/agent-events-reference.mts",
        ),
      );
      assert.equal(request.args[3], JSON.stringify(pin.input));
      assert.equal(request.args[4], path.join(folder, "invoice"));
      const stdout = stream(path.join(folder, "stdout"), process.stdoutSha256);
      assert.equal(
        stream(path.join(folder, "stderr"), process.stderrSha256),
        "",
      );
      assert.deepEqual(JSON.parse(stdout), reference);
    } else {
      const folder = path.dirname(envelope.usage.path),
        process = json(path.join(folder, "source.process.json"));
      assert.equal(process.exit, 0);
      assert.equal(process.command.length, 4);
      assert.equal(process.command[0], node);
      assert.equal(process.command[1], "--import");
      assert.ok(process.command[2].endsWith("/tsx/dist/loader.mjs"));
      assert.ok(
        process.command[3].endsWith(
          "/verification/parity/agent-events-usage-reference.mts",
        ),
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(folder, "source.stdout"), "utf8")),
        reference,
      );
      assert.equal(
        fs.readFileSync(path.join(folder, "source.stderr"), "utf8"),
        "",
      );
    }
    assert.equal(row.protocolError, null);
    assert.equal(row.process.status, 0);
    assert.equal(row.process.signal, null);
    assert.equal(row.process.error, null);
    const folder = path.join(
      path.dirname(envelope.worker.path),
      "processes",
      row.id,
    );
    assert.deepEqual(json(path.join(folder, "process.json")), row.process);
    const request = json(path.join(folder, "request.json"));
    assert.deepEqual(request.input, pin.input);
    assert.equal(request.binary, raw.binary.path);
    assert.deepEqual(request.args, [
      JSON.stringify(pin.input),
      path.join(folder, "invoice"),
    ]);
    const frame = JSON.parse(
      stream(path.join(folder, "stdout"), row.process.stdoutSha256),
    );
    assert.equal(
      stream(path.join(folder, "stderr"), row.process.stderrSha256),
      "",
    );
    assert.deepEqual(frame, {
      input: pin.input,
      output: row.actual,
      nativeTrace: row.nativeTrace,
      nativeOnly: row.nativeOnly,
    });
    assert.deepEqual(
      row.nativeTrace,
      pin.calls,
      `${row.id}: full actual call order/multiplicity`,
    );
    assert.ok(
      row.nativeTrace.length &&
        row.nativeTrace.every(
          (call) => typeof call === "string" && call.startsWith("demlik_tea::"),
        ),
    );
    assert.equal(row.matches, compareAgentEvents(row.expected, row.actual));
    const comparison = compareAgentEventsProfile(row);
    assert.equal(comparison.qualified, qualifiedIds.includes(row.id));
    assert.equal(comparison.strict, !qualifiedIds.includes(row.id));
    assert.ok(comparison.strict || comparison.qualified);
    (comparison.qualified ? qualifiedNativeEvidence : nativeEvidence)[
      `agent-events.${row.id}`
    ] = row.nativeTrace;
    if (comparison.qualified)
      qualifications[row.id] = comparison.qualifications;
    observations.push({
      id: row.id,
      input: row.input,
      ...comparison,
      nativeTrace: row.nativeTrace,
    });
  }
  assert.equal(Object.keys(nativeEvidence).length, 11);
  assert.deepEqual(Object.keys(qualifications), qualifiedIds);
  if (producer) {
    assert.equal(producer.binary, raw.binary.path);
    assert.equal(producer.binarySha256, raw.binary.sha256);
    assert.equal(hashFile(producer.binary), raw.binary.sha256);
    if (producer.mode !== "external-binary") {
      assert.equal(producer.driver.target.name, "agent_events_driver");
      assert.ok(producer.driver.target.kind.includes("example"));
      assertCheckPath(producer.actualArtifact, path.join(root, "target"));
      assertCheckPath(
        producer.libraries.demlik_tea.path,
        path.join(root, "target"),
      );
      assert.equal(hashFile(producer.actualArtifact), raw.binary.sha256);
      assert.equal(
        hashFile(producer.libraries.demlik_tea.path),
        producer.libraries.demlik_tea.sha256,
      );
      assert.equal(hashFile(producer.cargoJson), producer.cargoJsonSha256);
      assert.equal(
        producer.source.sha256,
        expected.fixturePins["crates/tea/examples/agent_events_driver.rs"],
      );
    }
  }
  return {
    cases: 15,
    observations: 15,
    passed: 11,
    qualifiedPassed: 4,
    qualifiedEvidenceCases: 4,
    failures: [],
    nativeEvidence,
    qualifiedNativeEvidence,
    qualifications,
    actualRows: observations,
    binarySha256: raw.binary.sha256,
    producer,
    oracleLineage: expected.lineage,
    processes: {
      Source14: source.processes,
      SourceUsage: json(
        path.join(path.dirname(envelope.usage.path), "source.process.json"),
      ),
      native: raw.rows.map((row) => row.process),
    },
    raw: { envelope, worker: raw, source, usage },
    limits: [
      "11 strict whole views and four exact HOST-ENVELOPE profiles only; no generic panic/Error/stack equality.",
      "Native-only checked failures, Weak/drop/reentry guards and type refusals add zero Source cases.",
      "NativeCalls/bare tools and Rc payloads; other payload/representation/routed/grid/SDK/provider/child profiles remain open.",
    ],
  };
}

export function agentEventsCheckpointParity(cargo, options = {}) {
  guards();
  const reportFile = path.resolve(
    options.reportFile ?? path.join(root, "target/parity/agent-events.json"),
  );
  const relative = path.relative(path.join(root, "target"), reportFile);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "report must belong to the worktree default target",
  );
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const proof = `${reportFile}.proof`;
  assert.ok(!fs.existsSync(proof));
  fs.mkdirSync(proof);
  assertCheckPath(proof, path.join(root, "target"));
  function launch(name, args) {
    const run = spawnSync(node, args, {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH}`,
      },
      encoding: "utf8",
      timeout: 240000,
      maxBuffer: 4 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(proof, `${name}.stdout`), run.stdout ?? "");
    fs.writeFileSync(path.join(proof, `${name}.stderr`), run.stderr ?? "");
    fs.writeFileSync(
      path.join(proof, `${name}.process.json`),
      `${JSON.stringify({ command: [node, ...args], exit: run.status, signal: run.signal, error: run.error ? String(run.error) : null }, null, 2)}\n`,
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.ifError(run.error);
    return run.stdout;
  }
  const sourceDirectory = path.join(proof, "source14");
  launch("source14", [
    path.join(root, "verification/parity/agent-events-source-run.mjs"),
    sourceDirectory,
  ]);
  const usageDirectory = path.join(proof, "usage");
  fs.mkdirSync(usageDirectory);
  const usageCommand = [
    "--import",
    path.join(root, "verification/parity/node_modules/tsx/dist/loader.mjs"),
    path.join(root, "verification/parity/agent-events-usage-reference.mts"),
  ];
  const usageStdout = launch("usage", usageCommand);
  fs.writeFileSync(path.join(usageDirectory, "source.stdout"), usageStdout);
  fs.copyFileSync(
    path.join(proof, "usage.stderr"),
    path.join(usageDirectory, "source.stderr"),
  );
  fs.copyFileSync(
    path.join(proof, "usage.process.json"),
    path.join(usageDirectory, "source.process.json"),
  );
  const usageFile = path.join(usageDirectory, "source-one.json");
  fs.writeFileSync(
    usageFile,
    `${JSON.stringify(JSON.parse(usageStdout), null, 2)}\n`,
  );
  const producer = options.binary
    ? {
        mode: "external-binary",
        binary: path.resolve(options.binary),
        binarySha256: hashFile(path.resolve(options.binary)),
      }
    : buildTeaExample(cargo, "agent_events_driver", reportFile);
  const before = hashFile(producer.binary),
    workerFile = path.join(proof, "native", "raw.json");
  let workerError, hashError;
  try {
    agentEventsParity({
      binary: producer.binary,
      sourceReport: path.join(sourceDirectory, "source-first.json"),
      usageReport: usageFile,
      output: workerFile,
    });
  } catch (error) {
    workerError = error;
  }
  try {
    assert.equal(hashFile(producer.binary), before, "executed binary changed");
  } catch (error) {
    hashError = error;
  }
  if (workerError && hashError)
    throw new AggregateError(
      [workerError, hashError],
      "AgentEvents worker and binary identity failed",
    );
  if (workerError || hashError) throw workerError ?? hashError;
  const envelope = {
    version: 1,
    worker: record(workerFile),
    source: record(path.join(sourceDirectory, "source-first.json")),
    usage: record(usageFile),
    binaryCheck: record(`${workerFile}.binary-check.json`),
  };
  fs.writeFileSync(
    `${reportFile}.envelope.json`,
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
  const report = normalizeAgentEventsReport(envelope, producer);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
