import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkedSpawnSync as spawnSync } from "./check-worktree.mjs";
import { buildExample } from "./tea-example.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { z } = createRequire(import.meta.url)("zod");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const admission = read(
  new URL("./cli-hotspots-window-admission.json", import.meta.url),
);
const definitions = read(
  new URL("./cli-hotspots-window-cases.json", import.meta.url),
);
const cause = z.strictObject({
  kind: z.string(),
  rawCode: z.number().int().nullable(),
  message: z.string(),
});
const frameSchema = z.strictObject({
  id: z.string(),
  exitCode: z.number().int(),
  observedCalls: z.array(z.string()).min(1),
  outcome: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("reports") }),
    z.strictObject({ kind: z.literal("hexagon") }),
    z.strictObject({
      kind: z.literal("reports-load-refused"),
      cause: z.string(),
    }),
    z.strictObject({
      kind: z.literal("reports-hotspots-refused"),
      cause: z.string(),
      stage: z.enum(["real-root", "top", "head", "tracked", "log"]),
    }),
    z.strictObject({
      kind: z.literal("thrown"),
      error: z.strictObject({
        name: z.literal("RangeError"),
        message: z.literal("Invalid time value"),
        details: z.null(),
      }),
    }),
  ]),
  io: z.strictObject({
    stored: z.number().int().nullable(),
    requested: z.number().nullable(),
    normal: z.number().int(),
    pending: z.array(
      z.strictObject({
        stream: z.enum(["stdout", "stderr"]),
        attemptedBytes: z.number().int().nonnegative(),
        suppressedWrites: z.number().int().nonnegative(),
        cause,
      }),
    ),
  }),
  writeObservations: z.array(
    z.strictObject({
      stream: z.enum(["stdout", "stderr"]),
      payload: z.string(),
      fileAtAck: z.array(z.number().int().min(0).max(255)).optional(),
    }),
  ),
});
const rangeProfile =
  "Node uncaught RangeError stack/display versus native typed error envelope; actual raw stderr retained";
const streamProfile =
  "Node pending-stream notification/uncaught display versus CliIo original pending error data; raw streams retained";
export function cliAnchorDigest(value) {
  const canonical = (item) =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, canonical(item[key])]),
          )
        : item;
  return hash(JSON.stringify(canonical(value)));
}

