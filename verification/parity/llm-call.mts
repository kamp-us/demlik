import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Effect, Exit, Scope } from "effect";
import { z } from "zod";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import {
  createLlmCall,
  type LlmFailMsg,
  type LlmRunCmd,
  type LlmSucceedMsg,
  liftLlmCall,
  type Schema,
} from "../../packages/tea/src/internal/llm-call/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import {
  cmdContractOver,
  type Machine,
  type Sub,
} from "../../packages/tea/src/pure/core.ts";
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
const data = z.json();
const mode = z.enum(["plan", "report", "pass", "reject"]);
const cause = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: data }).strict(),
  z.object({ kind: z.literal("error"), message: text }).strict(),
  z.object({ kind: z.literal("undefined") }).strict(),
]);
const action = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("attempt"),
      purpose: text,
      model: text.nullable(),
      payload: data,
      at: num,
      key: text.optional(),
      slot: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.literal("decode"),
      slot: z.string(),
      raw: data,
      at: num,
      apply: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("reject"),
      slot: z.string(),
      cause,
      field: z.enum(["own", "missing", "inherited"]),
      at: num,
      apply: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.enum([
        "errOf",
        "fail",
        "succeed",
        "roundTrip",
        "roundTripMsg",
        "lift",
      ]),
    })
    .strict(),
  z.object({ op: z.literal("mutateCause"), message: text }).strict(),
  z.object({ op: z.literal("fireNext"), slot: z.string() }).strict(),
  z
    .object({ op: z.literal("timer"), id: text, at: num, slot: z.string() })
    .strict(),
  z.object({ op: z.literal("schema"), purpose: text, mode }).strict(),
  z.object({ op: z.literal("schemaOf"), purpose: text }).strict(),
  z.object({ op: z.literal("restore"), encoded: z.string() }).strict(),
]);
const retry = z
  .object({
    baseMs: num,
    factor: num,
    capMs: num,
    jitter: z.enum(["none", "full", "equal"]),
    maxAttempts: num,
  })
  .strict();
