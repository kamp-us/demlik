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
  addItem,
  type BatchWindow,
  batchWindowExpired,
  createBatchWindow,
  createFanOut,
  initBatchWindow,
  initFanOut,
  isComplete,
  onWindow,
  subsFor,
  timerFor,
} from "../../packages/tea/src/flow/index.js";
import { definePort } from "../../packages/tea/src/index.js";

const wireNumber = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
type WireNumber = z.infer<typeof wireNumber>;
function number(value: WireNumber): number {
  if (typeof value === "number") return value;
  switch (value.$number) {
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return Infinity;
    case "-Infinity":
      return -Infinity;
    case "-0":
      return -0;
  }
}
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 1 && "$number" in value)
      return number(wireNumber.parse(value));
    if (
      entries.length === 1 &&
      "$undefined" in value &&
      value.$undefined === true
    )
      return undefined;
    return Object.fromEntries(
      entries.map(([key, value]) => [key, decode(value)]),
    );
  }
  return value;
}
function normalized(value: unknown): unknown {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $number: "NaN" };
    if (value === Infinity) return { $number: "Infinity" };
    if (value === -Infinity) return { $number: "-Infinity" };
    if (Object.is(value, -0)) return { $number: "-0" };
    return value;
  }
  if (value === undefined) return { $undefined: true };
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, normalized(value)]),
    );
  return value;
}
const itemSchema = z.object({ id: z.string(), value: z.json() }).strict();
const fanAction = z.discriminatedUnion("op", [
  z.object({ op: z.literal("scatter"), items: z.array(itemSchema) }).strict(),
  z.object({ op: z.literal("ok"), id: z.string(), result: z.json() }).strict(),
  z.object({ op: z.literal("err"), id: z.string(), error: z.json() }).strict(),
  z.object({ op: z.enum(["emit", "reset"]) }).strict(),
]);
const batchAction = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), item: itemSchema, at: wireNumber }).strict(),
  z.object({ op: z.literal("window"), at: wireNumber }).strict(),
  z
    .object({ op: z.literal("expired"), id: z.string(), at: wireNumber })
    .strict(),
  z.object({ op: z.literal("reset") }).strict(),
]);
export const flowScript = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fanOut"),
      concurrency: wireNumber,
      join: z.boolean(),
      bareInit: z.boolean(),
      actions: z.array(fanAction),
    })
    .strict(),
  z
    .object({
      kind: z.literal("batchWindow"),
      maxItems: wireNumber,
      maxMs: wireNumber,
      bound: z.boolean(),
      id: z.string().optional(),
      initial: z
        .object({
          buffer: z.array(itemSchema),
          openedAt: wireNumber.nullable(),
        })
        .strict()
        .optional(),
      actions: z.array(batchAction),
    })
    .strict(),
]);
type Script = z.infer<typeof flowScript>;
type Item = { id: string; value: unknown };
function input(value: z.infer<typeof itemSchema>): Item {
  return { id: value.id, value: decode(value.value) };
}
type FanCommand =
  | { type: "launch"; item: Item }
  | { type: "join"; results: readonly unknown[] };
type Flush = { type: "flush"; items: readonly Item[] };
const outputItem = z.object({ id: z.string(), value: z.unknown() }).strict();
const commands = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("launch"), item: outputItem }).strict(),
    z
      .object({ type: z.literal("join"), results: z.array(z.unknown()) })
      .strict(),
    z.object({ type: z.literal("flush"), items: z.array(outputItem) }).strict(),
  ]),
);
const deadline = z
  .object({ id: z.string(), type: z.literal("deadline"), atMs: wireNumber })
  .strict();
const expiry = z
  .object({
    id: z.string(),
    type: z.literal("deadline_exceeded"),
    atMs: wireNumber,
  })
  .strict();
