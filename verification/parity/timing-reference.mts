import { createInterface } from "node:readline";
import { z } from "zod";
import {
  type ArmTimer,
  type DeadlineExceeded,
  type DeadlineSub,
  type DeadlinesSub,
  deadlineExceeded,
  deadlineMsgType,
  deadlineSub,
  deadlines,
  deadlinesSub,
  nextTimer,
  setTimeoutArmTimer,
  subscribeDeadline,
  subscribeWith,
} from "../../packages/tea/src/internal/resilience/deadline/index.ts";
import { debounce } from "../../packages/tea/src/internal/timing/debounce/index.ts";
import { throttle } from "../../packages/tea/src/internal/timing/throttle/index.ts";
import {
  createThrottledInput,
  initThrottledInput,
  input,
  onFlush,
  subsFor,
  type ThrottledInput,
  type ThrottledInputConfig,
} from "../../packages/tea/src/internal/timing/throttled-input/index.ts";
import { desiredSub, subIdOf } from "../../packages/tea/src/pure/core.ts";
import {
  Clock,
  decode,
  encodeNumber,
  errorValue,
  normalize,
  numeric,
} from "./timing-clock.mts";

const action = z.discriminatedUnion("op", [
  z.object({ op: z.literal("invoke"), args: z.array(z.unknown()) }),
  z.object({ op: z.enum(["cancel", "flush"]) }),
  z.object({ op: z.literal("advance"), to: numeric }),
  z.object({ op: z.literal("throw"), value: z.unknown() }),
]);
const wrapperInput = z.object({
  kind: z.enum(["debounce", "throttle"]),
  ms: numeric,
  now: numeric.default(0),
  options: z
    .object({
      leading: z.boolean().optional(),
      trailing: z.boolean().optional(),
    })
    .default({}),
  failArmAt: z.number().int().optional(),
  reactions: z
    .array(z.object({ when: z.number().int(), actions: z.array(action) }))
    .default([]),
  actions: z.array(action),
});
function wrapper(raw: unknown) {
  const value = wrapperInput.parse(raw);
  const clock = new Clock(value.now, value.failArmAt);
  const reset = clock.install();
  try {
    const fires: unknown[] = [];
    let count = 0;
    let wrapped: ReturnType<typeof debounce<unknown[]>>;
    type WrapperAction = z.output<typeof action>;
    const run = (action: WrapperAction) => {
      switch (action.op) {
        case "invoke":
          wrapped(...action.args.map(decode));
          break;
        case "cancel":
          wrapped.cancel();
          break;
        case "flush":
          wrapped.flush();
          break;
        case "advance":
          clock.advance(action.to);
          break;
        case "throw":
          throw decode(action.value);
      }
    };
    const handler = (...args: unknown[]) => {
      count++;
      fires.push({ at: encodeNumber(clock.now), args: normalize(args) });
      for (const reaction of value.reactions)
        if (reaction.when === count)
          for (const action of reaction.actions) run(action);
    };
    wrapped = (value.kind === "debounce" ? debounce : throttle)(
      handler,
      value.ms,
      value.options,
    );
    for (const action of value.actions) {
      try {
        run(action);
      } catch (error) {
        clock.error("action", error);
      }
    }
    return {
      fires,
      timers: clock.events,
      errors: clock.errors,
      active: clock.active(),
    };
  } finally {
    reset();
  }
}

