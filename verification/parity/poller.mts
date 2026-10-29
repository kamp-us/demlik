import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  createPoller,
  type PollerState,
} from "../../packages/tea/src/flow/index.js";
import {
  type IdempotencyStore,
  initStore,
  remember,
  seen,
} from "../../packages/tea/src/idempotency/index.js";
import type { AnyRetryPolicy } from "../../packages/tea/src/retry-backoff/index.js";
import {
  createCheckWorktree,
  checkedSpawnSync as spawnSync,
} from "./check-worktree.mjs";
import { buildParityBinary } from "./tea-example.mjs";
import { decode, errorValue, normalize, numeric } from "./timing-clock.mts";

const num = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const text = z.union([
  z.string(),
  z.object({ $utf16: z.array(z.number().int().min(0).max(65535)) }).strict(),
]);
const data = z
  .unknown()
  .refine(
    (value) => z.json().safeParse(value).success,
    "expected encoded JSON data",
  );
const curve = z
  .object({
    baseMs: num,
    factor: num,
    capMs: num,
    jitter: z.enum(["none", "full", "equal"]),
  })
  .strict();
const budget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("count"), maxAttempts: num }).strict(),
  z
    .object({
      kind: z.literal("duration"),
      maxElapsedMs: num,
      maxAttempts: num.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("unbounded") }).strict(),
]);
const retry = z.object({ curve, budget }).strict();
const action = z.discriminatedUnion("op", [
  z.object({ op: z.literal("start"), at: num }).strict(),
  z.object({ op: z.enum(["tick", "reset", "roundTrip"]) }).strict(),
  z
    .object({
      op: z.literal("result"),
      value: data,
      at: num,
      untilHeld: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal("error"), error: data, at: num }).strict(),
  z.object({ op: z.literal("restore"), encoded: z.string() }).strict(),
  z.object({ op: z.literal("seen"), key: text, at: num }).strict(),
]);
const memoryAction = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("remember"),
      key: text,
      value: z.boolean(),
      at: num,
    })
    .strict(),
  z.object({ op: z.literal("seen"), key: text, at: num }).strict(),
  z.object({ op: z.literal("roundTrip") }).strict(),
]);
export const pollerScript = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("poller"),
      everyMs: num,
      untilAnswer: z.boolean(),
      dedupe: z.boolean(),
      ttlMs: num.optional(),
      retry: retry.optional(),
      rng: z.array(num).nonempty(),
      actions: z.array(action),
    })
    .strict(),
  z
    .object({
      kind: z.literal("memory"),
      capacity: num.optional(),
      ttlMs: num.optional(),
      actions: z.array(memoryAction),
    })
    .strict(),
]);
type Script = z.infer<typeof pollerScript>;
const n = (value: z.infer<typeof num>) => numeric.parse(value);
function policy(input: z.infer<typeof retry>): AnyRetryPolicy {
  const curve = {
    baseMs: n(input.curve.baseMs),
    factor: n(input.curve.factor),
    capMs: n(input.curve.capMs),
    jitter: input.curve.jitter,
  };
  switch (input.budget.kind) {
    case "count":
      return { ...curve, maxAttempts: n(input.budget.maxAttempts) };
    case "duration":
      return {
        ...curve,
        maxElapsedMs: n(input.budget.maxElapsedMs),
        ...(input.budget.maxAttempts === undefined
          ? {}
          : { maxAttempts: n(input.budget.maxAttempts) }),
      };
    case "unbounded":
      return { ...curve, unbounded: true };
  }
}
function memoryValues(store: IdempotencyStore<boolean>) {
  return {
    entries: normalize(store.entries),
    order: normalize(store.order),
    capacity: normalize(store.capacity),
    ttlMs: normalize(store.ttlMs),
  };
}
const restoredStore = z
  .object({
    entries: z.unknown(),
    order: z.array(z.string()),
    capacity: z.number().nullable().optional(),
    ttlMs: z.number().nullable().optional(),
  })
  .passthrough();
