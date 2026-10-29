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
  new URL("./hotspots-window-admission.json", import.meta.url),
);
const inputs = read(new URL("./hotspots-window-cases.json", import.meta.url));
const frame = z
  .strictObject({
    id: z.string(),
    clockReads: z.number().int().nonnegative(),
    output: z
      .strictObject({
        sinceIso: z.string(),
        untilIso: z.string(),
        days: z.number(),
      })
      .optional(),
    error: z
      .strictObject({
        name: z.literal("RangeError"),
        message: z.literal("Invalid time value"),
      })
      .optional(),
    nativeErrorData: z
      .strictObject({
        part: z.enum(["since", "until"]),
        valueBits: z.string().regex(/^[0-9a-f]{16}$/),
        sinceInput: z.string().nullable(),
        source: z.literal("Invalid time value"),
      })
      .optional(),
    zoneId: z.string(),
    timezoneDataVersion: z.literal("2025a"),
    nativeTrace: z.array(z.string()).length(4),
  })
  .refine(
    (value) => Object.hasOwn(value, "output") !== Object.hasOwn(value, "error"),
  );

export function assertHotspotsWindowEnvironment() {
  for (const key of [
    "CARGO_TARGET_DIR",
    "DEMLIK_MUTATION_TARGET_DIR",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_BUILD_DIR",
  ])
    assert.equal(process.env[key], undefined, `${key} must be unset`);
}
export function assertWindowLaunch(stdout, stderr, raw) {
  assert.equal(stderr, "");
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    cases: 80,
    passed: 80,
    nativeFrames: 80,
  });
  assert.equal(raw.rows.length, 80);
}
export function windowAnchorDigest(value) {
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
function view(source) {
  return Object.fromEntries(
    ["output", "error", "clockReads"]
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  );
}
export function sharedHotspotsWindow(raw, rawFile, expectedBinarySHA) {
  assert.deepEqual(read(rawFile), raw);
  assert.match(expectedBinarySHA, /^[a-f0-9]{64}$/);
  assert.equal(raw.cases, 80);
  assert.equal(raw.passed, 80);
  assert.deepEqual(raw.failures, []);
  if (raw.failure !== undefined) assert.equal(raw.failure, null);
  if (raw.qualifiedPairs !== undefined) assert.equal(raw.qualifiedPairs, 0);
  if (raw.rejectedInvalidInputs !== undefined)
    assert.equal(raw.rejectedInvalidInputs, 0);
  for (const [file, digest] of Object.entries(admission.sourcePins))
    assert.equal(hash(fs.readFileSync(path.join(root, file))), digest);
  const legacy = Object.hasOwn(raw, "windowRows");
  if (legacy) {
    assert.equal(raw.windowRows, 72);
    assert.equal(raw.parserCountercases, 8);
    assert.equal(raw.driver.sha256, expectedBinarySHA);
  } else {
    assert.equal(raw.binary.before, expectedBinarySHA);
    assert.equal(raw.binary.after, expectedBinarySHA);
    assert.equal(raw.sourcePhaseCompletedBeforeNative, true);
    assert.deepEqual(raw.sourcePinsBefore, admission.sourcePins);
    assert.deepEqual(raw.sourcePinsAfter, admission.sourcePins);
    assert.equal(raw.source.length, 3);
    const expectedProfiles = [
      ["window", "UTC"],
      ["window", "America/Los_Angeles"],
      ["parser", "UTC"],
    ];
    for (const [position, source] of raw.source.entries()) {
      assert.deepEqual(
        [source.profile, source.zone],
        expectedProfiles[position],
      );
      assert.equal(source.report.profile, source.profile);
      assert.equal(source.report.TZ, source.zone);
      assert.deepEqual(
        source.report.rows.map((row) => row.id),
        inputs
          .filter(
            (row) =>
              row.profile === source.profile && row.input.zone === source.zone,
          )
          .map((row) => row.id),
      );
      assert.deepEqual(source.process.command, [
        process.execPath,
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(
          new URL("./hotspots-window-reference.mjs", import.meta.url),
        ),
        source.profile,
        source.zone,
      ]);
      assert.equal(source.process.status, 0);
      assert.equal(source.process.signal, null);
      assert.equal(source.process.error, null);
      assert.deepEqual(read(source.process.stdout), source.report);
      assert.equal(fs.readFileSync(source.process.stderr, "utf8"), "");
      for (const stream of ["stdout", "stderr"])
        assert.equal(
          hash(fs.readFileSync(source.process[stream])),
          source.process[`${stream}Sha256`],
        );
      assert.deepEqual(
        [
          source.report.node,
          source.report.v8,
          source.report.icu,
          source.report.tz,
        ],
        Object.values(admission.SourceVersion),
      );
    }
  }
  assert.deepEqual(
    raw.rows.map((row) => row.id),
    inputs.map((row) => row.id),
  );
  const nativeEvidence = {};
  const cases = raw.rows.map((row, index) => {
    const input = inputs[index];
    assert.deepEqual(row.input, input.input);
    if (row.valid !== undefined) assert.equal(row.valid, true);
    if (row.passed !== undefined) assert.equal(row.passed, true);
    if (row.protocol !== undefined) assert.equal(row.protocol, false);
    if (row.qualifications !== undefined)
      assert.deepEqual(row.qualifications, []);
    assert.equal(row.equal, true);
    if (row.errors !== undefined) assert.deepEqual(row.errors, []);
    if (row.protocolError !== undefined) assert.equal(row.protocolError, null);
    const original = legacy ? { ...row.sourceRow, id: row.id } : row.source;
    if (!legacy)
      assert.deepEqual(
        original,
        raw.source
          .flatMap((entry) => entry.report.rows)
          .find((entry) => entry.id === row.id),
      );
    assert.equal(
      windowAnchorDigest(original),
      admission.sourceDigests[input.id],
    );
    if (legacy) {
      assert.equal(hash(fs.readFileSync(row.sourceFile)), row.sourceSha256);
      const source = read(row.sourceFile);
      const collection =
        input.profile === "window" ? source.windowRows : source.rows;
      assert.deepEqual(
        {
          ...collection.find(
            (r) =>
              `${input.id.slice(0, input.id.lastIndexOf(".") + 1)}${r.id}` ===
              input.id,
          ),
          id: input.id,
        },
        original,
      );
    }
    assert.deepEqual(row.expected, view(original));
    assert.deepEqual(row.actualView, row.expected);
    const process = row.process;
    assert.equal(process.status, 0);
    assert.equal(process.signal, null);
    if (process.error !== undefined) assert.equal(process.error, null);
    const request = legacy ? process.stdin : process.input;
    assert.equal(
      hash(fs.readFileSync(request)),
      legacy ? process.stdinSha256 : process.inputSha256,
    );
    assert.deepEqual(read(request), input.input);
    assert.equal(process.binarySha256, expectedBinarySHA);
    for (const stream of ["stdout", "stderr"])
      assert.equal(
        hash(fs.readFileSync(process[stream])),
        process[`${stream}Sha256`],
      );
    assert.equal(fs.readFileSync(process.stderr, "utf8"), "");
    const actual = frame.parse(read(process.stdout));
    assert.deepEqual(actual, row.native);
    assert.equal(
      windowAnchorDigest(actual),
      admission.nativeFrameDigests[input.id],
    );
    assert.deepEqual(actual.nativeTrace, admission.callOrder);
    nativeEvidence[row.id] = { observedCalls: actual.nativeTrace };
    return {
      id: row.id,
      valid: true,
      passed: true,
      qualifications: [],
      input: row.input,
      source: original,
      expected: row.expected,
      actual: row.actualView,
      nativeOnly: actual,
      nativeTrace: {
        observedCalls: actual.nativeTrace,
        frames: [{ process, frame: actual }],
      },
    };
  });
  return {
    attempted: 80,
    passed: 80,
    unqualifiedPairs: 80,
    qualifiedPairs: 0,
    cases,
    rejectedInvalidInputs: 0,
    rejectedInvalidInputRows: 0,
    responseGuards: 0,
    failures: [],
    nativeEvidence,
    qualifiedNativeEvidence: {},
    rustBinarySha256: expectedBinarySHA,
    nativeFrames: 80,
    reference: {
      rawFile,
      rawSha256: hash(fs.readFileSync(rawFile)),
      sourcePins: admission.sourcePins,
    },
    profiles: {
      scope:
        "80 measured windows/parser views. No universal JS Date/coercion/reflection/timezone database, protocol/UTF8, bootstrap or CLI gap closure.",
      timezone:
        "Actual native2025a versus pinned Node2025b; measured UTC/Los_Angeles only.",
      historical:
        "Original80raw and phase-specific component evidence remain immutable;70oldnative regression executable bytes are not retained.",
    },
  };
}

async function main() {
  const [binary, reportFile] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert(binary && reportFile);
  assertHotspotsWindowEnvironment();
  assert.equal(process.version, "v22.21.1");
  const before = hash(fs.readFileSync(binary));
  const receipt = {
    executionSteps: [],
    producer: null,
    supplied: { binary, sha256: before },
  };
  const producerFile = `${reportFile}.producer.json`,
    rawFile = `${reportFile}.raw.json`;
  let operationError, retentionError, identityError;
  try {
    receipt.producer = buildExample(
      process.env.CARGO ?? "cargo",
      "demlik-code-graph",
      "hotspots_window_driver",
      producerFile,
    );
    assert.equal(receipt.producer.binarySha256, before);
    const command = [
      process.execPath,
      "--import",
      createRequire(import.meta.url).resolve("tsx"),
      fileURLToPath(new URL("./graph-hotspots-window.mjs", import.meta.url)),
      receipt.producer.binary,
      rawFile,
    ];
    const result = spawnSync(command[0], command.slice(1), {
      cwd: root,
      env: { ...process.env, TMPDIR: "/private/tmp" },
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 8 << 20,
    });
    fs.writeFileSync(`${reportFile}.worker.stdout`, result.stdout ?? "");
    fs.writeFileSync(`${reportFile}.worker.stderr`, result.stderr ?? "");
    receipt.launch = {
      command,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: `${reportFile}.worker.stdout`,
      stderr: `${reportFile}.worker.stderr`,
    };
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    const raw = read(rawFile);
    assertWindowLaunch(result.stdout, result.stderr, raw);
    const normalized = sharedHotspotsWindow(raw, rawFile, before);
    normalized.producer = {
      file: `${producerFile}.artifacts.json`,
      binarySha256: before,
    };
    fs.writeFileSync(reportFile, `${JSON.stringify(normalized, null, 2)}\n`);
  } catch (error) {
    operationError = error;
  } finally {
    try {
      if (fs.existsSync(rawFile))
        receipt.executionSteps.push(
          ...read(rawFile).rows.map((row) => ({
            id: row.id,
            process: row.process,
          })),
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
      receipt.operationError = operationError ? String(operationError) : null;
      receipt.retentionError = retentionError ? String(retentionError) : null;
      receipt.identityError = identityError ? String(identityError) : null;
      fs.writeFileSync(
        `${reportFile}.execution.json`,
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
    }
  }
  const errors = [operationError, retentionError, identityError].filter(
    Boolean,
  );
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      "Window operation/retention/identity failed",
    );
  if (errors.length) throw errors[0];
}
if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