const gateConfig = z.object({
  throttleMs: numeric.optional(),
  debounceMs: numeric.optional(),
  cacheTtlMs: numeric.optional(),
  cacheKey: z.enum(["string", "json", "field"]).optional(),
  field: z.string().optional(),
});
const gateAction = z.discriminatedUnion("op", [
  z.object({ op: z.literal("input"), value: z.unknown(), at: numeric }),
  z.object({ op: z.literal("flush"), at: numeric }),
  z.object({ op: z.enum(["subs", "roundTrip"]) }),
]);
const gateInput = z.object({
  config: gateConfig,
  free: z.boolean().default(false),
  id: z.unknown().optional(),
  actions: z.array(gateAction),
});
function gate(raw: unknown) {
  const value = gateInput.parse(raw);
  let emitCalls = 0;
  let keyCalls = 0;
  const emit = (value: unknown) => {
    emitCalls++;
    return { type: "Emit", value };
  };
  const key = (input: unknown) => {
    keyCalls++;
    if (value.config.cacheKey === "json")
      return JSON.stringify(input) ?? "undefined";
    if (value.config.cacheKey === "field")
      return String(
        typeof input === "object" && input !== null
          ? Reflect.get(input, value.config.field ?? "id")
          : undefined,
      );
    return String(input);
  };
  let config: ThrottledInputConfig<unknown, ReturnType<typeof emit>>;
  if (value.config.cacheTtlMs !== undefined) {
    if (value.config.cacheKey === undefined)
      throw new Error("cacheKey is required with cacheTtlMs");
    config = {
      throttleMs: value.config.throttleMs,
      debounceMs: value.config.debounceMs,
      cacheTtlMs: value.config.cacheTtlMs,
      cacheKey: key,
      emit,
    };
  } else {
    if (value.config.cacheKey !== undefined)
      throw new Error("cacheKey is forbidden without cacheTtlMs");
    config = {
      throttleMs: value.config.throttleMs,
      debounceMs: value.config.debounceMs,
      emit,
    };
  }
  const knob = createThrottledInput(config);
  let state: ThrottledInput<unknown> = value.free
    ? initThrottledInput()
    : knob.init();
  const initial = normalize(state);
  const observations: unknown[] = [];
  const id = value.id === undefined ? undefined : String(decode(value.id));
  const subscriptions = () => {
    const subs = value.free ? subsFor(config, state, id) : knob.subs(state, id);
    return {
      subs: normalize(subs),
      subId: subs.length ? subIdOf("deadline", subs) : null,
    };
  };
  for (const action of value.actions) {
    const old = state;
    if (action.op === "roundTrip") {
      const json =
        JSON.stringify(
          state,
        ); /* Deliberate identity restore: preserve JSON's real numeric changes. */
      state = JSON.parse(json);
      observations.push({
        op: action.op,
        json,
        state: normalize(state),
        same: false,
        cacheSame: old.cache === state.cache,
        ...subscriptions(),
      });
      continue;
    }
    try {
      let cmds: readonly unknown[] = [];
      if (action.op === "input")
        [state, cmds] = value.free
          ? input(config, state, decode(action.value), action.at)
          : knob.input(state, decode(action.value), action.at);
      else if (action.op === "flush")
        [state, cmds] = value.free
          ? onFlush(config, state, action.at)
          : knob.onFlush(state, action.at);
      observations.push({
        op: action.op,
        state: normalize(state),
        cmds: normalize(cmds),
        same: old === state,
        cacheSame: old.cache === state.cache,
        ...subscriptions(),
      });
    } catch (error) {
      observations.push({
        op: action.op,
        error: errorValue(error),
        state: normalize(state),
        same: true,
        cacheSame: old.cache === state.cache,
      });
    }
  }
  return { initial, observations, emitCalls, keyCalls };
}