export function assertCliHotspotsEnvironment() {
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, `${key} must be unset`);
}
export function assertCliSourceLaunch(stdout, stderr, source) {
  assert.equal(stderr, "");
  const lines = stdout.trim().split("\n").map(JSON.parse);
  assert.equal(
    lines.length,
    21,
    "20 progress records plus one explicit source summary",
  );
  assert.deepEqual(
    lines.slice(0, 20),
    source.cases.map((row) => ({
      id: row.id,
      steps: row.steps.length,
      statuses: row.steps.map((step) => step.process.status),
    })),
  );
  assert.deepEqual(lines[20], {
    cases: 20,
    steps: 67,
    error: null,
    phase: "source-complete",
  });
}
export function assertCliNativeLaunch(stdout, stderr, raw) {
  assert.equal(stderr, "");
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.deepEqual(
    summary,
    Object.fromEntries(
      [
        "cases",
        "actualNativeProcesses",
        "passed",
        "strict",
        "qualified",
        "failures",
        "failure",
        "cleanup",
      ].map((key) => [key, raw[key]]),
    ),
  );
}
function allowed(caseID, stepID) {
  return admission.qualifications[caseID]?.[stepID] ?? [];
}
export function cliSourceAnchor(caseID, step) {
  const profile = allowed(caseID, step.id);
  const stderrWrites = step.io
    .filter((entry) => entry.op === "stdio-write" && entry.stream === "stderr")
    .map((entry) => entry.payload)
    .join("");
  const process = { ...step.process };
  if (profile.includes(rangeProfile)) {
    const thrown = step.events.filter((entry) => entry.event === "uncaught");
    assert.equal(thrown.length, 1);
    assert.equal(thrown[0].name, "RangeError");
    assert.equal(thrown[0].message, "Invalid time value");
    assert.equal(process.status, 1);
    assert.ok(process.stderr.startsWith(stderrWrites));
    assert.ok(
      process.stderr
        .slice(stderrWrites.length)
        .includes("RangeError: Invalid time value"),
    );
    delete process.stderr;
    delete process.stderrSha256;
    delete process.stderrBytes;
  } else if (profile.includes(streamProfile)) {
    const thrown = step.events.filter((entry) => entry.event === "uncaught");
    assert.equal(thrown.length, 1);
    assert.equal(thrown[0].name, "Error");
    assert.equal(thrown[0].code, "EBADF");
    assert.equal(thrown[0].syscall, "write");
    assert.equal(thrown[0].message, "EBADF: bad file descriptor, write");
    assert.ok(["stdout", "stderr"].includes(thrown[0].stream));
    assert.equal(process.status, 1);
    if (step.id === "pending-stdout") {
      assert.ok(process.stderr.includes("EBADF: bad file descriptor, write"));
      delete process.stderr;
      delete process.stderrSha256;
      delete process.stderrBytes;
    } else {
      assert.equal(step.id, "warning-pending-stderr");
      assert.equal(process.stderr, "");
    }
  }
  const clock = structuredClone(step.clock);
  clock.calls = clock.calls.map(({ stack: _stack, ...entry }) => entry);
  return {
    id: step.id,
    argv: step.argv,
    cwd: step.cwd,
    environment: step.environment,
    process,
    events: step.events,
    io: step.io,
    clock,
    before: step.before,
    after: step.after,
    delta: step.delta,
    ...Object.fromEntries(
      ["observedWindow", "observedRows", "noHistoryCount"]
        .filter((key) => Object.hasOwn(step, key))
        .map((key) => [key, step[key]]),
    ),
  };
}
function assertSourceTransport(step) {
  const request = read(step.requestFile);
  assert.equal(hash(fs.readFileSync(step.requestFile)), step.requestSha256);
  assert.deepEqual(request.input.argv, step.argv);
  assert.equal(request.fixture, step.cwd);
  assert.equal(request.clockMs, step.clock.requestedClockMs);
  for (const [suffix, field] of [
    ["stdout", "stdout"],
    ["stderr", "stderr"],
  ]) {
    const file = step.requestFile.replace(/\.request\.json$/, `.${suffix}`);
    assert.equal(fs.readFileSync(file, "utf8"), step.process[field]);
    assert.equal(hash(fs.readFileSync(file)), step.process[`${field}Sha256`]);
  }
  assert.deepEqual(
    [
      step.clock.node,
      step.clock.versions.v8,
      step.clock.versions.icu,
      step.clock.versions.tz,
    ],
    Object.values(admission.SourceVersion),
  );
  assert.equal(step.process.signal, null);
}
export function sharedCliHotspotsWindow(
  raw,
  source,
  rawFile,
  sourceFile,
  expectedBinarySHA,
) {
  assert.deepEqual(read(rawFile), raw);
  assert.deepEqual(read(sourceFile), source);
  assert.match(expectedBinarySHA, /^[a-f0-9]{64}$/);
  assert.equal(raw.driver.sha256, expectedBinarySHA);
  assert.equal(raw.sourceSha256, hash(fs.readFileSync(sourceFile)));
  assert.equal(source.error, null);
  assert.equal(source.sourceUnchanged, true);
  for (const [name, expected] of Object.entries(admission.sourcePins)) {
    assert.equal(source.sourceBefore[name], expected);
    assert.equal(source.sourceAfter[name], expected);
    assert.equal(hash(fs.readFileSync(path.join(root, name))), expected);
  }
  assert.equal(source.cleanup.root, admission.fixedOwnedFixture);
  assert.equal(raw.cleanup.root, admission.fixedOwnedFixture);
  for (const cleanup of [source.cleanup, raw.cleanup]) {
    if (Object.hasOwn(cleanup, "fixturesRemoved")) {
      assert.equal(cleanup.fixturesRemoved, true);
      assert.equal(cleanup.parentRetainedForWrapper, true);
    } else assert.equal(cleanup.removed, true);
  }
  assert.deepEqual(
    source.cases.map((row) => row.id),
    admission.caseOrder,
  );
  assert.deepEqual(
    raw.rows.map((row) => row.id),
    admission.caseOrder,
  );
  assert.deepEqual(
    [
      raw.cases,
      raw.passed,
      raw.strict,
      raw.qualified,
      raw.actualNativeProcesses,
    ],
    [20, 20, 14, 6, 67],
  );
  assert.equal(raw.failure, null);
  assert.deepEqual(raw.failures, []);
  if (raw.rejectedInvalidInputs !== undefined)
    assert.equal(raw.rejectedInvalidInputs, 0);
  const nativeEvidence = {},
    qualifiedNativeEvidence = {};
  let frames = 0;
  const cases = raw.rows.map((row, index) => {
    const original = source.cases[index],
      definition = definitions.cases[index];
    assert.equal(row.id, definition.id);
    assert.equal(row.equalWithinDeclaredProfile, true);
    if (row.valid !== undefined) assert.equal(row.valid, true);
    if (row.passed !== undefined) assert.equal(row.passed, true);
    if (row.protocol !== undefined) assert.equal(row.protocol, false);
    assert.equal(row.steps.length, definition.steps.length);
    assert.equal(original.steps.length, definition.steps.length);
    const calls = [],
      normalizedFrames = [];
    for (const [position, step] of row.steps.entries()) {
      const expected = original.steps[position],
        input = definition.steps[position];
      assert.equal(step.id, input.id);
      assert.deepEqual(step.source, expected);
      assertSourceTransport(expected);
      assert.equal(
        cliAnchorDigest(cliSourceAnchor(row.id, expected)),
        admission.sourceDigests[row.id][position],
      );
      const qualifications = allowed(row.id, step.id);
      assert.deepEqual(step.qualifications, qualifications);
      assert.equal(step.equalWithinDeclaredProfile, true);
      assert.deepEqual(step.errors, []);
      const process = step.native.process;
      assert.equal(process.binarySha256, expectedBinarySHA);
      assert.equal(process.signal, null);
      assert.equal(process.cwd, expected.cwd);
      assert.deepEqual(process.command, [raw.driver.actualPath]);
      assert.equal(hash(fs.readFileSync(process.stdin)), process.stdinSha256);
      assert.deepEqual(read(process.stdin), step.request);
      assert.deepEqual(step.request.argv, expected.argv);
      assert.equal(step.request.clockMs, expected.clock.requestedClockMs);
      assert.deepEqual(
        step.request.initial ?? null,
        read(expected.requestFile).input.initial ?? null,
      );
      assert.equal(step.request.compiler, "/nonexistent/explicit-tsgo");
      assert.equal(step.request.plain, true);
      assert.equal(step.request.lateReports, true);
      for (const stream of ["stdout", "stderr"])
        assert.equal(
          hash(fs.readFileSync(process[stream])),
          process[`${stream}Sha256`],
        );
      const actual = frameSchema.parse(read(step.request.trace));
      assert.deepEqual(actual, step.native.trace);
      assert.equal(
        cliAnchorDigest(actual),
        admission.nativeFrameDigests[row.id][position],
      );
      assert.deepEqual(
        actual.observedCalls,
        admission.nativeCallOrder[row.id][position],
      );
      assert.equal(actual.id, step.request.id);
      assert.equal(actual.exitCode, process.status);
      assert.equal(process.status, expected.process.status);
      assert.equal(
        fs.readFileSync(process.stdout, "utf8"),
        expected.process.stdout,
      );
      assert.deepEqual(step.native.before, expected.before);
      assert.deepEqual(step.native.after, expected.after);
      assert.deepEqual(step.native.delta, expected.delta);
      assert.deepEqual(step.native.gitBefore, step.native.gitAfter);
      if (qualifications.includes(rangeProfile)) {
        const event = expected.events.find(
          (entry) => entry.event === "uncaught",
        );
        assert.equal(actual.outcome.kind, "thrown");
        assert.equal(actual.outcome.error.name, event.name);
        assert.equal(actual.outcome.error.message, event.message);
        assert.equal(actual.io.stored, event.exitCode ?? null);
        assert.deepEqual(actual.io.pending, []);
        const writes = expected.io
          .filter((entry) => entry.op === "stdio-write")
          .map(({ stream, payload }) => ({ stream, payload }));
        assert.deepEqual(actual.writeObservations, writes);
        assert.equal(
          fs.readFileSync(process.stderr, "utf8"),
          writes
            .filter((entry) => entry.stream === "stderr")
            .map((entry) => entry.payload)
            .join(""),
        );
      } else if (qualifications.includes(streamProfile)) {
        const event = expected.events.find(
          (entry) => entry.event === "uncaught",
        );
        assert.equal(actual.io.pending.length, 1);
        assert.equal(actual.io.pending[0].stream, event.stream);
        assert.equal(actual.io.pending[0].cause.rawCode, 9);
        assert.equal(fs.readFileSync(process.stderr, "utf8"), "");
      } else
        assert.equal(
          fs.readFileSync(process.stderr, "utf8"),
          expected.process.stderr,
        );
      calls.push(...actual.observedCalls);
      normalizedFrames.push({ process, frame: actual });
      frames++;
    }
    const qualifications = [
      ...new Set(Object.values(admission.qualifications[row.id] ?? {}).flat()),
    ].sort();
    assert.deepEqual(row.qualifications, qualifications);
    const declared = qualifications.length
      ? qualifiedNativeEvidence
      : nativeEvidence;
    declared[row.id] = { observedCalls: calls };
    return {
      ...row,
      valid: true,
      passed: true,
      qualifications,
      nativeTrace: { observedCalls: calls, frames: normalizedFrames },
    };
  });
  assert.equal(frames, 67);
  assert.equal(
    cases.find((row) => row.id === "real-two-scope-three-module-Git-repeat-out")
      .steps.length,
    9,
  );
  assert.equal(Object.keys(nativeEvidence).length, 14);
  assert.equal(Object.keys(qualifiedNativeEvidence).length, 6);
  return {
    attempted: 20,
    passed: 20,
    unqualifiedPairs: 14,
    qualifiedPairs: 6,
    cases,
    nativeEvidence,
    qualifiedNativeEvidence,
    rejectedInvalidInputs: 0,
    rejectedInvalidInputRows: 0,
    responseGuards: 0,
    failures: [],
    nativeFrames: 67,
    rustBinarySha256: expectedBinarySHA,
    reference: {
      rawFile,
      rawSha256: hash(fs.readFileSync(rawFile)),
      sourceFile,
      sourceSha256: hash(fs.readFileSync(sourceFile)),
      sourcePins: admission.sourcePins,
    },
    profiles: {
      scope:
        "20 actual late hotspots wholeviews,67nativeframes; nine actions count once. All53CLI/raw/bootstrap gaps stay open.",
      host: "Only exact12RangeError+2pendingstdio step profiles in6named wholeviews; original raw streams/errors/files are retained. No stderr/path/root normalization.",
      sourceOnly:
        "Clock stack/transport locations and per-run Git metadata are diagnostic-only; semantic clock/input/file/output/call facts remain mandatory.",
      invalidInputs:
        "No component generic stdin/refusal or UTF8 probe;0protocol/response-guard credit.",
      historical:
        "Original100case component phases,4controls and70unretained old native exe limit remain explicit; this adapter adds0newcredit.",
    },
  };
}

