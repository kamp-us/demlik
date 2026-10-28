import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  createSaga,
  initSaga,
  isAborted,
  isCommitted,
  isCompensationFailed,
  isSettled,
  type SagaState,
} from "../../packages/tea/src/flow/index.js";
import type { Cmd } from "../../packages/tea/src/index.js";
import { buildParityBinary } from "./tea-example.mjs";
import { decode, normalize, numeric } from "./timing-clock.mts";

const wireNumber = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const id = wireNumber.nullable(),
  phase = z.enum([
    "idle",
    "running",
    "compensating",
    "committed",
    "aborted",
    "compensation_failed",
  ]);
const commandRecord = z.object({ type: z.string() }).passthrough();
const encodedData = z
  .unknown()
  .refine(
    (value) => z.json().safeParse(value).success,
    "expected encoded JSON data",
  );
const command = z
  .unknown()
  .refine(
    (value) =>
      encodedData.safeParse(value).success &&
      commandRecord.safeParse(decode(value)).success,
    "expected encoded command data",
  );
const step = z.object({ do: command, undo: command }).strict();
const seed = z
  .object({
    position: id,
    done: z.array(id),
    compensating: z.boolean(),
    phase,
    error: encodedData.optional(),
    compensationError: encodedData.optional(),
  })
  .strict();
const action = z.discriminatedUnion("op", [
  z
    .object({ op: z.enum(["start", "stepOk", "undoOk", "reset", "roundTrip"]) })
    .strict(),
  z.object({ op: z.enum(["stepErr", "undoErr"]), error: encodedData }).strict(),
  z.object({ op: z.literal("restore"), encoded: z.string() }).strict(),
]);
export const sagaScript = z
  .object({
    steps: z.array(step),
    initial: seed.optional(),
    actions: z.array(action),
  })
  .strict();
