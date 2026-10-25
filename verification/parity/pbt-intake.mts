import assert from "node:assert/strict";
import { z } from "zod";
import { createIntake } from "../../packages/tea/src/idempotency/index.js";
import { defineMachine } from "../../packages/tea/src/index.js";
import { foldEvents } from "../../packages/tea/src/pbt/index.js";
import { normalize, numeric } from "./timing-clock.mts";

const num = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const action = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("receive"),
      slot: z.number().int().min(0).max(2),
      id: z.string(),
      at: num,
    })
    .strict(),
  z
    .object({
      op: z.literal("complete"),
      key: z.string(),
      slot: z.number().int().min(0).max(1),
      at: num,
    })
    .strict(),
  z.object({ op: z.literal("claim"), at: num }).strict(),
  z.object({ op: z.enum(["boot", "noop"]) }).strict(),
  z
    .object({ op: z.literal("reuse"), index: z.number().int().nonnegative() })
    .strict(),
]);
export const pbtIntakeScript = z
  .object({
    kind: z.literal("intake"),
    ttlMs: num.optional(),
    loaded: z.boolean(),
    roundTripSeed: z.boolean(),
    initBoot: z.boolean(),
    initCommand: z.boolean(),
    seed: z.array(action),
    messages: z.array(action),
  })
  .strict();