async function main() {
  const [binary, reportFile] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert(binary && reportFile);
  assertCliHotspotsEnvironment();
  assert.equal(process.version, "v22.21.1");
  const before = hash(fs.readFileSync(binary));
  const receipt = {
    producer: null,
    executionSteps: [],
    launches: [],
    supplied: { binary, sha256: before },
  };
  const proof = `${reportFile}.proof`,
    rawFile = `${reportFile}.raw.json`,
    producerFile = `${reportFile}.producer.json`;
  fs.mkdirSync(proof, { recursive: true });
  let ownsFixture = false,
    operationError,
    retentionError,
    identityError,
    cleanupError;
  function launch(name, script, args) {
    const command = [
      "python3",
      fileURLToPath(new URL(script, import.meta.url)),
      ...args,
    ];
    const result = spawnSync(command[0], command.slice(1), {
      cwd: root,
      env: {
        ...process.env,
        TMPDIR: "/private/tmp",
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
      encoding: "utf8",
      timeout: 600000,
      maxBuffer: 16 << 20,
    });
    const stdout = `${reportFile}.${name}.stdout`,
      stderr = `${reportFile}.${name}.stderr`;
    fs.writeFileSync(stdout, result.stdout ?? "");
    fs.writeFileSync(stderr, result.stderr ?? "");
    receipt.launches.push({
      command,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout,
      stderr,
      stdoutSha256: hash(fs.readFileSync(stdout)),
      stderrSha256: hash(fs.readFileSync(stderr)),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    return result;
  }
  try {
    receipt.producer = buildExample(
      process.env.CARGO ?? "cargo",
      "demlik-code-graph",
      "collapse_cli_driver",
      producerFile,
    );
    assert.equal(receipt.producer.binarySha256, before);
    fs.mkdirSync(admission.fixedOwnedFixture);
    ownsFixture = true;
    const source = launch("source-worker", "./cli-hotspots-window-source.py", [
      proof,
      admission.fixedOwnedFixture,
    ]);
    const sourceFile = path.join(proof, "source-first.json"),
      observed = read(sourceFile);
    assertCliSourceLaunch(source.stdout, source.stderr, observed);
    const driver = path.join(proof, "selected-driver.json");
    fs.writeFileSync(
      driver,
      `${JSON.stringify({ role: "collapse_cli_driver", actualPath: receipt.producer.binary, sha256: before, producer: receipt.producer }, null, 2)}\n`,
    );
    const native = launch("native-worker", "./graph-cli-hotspots-window.py", [
      receipt.producer.binary,
      proof,
      driver,
    ]);
    const workerRaw = path.join(proof, "cli-pairs-final.json");
    fs.copyFileSync(workerRaw, rawFile);
    const raw = read(rawFile);
    assertCliNativeLaunch(native.stdout, native.stderr, raw);
    const normalized = sharedCliHotspotsWindow(
      raw,
      observed,
      rawFile,
      sourceFile,
      before,
    );
    normalized.producer = {
      file: `${producerFile}.artifacts.json`,
      binarySha256: before,
    };
    fs.writeFileSync(reportFile, `${JSON.stringify(normalized, null, 2)}\n`);
  } catch (error) {
    operationError = error;
  } finally {
    const partial = path.join(proof, "cli-pairs-final.json");
    try {
      if (fs.existsSync(partial))
        receipt.executionSteps.push(
          ...read(partial).rows.flatMap((row) =>
            row.steps.map((step) => ({
              id: `${row.id}--${step.id}`,
              process: step.native.process,
            })),
          ),
        );
    } catch (error) {
      retentionError = error;
    }
    try {
      if (receipt.producer)
        assert.equal(hash(fs.readFileSync(receipt.producer.binary)), before);
      assert.equal(hash(fs.readFileSync(binary)), before);
    } catch (error) {
      identityError = error;
    } finally {
      try {
        if (ownsFixture)
          fs.rmSync(admission.fixedOwnedFixture, {
            recursive: true,
            force: true,
          });
      } catch (error) {
        cleanupError = error;
      }
      receipt.cleanup = {
        fixture: admission.fixedOwnedFixture,
        owned: ownsFixture,
        removed: ownsFixture
          ? !fs.existsSync(admission.fixedOwnedFixture)
          : null,
      };
      receipt.operationError = operationError ? String(operationError) : null;
      receipt.retentionError = retentionError ? String(retentionError) : null;
      receipt.identityError = identityError ? String(identityError) : null;
      receipt.cleanupError = cleanupError ? String(cleanupError) : null;
      fs.writeFileSync(
        `${reportFile}.execution.json`,
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
    }
  }
  const errors = [
    operationError,
    retentionError,
    identityError,
    cleanupError,
  ].filter(Boolean);
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      "Hotspots operation/retention/identity/cleanup failed",
    );
  if (errors.length) throw errors[0];
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