export const llmScript = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("pure"),
      retry: retry.optional(),
      rng: z.array(num).nonempty(),
      actions: z.array(action),
    })
    .strict(),
  z
    .object({
      kind: z.literal("runtime"),
      profile: z.enum(["promise", "effect"]),
      mode: z.enum(["success", "provider", "schema"]),
    })
    .strict(),
]);
type Script = z.infer<typeof llmScript>;
type Outputs = Record<string, unknown>;
type Msg = LlmFailMsg<string> | LlmSucceedMsg<string, Outputs>;
function string(value: z.infer<typeof text>): string {
  const decoded = decode(value);
  assert.equal(typeof decoded, "string");
  return String(decoded);
}
function settled(value: unknown): asserts value is Msg {
  z.object({
    type: z.enum(["resilient_run_ok", "resilient_run_err"]),
    cmd: z.object({
      key: z.string(),
      input: z.object({ purpose: z.string() }),
    }),
    at: z.custom<number>((value) => typeof value === "number"),
  }).parse(value);
  assert(
    value !== null &&
      typeof value === "object" &&
      ("value" in value || "error" in value),
  );
}
function pure(script: Extract<Script, { kind: "pure" }>) {
  let parseCalls = 0,
    rngCalls = 0;
  const failure = new Error("schema rejected");
  const parser = (kind: z.infer<typeof mode>): Schema<unknown> => ({
    parse(raw) {
      parseCalls++;
      if (kind === "pass") return raw;
      if (kind === "plan") {
        const parsed = z.object({ steps: z.array(z.string()) }).safeParse(raw);
        if (parsed.success) return parsed.data;
      }
      if (kind === "report") {
        const parsed = z.object({ summary: z.string() }).safeParse(raw);
        if (parsed.success) return parsed.data;
      }
      throw failure;
    },
  });
  const schemas: Record<string, Schema<unknown>> = {
    plan: parser("plan"),
    report: parser("report"),
  };
  const r = script.retry;
  const knob = createLlmCall<string, Outputs>(
    {
      schemas,
      ...(r
        ? {
            retry: {
              baseMs: numeric.parse(r.baseMs),
              factor: numeric.parse(r.factor),
              capMs: numeric.parse(r.capMs),
              jitter: r.jitter,
              maxAttempts: numeric.parse(r.maxAttempts),
            },
          }
        : {}),
    },
    () =>
      numeric.parse(script.rng[Math.min(rngCalls++, script.rng.length - 1)]),
  );
  let state = knob.init(),
    last: Msg | undefined,
    expected: unknown;
  const slots = new Map<string, LlmRunCmd<string>>(),
    history: unknown[] = [];
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
  for (const action of script.actions) {
    const previous = state,
      before = JSON.stringify(state);
    let cmds: readonly LlmRunCmd<string>[] = [],
      response: unknown = null,
      error: unknown = null;
    const save = (slot: string) => {
      if (cmds[0]) slots.set(slot, cmds[0]);
    };
    const apply = () => {
      assert(last);
      [state, cmds] =
        "value" in last ? knob.succeed(state, last) : knob.fail(state, last);
    };
    try {
      switch (action.op) {
        case "attempt":
          [state, cmds] = knob.attempt(
            state,
            {
              purpose: string(action.purpose),
              model: action.model === null ? null : string(action.model),
              payload: decode(action.payload),
            },
            numeric.parse(action.at),
            action.key === undefined ? undefined : string(action.key),
          );
          save(action.slot);
          break;
        case "decode": {
          const cmd = slots.get(action.slot);
          assert(cmd);
          const outcome = knob.decode(cmd, decode(action.raw));
          expected = outcome._tag === "Err" ? failure : undefined;
          response = outcome;
          const msg = cmdContractOver([knob.run], () =>
            numeric.parse(action.at),
          ).settle(cmd, outcome);
          settled(msg);
          last = msg;
          if (action.apply) apply();
          break;
        }
        case "reject": {
          const cmd = slots.get(action.slot);
          assert(cmd);
          const value =
            action.cause.kind === "undefined"
              ? undefined
              : action.cause.kind === "error"
                ? new Error(string(action.cause.message))
                : decode(action.cause.value);
          expected = action.field === "missing" ? undefined : value;
          const outcome = knob.rejected(value);
          if (outcome._tag !== "Err") throw Error("rejection");
          if (action.field === "missing")
            Reflect.deleteProperty(outcome.error, "cause");
          if (action.field === "inherited") {
            Reflect.deleteProperty(outcome.error, "cause");
            Object.setPrototypeOf(outcome.error, { cause: value });
          }
          response = {
            hasCause: "cause" in outcome.error,
            ownCause: Object.hasOwn(outcome.error, "cause"),
          };
          const msg = cmdContractOver([knob.run], () =>
            numeric.parse(action.at),
          ).settle(cmd, outcome);
          settled(msg);
          last = msg;
          if (action.apply) apply();
          break;
        }
        case "errOf": {
          assert(last && "error" in last);
          const parsed = knob.errOf(last);
          response = {
            key: parsed.key,
            purpose: parsed.purpose,
            reason: parsed.reason,
            sameCause:
              parsed.error === ("cause" in last.error ? expected : last.error),
            undefined: parsed.error === undefined,
          };
          break;
        }
        case "fail":
          assert(last && "error" in last);
          [state, cmds] = knob.fail(state, last);
          break;
        case "succeed":
          assert(last && "value" in last);
          [state, cmds] = knob.succeed(state, last);
          break;
        case "mutateCause":
          assert(expected instanceof Error);
          expected.message = string(action.message);
          break;
        case "fireNext": {
          const timer = knob.timer(state);
          if (timer) {
            [state, cmds] = knob.onTimer(state, timer.msg);
            save(action.slot);
          }
          break;
        }
        case "timer":
          [state, cmds] = knob.onTimer(state, {
            type: "deadline_exceeded",
            id: string(action.id),
            atMs: numeric.parse(action.at),
          });
          save(action.slot);
          break;
        case "schema":
          schemas[string(action.purpose)] = parser(action.mode);
          break;
        case "schemaOf":
          response = {
            same:
              knob.schemaOf(string(action.purpose)) ===
              schemas[string(action.purpose)],
          };
          break;
        case "roundTrip":
          state = wire(state);
          break;
        case "roundTripMsg":
          assert(last);
          last = wire(last);
          expected = undefined;
          break;
        case "restore":
          state = JSON.parse(action.encoded);
          break;
        case "lift": {
          const token = {},
            host = { resilience: state, token };
          const [result, commands] = liftLlmCall(host, [state, []]);
          state = result.resilience;
          response = {
            sameToken: result.token === token,
            cmds: commands.length,
          };
          break;
        }
      }
    } catch (cause) {
      error = errorValue(cause);
    }
    history.push(
      normalize({
        storedState: wire(state),
        sameState: state === previous,
        priorUnchanged: JSON.stringify(previous) === before,
        cmds,
        deadlines: knob.deadlines(state),
        timer: knob.timer(state) ?? null,
        response,
        error,
        rngCalls,
        parseCalls,
      }),
    );
  }
  return { name: knob.name, history };
}
async function runtime(script: Extract<Script, { kind: "runtime" }>) {
  const cause = new Error(
      script.mode === "schema" ? "schema rejected" : "provider rejected",
    ),
    context = { token: {} };
  let providerCalls = 0;
  type Plan = { steps: string[] };
  type Report = { summary: string; plan: Plan };
  type O = { plan: Plan; report: Report };
  function assertPlan(raw: unknown): asserts raw is Plan {
    assert(z.object({ steps: z.array(z.string()) }).safeParse(raw).success);
  }
  function assertReport(raw: unknown): asserts raw is Report {
    assert(
      z
        .object({
          summary: z.string(),
          plan: z.object({ steps: z.array(z.string()) }),
        })
        .safeParse(raw).success,
    );
  }
  const schemas = {
    plan: {
      parse(raw: unknown) {
        if (raw === "wrong") throw cause;
        return { steps: ["inspect", "explain"] };
      },
    },
    report: {
      parse(raw: unknown) {
        assertPlan(raw);
        return { summary: `${raw.steps.length} steps verified`, plan: raw };
      },
    },
  };
  const knob = createLlmCall<"plan" | "report", O>({ schemas });
  type M = LlmFailMsg<"plan" | "report"> | LlmSucceedMsg<"plan" | "report", O>;
  type S = {
    resilience: ReturnType<typeof knob.init>;
    context: typeof context;
    events: unknown[];
    done: boolean;
  };
  const update = (
    s: S,
    msg: M,
  ): readonly [S, readonly LlmRunCmd<"plan" | "report">[]] => {
    if ("error" in msg) {
      const error = knob.errOf(msg);
      const [resilience, cmds] = knob.fail(s.resilience, msg);
      return [
        {
          ...s,
          resilience,
          done: true,
          events: [
            ...s.events,
            {
              tag: msg.type,
              purpose: "plan",
              key: "plan",
              reason: error.reason,
              sameCause: error.error === cause,
            },
          ],
        },
        cmds,
      ];
    }
    const [resilience, cmds] = knob.succeed(s.resilience, msg);
    if (msg.value.purpose === "plan") {
      const parsed = msg.value.output;
      assertPlan(parsed);
      const [next, commands] = knob.attempt(
        resilience,
        { purpose: "report", model: "local", payload: parsed },
        101,
      );
      return [
        {
          ...s,
          resilience: next,
          events: [
            ...s.events,
            {
              tag: msg.type,
              purpose: "plan",
              key: "plan",
              steps: parsed.steps,
              token: true,
            },
          ],
        },
        commands,
      ];
    }
    const parsed = msg.value.output;
    assertReport(parsed);
    return [
      {
        ...s,
        resilience,
        done: true,
        events: [
          ...s.events,
          {
            tag: msg.type,
            purpose: "report",
            key: "report",
            summary: parsed.summary,
            samePlan:
              s.resilience.calls.plan?.phase === "succeeded" &&
              s.resilience.calls.plan.result.output === parsed.plan,
          },
        ],
      },
      cmds,
    ];
  };
  const machine: Machine<
    S,
    M,
    LlmRunCmd<"plan" | "report">,
    Sub<never>,
    undefined
  > = {
    cmds: [knob.run],
    init: () => {
      const [resilience, cmds] = knob.attempt(
        knob.init(),
        { purpose: "plan", model: null, payload: "explain a local port" },
        100,
      );
      return [{ resilience, context, events: [], done: false }, cmds];
    },
    update: { resilient_run_ok: update, resilient_run_err: update },
  };
  const handle = (cmd: LlmRunCmd<"plan" | "report">) => {
    providerCalls++;
    if (script.mode === "provider") return knob.rejected(cause);
    return knob.decode(
      cmd,
      cmd.input.purpose === "plan"
        ? script.mode === "schema"
          ? "wrong"
          : "plan"
        : cmd.input.payload,
    );
  };
  const options = {
    ctx: undefined,
    clock: () => 100,
    terminal: (s: S) => s.done,
  };
  let result: S;
  if (script.profile === "promise") {
    const h = runPromise(machine, {
      ...options,
      interpret: { resilient_run: async (cmd) => handle(cmd) },
    });
    const r = await h.ready;
    result = await r.done();
    await r.stop();
  } else {
    const scope = await Effect.runPromise(Scope.make());
    const h = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(machine, {
          ...options,
          interpret: {
            resilient_run: (cmd) =>
              Effect.flatMap(
                Effect.sync(() => handle(cmd)),
                (outcome) =>
                  outcome._tag === "Ok"
                    ? Effect.succeed(outcome.value)
                    : Effect.fail(outcome.error),
              ),
          },
        }),
      ),
    );
    const r = await Effect.runPromise(h.ready);
    result = await Effect.runPromise(r.done());
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  return {
    events: result.events,
    providerCalls,
    sameContext: result.context === context,
    done: result.done,
  };
}
export async function execute(script: Script) {
  return script.kind === "pure" ? pure(script) : runtime(script);
}

