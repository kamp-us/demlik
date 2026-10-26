import assert from "node:assert/strict";
import {
  liftSlice,
  readInOrder,
} from "../../packages/tea/src/compose/index.js";
import {
  defineMachine,
  NoCellError,
  replay,
} from "../../packages/tea/src/index.js";
import type { ComposeScript } from "./compose-cases.mts";
import { encodeNumber, numeric } from "./timing-clock.mts";

type Text = string | { $utf16: number[] };
export const textValue = (value: Text) =>
  typeof value === "string" ? value : String.fromCharCode(...value.$utf16);
const units = (value: string) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
type Spec = ComposeScript["values"][number];
type Token = { n: number; capability: () => void };
type Fn = (() => number) & { n: number };
type Item = undefined | null | boolean | number | string | Token | Fn;
function valuesOf(specs: readonly Spec[]): Item[] {
  return specs.map((s) => {
    switch (s.type) {
      case "undefined":
        return undefined;
      case "null":
        return null;
      case "bool":
        return s.value;
      case "number":
        return numeric.parse(s.value);
      case "text":
        return textValue(s.value);
      case "token":
        return { n: numeric.parse(s.n), capability: () => {} };
      case "function":
        return Object.assign(() => 17, { n: numeric.parse(s.n) });
    }
    throw new Error("unknown parsed item");
  });
}
function view(value: Item, spec: Spec): unknown {
  switch (spec.type) {
    case "undefined":
      return { type: "undefined" };
    case "null":
      return { type: "null" };
    case "bool":
      return { type: "bool", value };
    case "number":
      assert(typeof value === "number");
      return { type: "number", value: encodeNumber(value) };
    case "text":
      assert(typeof value === "string");
      return { type: "text", units: units(value) };
    case "token":
    case "function":
      assert(
        value !== null &&
          (typeof value === "object" || typeof value === "function"),
      );
      return { type: spec.type, n: encodeNumber(Reflect.get(value, "n")) };
  }
}
function tokenSet(values: Item[], slot: number, n: number) {
  const v = values[slot];
  assert(v !== null && (typeof v === "object" || typeof v === "function"));
  Reflect.set(v, "n", n);
}
export function executeCompose(input: ComposeScript): unknown {
  const values = valuesOf(input.values),
    valueView = (slot: number) => view(values[slot], input.values[slot]);
  if (input.kind === "read") {
    const actualInput = {
        n: numeric.parse(input.input.n),
        capability: () => {},
      },
      log: unknown[] = [],
      counts = input.readers.map(() => 0);
    type Reader = { name: string; read: (input: typeof actualInput) => Item };
    const pool: Reader[] = [];
    const order: Reader[] = [];
    for (const [index, spec] of input.readers.entries())
      pool.push({
        name: textValue(spec.name),
        read(actual) {
          const call = counts[index]++;
          log.push({
            reader: index,
            call,
            nameUnits: units(this.name),
            sameInput: actual === actualInput,
            sameReceiver: this === pool[index],
            n: encodeNumber(actual.n),
          });
          if (call === spec.mutateOn)
            for (const effect of spec.effects) {
              switch (effect.op) {
                case "setInput":
                  actual.n = numeric.parse(effect.n);
                  break;
                case "setToken":
                  tokenSet(values, effect.slot, numeric.parse(effect.n));
                  break;
                case "append":
                  order.push(pool[effect.reader]);
                  break;
                case "remove":
                  order.splice(effect.index, 1);
                  break;
                case "reverse":
                  order.reverse();
                  break;
                case "truncate":
                  order.length = Math.min(order.length, effect.len);
                  break;
              }
            }
          switch (spec.action.op) {
            case "defer":
              return undefined;
            case "answer":
              return values[spec.action.slot];
            case "throw":
              throw values[spec.action.slot];
          }
        },
      });
    order.push(...input.order.map((index) => pool[index]));
    let result: unknown,
      status = "ok";
    try {
      if (input.direct !== undefined) {
        result = pool[input.direct].read(actualInput);
        if (result === undefined) result = values[input.absent];
      } else {
        // Source receives the actual live reader array, including callback mutations.
        result = readInOrder(actualInput, order, values[input.absent]);
      }
    } catch (error) {
      status = "error";
      result = error;
    }
    const slot = values.findIndex((v) => Object.is(v, result));
    assert(slot >= 0);
    const before = valueView(slot);
    for (const e of input.post) {
      if (e.op === "setInput") actualInput.n = numeric.parse(e.n);
      else if (e.op === "setToken")
        tokenSet(values, e.slot, numeric.parse(e.n));
      else throw new Error("post scalar only");
    }
    return {
      status,
      slot,
      value: before,
      after: valueView(slot),
      sameOriginal: Object.is(result, values[slot]),
      inputN: encodeNumber(actualInput.n),
      log,
      order: order.map((reader) => pool.indexOf(reader)),
    };
  }
  if (input.kind === "lift") {
    const context = { capability: () => {} },
      host = { left: values[0], right: values[1], context },
      replacement = input.sameSlice
        ? host[input.field]
        : values[input.nextSlot];
    const commands = input.commands.map((slot) => ({
      slot,
      value: values[slot],
    }));
    const [next, out] = liftSlice(input.field, host, [replacement, commands]);
    return {
      fresh: next !== host,
      sliceIdentity: Object.is(next[input.field], replacement),
      siblingIdentity: Object.is(
        next[input.field === "left" ? "right" : "left"],
        host[input.field === "left" ? "right" : "left"],
      ),
      contextIdentity: next.context === context,
      original: [valueView(0), valueView(1)],
      next: [
        view(
          next.left,
          input.values[next.left === host.left ? 0 : input.nextSlot],
        ),
        view(
          next.right,
          input.values[next.right === host.right ? 1 : input.nextSlot],
        ),
      ],
      commandsOwner: out === commands,
      commands: out.map((c, i) => ({
        slot: c.slot,
        value: valueView(c.slot),
        sameOriginal: c === commands[i] && Object.is(c.value, values[c.slot]),
      })),
    };
  }
  type Answer = { slot: number; value: Item };
  type State = {
    type: "lookup";
    cache: ReadonlyArray<readonly [string, Answer]>;
    pending: ReadonlyArray<readonly [string, number]>;
    asked: number;
    context: object;
  };
  type Command = {
    type: string;
    key: string | null;
    slot: number | null;
    payload?: { value: Item };
  };
  const context = { capability: () => {} },
    log: unknown[] = [],
    lifts: unknown[] = [];
  const stateView = (s: State) => ({
    asked: s.asked,
    cache: s.cache.map(([key, a]) => ({
      key: units(key),
      slot: a.slot,
      value: valueView(a.slot),
    })),
    pending: s.pending.map(([key, at]) => ({
      key: units(key),
      at: encodeNumber(at),
    })),
  });
  const statusOf = (s: State, key: string) => {
    const cache = {
        name: "cache",
        read: (actual: string) => {
          const entry = s.cache.find(([k]) => k === actual);
          if (entry === undefined) return undefined;
          const a = entry[1];
          return {
            state: "ready",
            slot: a.slot,
            value: valueView(a.slot),
            sameOriginal: Object.is(a.value, values[a.slot]),
          };
        },
      },
      pending = {
        name: "inFlight",
        read: (actual: string) => {
          const entry = s.pending.find(([k]) => k === actual);
          return entry === undefined
            ? undefined
            : { state: "pending", at: encodeNumber(entry[1]) };
        },
      };
    return Reflect.apply(readInOrder, undefined, [
      key,
      input.reversed ? [pending, cache] : [cache, pending],
      { state: "unknown" },
    ]);
  };
  const recordLift = (
    field: "cache" | "pending",
    before: State,
    slice: State["cache"] | State["pending"],
    commands: readonly Command[],
    next: State,
    out: readonly Command[],
  ) =>
    lifts.push({
      field,
      fresh: next !== before,
      sliceIdentity: next[field] === slice,
      siblingIdentity:
        next[field === "cache" ? "pending" : "cache"] ===
        before[field === "cache" ? "pending" : "cache"],
      contextIdentity: next.context === before.context,
      commandsOwner: out === commands,
    });
  type Msg =
    | { type: "ask"; key: string; at: number }
    | { type: "arrive"; key: string; answer: Answer }
    | { type: "unknown" };
  const definition = {
    init: (loaded: State | null, ctx: { label: string }) => {
      log.push(["init", loaded === null ? null : stateView(loaded), ctx.label]);
      return [
        loaded ?? { type: "lookup", cache: [], pending: [], asked: 0, context },
        input.bootCommand ? [{ type: "boot", key: null, slot: null }] : [],
      ] as const;
    },
    update: {
      ask: (s: State, m: Extract<Msg, { type: "ask" }>) => {
        log.push(["update", "ask", units(m.key)]);
        const pending = s.pending.map(
          ([k, v]) => [k, k === m.key ? m.at : v] as const,
        );
        if (!s.pending.some(([k]) => k === m.key)) pending.push([m.key, m.at]);
        const host = { ...s, asked: s.asked + 1 };
        const commands = [
          { type: "fetch", key: m.key, slot: null },
          { type: "audit", key: m.key, slot: null },
        ];
        const [next, out] = liftSlice("pending", host, [pending, commands]);
        recordLift("pending", host, pending, commands, next, out);
        log.push(["read", units(m.key), statusOf(next, m.key)]);
        return [next, out] as const;
      },
      arrive: (s: State, m: Extract<Msg, { type: "arrive" }>) => {
        log.push(["update", "arrive", units(m.key)]);
        const pending = s.pending.filter(([k]) => k !== m.key),
          empty: Command[] = [];
        const [ended, endedCommands] = liftSlice("pending", s, [
          pending,
          empty,
        ]);
        recordLift("pending", s, pending, empty, ended, endedCommands);
        const cache = ended.cache.map(
          ([k, a]) => [k, k === m.key ? m.answer : a] as const,
        );
        if (!ended.cache.some(([k]) => k === m.key))
          cache.push([m.key, m.answer]);
        const commands: Command[] = [
          {
            type: "ack",
            key: m.key,
            slot: m.answer.slot,
            payload: { value: m.answer.value },
          },
          { type: "audit", key: m.key, slot: null },
        ];
        const [next, out] = liftSlice("cache", ended, [cache, commands]);
        recordLift("cache", ended, cache, commands, next, out);
        log.push(["read", units(m.key), statusOf(next, m.key)]);
        return [next, out] as const;
      },
    },
    subs: [
      {
        type: "watch",
        deps: (s: State) => {
          log.push(["subs", s.asked]);
          return null;
        },
      },
    ],
  };
  Object.defineProperty(definition, "__form", { value: "reducer" });
  const machine: unknown = Reflect.apply(defineMachine, undefined, [
    definition,
  ]);
  const loaded: State | null = input.loaded
    ? {
        type: "lookup",
        cache: input.loaded.cache.map((v) => [
          textValue(v.key),
          { slot: v.slot, value: values[v.slot] },
        ]),
        pending: input.loaded.pending.map((v) => [
          textValue(v.key),
          numeric.parse(v.at),
        ]),
        asked: input.loaded.asked,
        context,
      }
    : null;
  const messages: Msg[] = input.messages.map((m) =>
    m.op === "unknown"
      ? { type: "unknown" }
      : m.op === "ask"
        ? { type: "ask", key: textValue(m.key), at: numeric.parse(m.at) }
        : {
            type: "arrive",
            key: textValue(m.key),
            answer: { slot: m.slot, value: values[m.slot] },
          },
  );
  try {
    const done = Reflect.apply(replay, undefined, [
      machine,
      { loaded, ctx: { label: "invoice-host" }, msgs: messages },
    ]);
    const s: State = done.state;
    return {
      status: "ok",
      state: stateView(s),
      commands: (done.cmds as Command[]).map((c) => ({
        type: c.type,
        key: c.key === null ? null : units(c.key),
        slot: c.slot,
        sameOriginal:
          c.payload === undefined ||
          Object.is(c.payload.value, values[c.slot ?? 0]),
      })),
      queries: input.queries.map((k) => {
        const key = textValue(k);
        return { key: units(key), answer: statusOf(s, key) };
      }),
      log,
      lifts,
    };
  } catch (error) {
    assert(error instanceof NoCellError);
    return {
      status: "refusal",
      error: {
        msg: Reflect.get(error, "msgType"),
        state: Reflect.get(error, "stateName"),
        accepted: Reflect.get(error, "acceptedTypes"),
      },
      log,
      lifts,
    };
  }
}