const common = {
  commands,
  sameState: z.boolean().nullable(),
  priorStateUnchanged: z.boolean(),
};
const comparisonSchema = z.array(
  z.union([
    z
      .object({
        ...common,
        state: z
          .object({
            pending: z.array(outputItem),
            running: z.array(outputItem),
            done: z.array(
              z.object({ item: outputItem, result: z.unknown() }).strict(),
            ),
            failed: z.array(
              z.object({ item: outputItem, error: z.unknown() }).strict(),
            ),
            items: z.array(
              z
                .object({
                  id: z.string(),
                  input: outputItem,
                  enqueuedAt: wireNumber,
                  status: z.enum(["pending", "running", "done", "failed"]),
                  startedAt: wireNumber.optional(),
                })
                .strict(),
            ),
            waveDoneFrom: wireNumber,
            waveFailedFrom: wireNumber,
            joined: z.boolean(),
          })
          .strict(),
        complete: z.boolean(),
        emissions: z.array(z.array(z.unknown())),
      })
      .strict(),
    z
      .object({
        ...common,
        state: z
          .object({
            buffer: z.array(outputItem),
            openedAt: wireNumber.nullable(),
          })
          .strict(),
        event: expiry.nullable(),
        timer: z.object({ ms: wireNumber, msg: expiry }).strict().nullable(),
        deadlines: z.array(deadline),
      })
      .strict(),
  ]),
);
const responseSchema = z
  .object({
    comparison: comparisonSchema,
    observedRustCalls: z.array(z.string()).nonempty(),
  })
  .strict();