function restoredTimestampCases() {
  return ["Infinity", "NaN", "-Infinity"].map((value) => ({
    id: `llm.restored-stamp.${value}`,
    input: llmScript.parse({
      kind: "pure",
      rng: [0.5],
      actions: [
        {
          op: "attempt",
          purpose: "plan",
          model: null,
          payload: "prompt",
          at: 0,
          slot: "a",
        },
        { op: "schema", purpose: "plan", mode: "pass" },
        {
          op: "decode",
          slot: "a",
          raw: "parsed",
          at: { $number: value },
          apply: false,
        },
        { op: "roundTripMsg" },
        { op: "succeed" },
      ],
    }),
  }));
}

export function corpus() {
  const cases: { id: string; input: Script }[] = [];
  const add = (id: string, input: unknown) =>
    cases.push({ id, input: llmScript.parse(input) });
  const attempt = (slot = "a", purpose = "plan", key?: string) => ({
    op: "attempt",
    purpose,
    model: null,
    payload: { prompt: slot },
    at: 0,
    slot,
    ...(key === undefined ? {} : { key }),
  });
  const reject = (
    field = "own",
    cause: unknown = { kind: "error", message: "provider rejected" },
    apply = true,
    slot = "a",
    at: unknown = 1,
  ) => ({ op: "reject", slot, cause, field, at, apply });
  const plan = { steps: ["inspect", "explain"], extra: "strip" };
  const decodeAction = (raw: unknown = plan, slot = "a", at = 1) => ({
    op: "decode",
    slot,
    raw,
    at,
    apply: true,
  });
  const base = (actions: unknown[], extra: object = {}) => ({
    kind: "pure",
    rng: [0.5],
    actions,
    ...extra,
  });
  add(
    "llm.two-purpose",
    base([
      attempt(),
      decodeAction(),
      attempt("b", "report"),
      decodeAction({ summary: "done", extra: 2 }, "b"),
      { op: "lift" },
    ]),
  );
  for (const key of [
    undefined,
    "fanout:1",
    "",
    "__proto__",
    "toString",
    "0",
    "constructor",
    "a:b",
  ]) {
    add(
      `llm.key.${key ?? "default"}`,
      base([attempt("a", "plan", key), decodeAction(), { op: "roundTrip" }]),
    );
  }
  for (const value of [
    null,
    false,
    0,
    "plain",
    { message: "not an Error" },
    { $undefined: true },
    { $number: "NaN" },
    { $number: "Infinity" },
    { $utf16: [0xd800] },
    [],
    { toString: null },
  ]) {
    add(
      `llm.cause.${cases.length}`,
      base([
        attempt(),
        reject("own", { kind: "value", value }, false),
        { op: "errOf" },
        { op: "fail" },
      ]),
    );
  }
  for (const field of ["own", "missing", "inherited"]) {
    for (const cause of [
      { kind: "undefined" },
      { kind: "error", message: "raw cause" },
      { kind: "value", value: null },
    ])
      add(
        `llm.presence.${field}.${cause.kind}`,
        base([
          attempt(),
          reject(field, cause, false),
          { op: "errOf" },
          { op: "fail" },
          { op: "roundTrip" },
        ]),
      );
  }
  for (const field of ["own", "missing", "inherited"]) {
    add(
      `llm.message-restore.${field}`,
      base([
        attempt(),
        reject(field, { kind: "undefined" }, false),
        { op: "roundTripMsg" },
        { op: "errOf" },
        { op: "fail" },
        { op: "roundTrip" },
      ]),
    );
  }
  add(
    "llm.coercion-before-retry",
    base(
      [
        attempt(),
        reject(
          "own",
          { kind: "value", value: { toString: null } },
          false,
          "a",
          40,
        ),
        { op: "errOf" },
        { op: "fail" },
      ],
      {
        retry: {
          baseMs: 10,
          factor: 2,
          capMs: 50,
          jitter: "full",
          maxAttempts: 3,
        },
      },
    ),
  );
  add(
    "llm.mutable-error",
    base([
      attempt(),
      reject(),
      { op: "mutateCause", message: "after" },
      { op: "errOf" },
    ]),
  );
  add(
    "llm.schema-live",
    base([
      attempt(),
      { op: "schemaOf", purpose: "plan" },
      { op: "schema", purpose: "plan", mode: "pass" },
      { op: "schemaOf", purpose: "plan" },
      decodeAction({ unknown: true }),
    ]),
  );
  for (const raw of [
    null,
    false,
    {},
    { $undefined: true },
    { steps: [4] },
    { summary: "wrong purpose" },
  ])
    add(
      `llm.schema-reject.${cases.length}`,
      base([
        attempt(),
        decodeAction(raw),
        { op: "errOf" },
        { op: "roundTrip" },
      ]),
    );
  add(
    "llm.undefined-output",
    base([
      { op: "schema", purpose: "plan", mode: "pass" },
      attempt(),
      decodeAction({ $undefined: true }),
      { op: "roundTrip" },
    ]),
  );
  add(
    "llm.stale-success",
    base([
      attempt("a"),
      attempt("b"),
      decodeAction(plan, "a"),
      decodeAction({ steps: ["new"] }, "b"),
    ]),
  );
  add(
    "llm.stale-purpose",
    base([
      attempt("a", "plan", "shared"),
      attempt("b", "report", "shared"),
      reject("own", { kind: "error", message: "old plan" }),
      { op: "errOf" },
    ]),
  );
  for (const jitter of ["none", "full", "equal"]) {
    for (const maxAttempts of [1, 2, 3]) {
      const actions: unknown[] = [attempt()];
      for (let n = 0; n < maxAttempts + 1; n++) {
        actions.push(
          reject(
            "own",
            { kind: "error", message: `failure${n}` },
            true,
            n === 0 ? "a" : `r${n - 1}`,
            n + 1,
          ),
        );
        actions.push({ op: "fireNext", slot: `r${n}` });
        if (n >= maxAttempts - 1) break;
      }
      actions.push({ op: "roundTrip" }, { op: "lift" });
      add(
        `llm.retry.${jitter}.${maxAttempts}`,
        base(actions, {
          retry: { baseMs: 10, factor: 2, capMs: 50, jitter, maxAttempts },
        }),
      );
    }
  }
  add(
    "llm.retry-recover",
    base(
      [
        attempt(),
        reject(),
        { op: "roundTrip" },
        { op: "fireNext", slot: "b" },
        decodeAction(plan, "b", 20),
        { op: "fireNext", slot: "unused" },
      ],
      {
        retry: {
          baseMs: 10,
          factor: 2,
          capMs: 50,
          jitter: "none",
          maxAttempts: 3,
        },
      },
    ),
  );
  add(
    "llm.stale-retry-input",
    base(
      [
        attempt("a", "plan", "shared"),
        attempt("b", "report", "shared"),
        reject(),
        { op: "fireNext", slot: "c" },
        decodeAction({ summary: "current input" }, "c", 20),
      ],
      {
        retry: {
          baseMs: 10,
          factor: 2,
          capMs: 50,
          jitter: "none",
          maxAttempts: 2,
        },
      },
    ),
  );
  for (const id of [
    "other",
    "resilient:deadline:plan",
    "resilient:retry:plan",
  ]) {
    add(
      `llm.timer.${id}`,
      base([
        attempt(),
        { op: "timer", id, at: 4, slot: "timer" },
        { op: "timer", id, at: 6, slot: "again" },
      ]),
    );
  }
  for (const at of [
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
    { $number: "-0" },
  ])
    add(
      `llm.clock.${cases.length}`,
      base(
        [
          { ...attempt(), at },
          reject(),
          { op: "roundTrip" },
          { op: "fireNext", slot: "r" },
        ],
        {
          retry: {
            baseMs: 1,
            factor: 2,
            capMs: 4,
            jitter: "full",
            maxAttempts: 2,
          },
        },
      ),
    );
  const restored = {
    circuit: { phase: "closed", failures: 0 },
    bucket: { tokens: 1, capacity: 1, refillPerSec: 1, lastRefillMs: 0 },
    retry: {},
    cache: { entries: {} },
    calls: {},
    clockMs: 0,
  };
  for (const payload of [undefined, null]) {
    const state = {
      ...restored,
      calls: {
        plan: {
          phase: "waiting_retry",
          input: {
            purpose: "plan",
            model: null,
            ...(payload === undefined ? {} : { payload }),
          },
          retryAtMs: null,
          budget: { remainingMs: null, chargingSinceMs: null },
        },
      },
    };
    add(
      `llm.restore.payload.${payload === undefined ? "missing" : "null"}`,
      base([
        { op: "restore", encoded: JSON.stringify(state) },
        { op: "fireNext", slot: "a" },
        decodeAction(),
        { op: "roundTrip" },
      ]),
    );
  }
  for (const output of [undefined, null]) {
    const state = {
      ...restored,
      calls: {
        plan: {
          phase: "succeeded",
          result: {
            key: "plan",
            purpose: "plan",
            ...(output === undefined ? {} : { output }),
          },
        },
      },
    };
    add(
      `llm.restore.output.${output === undefined ? "missing" : "null"}`,
      base([
        { op: "restore", encoded: JSON.stringify(state) },
        { op: "roundTrip" },
        { op: "lift" },
      ]),
    );
  }
  add(
    "llm.error.utf16",
    base([
      attempt(),
      reject(
        "own",
        { kind: "error", message: { $utf16: [0xd800, 97] } },
        false,
      ),
      { op: "errOf" },
      { op: "fail" },
    ]),
  );
  add(
    "llm.rng.draws",
    base(
      [
        attempt(),
        reject(),
        { op: "fireNext", slot: "b" },
        reject("own", { kind: "error", message: "again" }, true, "b", 20),
        { op: "fireNext", slot: "c" },
        decodeAction(plan, "c", 50),
      ],
      {
        rng: [0, 1, 0.25],
        retry: {
          baseMs: 10,
          factor: 2,
          capMs: 50,
          jitter: "full",
          maxAttempts: 3,
        },
      },
    ),
  );
  for (let seed = 0; seed < 8; seed++) {
    const actions: unknown[] = [];
    let value = seed + 1;
    for (let n = 0; n < 6; n++) {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      const purpose = value % 2 ? "plan" : "report",
        slot = `s${n}`,
        key = `${purpose}:${value % 3}`;
      actions.push({ ...attempt(slot, purpose, key), at: n * 10 });
      const valid = purpose === "plan" ? plan : { summary: `report ${n}` };
      actions.push(
        decodeAction(value % 4 === 0 ? false : valid, slot, n * 10 + 1),
      );
      if (value % 4 === 0) actions.push({ op: "errOf" });
      if (n % 2 === 0) actions.push({ op: "roundTrip" });
    }
    add(`llm.sequence.${seed}`, base(actions));
  }
  for (const profile of ["promise", "effect"])
    for (const mode of ["success", "provider", "schema"])
      add(`llm.runtime.${profile}.${mode}`, { kind: "runtime", profile, mode });
  cases.push(...restoredTimestampCases());
  for (const value of ["Infinity", "NaN", "-Infinity"]) {
    const first = [
      attempt(),
      reject("own", { kind: "value", value: "provider error" }, false, "a", {
        $number: value,
      }),
      { op: "roundTripMsg" },
      { op: "fail" },
    ];
    add(`llm.restored-error.${value}`, base([...first, { op: "roundTrip" }]));
    add(
      `llm.restored-retry.${value}`,
      base(
        [
          ...first,
          { op: "fireNext", slot: "b" },
          { ...decodeAction(plan, "b"), at: { $number: value }, apply: false },
          { op: "roundTripMsg" },
          { op: "succeed" },
        ],
        {
          retry: {
            baseMs: 1,
            factor: 2,
            capMs: 4,
            jitter: "none",
            maxAttempts: 2,
          },
        },
      ),
    );
  }
  return cases;
}