type Script = z.infer<typeof pbtIntakeScript>;
const result = z
  .object({
    states: z.array(z.unknown()),
    steps: z.array(
      z
        .object({
          prev: z.unknown(),
          next: z.unknown(),
          msg: z.unknown(),
          cmds: z.array(z.unknown()),
        })
        .strict(),
    ),
    finalState: z.unknown(),
  })
  .strict();
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function rec(v: unknown) {
  assert(isRecord(v));
  return v;
}
function ids() {
  const map = new WeakMap<object, number>();
  let next = 0;
  return (v: unknown) => {
    assert(v !== null && typeof v === "object");
    const before = map.get(v);
    if (before !== undefined) return before;
    map.set(v, next);
    return next++;
  };
}
export function executePbtIntake(input: Script) {
  const p = [
      { id: "a", amount: 5 },
      { id: "b", amount: 9 },
      { id: "a", amount: 7 },
    ],
    r = [{ chargedCents: 500 }, { chargedCents: 900 }];
  const intake = createIntake<unknown, unknown>({
    keyOf: (p) => {
      const id = rec(p).id;
      assert.equal(typeof id, "string");
      return String(id);
    },
    ...(input.ttlMs === undefined ? {} : { ttlMs: numeric.parse(input.ttlMs) }),
  });
  function messages(actions: z.infer<typeof action>[]) {
    const list: Record<string, unknown>[] = [];
    for (const a of actions) {
      if (a.op === "reuse") {
        assert(list[a.index]);
        list.push(list[a.index]);
      } else if (a.op === "receive") {
        list.push({
          type: a.op,
          payload: p[a.slot],
          id: a.id,
          at: numeric.parse(a.at),
        });
      } else if (a.op === "complete") {
        list.push({
          type: a.op,
          key: a.key,
          result: r[a.slot],
          at: numeric.parse(a.at),
        });
      } else if (a.op === "claim") {
        list.push({ type: a.op, at: numeric.parse(a.at) });
      } else list.push({ type: a.op });
    }
    return list;
  }
  function apply(state: unknown, msg: Record<string, unknown>) {
    const s = state;
    switch (msg.type) {
      case "receive":
        return Reflect.apply(intake.receive, undefined, [
          s,
          msg.payload,
          msg.at,
          msg.id,
        ]);
      case "complete":
        return Reflect.apply(intake.complete, undefined, [
          s,
          msg.key,
          msg.result,
          msg.at,
        ]);
      case "claim": {
        const claimed: unknown = Reflect.apply(intake.claimNext, undefined, [
          s,
          msg.at,
        ]);
        return [claimed === null ? s : rec(claimed).state, []];
      }
      case "boot":
        return Reflect.apply(intake.boot, undefined, [s]);
      case "noop":
        return [s, []];
      default:
        throw Error("event");
    }
  }
  let seed: unknown = intake.init();
  for (const m of messages(input.seed)) {
    const step = z
      .tuple([z.unknown(), z.array(z.unknown())])
      .parse(apply(seed, m));
    seed = step[0];
  }
  if (input.roundTripSeed) seed = JSON.parse(JSON.stringify(seed));
  const loaded = input.loaded ? seed : null,
    log: unknown[] = [];
  const cell = (s: unknown, m: Record<string, unknown>) => {
    log.push(["cell", m.type]);
    return apply(s, m);
  };
  const machine: unknown = Reflect.apply(defineMachine, undefined, [
    {
      init: (saved: unknown) => {
        log.push(["init", saved !== null]);
        let state: unknown = saved ?? intake.init();
        if (input.initBoot)
          state = z
            .tuple([z.unknown(), z.array(z.unknown())])
            .parse(Reflect.apply(intake.boot, undefined, [state]))[0];
        return [state, input.initCommand ? [{ type: "resume" }] : []];
      },
      update: {
        receive: cell,
        complete: cell,
        claim: cell,
        boot: cell,
        noop: cell,
      },
    },
  ]);
  const inputMessages = messages(input.messages),
    trace = result.parse(
      Reflect.apply(foldEvents, undefined, [
        machine,
        undefined,
        loaded,
        inputMessages,
      ]),
    ),
    sid = ids(),
    mid = ids();
  if (loaded) sid(loaded);
  const stateIds = trace.states.map(sid),
    inputMsgIds = inputMessages.map(mid);
  const ref = (value: unknown, pool: unknown[]) => {
    const i = pool.indexOf(value);
    return i < 0 ? null : i;
  };
  function stateView(v: unknown) {
    const s = rec(v),
      queue = z.array(z.unknown()).parse(s.queue),
      entries = rec(rec(s.seen).entries);
    const cachedResultRefs = Object.entries(entries).flatMap(([key, row]) => {
      const value = rec(rec(row).value);
      return value.phase === "done" && value.result !== undefined
        ? [[key, ref(value.result, r)]]
        : [];
    });
    return {
      wire: JSON.stringify(v),
      queuePayloadRefs: queue.map((q) => ref(rec(q).input, p)),
      cachedResultRefs,
    };
  }
  function msgView(v: unknown) {
    const m = rec(v);
    if (m.type === "receive")
      return { ...rec(normalize(v)), payloadRef: ref(m.payload, p) };
    if (m.type === "complete")
      return { ...rec(normalize(v)), resultRef: ref(m.result, r) };
    return normalize(v);
  }
  function command(v: unknown) {
    const c = rec(v);
    return {
      value: normalize(v),
      wire: JSON.stringify(v),
      payloadRef: c.type === "intake:process" ? ref(c.payload, p) : null,
      resultRef: c.type === "intake:replay" ? ref(c.result, r) : null,
    };
  }
  return {
    status: "ok",
    log,
    inputMsgIds,
    states: trace.states.map((s, i) => ({
      id: stateIds[i],
      value: stateView(s),
    })),
    steps: trace.steps.map((s, i) => ({
      prev: sid(s.prev),
      next: sid(s.next),
      msgId: mid(s.msg),
      msg: msgView(s.msg),
      commands: s.cmds.map(command),
      sameState: s.prev === s.next,
      sameMsg: s.msg === inputMessages[i],
      prevLink: s.prev === trace.states[i],
      nextLink: s.next === trace.states[i + 1],
    })),
    final: sid(trace.finalState),
    finalLink: trace.finalState === trace.states.at(-1),
  };
}
export function pbtIntakeCases() {
  const base = {
    kind: "intake",
    loaded: false,
    roundTripSeed: false,
    initBoot: false,
    initCommand: true,
    seed: [],
  };
  const history = [
    { op: "receive", slot: 0, id: "q1", at: 0 },
    { op: "claim", at: 1 },
    { op: "complete", key: "a", slot: 0, at: 5 },
    { op: "boot" },
    { op: "receive", slot: 0, id: "q2", at: 6 },
    { op: "receive", slot: 1, id: "q3", at: 7 },
    { op: "claim", at: 8 },
    { op: "receive", slot: 1, id: "q4", at: 9 },
  ];
  const cases: { id: string; input: unknown }[] = [
    {
      id: "pbt-fold.intake.duplicate-complete-boot-eight",
      input: { ...base, messages: history },
    },
    {
      id: "pbt-fold.intake.pending-never-expires",
      input: {
        ...base,
        ttlMs: 1,
        messages: [
          { op: "receive", slot: 0, id: "q1", at: 0 },
          { op: "claim", at: 1 },
          { op: "receive", slot: 2, id: "q2", at: 100000 },
          { op: "boot" },
          { op: "receive", slot: 0, id: "q3", at: 200000 },
          { op: "reuse", index: 0 },
        ],
      },
    },
    {
      id: "pbt-fold.intake.ttl-half-open",
      input: {
        ...base,
        ttlMs: 10,
        messages: [
          { op: "receive", slot: 0, id: "q1", at: 0 },
          { op: "complete", key: "a", slot: 0, at: 5 },
          { op: "receive", slot: 2, id: "q2", at: 14 },
          { op: "receive", slot: 0, id: "q3", at: 15 },
          { op: "claim", at: 16 },
          { op: "boot" },
          { op: "receive", slot: 2, id: "q4", at: 1000 },
        ],
      },
    },
  ];
  for (const roundTripSeed of [false, true]) {
    const suffix = roundTripSeed ? "json" : "retained";
    cases.push({
      id: `pbt-fold.intake.running-resume-${suffix}`,
      input: {
        ...base,
        loaded: true,
        initBoot: true,
        roundTripSeed,
        seed: [
          { op: "receive", slot: 0, id: "q1", at: 0 },
          { op: "claim", at: 1 },
        ],
        messages: [
          { op: "claim", at: 2 },
          { op: "receive", slot: 2, id: "q2", at: 50 },
          { op: "complete", key: "a", slot: 0, at: 51 },
          { op: "boot" },
          { op: "receive", slot: 0, id: "q3", at: 52 },
        ],
      },
    });
    cases.push({
      id: `pbt-fold.intake.done-before-crash-${suffix}`,
      input: {
        ...base,
        loaded: true,
        initBoot: true,
        roundTripSeed,
        seed: [
          { op: "receive", slot: 0, id: "q1", at: 0 },
          { op: "claim", at: 1 },
          { op: "complete", key: "a", slot: 0, at: 2 },
        ],
        messages: [
          { op: "claim", at: 100 },
          { op: "boot" },
          { op: "receive", slot: 0, id: "q2", at: 101 },
          { op: "receive", slot: 1, id: "q3", at: 102 },
          { op: "claim", at: 103 },
          { op: "noop" },
        ],
      },
    });
  }
  cases.push({
    id: "pbt-fold.intake.empty-loaded-boot",
    input: {
      ...base,
      loaded: true,
      roundTripSeed: true,
      initBoot: true,
      seed: [
        { op: "receive", slot: 0, id: "q1", at: 0 },
        { op: "claim", at: 1 },
      ],
      messages: [],
    },
  });
  return cases.map((c) => ({
    id: c.id,
    input: pbtIntakeScript.parse(c.input),
  }));
}