let portSequence = 0;
export function executeFlow(value: unknown) {
  const script = flowScript.parse(value);
  if (script.kind === "fanOut") {
    const config = {
      concurrency: number(script.concurrency),
      idOf: (item: Item) => item.id,
      of: (item: Item): FanCommand => ({ type: "launch", item }),
      ...(script.join
        ? {
            join: (results: readonly unknown[]): FanCommand => ({
              type: "join",
              results,
            }),
          }
        : {}),
    };
    const knob = createFanOut<Item, unknown, FanCommand, FanCommand>(config);
    let state = script.bareInit ? initFanOut<Item, unknown>() : knob.init();
    const completion = knob.completion({
      complete: definePort<readonly unknown[]>(
        `flow.driver.complete.${portSequence++}`,
      ),
    });
    const emissions: unknown[] = [];
    const row = (
      commands: readonly FanCommand[],
      sameState: boolean | null,
      priorStateUnchanged: boolean,
    ) =>
      normalized({
        state,
        commands,
        sameState,
        priorStateUnchanged,
        complete: isComplete(state),
        emissions: [...emissions],
      });
    const rows = [row([], null, true)];
    for (const action of script.actions) {
      const previous = state,
        before = normalized(state);
      let commands: readonly FanCommand[] = [];
      switch (action.op) {
        case "scatter":
          [state, commands] = knob.scatter(state, action.items.map(input));
          break;
        case "ok":
          [state, commands] = knob.itemOk(
            state,
            action.id,
            decode(action.result),
          );
          break;
        case "err":
          [state, commands] = knob.itemErr(
            state,
            action.id,
            decode(action.error),
          );
          break;
        case "reset":
          state = knob.init();
          break;
        case "emit":
          completion.emitOnComplete(
            (_, values) => emissions.push(normalized(values)),
            state,
          );
          break;
      }
      assert.equal(knob.isComplete(state), isComplete(state));
      rows.push(
        row(
          commands,
          state === previous,
          JSON.stringify(before) === JSON.stringify(normalized(previous)),
        ),
      );
    }
    return comparisonSchema.parse(rows);
  }
  const config = {
    maxItems: number(script.maxItems),
    maxMs: number(script.maxMs),
    flush: (items: readonly Item[]): Flush => ({ type: "flush", items }),
  };
  const knob = createBatchWindow(config);
  const init = () => (script.bound ? knob.init() : initBatchWindow<Item>());
  let state: BatchWindow<Item> = script.initial
    ? {
        buffer: script.initial.buffer.map(input),
        openedAt:
          script.initial.openedAt === null
            ? null
            : number(script.initial.openedAt),
      }
    : init();
  const row = (
    commands: readonly Flush[],
    sameState: boolean | null,
    priorStateUnchanged: boolean,
    event: unknown = null,
  ) =>
    normalized({
      state,
      commands,
      sameState,
      priorStateUnchanged,
      event,
      timer: script.bound
        ? knob.timer(state, script.id)
        : timerFor(config, state, script.id),
      deadlines: script.bound
        ? knob.subs(state, script.id)
        : subsFor(config, state, script.id),
    });
  const rows = [row([], null, true)];
  for (const action of script.actions) {
    const previous = state,
      before = normalized(state);
    let commands: readonly Flush[] = [],
      event: unknown = null;
    switch (action.op) {
      case "add":
        [state, commands] = script.bound
          ? knob.add(state, input(action.item), number(action.at))
          : addItem(config, state, input(action.item), number(action.at));
        break;
      case "window":
        [state, commands] = script.bound
          ? knob.onWindow(state, number(action.at))
          : onWindow(config, state, number(action.at));
        break;
      case "expired":
        event = batchWindowExpired(action.id, number(action.at));
        break;
      case "reset":
        state = init();
        break;
    }
    rows.push(
      row(
        commands,
        state === previous,
        JSON.stringify(before) === JSON.stringify(normalized(previous)),
        event,
      ),
    );
  }
  return comparisonSchema.parse(rows);
}
type Case = { id: string; script: Script };
function corpus(): Case[] {
  const cases: Case[] = [],
    item = (id: string, value: number) => ({ id, value });
  const fan = (
    id: string,
    concurrency: WireNumber,
    actions: z.infer<typeof fanAction>[],
    join = true,
    bareInit = false,
  ) =>
    cases.push({
      id: `flow.fan-out.${id}`,
      script: { kind: "fanOut", concurrency, join, bareInit, actions },
    });
  fan("duplicate-waves", 2, [
    { op: "emit" },
    { op: "scatter", items: [item("dup", 1), item("dup", 2), item("z", 3)] },
    { op: "ok", id: "dup", result: 10 },
    { op: "err", id: "dup", error: { code: "E", detail: [false, null] } },
    { op: "ok", id: "z", result: 30 },
    { op: "emit" },
    { op: "emit" },
    { op: "ok", id: "z", result: 999 },
    { op: "scatter", items: [item("next", 4)] },
    { op: "ok", id: "next", result: 40 },
    { op: "emit" },
    { op: "scatter", items: [] },
    { op: "emit" },
  ]);
  fan(
    "mid-wave-and-failures",
    1,
    [
      { op: "scatter", items: [item("a", 1), item("b", 2)] },
      { op: "scatter", items: [item("a", 3)] },
      { op: "err", id: "unknown", error: "stale" },
      { op: "err", id: "a", error: { $undefined: true } },
      { op: "ok", id: "b", result: { $number: "NaN" } },
      { op: "err", id: "a", error: [1, 2] },
      { op: "emit" },
      { op: "reset" },
    ],
    false,
    true,
  );
  for (const [label, budget] of Object.entries({
    zero: 0,
    negative: -2,
    fractional: 2.75,
    nan: { $number: "NaN" },
    infinity: { $number: "Infinity" },
    negativeInfinity: { $number: "-Infinity" },
    negativeZero: { $number: "-0" },
  })) {
    fan(
      `budget-${label}`,
      wireNumber.parse(budget),
      [
        { op: "scatter", items: [item("", 1), item("😀", 2), item("last", 3)] },
        { op: "ok", id: "", result: { $number: "-0" } },
        { op: "ok", id: "😀", result: false },
        { op: "ok", id: "last", result: null },
        { op: "emit" },
      ],
      true,
      true,
    );
  }
  for (let seed = 1; seed <= 12; seed++) {
    let rng = seed,
      id = 0;
    const draw = (n: number) => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      return rng % n;
    };
    const actions: z.infer<typeof fanAction>[] = [];
    const live: string[] = [];
    for (let wave = 0; wave < 3; wave++) {
      const items = Array.from({ length: 2 + draw(6) }, () =>
        item(`id-${id++ % 4}`, id),
      );
      live.push(...items.map((item) => item.id));
      actions.push({ op: "scatter", items });
      for (const key of live.splice(0))
        actions.push(
          draw(3) === 0
            ? { op: "err", id: key, error: { seed, at: actions.length } }
            : { op: "ok", id: key, result: [seed, actions.length] },
        );
      actions.push({ op: "emit" }, { op: "ok", id: "never", result: 0 });
    }
    fan(
      `generated-${seed}`,
      1 + (seed % 4),
      actions,
      seed % 3 !== 0,
      seed % 2 === 0,
    );
  }
  const batch = (
    id: string,
    maxItems: WireNumber,
    maxMs: WireNumber,
    actions: z.infer<typeof batchAction>[],
    bound = false,
    initial?: Extract<Script, { kind: "batchWindow" }>["initial"],
    key?: string,
  ) =>
    cases.push({
      id: `flow.batch-window.${id}`,
      script: {
        kind: "batchWindow",
        maxItems,
        maxMs,
        bound,
        actions,
        ...(initial ? { initial } : {}),
        ...(key === undefined ? {} : { id: key }),
      },
    });
  for (const bound of [false, true]) {
    batch(
      `size-stale-${bound}`,
      3,
      1000,
      [
        { op: "add", item: item("a", 30), at: 100 },
        { op: "add", item: item("b", 10), at: 110 },
        { op: "add", item: item("c", 20), at: 120 },
        { op: "window", at: 1100 },
        { op: "expired", id: "batch-window", at: 1100 },
      ],
      bound,
    );
    batch(
      `early-window-${bound}`,
      20,
      1000,
      [
        { op: "window", at: 0 },
        { op: "add", item: item("one", 1), at: 100 },
        { op: "window", at: 101 },
        { op: "window", at: 1100 },
        { op: "reset" },
      ],
      bound,
      undefined,
      "",
    );
    batch(
      `restored-${bound}`,
      10,
      1000,
      [
        { op: "add", item: item("second", 2), at: 1000 },
        { op: "window", at: 1100 },
      ],
      bound,
      { buffer: [item("first", 1)], openedAt: 100 },
      "restore",
    );
  }
  for (const [label, value] of Object.entries({
    zero: 0,
    negative: -1,
    fractional: 1.5,
    nan: { $number: "NaN" },
    infinity: { $number: "Infinity" },
    negativeInfinity: { $number: "-Infinity" },
    negativeZero: { $number: "-0" },
  })) {
    batch(
      `limits-${label}`,
      wireNumber.parse(value),
      wireNumber.parse(value),
      [
        { op: "add", item: item("a", 1), at: { $number: "-0" } },
        { op: "add", item: item("b", 2), at: { $number: "Infinity" } },
        { op: "window", at: { $number: "NaN" } },
      ],
      true,
    );
  }
  batch(
    "nan-anchor",
    10,
    25.5,
    [
      { op: "add", item: item("b", 2), at: 100 },
      { op: "window", at: 0 },
    ],
    false,
    { buffer: [item("a", 1)], openedAt: { $number: "NaN" } },
  );
  batch(
    "inconsistent-restored-open",
    10,
    15.25,
    [
      { op: "window", at: 0 },
      { op: "add", item: item("a", 1), at: 200 },
    ],
    false,
    { buffer: [], openedAt: 100 },
  );
  for (let seed = 1; seed <= 12; seed++) {
    let rng = seed;
    const draw = (n: number) => {
      rng = (Math.imul(rng, 1103515245) + 12345) >>> 0;
      return rng % n;
    };
    const actions: z.infer<typeof batchAction>[] = [];
    for (let i = 0; i < 36; i++)
      actions.push(
        draw(4) === 0
          ? { op: "window", at: i * 3 }
          : { op: "add", item: item(`item-${i}`, draw(100)), at: i * 3 },
      );
    actions.push({ op: "window", at: 10000 });
    batch(`generated-${seed}`, 1 + (seed % 5), 17.25, actions, seed % 2 === 0);
  }
  return cases;
}
function command(
  binary: string,
  args: string[],
  input?: string,
  cwd = process.cwd(),
  env = process.env,
) {
  const result = spawnSync(binary, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${binary} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}
function binary(cwd = process.cwd(), target = process.env.CARGO_TARGET_DIR) {
  return join(
    target ? resolve(cwd, target) : join(cwd, "target"),
    "debug/flow_driver",
  );
}
function build(cwd = process.cwd(), target?: string) {
  command(
    process.env.CARGO ?? "cargo",
    ["build", "--locked", "-p", "demlik-parity", "--bin", "flow_driver"],
    undefined,
    cwd,
    {
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      ...(target ? { CARGO_TARGET_DIR: target } : {}),
    },
  );
}
function native(cases: Case[], executable: string) {
  return command(
    executable,
    [],
    `${cases.map((item) => JSON.stringify(item.script)).join("\n")}\n`,
  )
    .trim()
    .split("\n")
    .map((line) => responseSchema.parse(JSON.parse(line)));
}
function digest(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
const mutations = [
  {
    id: "fan-out-cumulative-wave",
    file: "crates/tea/src/flow/fan_out.rs",
    needle: "next.wave_done_from = state.done.len() as f64;",
    replacement: "next.wave_done_from = 0.0;",
  },
  {
    id: "batch-window-skips-one-item",
    file: "crates/tea/src/flow/batch_window.rs",
    needle: "if state.buffer.is_empty()",
    replacement: "if state.buffer.len() <= 1",
  },
];
function controls(cases: Case[], expected: z.infer<typeof comparisonSchema>[]) {
  return mutations.map((mutation) => {
    const temporary = mkdtempSync(join(tmpdir(), "demlik-flow-control-")),
      before = digest(mutation.file);
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
      const file = join(temporary, mutation.file),
        source = readFileSync(file, "utf8");
      assert.equal(digest(file), before);
      assert.equal(source.split(mutation.needle).length, 2);
      writeFileSync(
        file,
        source.replace(mutation.needle, mutation.replacement),
      );
      const target = resolve(
        process.env.CARGO_TARGET_DIR ?? "target",
        "parity/flow-control-build",
      );
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
      assert(
        detectedIds.length > 0,
        `${mutation.id} must change observable output`,
      );
      assert.equal(digest(mutation.file), before);
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
      assert.equal(digest(mutation.file), before);
    }
  });
}
export function verifyFlow(
  reportPath = "target/parity/flow.json",
  binaryOverride?: string,
  mutationCheck = false,
) {
  if (!binaryOverride) build();
  const executable = binaryOverride ?? binary(),
    cases = corpus(),
    expected = cases.map((item) => executeFlow(item.script)),
    results = native(cases, executable);
  assert.equal(results.length, cases.length);
  cases.forEach((item, index) => {
    assert.deepEqual(results[index].comparison, expected[index], item.id);
  });
  // Independent source-law witnesses keep a changed reference from silently redefining these contracts.
  const wave =
    expected[
      cases.findIndex((item) => item.id === "flow.fan-out.duplicate-waves")
    ];
  assert.deepEqual(wave[10].commands, [{ type: "join", results: [40] }]);
  const early =
    expected[
      cases.findIndex(
        (item) => item.id === "flow.batch-window.early-window-false",
      )
    ];
  assert.deepEqual(early[3].commands, [
    { type: "flush", items: [{ id: "one", value: 1 }] },
  ]);
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  const report = {
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      rustc: command(rustc, ["--version"]).trim(),
    },
    binary: { path: executable, sha256: digest(executable) },
    compared: cases.length,
    transitions: cases.reduce(
      (sum, item) => sum + item.script.actions.length,
      0,
    ),
    controls: mutationCheck ? controls(cases, expected) : [],
    cases: cases.map((item, index) => ({
      ...item,
      ...results[index],
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
  const report = verifyFlow(
    values.report,
    values["native-binary"],
    values["mutation-check"],
  );
  console.log(
    JSON.stringify({
      compared: report.compared,
      transitions: report.transitions,
      controls: report.controls.map((item) => ({
        id: item.id,
        detected: item.detectedIds.length,
      })),
      report: values.report ?? "target/parity/flow.json",
    }),
  );
}