export async function llmCallParity(
  options: {
    binary?: string;
    reportFile?: string;
    cargo?: string;
    caseIds?: readonly string[];
  } = {},
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const root = resolve(dirname(new URL(import.meta.url).pathname), "../.."),
    cargo = options.cargo ?? process.env.CARGO ?? "cargo",
    reportFile =
      options.reportFile ?? join(root, "target/parity/llm-call.json");
  let producer: ReturnType<typeof buildParityBinary> | null = null;
  let binary: string;
  if (options.binary) {
    binary = options.binary;
  } else {
    producer = buildParityBinary(cargo, "llm_call_driver", reportFile);
    binary = options.binary ?? producer.binary;
  }
  const allCases = corpus();
  const cases = options.caseIds
    ? allCases.filter((test) => options.caseIds?.includes(test.id))
    : allCases;
  if (options.caseIds) assert.equal(cases.length, options.caseIds.length);
  assert(cases.length > 0);
  const comparedCases = cases;
  const input = `${comparedCases.map((test) => JSON.stringify(test)).join("\n")}\n`;
  const run = spawnSync(binary, [], {
    cwd: root,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const native = run.stdout
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({
          id: z.string(),
          output: z.object({ value: z.unknown(), calls: z.array(z.string()) }),
        })
        .parse(JSON.parse(line)),
    );
  assert.equal(native.length, comparedCases.length);
  const comparedResults: {
    id: string;
    equal: boolean;
    actions: number;
    reference: unknown;
    rust: unknown;
    publicCalls: string[];
  }[] = [];
  for (let i = 0; i < comparedCases.length; i++) {
    const test = comparedCases[i];
    const reference = await execute(test.input);
    assert.equal(native[i].id, test.id);
    const rust = native[i].output;
    let equal = true;
    try {
      assert.deepEqual(rust.value, reference);
    } catch {
      equal = false;
    }
    comparedResults.push({
      id: test.id,
      equal,
      actions: test.input.kind === "pure" ? test.input.actions.length : 1,
      reference,
      rust: rust.value,
      publicCalls: rust.calls,
    });
  }
  const results = comparedResults,
    timestampProbes = comparedResults.filter((result) =>
      result.id.startsWith("llm.restored-"),
    );
  const mismatches = results.filter((result) => !result.equal);
  const sourceFiles = [
    "packages/tea/src/internal/llm-call/index.ts",
    "packages/tea/src/describe-error.ts",
    "crates/tea/src/llm_call.rs",
    "crates/tea/src/llm_call/wire.rs",
    "crates/tea/src/describe_error.rs",
    "crates/tea/src/command.rs",
    "crates/tea/src/data.rs",
    "crates/tea/src/data/number.rs",
    "crates/tea/src/work_queue/mod.rs",
    "crates/tea/src/resilience/resilient_call/mod.rs",
    "crates/tea/src/resilience/resilient_call/model.rs",
    "crates/tea/examples/llm_structured/consumer.rs",
    "crates/parity/src/bin/llm_call_driver.rs",
    "verification/parity/llm-call.mts",
  ];
  const hash = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  const capabilities = [
    ["createLlmCall", "LlmCall::new"],
    ["init", "LlmCall::init"],
    ["attempt", "LlmCall::attempt"],
    ["attempt(key)", "LlmCall::attempt_keyed"],
    ["succeed", "LlmCall::succeed"],
    ["errOf", "LlmCall::err_of"],
    ["fail", "LlmCall::fail"],
    ["onTimer", "LlmCall::on_timer"],
    ["deadlines", "LlmCall::deadlines"],
    ["timer", "LlmCall::timer"],
    ["decode", "LlmCall::decode"],
    ["rejected", "LlmCall::rejected"],
    ["schemaOf", "LlmCall::schema_of"],
    ["run", "LlmCall::run"],
    ["name", "LlmCall::name"],
    ["liftLlmCall", "llm::lift_llm_call"],
  ].map(([sourceSymbol, nativeSymbol]) => ({
    sourceSymbol,
    sourcePath: "packages/tea/src/internal/llm-call/index.ts",
    nativeSymbol,
    nativePath: "crates/tea/src/llm_call.rs",
    caseIds: results
      .filter(
        (result) => result.equal && result.publicCalls.includes(nativeSymbol),
      )
      .map((result) => result.id),
  }));
  // This proposes mappings from observed successful calls; root owns registration.
  if (!options.caseIds)
    assert(capabilities.every((capability) => capability.caseIds.length > 0));
  const report = {
    producer,
    version: 1,
    profile: "numeric-and-json-null-settled-timestamps",
    passed: results.length - mismatches.length,
    total: results.length,
    actions: results.reduce((n, r) => n + r.actions, 0),
    failures: mismatches,
    results,
    timestampProbes,
    openGaps: timestampProbes
      .filter((result) => !result.equal)
      .map((result) => ({
        ...result,
        owner: "crates/tea/src/command.rs:restore_settled_value",
        contract:
          "A nonfinite numeric engine stamp is JSON null after persistence. Source restores and settles it; native canonical Settled must preserve that null through its data-owned NumberOrNull. These are strict valid-call/persistence cases.",
      })),
    sourceHashes: Object.fromEntries(
      sourceFiles.map((file) => [file, hash(join(root, file))]),
    ),
    binaryHash: hash(binary),
    capabilityMappingProposal: capabilities,
    engine: { node: process.version, v8: process.versions.v8 },
    qualifications: [
      "Opaque native error uses an explicit application-owned Serialize projection at the existing command boundary; its original non-Serialize Rc cause is retained and tested. Unprojected opaque errors remain unsupported by CommandFamily.",
      "Native Schema is a supplied typed parser, with no network/provider or agent framework. Typed missing schema/purpose and host panic behavior are outside these accepted scripts.",
      "Runtime cases use awaited serial operations and fixed clocks; arbitrary host executor ordering is not asserted.",
      "Strict cases use numeric Source clock values and their JSON-restored null, including promoted a6 timestamp probes. Manually missing or nonnumeric raw timestamps remain outside the typed number contract and are explicitly not claimed equivalent.",
    ],
  };
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { binary: { type: "string" }, report: { type: "string" } },
  });
  const report = await llmCallParity({
    binary: values.binary,
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      passed: report.passed,
      total: report.total,
      actions: report.actions,
      openGaps: report.openGaps.length,
      report: values.report ?? "target/parity/llm-call.json",
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
