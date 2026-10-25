import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createSnapshot } from "../../packages/tea/src/persistence/index.js";
import { normalize, numeric } from "./timing-clock.mts";

const number = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const script = z
  .object({
    seq: number,
    at: number,
    roundTrip: z.boolean(),
    lastSavedSeq: number.optional(),
    lastSavedAt: number.optional(),
  })
  .strict();
type Script = z.infer<typeof script>;
export function snapshotInputCases() {
  return [
    {
      id: "snapshot.input.finite",
      input: { seq: 2, at: 17.25, roundTrip: false },
    },
    {
      id: "snapshot.input.finite-json",
      input: { seq: 2, at: 17.25, roundTrip: true },
    },
    {
      id: "snapshot.input.nonfinite",
      input: {
        seq: { $number: "Infinity" },
        at: { $number: "NaN" },
        roundTrip: false,
      },
    },
    {
      id: "snapshot.input.nonfinite-json",
      input: {
        seq: { $number: "Infinity" },
        at: { $number: "NaN" },
        roundTrip: true,
      },
    },
    {
      id: "snapshot.input.null-vs-zero",
      input: {
        seq: { $number: "NaN" },
        at: { $number: "Infinity" },
        roundTrip: true,
        lastSavedSeq: 0,
        lastSavedAt: 10,
      },
    },
    {
      id: "snapshot.input.null-vs-negative",
      input: {
        seq: { $number: "-Infinity" },
        at: { $number: "NaN" },
        roundTrip: true,
        lastSavedSeq: -1,
        lastSavedAt: 10,
      },
    },
    {
      id: "snapshot.input.null-vs-positive",
      input: {
        seq: { $number: "Infinity" },
        at: { $number: "-Infinity" },
        roundTrip: true,
        lastSavedSeq: 1,
        lastSavedAt: 10,
      },
    },
    {
      id: "snapshot.input.null-watermark",
      input: {
        seq: { $number: "Infinity" },
        at: { $number: "NaN" },
        roundTrip: true,
        lastSavedSeq: { $number: "NaN" },
        lastSavedAt: 10,
      },
    },
    {
      id: "snapshot.input.negative-zero",
      input: {
        seq: { $number: "-0" },
        at: { $number: "-0" },
        roundTrip: false,
      },
    },
    {
      id: "snapshot.input.old-finite",
      input: {
        seq: 1,
        at: 17,
        roundTrip: false,
        lastSavedSeq: 2,
        lastSavedAt: 10,
      },
    },
  ].map((v) => ({ id: v.id, input: script.parse(v.input) }));
}
function execute(value: Script) {
  const input = script.parse(value),
    snap = createSnapshot<unknown>({ every: 1 });
  let raw = {
    key: "snapshot",
    seq: numeric.parse(input.seq),
    at: numeric.parse(input.at),
    payload: null,
  };
  if (input.roundTrip) raw = JSON.parse(JSON.stringify(raw));
  const command = snap.write(raw),
    state = {
      ...snap.init(),
      lastSavedSeq:
        input.lastSavedSeq === undefined
          ? null
          : numeric.parse(input.lastSavedSeq),
      lastSavedAt:
        input.lastSavedAt === undefined
          ? null
          : numeric.parse(input.lastSavedAt),
    };
  const [next, commands] = snap.confirm(
    state,
    snap.write.ok(command, undefined, 1),
  );
  return {
    input: normalize(raw),
    wire: JSON.stringify(command),
    sameState: next === state,
    state: normalize(next),
    commands: commands.length,
  };
}
const nativeOutput = z
  .object({
    id: z.string(),
    comparison: z.unknown(),
    observedRustCalls: z.array(z.string()),
  })
  .strict();
export function snapshotInputParity(options: {
  binary: string;
  reportFile?: string;
}) {
  const cases = snapshotInputCases(),
    expected = cases.map((c) => execute(c.input));
  const run = spawnSync(options.binary, [], {
    input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const actual = run.stdout
    .trim()
    .split("\n")
    .map((s) => nativeOutput.parse(JSON.parse(s)));
  assert.equal(actual.length, cases.length);
  const failures = cases.flatMap((c, i) => {
    assert.equal(actual[i].id, c.id);
    try {
      assert.deepEqual(actual[i].comparison, expected[i]);
      return [];
    } catch {
      return [
        { id: c.id, reference: expected[i], native: actual[i].comparison },
      ];
    }
  });
  const report = {
    runtime: { node: process.version, v8: process.versions.v8 },
    binary: {
      path: options.binary,
      sha256: createHash("sha256")
        .update(readFileSync(options.binary))
        .digest("hex"),
    },
    compared: cases.length,
    passed: cases.length - failures.length,
    failures,
    cases: cases.map((c, i) => ({
      ...c,
      ...actual[i],
      equal: !failures.some((f) => f.id === c.id),
    })),
    qualifications: [
      "Valid numeric calls and their JSON-restored null fields; arbitrary manually ill-typed raw values are outside this number-or-null profile.",
    ],
  };
  const path = options.reportFile ?? "target/parity/snapshot-input.json";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { "native-bin": { type: "string" }, report: { type: "string" } },
    strict: true,
  });
  assert(values["native-bin"], "--native-bin required");
  const r = snapshotInputParity({
    binary: values["native-bin"],
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      compared: r.compared,
      passed: r.passed,
      failures: r.failures,
    }),
  );
  if (r.failures.length) process.exitCode = 1;
}