type Script = z.infer<typeof sagaScript>;
const restoredState = z
  .object({
    position: z.number().nullable(),
    done: z.array(z.number().nullable()),
    compensating: z.boolean(),
    phase,
    items: z.array(
      z
        .object({
          id: z.string(),
          status: z.enum(["pending", "running", "done", "failed", "cancelled"]),
          input: z.number().nullable(),
          enqueuedAt: z.number().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
function number(value: z.infer<typeof id>): number {
  if (value !== null) return numeric.parse(value);
  const holder = { value: 0 };
  Reflect.set(holder, "value", null);
  return holder.value;
}
function initial(input: z.infer<typeof seed>): SagaState {
  const state: SagaState = {
    position: number(input.position),
    done: input.done.map(number),
    compensating: input.compensating,
    phase: input.phase,
    items: [],
  };
  if (Object.hasOwn(input, "error"))
    Reflect.set(state, "error", decode(input.error));
  if (Object.hasOwn(input, "compensationError"))
    Reflect.set(state, "compensationError", decode(input.compensationError));
  return state;
}
function restored(encoded: string, previous: SagaState): SagaState {
  const raw: unknown = JSON.parse(encoded);
  restoredState.parse(raw);
  const holder = { state: previous };
  Reflect.set(holder, "state", raw);
  return holder.state;
}
export function executeSaga(input: unknown): unknown {
  const script = sagaScript.parse(input);
  const steps = script.steps.map((step) => ({
    do: decodedCommand(step.do),
    undo: decodedCommand(step.undo),
  }));
  const saga = createSaga({ steps });
  let state = script.initial ? initial(script.initial) : saga.init();
  const row = (
    commands: readonly Cmd[],
    sameState: boolean | null,
    sameItems: boolean | null,
    priorUnchanged: boolean,
  ) =>
    normalize({
      state,
      commands,
      sameState,
      sameItems,
      priorUnchanged,
      commandsAreConfigured: commands.every((command) =>
        steps.some((step) => command === step.do || command === step.undo),
      ),
      predicates: {
        committed: isCommitted(state),
        aborted: isAborted(state),
        compensationFailed: isCompensationFailed(state),
        settled: isSettled(state),
      },
      serialized: JSON.stringify(state),
    });
  const rows = [row([], null, null, true)];
  for (const action of script.actions) {
    const previous = state,
      before = normalize(previous);
    let commands: readonly Cmd[] = [];
    switch (action.op) {
      case "start":
        [state, commands] = saga.start(state);
        break;
      case "stepOk":
        [state, commands] = saga.stepOk(state);
        break;
      case "stepErr":
        [state, commands] = saga.stepErr(state, decode(action.error));
        break;
      case "undoOk":
        [state, commands] = saga.undoOk(state);
        break;
      case "undoErr":
        [state, commands] = saga.undoErr(state, decode(action.error));
        break;
      case "reset":
        state = initSaga();
        break;
      case "roundTrip":
        state = restored(JSON.stringify(state), state);
        break;
      case "restore":
        state = restored(action.encoded, state);
        break;
    }
    rows.push(
      row(
        commands,
        state === previous,
        state.items === previous.items,
        JSON.stringify(before) === JSON.stringify(normalize(previous)),
      ),
    );
  }
  return rows;
}
function decodedCommand(input: unknown): Cmd {
  const raw = decode(input);
  commandRecord.parse(raw);
  // Validation must not replace the value: Zod strips an own __proto__ key.
  const holder: { value: Cmd } = { value: { type: "validated" } };
  Reflect.set(holder, "value", raw);
  return holder.value;
}
type Case = { id: string; script: Script };
function corpus(): Case[] {
  const cases: Case[] = [];
  const add = (id: string, script: unknown) =>
    cases.push({ id, script: sagaScript.parse(script) });
  const steps = Array.from({ length: 4 }, (_, id) => ({
    do: { type: "forward", id, payload: id === 1 ? { $utf16: [0xd800] } : id },
    undo: { type: "undo", id },
  }));
  add("saga.commands-retain-prototype-data-and-lossless-tags", {
    steps: [
      {
        do: {
          $object: [
            ["type", { $utf16: [0xd800] }],
            ["__proto__", { kept: true }],
            ["extra", { $undefined: true }],
          ],
        },
        undo: {
          $object: [
            ["type", "undo"],
            ["__proto__", null],
          ],
        },
      },
    ],
    actions: [
      { op: "start" },
      { op: "roundTrip" },
      { op: "stepOk" },
      { op: "reset" },
    ],
  });
  add("saga.forward-commit-stale-and-reset", {
    steps,
    actions: [
      { op: "stepOk" },
      { op: "undoOk" },
      { op: "start" },
      { op: "start" },
      { op: "stepOk" },
      { op: "roundTrip" },
      { op: "stepOk" },
      { op: "stepOk" },
      { op: "stepOk" },
      { op: "stepErr", error: "late" },
      { op: "undoErr", error: null },
      { op: "undoOk" },
      { op: "reset" },
      { op: "start" },
    ],
  });
  for (const failure of ["ok", "err"]) {
    add(`saga.reverse-${failure}`, {
      steps,
      actions: [
        { op: "start" },
        { op: "stepOk" },
        { op: "stepOk" },
        { op: "stepOk" },
        { op: "stepErr", error: { forward: "shipping" } },
        { op: "roundTrip" },
        { op: "stepOk" },
        { op: "undoOk" },
        { op: "roundTrip" },
        { op: "undoOk" },
        failure === "ok"
          ? { op: "undoOk" }
          : { op: "undoErr", error: { inverse: "release" } },
        { op: "roundTrip" },
        { op: "start" },
        { op: "stepErr", error: "late" },
        { op: "undoOk" },
      ],
    });
  }
  add("saga.first-failure", {
    steps,
    actions: [
      { op: "start" },
      { op: "stepErr", error: { $undefined: true } },
      { op: "roundTrip" },
      { op: "undoErr", error: null },
    ],
  });
  add("saga.empty", {
    steps: [],
    actions: [
      { op: "start" },
      { op: "stepOk" },
      { op: "stepErr", error: 0 },
      { op: "undoOk" },
      { op: "undoErr", error: 0 },
      { op: "roundTrip" },
    ],
  });
  add("saga.spread-order-absence-and-prototype-data", {
    steps,
    actions: [
      {
        op: "restore",
        encoded:
          '{"position":1,"done":[0],"compensating":false,"phase":"running","compensationError":null,"items":[],"__proto__":{"kept":true},"trailing":"keep"}',
      },
      { op: "stepErr", error: { $undefined: true } },
      { op: "roundTrip" },
      { op: "undoErr", error: null },
      { op: "roundTrip" },
    ],
  });
  add("saga.error-lossless-keys", {
    steps,
    actions: [
      { op: "start" },
      { op: "stepOk" },
      {
        op: "stepErr",
        error: {
          $object: [
            [{ $utf16: [0xd800] }, { $number: "NaN" }],
            ["__proto__", { $utf16: [0xdc00] }],
            ["undefined", { $undefined: true }],
          ],
        },
      },
      { op: "roundTrip" },
      { op: "undoErr", error: { $utf16: [0xd800] } },
      { op: "roundTrip" },
    ],
  });
  const rawFailure: unknown = JSON.parse(
    '{"__proto__":{"failure":true},"trailing":7}',
  );
  add("saga.failures-retain-own-prototype-data", {
    steps,
    actions: [
      { op: "start" },
      { op: "stepOk" },
      { op: "stepErr", error: rawFailure },
      { op: "roundTrip" },
      { op: "undoErr", error: rawFailure },
      { op: "roundTrip" },
    ],
  });
  for (const position of [
    null,
    -2,
    -1,
    0.5,
    { $number: "-0" },
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
  ]) {
    for (const direction of ["forward", "reverse"]) {
      add(`saga.position-${JSON.stringify(position)}-${direction}`, {
        steps,
        initial: {
          position,
          done: direction === "forward" ? [0] : [0, 1],
          compensating: direction === "reverse",
          phase: direction === "forward" ? "running" : "compensating",
        },
        actions:
          direction === "forward"
            ? [
                { op: "stepOk" },
                { op: "roundTrip" },
                { op: "stepErr", error: null },
                { op: "undoOk" },
              ]
            : [
                { op: "undoOk" },
                { op: "roundTrip" },
                { op: "undoErr", error: { $undefined: true } },
              ],
      });
    }
  }
  for (const done of [
    [],
    [null],
    [99],
    [0, 99],
    [0, null],
    [0, { $number: "NaN" }],
    [1, 0],
  ]) {
    for (const operation of ["stepErr", "undoOk"]) {
      add(`saga.done-${JSON.stringify(done)}-${operation}`, {
        steps,
        initial: {
          position: 99,
          done,
          compensating: operation === "undoOk",
          phase: operation === "undoOk" ? "compensating" : "running",
        },
        actions: [
          operation === "stepErr"
            ? { op: operation, error: { $undefined: true } }
            : { op: operation },
          { op: "roundTrip" },
          { op: "undoOk" },
        ],
      });
    }
  }
  for (let run = 0; run < 32; run++) {
    const count = run % 7,
      fail = run % 4 === 0 ? -1 : run % Math.max(1, count),
      steps = Array.from({ length: count }, (_, index) => ({
        do: { type: "do", run, index },
        undo: { type: "undo", run, index },
      })),
      actions: unknown[] = [{ op: "start" }];
    for (let index = 0; index < count; index++) {
      if (index === fail) {
        actions.push({
          op: "stepErr",
          error: run % 2 === 0 ? { $undefined: true } : { forward: run },
        });
        for (let undo = index - 1; undo >= 0; undo--) {
          if (undo === 0 && run % 3 === 0) {
            actions.push({ op: "undoErr", error: { inverse: run } });
            break;
          }
          actions.push({ op: "undoOk" });
          if (undo % 2 === 0) actions.push({ op: "roundTrip" });
        }
        break;
      }
      actions.push({ op: "stepOk" });
      if (index % 2 === 0) actions.push({ op: "roundTrip" });
    }
    actions.push({ op: "stepErr", error: "stale" }, { op: "undoOk" });
    add(`saga.generated-${run}`, { steps, actions });
  }
  return cases;
}
function commandRun(
  executable: string,
  args: string[],
  input?: string,
  cwd = process.cwd(),
  env = process.env,
) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${executable} exited ${result.status}\n${result.stderr.slice(-8000)}`,
    );
  return result.stdout;
}
function binary(cwd = process.cwd(), target = process.env.CARGO_TARGET_DIR) {
  return join(
    target ? resolve(cwd, target) : join(cwd, "target"),
    "debug/saga_driver",
  );
}
function build(cwd = process.cwd(), target?: string) {
  commandRun(
    process.env.CARGO ?? "cargo",
    ["build", "--locked", "-p", "demlik-parity", "--bin", "saga_driver"],
    undefined,
    cwd,
    {
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      ...(target ? { CARGO_TARGET_DIR: target } : {}),
    },
  );
}
const response = z
  .object({
    comparison: z.array(z.unknown()),
    observedRustCalls: z.array(z.string()).nonempty(),
  })
  .strict();
function native(cases: Case[], executable: string) {
  return commandRun(
    executable,
    [],
    `${cases.map((item) => JSON.stringify(item.script)).join("\n")}\n`,
  )
    .trim()
    .split("\n")
    .map((line) => response.parse(JSON.parse(line)));
}
const digest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const mutations = [
  {
    id: "saga-walks-oldest-completed-first",
    needle: "done.last().copied()",
    replacement: "done.first().copied()",
  },
  {
    id: "saga-forgets-uncompensated-work-after-inverse-failure",
    needle: "next.fields.compensation_error = QueueField::Value(error);",
    replacement:
      "next.fields.compensation_error = QueueField::Value(error); next.fields.done = Rc::new(vec![]);",
  },
];
function controls(cases: Case[], expected: unknown[]) {
  const owner = "crates/tea/src/flow/saga.rs";
  return mutations.map((mutation) => {
    const temporary = mkdtempSync(join(tmpdir(), "demlik-saga-control-")),
      before = digest(owner);
    try {
      for (const file of ["Cargo.toml", "Cargo.lock"])
        cpSync(file, join(temporary, file));
      cpSync("crates", join(temporary, "crates"), {
        recursive: true,
        filter: (file) =>
          !file
            .split(sep)
            .some((part) => ["target", "node_modules", ".git"].includes(part)),
      });
      if (existsSync(".cargo"))
        cpSync(".cargo", join(temporary, ".cargo"), { recursive: true });
      const file = join(temporary, owner),
        source = readFileSync(file, "utf8");
      assert.equal(digest(file), before);
      assert.equal(source.split(mutation.needle).length, 2);
      writeFileSync(
        file,
        source.replace(mutation.needle, mutation.replacement),
      );
      const target = join(temporary, "target");
      build(temporary, target);
      const executable = binary(temporary, target),
        results = native(cases, executable);
      assert.equal(results.length, cases.length);
      const detectedIds = cases
        .filter((_, index) => {
          try {
            assert.deepEqual(results[index].comparison, expected[index]);
            return false;
          } catch {
            return true;
          }
        })
        .map((item) => item.id);
      assert(detectedIds.length > 0, mutation.id);
      assert.equal(digest(owner), before);
      return {
        id: mutation.id,
        isolation: "disposable-source-copy",
        sourceBeforeSha256: before,
        mutantSourceSha256: digest(file),
        nativeBinarySha256: digest(executable),
        activeSourceUnchanged: true,
        detectedIds,
      };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      assert.equal(digest(owner), before);
    }
  });
}
export function verifySaga(
  reportPath = "target/parity/saga.json",
  binaryOverride?: string,
  mutationCheck = false,
) {
  let producer: ReturnType<typeof buildParityBinary> | null = null;
  let executable: string;
  if (binaryOverride) {
    executable = binaryOverride;
  } else {
    producer = buildParityBinary(
      process.env.CARGO ?? "cargo",
      "saga_driver",
      reportPath,
    );
    executable = binaryOverride ?? producer.binary;
  }
  const cases = corpus(),
    expected = cases.map((item) => executeSaga(item.script)),
    results = native(cases, executable);
  assert.equal(results.length, cases.length);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  const failures: {
    id: string;
    message: string;
    reference: unknown;
    native: unknown;
  }[] = [];
  cases.forEach((item, index) => {
    try {
      assert.deepEqual(results[index].comparison, expected[index], item.id);
    } catch (error) {
      failures.push({
        id: item.id,
        message: error instanceof Error ? error.message : String(error),
        reference: expected[index],
        native: results[index].comparison,
      });
    }
  });
  const selected = (id: string, position: number) => {
    const index = cases.findIndex((item) => item.id === id);
    assert(index >= 0);
    const rows = z.array(z.unknown()).parse(expected[index]);
    return rows[position < 0 ? rows.length + position : position];
  };
  const state = z.object({
    state: z.object({ phase: z.string(), done: z.array(z.number()) }),
  });
  assert.equal(
    state.parse(selected("saga.forward-commit-stale-and-reset", 9)).state.phase,
    "committed",
  );
  assert.equal(
    state.parse(selected("saga.reverse-ok", -1)).state.phase,
    "aborted",
  );
  assert.deepEqual(
    state.parse(selected("saga.reverse-err", -1)).state.done,
    [0],
  );
  const firstUndo = z
    .object({
      commands: z.array(z.object({ type: z.string(), id: z.number() })),
    })
    .parse(selected("saga.reverse-ok", 5));
  assert.deepEqual(firstUndo.commands, [{ type: "undo", id: 2 }]);
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  const report = {
    producer,
    scope:
      "native reversible saga queue composition; full port remains incomplete",
    passed: cases.length - failures.length,
    failures,
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      rustc: commandRun(rustc, ["--version"]).trim(),
    },
    binary: { path: executable, sha256: digest(executable) },
    compared: cases.length,
    transitions: cases.reduce(
      (sum, item) => sum + item.script.actions.length,
      0,
    ),
    controls:
      mutationCheck && !failures.length ? controls(cases, expected) : [],
    cases: cases.map((item, index) => ({
      ...item,
      ...results[index],
      equal: !failures.some((failure) => failure.id === item.id),
      functions: [...new Set(results[index].observedRustCalls)].sort(),
    })),
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      "native-binary": { type: "string" },
      "mutation-check": { type: "boolean", default: false },
    },
    strict: true,
  });
  const report = verifySaga(
    values.report,
    values["native-binary"],
    values["mutation-check"],
  );
  console.log(
    JSON.stringify({
      compared: report.compared,
      passed: report.passed,
      failures: report.failures,
      transitions: report.transitions,
      controls: report.controls.map((item) => ({
        id: item.id,
        detected: item.detectedIds.length,
      })),
      report: values.report ?? "target/parity/saga.json",
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