const deadlineInput = z.object({
  list: z
    .array(
      z.object({ id: z.unknown(), atMs: numeric, name: z.string().optional() }),
    )
    .default([]),
  queries: z.array(numeric).default([]),
  now: numeric.default(0),
  mode: z.enum(["none", "default", "seam", "record", "inline"]).default("none"),
  failArmAt: z.number().int().optional(),
  failCancelAt: z.number().int().optional(),
  actions: z
    .array(
      z.discriminatedUnion("op", [
        z.object({ op: z.literal("advance"), to: numeric }),
        z.object({ op: z.literal("cancel") }),
        z.object({ op: z.literal("fire"), index: z.number().int() }),
      ]),
    )
    .default([]),
});
function deadline(raw: unknown) {
  const value = deadlineInput.parse(raw);
  const list: DeadlineSub<string | undefined>[] = value.list.map((entry) =>
    deadlineSub(
      String(decode(entry.id)),
      entry.atMs,
      entry.name === undefined ? undefined : { name: entry.name },
    ),
  );
  const messages = list.map((deadline) =>
    deadlineExceeded(deadline.id, deadline.atMs, deadline.name),
  );
  const tags = list.map((deadline) => deadlineMsgType(deadline.name));
  const depsSame = deadlines(list) === list;
  const projection = desiredSub(
    deadlinesSub((state: typeof list) => state),
    list,
  );
  const queries = value.queries.map((now) => normalize(nextTimer(list, now)));
  const clock = new Clock(value.now, value.failArmAt);
  const reset = clock.install();
  try {
    const dispatches: unknown[] = [];
    const arms: unknown[] = [];
    const cancels: unknown[] = [];
    const parked: Array<{
      active: boolean;
      msg: DeadlineExceeded<string | undefined>;
      dispatch: (msg: DeadlineExceeded<string | undefined>) => void;
    }> = [];
    const dispatch = (msg: DeadlineExceeded<string | undefined>) =>
      dispatches.push({ at: encodeNumber(clock.now), msg: normalize(msg) });
    const sub: DeadlinesSub<string | undefined> = {
      id: subIdOf("deadline", list),
      type: "deadline",
      deps: list,
    };
    let cleanup: (() => void) | undefined;
    try {
      if (value.mode === "default")
        cleanup = subscribeDeadline(sub, undefined, dispatch);
      else if (value.mode === "seam")
        cleanup = subscribeWith<string | undefined>(
          setTimeoutArmTimer<string | undefined>(),
        )(sub, undefined, dispatch);
      else if (value.mode === "record" || value.mode === "inline") {
        let count = 0;
        let cancelCount = 0;
        const arm: ArmTimer<DeadlineExceeded<string | undefined>> = (
          id,
          atMs,
          msg,
          dispatch,
        ) => {
          count++;
          arms.push({
            id: normalize(id),
            atMs: encodeNumber(atMs),
            msg: normalize(msg),
            at: encodeNumber(clock.now),
          });
          if (value.failArmAt === count) throw new Error(`arm failed ${count}`);
          const entry = { active: true, msg, dispatch };
          if (value.mode === "inline") dispatch(msg);
          parked.push(entry);
          return () => {
            cancelCount++;
            cancels.push(normalize(id));
            if (value.failCancelAt === cancelCount)
              throw new Error(`cancel failed ${cancelCount}`);
            entry.active = false;
          };
        };
        cleanup = subscribeWith(arm)(sub, undefined, dispatch);
      }
    } catch (error) {
      clock.error("subscribe", error);
    }
    for (const action of value.actions) {
      try {
        if (action.op === "advance") clock.advance(action.to);
        else if (action.op === "cancel") cleanup?.();
        else {
          const entry = parked[action.index];
          if (entry?.active) entry.dispatch(entry.msg);
        }
      } catch (error) {
        clock.error("action", error);
      }
    }
    return {
      declarations: normalize(list),
      messages: normalize(messages),
      tags,
      depsSame,
      projection: normalize(projection),
      queries,
      arms,
      cancels,
      dispatches,
      timers: clock.events,
      errors: clock.errors,
      active: clock.active(),
    };
  } finally {
    reset();
  }
}
const envelope = z.object({
  id: z.string(),
  operation: z.string(),
  input: z.unknown(),
});
const operations: Record<string, (input: unknown) => unknown> = {
  "timing.wrapper": wrapper,
  "timing.input": gate,
  "timing.deadline": deadline,
};
for await (const line of createInterface({ input: process.stdin })) {
  const value = envelope.parse(JSON.parse(line));
  let response: unknown;
  try {
    const execute = operations[value.operation];
    if (!execute)
      throw new Error(`unsupported timing operation ${value.operation}`);
    response = { id: value.id, ok: true, output: await execute(value.input) };
  } catch (error) {
    response = {
      id: value.id,
      ok: false,
      error: { kind: "driver_error", message: String(error) },
    };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