const restoredCore = {
  tick: z.number().nullable(),
  lastResult: z.unknown().optional(),
  retry: z
    .object({
      attempt: z.number().nullable(),
      lastError: z.unknown().optional(),
      firstFailureAtMs: z.number().nullable().optional(),
    })
    .passthrough(),
  dedupe: restoredStore,
};
const restoredPoller = z.discriminatedUnion("phase", [
  z
    .object({
      phase: z.literal("polling"),
      ...restoredCore,
      nextAtMs: z.number().nullable(),
    })
    .passthrough(),
  z
    .object({ phase: z.enum(["done", "gave_up"]), ...restoredCore })
    .passthrough(),
]);
function restorePoller(
  encoded: string,
  previous: PollerState<unknown>,
): PollerState<unknown> {
  const raw: unknown = JSON.parse(encoded);
  restoredPoller.parse(raw);
  const holder = { state: previous };
  Reflect.set(holder, "state", raw);
  return holder.state;
}
function restoreStore(
  encoded: string,
  previous: IdempotencyStore<boolean>,
): IdempotencyStore<boolean> {
  const raw: unknown = JSON.parse(encoded);
  restoredStore.parse(raw);
  const holder = { store: previous };
  Reflect.set(holder, "store", raw);
  return holder.store;
}
export function executePoller(input: unknown): unknown {
  const script = pollerScript.parse(input);
  if (script.kind === "memory") {
    let store = initStore<boolean>({
      capacity: script.capacity === undefined ? undefined : n(script.capacity),
      ttlMs: script.ttlMs === undefined ? undefined : n(script.ttlMs),
    });
    const row = (result: unknown) => ({
      wireState: JSON.parse(JSON.stringify(store)),
      serialized: JSON.stringify(store),
      values: memoryValues(store),
      result,
    });
    const rows = [row(null)];
    for (const action of script.actions) {
      let result: unknown = null;
      switch (action.op) {
        case "remember":
          store = remember(
            store,
            z.string().parse(decode(action.key)),
            action.value,
            n(action.at),
          );
          break;
        case "seen":
          result = seen(
            store,
            z.string().parse(decode(action.key)),
            n(action.at),
          );
          break;
        case "roundTrip":
          store = restoreStore(JSON.stringify(store), store);
          break;
      }
      rows.push(row(result));
    }
    return rows;
  }
  let untilCalls = 0,
    onTickCalls = 0,
    rngCalls = 0,
    keyCalls = 0;
  const keyInputs: unknown[] = [];
  const config = {
    everyMs: n(script.everyMs),
    until: (_: unknown) => {
      untilCalls++;
      return script.untilAnswer;
    },
    onTick: () => ({ type: "fetch_status", serial: ++onTickCalls }),
    ...(script.retry ? { retry: policy(script.retry) } : {}),
    ...(script.ttlMs === undefined ? {} : { dedupeTtlMs: n(script.ttlMs) }),
    ...(script.dedupe
      ? {
          dedupeKey: (result: unknown) => {
            keyCalls++;
            keyInputs.push(normalize(result));
            return typeof result === "string" ? result : "other";
          },
        }
      : {}),
  };
  const poller = createPoller<unknown, unknown>(config, () => {
    const index = rngCalls++;
    return n(script.rng[Math.min(index, script.rng.length - 1)]);
  });
  let state: PollerState<unknown> = poller.init();
  const row = (
    commands: readonly unknown[],
    sameState: boolean | null,
    priorUnchanged: boolean,
    query: unknown,
    error: unknown,
  ) =>
    normalize({
      wireState: JSON.parse(JSON.stringify(state)),
      serialized: JSON.stringify(state),
      phase: state.phase,
      tick: state.tick,
      target: state.phase === "polling" ? state.nextAtMs : undefined,
      lastResult: state.lastResult,
      lastResultPresent: Object.hasOwn(state, "lastResult"),
      retry: {
        attempt: state.retry.attempt,
        lastError: state.retry.lastError,
        lastErrorPresent: Object.hasOwn(state.retry, "lastError"),
        firstFailureAtMs: Reflect.get(state.retry, "firstFailureAtMs"),
        originPresent: Object.hasOwn(state.retry, "firstFailureAtMs"),
      },
      dedupe: memoryValues(state.dedupe),
      commands,
      subs: poller.subs(state),
      sameState,
      priorUnchanged,
      untilCalls,
      onTickCalls,
      rngCalls,
      keyCalls,
      keyInputs,
      query,
      error,
    });
  const rows = [row([], null, true, null, null)];
  for (const action of script.actions) {
    const previous = state,
      before = JSON.stringify(state);
    let commands: readonly unknown[] = [],
      query: unknown = null,
      error: unknown = null;
    try {
      switch (action.op) {
        case "start":
          [state, commands] = poller.start(state, n(action.at));
          break;
        case "tick":
          [state, commands] = poller.tick(state);
          break;
        case "result":
          [state, commands] = poller.tickResult(
            state,
            decode(action.value),
            n(action.at),
            action.untilHeld,
          );
          break;
        case "error":
          [state, commands] = poller.tickErr(
            state,
            decode(action.error),
            n(action.at),
          );
          break;
        case "reset":
          state = poller.init();
          break;
        case "roundTrip":
          state = restorePoller(JSON.stringify(state), state);
          break;
        case "restore":
          state = restorePoller(action.encoded, state);
          break;
        case "seen":
          query = seen(
            state.dedupe,
            z.string().parse(decode(action.key)),
            n(action.at),
          );
          break;
      }
    } catch (cause) {
      error = errorValue(cause);
    }
    rows.push(
      row(
        commands,
        state === previous,
        before === JSON.stringify(previous),
        query,
        error,
      ),
    );
  }
  return rows;
}
type Case = { id: string; script: Script };
function corpus(): Case[] {
  const cases: Case[] = [];
  const add = (id: string, script: unknown) =>
    cases.push({ id, script: pollerScript.parse(script) });
  const base = {
    kind: "poller",
    everyMs: 1000,
    untilAnswer: true,
    dedupe: false,
    rng: [0.5],
  };
  add("poller.cadence-until-override-and-terminal-restarts", {
    ...base,
    actions: [
      { op: "start", at: 0 },
      { op: "tick" },
      {
        op: "result",
        value: { status: "pending" },
        at: 1000,
        untilHeld: false,
      },
      { op: "tick" },
      { op: "result", value: { status: "ready" }, at: 2000, untilHeld: true },
      { op: "tick" },
      { op: "start", at: 3000 },
      { op: "result", value: { $undefined: true }, at: 3100, untilHeld: true },
      { op: "result", value: null, at: 3200, untilHeld: false },
      { op: "roundTrip" },
      { op: "error", error: null, at: 4000 },
    ],
  });
  add("poller.dedupe-touches-and-half-open-expiry", {
    ...base,
    dedupe: true,
    ttlMs: 10,
    actions: [
      { op: "result", value: "v", at: 0, untilHeld: false },
      { op: "result", value: "v", at: 9, untilHeld: false },
      { op: "result", value: "v", at: 10, untilHeld: false },
      { op: "result", value: "v", at: 20, untilHeld: false },
      { op: "result", value: "v2", at: 21, untilHeld: false },
      { op: "result", value: "ready", at: 22, untilHeld: true },
    ],
  });
  add("poller.nan-entry-json-null-cold-ttl", {
    ...base,
    dedupe: true,
    ttlMs: 10,
    actions: [
      { op: "result", value: "k", at: { $number: "NaN" }, untilHeld: false },
      { op: "roundTrip" },
      { op: "seen", key: "k", at: 0 },
      { op: "seen", key: "k", at: 10 },
      { op: "result", value: "k", at: 0, untilHeld: false },
    ],
  });
  add("poller.nan-ttl-json-null-cold-expiry", {
    ...base,
    dedupe: true,
    ttlMs: { $number: "NaN" },
    actions: [
      { op: "result", value: "k", at: 0, untilHeld: false },
      { op: "seen", key: "k", at: 0 },
      { op: "roundTrip" },
      { op: "seen", key: "k", at: 0 },
      { op: "result", value: "k", at: 0, untilHeld: false },
    ],
  });
  for (const key of [
    "toString",
    "__proto__",
    "constructor",
    "valueOf",
    { $utf16: [0xd800] },
  ])
    add(`poller.prototype-and-text-${JSON.stringify(key)}`, {
      ...base,
      dedupe: true,
      ttlMs: 10,
      actions: [
        { op: "result", value: key, at: 0, untilHeld: false },
        { op: "seen", key, at: 0 },
        { op: "result", value: key, at: 10, untilHeld: false },
        { op: "roundTrip" },
        { op: "seen", key, at: 10 },
        { op: "result", value: key, at: 20, untilHeld: false },
      ],
    });
  const curve = { baseMs: 100, factor: 2, capMs: 10000, jitter: "none" };
  for (const budget of [
    { kind: "count", maxAttempts: 3 },
    { kind: "duration", maxElapsedMs: 50 },
    { kind: "duration", maxElapsedMs: 50, maxAttempts: 2 },
    { kind: "unbounded" },
  ])
    add(`poller.budget-${JSON.stringify(budget)}`, {
      ...base,
      retry: { curve, budget },
      actions: [
        { op: "error", error: "first", at: 0 },
        { op: "error", error: { $undefined: true }, at: 49 },
        { op: "error", error: null, at: 50 },
        { op: "start", at: 1000 },
        { op: "error", error: "late", at: 1050 },
        { op: "result", value: { ok: true }, at: 1100, untilHeld: false },
        { op: "error", error: { $utf16: [0xd800] }, at: 1200 },
        { op: "roundTrip" },
      ],
    });
  for (const value of [
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
    { $number: "-0" },
    -1,
    0,
    0.25,
  ])
    add(`poller.numeric-${JSON.stringify(value)}`, {
      ...base,
      everyMs: value,
      dedupe: true,
      ttlMs: value,
      retry: {
        curve: { baseMs: value, factor: -1, capMs: value, jitter: "full" },
        budget: { kind: "unbounded" },
      },
      rng: [value],
      actions: [
        { op: "start", at: value },
        { op: "tick" },
        {
          op: "result",
          value: {
            $object: [
              [{ $utf16: [0xd800] }, { $undefined: true }],
              ["__proto__", true],
            ],
          },
          at: value,
          untilHeld: false,
        },
        { op: "error", error: value, at: value },
        { op: "roundTrip" },
        { op: "seen", key: "other", at: 0 },
        { op: "error", error: "cold", at: 10 },
        { op: "reset" },
      ],
    });
  add("poller.restored-null-counter-origin", {
    ...base,
    retry: { curve, budget: { kind: "duration", maxElapsedMs: 20 } },
    actions: [
      {
        op: "restore",
        encoded:
          '{"phase":"gave_up","tick":null,"retry":{"attempt":null,"firstFailureAtMs":null},"dedupe":{"entries":{},"order":[]}}',
      },
      { op: "error", error: null, at: 100 },
      { op: "roundTrip" },
      { op: "result", value: null, at: 120, untilHeld: true },
      { op: "error", error: { $undefined: true }, at: 200 },
    ],
  });
  for (const { options, at } of [
    { options: { ttlMs: 10 }, at: { $number: "NaN" } },
    { options: { ttlMs: { $number: "NaN" } }, at: 0 },
    { options: { capacity: { $number: "Infinity" } }, at: 0 },
    { options: {}, at: 0 },
  ])
    add(`idempotency.cold-${JSON.stringify(options)}`, {
      kind: "memory",
      ...options,
      actions: [
        {
          op: "remember",
          key: "k",
          value: true,
          at,
        },
        { op: "roundTrip" },
        { op: "seen", key: "k", at: 0 },
        { op: "seen", key: "k", at: 10 },
        { op: "remember", key: "j", value: false, at: 1 },
        { op: "roundTrip" },
      ],
    });
  for (let run = 0; run < 32; run++) {
    const actions: unknown[] = [{ op: "start", at: 0 }];
    for (let step = 0; step < 10; step++) {
      const at = step * (1 + (run % 4));
      if (step % 3 === 0) actions.push({ op: "tick" });
      if ((run + step) % 4 === 0)
        actions.push({ op: "error", error: { run, step }, at });
      else
        actions.push({
          op: "result",
          value: step % 2 === 0 ? "same" : `v${step % 3}`,
          at,
          untilHeld: step === 7,
        });
      if (step % 4 === 2) actions.push({ op: "roundTrip" });
    }
    add(`poller.generated-${run}`, {
      ...base,
      dedupe: run % 2 === 0,
      ttlMs: run % 5,
      everyMs: 1 + (run % 3),
      retry: {
        curve: {
          baseMs: 1 + (run % 3),
          factor: 2,
          capMs: 7,
          jitter: ["none", "full", "equal"][run % 3],
        },
        budget:
          run % 3 === 0
            ? { kind: "duration", maxElapsedMs: 10 }
            : run % 3 === 1
              ? { kind: "count", maxAttempts: 3 }
              : { kind: "unbounded" },
      },
      actions,
    });
  }
  return cases;
}
function command(
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
      `${executable} exited ${result.status}\n${result.stderr.slice(-10000)}`,
    );
  return result.stdout;
}
function binary(cwd = process.cwd(), target = process.env.CARGO_TARGET_DIR) {
  return join(
    target ? resolve(cwd, target) : join(cwd, "target"),
    "debug/poller_driver",
  );
}
function build(cwd = process.cwd(), target?: string) {
  command(
    process.env.CARGO ?? "cargo",
    ["build", "--locked", "-p", "demlik-parity", "--bin", "poller_driver"],
    undefined,
    cwd,
    {
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      ...(target ? {} : {}),
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
  return command(
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
    id: "poller-fetches-on-ordinary-result",
    file: "crates/tea/src/flow/poller.rs",
    needle: "return Ok(Step::new(Rc::new(next), vec![]));\n        };",
    replacement:
      "return Ok(Step::new(Rc::new(next), vec![(self.config.on_tick)()]));\n        };",
  },
  {
    id: "idempotency-forgets-present-null-bound",
    file: "crates/tea/src/idempotency.rs",
    needle: "IdempotencyNumber::deserialize(deserializer).map(Some)",
    replacement: "Option::<IdempotencyNumber>::deserialize(deserializer)",
  },
  {
    id: "idempotency-null-time-is-nan",
    file: "crates/tea/src/idempotency.rs",
    needle: "self.at_ms.number_or_zero()",
    replacement: "self.at_ms.number().unwrap_or(f64::NAN)",
  },
];
function controls(cases: Case[], expected: unknown[]) {
  return mutations.map((mutation) => {
    const mutationCheck = createCheckWorktree(process.cwd(), "poller");
    let mutationFailure: unknown;
    try {
      const temporary = mutationCheck.root,
        before = digest(mutation.file);
      try {
        const file = join(temporary, mutation.file),
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
        assert.equal(digest(mutation.file), before);
        return {
          id: mutation.id,
          isolation: "registered-worktree-default-target",
          sourceBeforeSha256: before,
          mutantSourceSha256: digest(file),
          nativeBinarySha256: digest(executable),
          activeSourceUnchanged: true,
          detectedIds,
        };
      } finally {
        assert.equal(digest(mutation.file), before);
      }
    } catch (error) {
      mutationFailure = error;
      throw error;
    } finally {
      mutationCheck.remove(mutationFailure);
    }
  });
}
export function verifyPoller(
  reportPath = "target/parity/poller.json",
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
      "poller_driver",
      reportPath,
    );
    executable = binaryOverride ?? producer.binary;
  }
  const cases = corpus(),
    expected = cases.map((item) => executePoller(item.script)),
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
  const row = (id: string, position: number) => {
    const index = cases.findIndex((item) => item.id === id);
    assert(index >= 0);
    return z.array(z.unknown()).parse(expected[index])[position];
  };
  const query = z.object({ query: z.boolean() });
  assert.equal(
    query.parse(row("poller.nan-entry-json-null-cold-ttl", 3)).query,
    true,
  );
  assert.equal(
    query.parse(row("poller.nan-entry-json-null-cold-ttl", 4)).query,
    false,
  );
  assert.equal(
    query.parse(row("poller.nan-ttl-json-null-cold-expiry", 2)).query,
    true,
  );
  assert.equal(
    query.parse(row("poller.nan-ttl-json-null-cold-expiry", 4)).query,
    false,
  );
  const capacity = z
    .object({
      values: z.object({ order: z.array(z.string()), capacity: z.null() }),
    })
    .parse(row('idempotency.cold-{"capacity":{"$number":"Infinity"}}', 5));
  assert.deepEqual(capacity.values.order, []);
  const cadence = z.object({
    phase: z.string(),
    onTickCalls: z.number(),
    untilCalls: z.number(),
  });
  assert.equal(
    cadence.parse(row("poller.cadence-until-override-and-terminal-restarts", 1))
      .onTickCalls,
    0,
  );
  assert.equal(
    cadence.parse(row("poller.cadence-until-override-and-terminal-restarts", 3))
      .onTickCalls,
    1,
  );
  assert.equal(
    cadence.parse(row("poller.cadence-until-override-and-terminal-restarts", 7))
      .phase,
    "polling",
  );
  for (const [index, item] of cases.entries()) {
    if (item.script.kind !== "poller") continue;
    for (const result of z.array(z.unknown()).parse(expected[index])) {
      assert.equal(
        z.object({ untilCalls: z.number() }).parse(result).untilCalls,
        0,
        item.id,
      );
    }
  }
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  const report = {
    producer,
    scope:
      "native poller and idempotency cold restore; full port remains incomplete",
    passed: cases.length - failures.length,
    failures,
    comparison:
      "canonical JSON wire plus lossless field values, presence and transitions",
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
  const report = verifyPoller(
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
      report: values.report ?? "target/parity/poller.json",
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
