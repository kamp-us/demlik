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
import { Effect, Exit, Scope } from "effect";
import { z } from "zod";
import {
  applyEffectEvent,
  type EffectLedgerEvent,
  emptyLedger,
  foldLedger,
  isOwed,
  pendingEffectsLedger,
  survivingEffects,
} from "../../packages/tea/src/do/index.js";
import { run as runEffect } from "../../packages/tea/src/effect/index.js";
import {
  createWorkflow,
  foldWorkflow,
  routeWorkflowMsg,
  type WorkflowCmd,
  type WorkflowMsg,
  type WorkflowState,
  type WorkflowStep,
  workflowActivityDef,
  workflowCompensationDef,
} from "../../packages/tea/src/flow/index.js";
import {
  type Machine,
  Outcome,
  type Settled,
  type Store,
  type Sub,
} from "../../packages/tea/src/index.js";
import { memoryStore } from "../../packages/tea/src/mem/index.js";
import { run as runPromise } from "../../packages/tea/src/promise/index.js";
import { decode, errorValue, normalize, numeric } from "./timing-clock.mts";

const wireNumber = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const id = wireNumber.nullable();
const seed = z
  .union([id, z.object({ $undefined: z.literal(true) }).strict()])
  .optional();
const text = z.union([
  z.string(),
  z.object({ $utf16: z.array(z.number().int().min(0).max(65535)) }).strict(),
]);
const stepInput = z
  .object({
    name: text,
    activity: z.json().optional(),
    compensation: z.json().optional(),
  })
  .strict();
const messageInput = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("activity_ok"), id, result: z.json().optional() })
    .strict(),
  z
    .object({
      type: z.literal("activity_err"),
      id,
      failure: z.json().optional(),
    })
    .strict(),
  z.object({ type: z.literal("compensation_ok"), id }).strict(),
  z
    .object({
      type: z.literal("compensation_err"),
      id,
      failure: z.json().optional(),
    })
    .strict(),
]);
const action = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["init", "roundTrip", "surviving"]) }).strict(),
  z
    .object({
      op: z.literal("deliver"),
      message: messageInput,
      route: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal("autoOk"), result: z.json().optional() }).strict(),
  z.object({ op: z.literal("autoErr"), failure: z.json().optional() }).strict(),
  z.object({ op: z.literal("recreate"), lastId: seed }).strict(),
  z.object({ op: z.literal("current"), index: id, id }).strict(),
  z.object({ op: z.literal("fold"), messages: z.array(messageInput) }).strict(),
]);
const eventInput = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("effect_owed"), id, effect: z.json().optional() })
    .strict(),
  z.object({ type: z.literal("effect_confirmed"), id }).strict(),
]);
const ledgerAction = z.discriminatedUnion("op", [
  z.object({ op: z.literal("owe"), effect: z.json() }).strict(),
  z.object({ op: z.enum(["confirm", "query"]), id }).strict(),
  z.object({ op: z.literal("apply"), event: eventInput }).strict(),
  z.object({ op: z.literal("fold"), events: z.array(eventInput) }).strict(),
  z.object({ op: z.literal("recreate"), lastId: seed }).strict(),
  z.object({ op: z.literal("roundTrip") }).strict(),
]);
export const workflowScript = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("transport"),
      profile: z.enum(["promise", "effect"]),
      command: z.enum(["activity", "compensation"]),
      mode: z.enum(["success", "malformed", "undefined"]),
      index: wireNumber,
      id: wireNumber,
      payload: z.json(),
      at: wireNumber,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflow"),
      steps: z.tuple([stepInput], stepInput),
      lastId: seed,
      actions: z.array(action),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ledger"),
      events: z.array(eventInput),
      lastId: seed,
      actions: z.array(ledgerAction),
    })
    .strict(),
]);
type Script = z.infer<typeof workflowScript>;
async function executeTransport(
  script: Extract<Script, { kind: "transport" }>,
) {
  const activity = workflowActivityDef<unknown>(),
    compensation = workflowCompensationDef<unknown>();
  type Def = typeof activity | typeof compensation;
  type Msg = Settled<Def>;
  type Model = { messages: readonly Msg[] };
  const command =
    script.command === "activity"
      ? activity({
          index: numeric.parse(script.index),
          id: numeric.parse(script.id),
          activity: decode(script.payload),
        })
      : compensation({
          index: numeric.parse(script.index),
          id: numeric.parse(script.id),
          compensation: decode(script.payload),
        });
  const trace: unknown[] = [];
  const update = (
    state: Model,
    msg: Msg,
  ): readonly [Model, readonly WorkflowCmd<unknown>[]] => [
    { messages: [...state.messages, msg] },
    [],
  ];
  const machine: Machine<
    Model,
    Msg,
    WorkflowCmd<unknown>,
    Sub<never>,
    undefined
  > = {
    cmds: [activity, compensation],
    init: () => [{ messages: [] }, [command]],
    update: {
      workflow_activity_ok: update,
      workflow_activity_err: update,
      workflow_compensation_ok: update,
      workflow_compensation_err: update,
    },
  };
  const saved = memoryStore<Model>(null);
  const store: Store<Model> = {
    load: () => saved.load(),
    migrate: (raw) => saved.migrate(raw),
    async save(state) {
      trace.push({ kind: "save", state });
      await saved.save(state);
    },
  };
  const shared = {
    ctx: undefined,
    store,
    clock: () => numeric.parse(script.at),
  };
  const booted = (state: Model) => {
    trace.push({ kind: "commit", msg: null, state });
  };
  const committed = (msg: Msg, state: Model) => {
    trace.push({ kind: "commit", msg, state });
  };
  if (script.profile === "promise") {
    const handler = async (command: WorkflowCmd<unknown>) => {
      trace.push({ kind: "handler", command });
      return script.mode === "undefined"
        ? undefined
        : Outcome.ok(script.mode === "malformed" ? null : undefined);
    };
    const interpret = {
      workflow_activity: async () => Outcome.ok(undefined),
      workflow_compensation: async () => Outcome.ok(undefined),
    };
    // These invalid return values deliberately cross the untyped JS boundary.
    Reflect.set(interpret, "workflow_activity", handler);
    Reflect.set(interpret, "workflow_compensation", handler);
    const handle = runPromise(machine, { ...shared, interpret });
    handle.onBoot(booted);
    handle.observe(committed);
    const runtime = await handle.ready;
    await runtime.idle();
    const comparison = normalize([
      { state: runtime.getState(), saved: await saved.load(), trace },
    ]);
    await runtime.stop();
    return comparison;
  }
  const handler = (command: WorkflowCmd<unknown>) =>
    Effect.sync(() => {
      trace.push({ kind: "handler", command });
      return script.mode === "malformed" ? null : undefined;
    });
  const interpret = {
    workflow_activity: () => Effect.succeed(undefined),
    workflow_compensation: () => Effect.succeed(undefined),
  };
  Reflect.set(interpret, "workflow_activity", handler);
  Reflect.set(interpret, "workflow_compensation", handler);
  const scope = await Effect.runPromise(Scope.make());
  const handle = await Effect.runPromise(
    Scope.provide(scope)(runEffect(machine, { ...shared, interpret })),
  );
  handle.onBoot(booted);
  handle.observe(committed);
  const runtime = await Effect.runPromise(handle.ready);
  await Effect.runPromise(runtime.idle());
  const comparison = normalize([
    { state: runtime.getState(), saved: await saved.load(), trace },
  ]);
  await Effect.runPromise(Scope.close(scope, Exit.void));
  return comparison;
}
type State = WorkflowState<unknown, unknown, unknown>;
function number(value: z.infer<typeof id>): number {
  if (value !== null) return numeric.parse(value);
  // A JSON-restored null is intentionally outside TS's numeric annotation.
  const holder = { value: 0 };
  Reflect.set(holder, "value", null);
  return holder.value;
}
function restore(
  events: Iterable<EffectLedgerEvent<WorkflowCmd<unknown>>>,
  lastId: z.infer<typeof seed>,
) {
  const result: {
    events: Iterable<EffectLedgerEvent<WorkflowCmd<unknown>>>;
    lastId?: number;
  } = { events };
  if (lastId !== undefined) Reflect.set(result, "lastId", decode(lastId));
  return result;
}
function message(
  value: z.infer<typeof messageInput>,
): WorkflowMsg<unknown, unknown> {
  switch (value.type) {
    case "activity_ok": {
      const msg = {
        type: value.type,
        id: number(value.id),
        result: decode(value.result),
      };
      if (!Object.hasOwn(value, "result"))
        Reflect.deleteProperty(msg, "result");
      return msg;
    }
    case "activity_err": {
      const msg = {
        type: value.type,
        id: number(value.id),
        failure: decode(value.failure),
      };
      if (!Object.hasOwn(value, "failure"))
        Reflect.deleteProperty(msg, "failure");
      return msg;
    }
    case "compensation_ok":
      return { type: value.type, id: number(value.id) };
    case "compensation_err": {
      const msg = {
        type: value.type,
        id: number(value.id),
        failure: decode(value.failure),
      };
      if (!Object.hasOwn(value, "failure"))
        Reflect.deleteProperty(msg, "failure");
      return msg;
    }
  }
}
function event(value: z.infer<typeof eventInput>): EffectLedgerEvent<unknown> {
  if (value.type === "effect_confirmed")
    return { type: value.type, id: number(value.id) };
  const result = {
    type: value.type,
    id: number(value.id),
    effect: decode(value.effect),
  };
  if (!Object.hasOwn(value, "effect")) Reflect.deleteProperty(result, "effect");
  return result;
}
function makeStep(value: z.infer<typeof stepInput>): WorkflowStep<unknown> {
  const result: WorkflowStep<unknown> = {
    name: z.string().parse(decode(value.name)),
    activity: decode(value.activity),
  };
  if (!Object.hasOwn(value, "activity"))
    Reflect.deleteProperty(result, "activity");
  if (Object.hasOwn(value, "compensation"))
    Reflect.set(result, "compensation", decode(value.compensation));
  return result;
}
export async function executeWorkflow(input: unknown): Promise<unknown> {
  const script = workflowScript.parse(input);
  if (script.kind === "transport") return executeTransport(script);
  if (script.kind === "workflow") {
    const [first, ...rest] = script.steps;
    const steps: [WorkflowStep<unknown>, ...WorkflowStep<unknown>[]] = [
      makeStep(first),
      ...rest.map(makeStep),
    ];
    let log: EffectLedgerEvent<WorkflowCmd<unknown>>[] = [],
      flow = createWorkflow<unknown, unknown, unknown>(
        restore([], script.lastId),
      ),
      state: State | undefined;
    const rows: unknown[] = [];
    for (const action of script.actions) {
      const previous = state,
        before = normalize(previous);
      let ledger: readonly EffectLedgerEvent<WorkflowCmd<unknown>>[] = [],
        cmds: readonly WorkflowCmd<unknown>[] = [],
        error: unknown = null,
        folded: unknown = null;
      try {
        let result: ReturnType<typeof flow.init> | undefined;
        switch (action.op) {
          case "init":
            result = flow.init(steps);
            break;
          case "deliver": {
            assert(state);
            const msg = message(action.message);
            if (action.route) result = routeWorkflowMsg(flow, state, msg);
            else
              switch (msg.type) {
                case "activity_ok":
                  result = flow.onActivityOk(state, msg);
                  break;
                case "activity_err":
                  result = flow.onActivityErr(state, msg);
                  break;
                case "compensation_ok":
                  result = flow.onCompensationOk(state, msg);
                  break;
                case "compensation_err":
                  result = flow.onCompensationErr(state, msg);
                  break;
              }
            break;
          }
          case "autoOk": {
            if (
              !state ||
              (state.status !== "running" && state.status !== "compensating")
            )
              break;
            result = routeWorkflowMsg(
              flow,
              state,
              state.status === "running"
                ? {
                    type: "activity_ok",
                    id: state.current.id,
                    result: decode(action.result),
                  }
                : { type: "compensation_ok", id: state.current.id },
            );
            break;
          }
          case "autoErr": {
            if (
              !state ||
              (state.status !== "running" && state.status !== "compensating")
            )
              break;
            result = routeWorkflowMsg(
              flow,
              state,
              state.status === "running"
                ? {
                    type: "activity_err",
                    id: state.current.id,
                    failure: decode(action.failure),
                  }
                : {
                    type: "compensation_err",
                    id: state.current.id,
                    failure: decode(action.failure),
                  },
            );
            break;
          }
          case "roundTrip": {
            if (state) {
              const holder = { state };
              Reflect.set(holder, "state", JSON.parse(JSON.stringify(state)));
              state = holder.state;
            }
            log = JSON.parse(JSON.stringify(log));
            flow = createWorkflow({ events: log });
            break;
          }
          case "recreate":
            flow = createWorkflow(restore(log, action.lastId));
            break;
          case "current": {
            assert(state);
            assert(
              state.status === "running" || state.status === "compensating",
            );
            state = {
              ...state,
              current: {
                ...state.current,
                index: number(action.index),
                id: number(action.id),
              },
            };
            break;
          }
          case "fold":
            folded = normalize(
              foldWorkflow(steps, action.messages.map(message)),
            );
            break;
          case "surviving":
            break;
        }
        if (result) {
          state = result.state;
          ledger = result.ledger;
          cmds = result.cmds;
          log.push(...ledger);
        }
      } catch (cause) {
        error = errorValue(cause);
      }
      rows.push(
        normalize({
          state: state ?? null,
          ledger,
          cmds,
          sameState: previous === state,
          priorUnchanged:
            JSON.stringify(before) === JSON.stringify(normalize(previous)),
          commandsAreOwed: cmds.every((cmd) =>
            ledger.some(
              (event) => event.type === "effect_owed" && event.effect === cmd,
            ),
          ),
          survivors: flow.survivingActivities(log),
          serialized: state ? JSON.stringify(state) : null,
          folded,
          error,
        }),
      );
    }
    return rows;
  }
  let events = script.events.map(event),
    recorder = pendingEffectsLedger<unknown>(
      restoreUnknown(events, script.lastId),
    ),
    pure = emptyLedger<unknown>();
  const rows: unknown[] = [];
  for (const action of script.actions) {
    const previous = recorder.ledger();
    let result: unknown = null;
    switch (action.op) {
      case "owe": {
        const effect = decode(action.effect),
          owed = recorder.owe(effect);
        result = { ...owed, sameEffect: effect === owed.event.effect };
        events.push(owed.event);
        break;
      }
      case "confirm": {
        const confirmed = recorder.confirm(number(action.id));
        result = confirmed;
        events.push(confirmed.event);
        break;
      }
      case "apply":
        pure = applyEffectEvent(pure, event(action.event));
        break;
      case "fold":
        pure = foldLedger(
          (function* () {
            yield* action.events.map(event);
          })(),
        );
        break;
      case "recreate":
        recorder = pendingEffectsLedger(restoreUnknown(events, action.lastId));
        break;
      case "roundTrip":
        events = JSON.parse(JSON.stringify(events));
        recorder = pendingEffectsLedger({
          events: (function* () {
            yield* events;
          })(),
        });
        break;
      case "query":
        result = isOwed(previous, number(action.id));
        break;
    }
    rows.push(
      normalize({
        lastId: recorder.lastId(),
        survivors: recorder.surviving(),
        pure: survivingEffects(pure),
        sameLedger: previous === recorder.ledger(),
        previous: survivingEffects(previous),
        result,
        serializedEvents: JSON.stringify(events),
      }),
    );
  }
  return rows;
}
function restoreUnknown(
  events: Iterable<EffectLedgerEvent<unknown>>,
  lastId: z.infer<typeof seed>,
) {
  const result: {
    events: Iterable<EffectLedgerEvent<unknown>>;
    lastId?: number;
  } = { events };
  if (lastId !== undefined) Reflect.set(result, "lastId", decode(lastId));
  return result;
}
type Case = { id: string; script: Script };
function corpus(): Case[] {
  const cases: Case[] = [];
  const add = (id: string, script: unknown) =>
    cases.push({ id, script: workflowScript.parse(script) });
  for (const profile of ["promise", "effect"]) {
    for (const command of ["activity", "compensation"]) {
      for (const mode of ["success", "malformed", "undefined"]) {
        add(`workflow.transport.${profile}.${command}.${mode}`, {
          kind: "transport",
          profile,
          command,
          mode,
          index: 0,
          id: 4,
          payload: { $utf16: [0xd800] },
          at: 17.25,
        });
      }
    }
  }
  const steps = [
    {
      name: "reserve",
      activity: { op: "reserve" },
      compensation: { op: "release" },
    },
    { name: "notify", activity: "notify", compensation: { $undefined: true } },
    { name: "charge", activity: "charge", compensation: null },
    { name: "ship", activity: "ship" },
  ];
  add("workflow.forward-duplicate-and-replay", {
    kind: "workflow",
    steps,
    actions: [
      { op: "init" },
      {
        op: "deliver",
        route: false,
        message: { type: "activity_ok", id: 99, result: "stale" },
      },
      {
        op: "deliver",
        route: false,
        message: { type: "compensation_ok", id: 1 },
      },
      {
        op: "deliver",
        route: false,
        message: { type: "activity_ok", id: 1, result: "reserved" },
      },
      {
        op: "deliver",
        route: true,
        message: { type: "activity_ok", id: 1, result: "duplicate" },
      },
      { op: "roundTrip" },
      { op: "autoOk", result: { $undefined: true } },
      { op: "autoOk", result: null },
      { op: "autoOk", result: { ok: true } },
      {
        op: "deliver",
        route: false,
        message: { type: "activity_err", id: 4, failure: "late" },
      },
      {
        op: "fold",
        messages: [
          { type: "activity_ok", id: 1, result: "reserved" },
          { type: "activity_ok", id: 2, result: { $undefined: true } },
          { type: "activity_ok", id: 3, result: null },
          { type: "activity_ok", id: 4, result: { ok: true } },
        ],
      },
    ],
  });
  for (const inverse of ["ok", "err"]) {
    add(`workflow.rollback-${inverse}-restored`, {
      kind: "workflow",
      steps,
      actions: [
        { op: "init" },
        { op: "autoOk", result: 1 },
        { op: "autoOk", result: 2 },
        { op: "autoOk", result: 3 },
        { op: "autoErr", failure: { forward: "unavailable" } },
        {
          op: "deliver",
          route: false,
          message: { type: "activity_err", id: 5, failure: "wrong-channel" },
        },
        { op: "roundTrip" },
        {
          op: "deliver",
          route: false,
          message: { type: "compensation_ok", id: 5 },
        },
        { op: "roundTrip" },
        {
          op: "deliver",
          route: false,
          message:
            inverse === "ok"
              ? { type: "compensation_ok", id: 6 }
              : {
                  type: "compensation_err",
                  id: 6,
                  failure: { inverse: "offline" },
                },
        },
        {
          op: "deliver",
          route: true,
          message: { type: "compensation_ok", id: 6 },
        },
      ],
    });
  }
  add("workflow.no-inverse-fails", {
    kind: "workflow",
    steps: [{ name: "only", activity: null }],
    actions: [
      { op: "init" },
      { op: "deliver", route: false, message: { type: "activity_err", id: 1 } },
      { op: "roundTrip" },
      {
        op: "deliver",
        route: true,
        message: { type: "activity_ok", id: 1, result: 9 },
      },
    ],
  });
  add("workflow.repeated-init", {
    kind: "workflow",
    steps,
    actions: [
      { op: "init" },
      { op: "init" },
      { op: "init" },
      { op: "recreate", lastId: 0 },
      { op: "init" },
      { op: "surviving" },
    ],
  });
  for (const value of [
    null,
    0,
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
    { $number: "-0" },
    { $undefined: true },
  ]) {
    add(`workflow.counter-${JSON.stringify(value)}`, {
      kind: "workflow",
      steps,
      lastId: value,
      actions: [
        { op: "init" },
        ...(typeof value === "object" &&
        value !== null &&
        "$number" in value &&
        value.$number === "NaN"
          ? [{ op: "init" }]
          : [
              { op: "autoOk", result: { $undefined: true } },
              { op: "roundTrip" },
              { op: "autoErr", failure: { $undefined: true } },
              { op: "roundTrip" },
              { op: "autoOk" },
            ]),
      ],
    });
  }
  for (const index of [
    null,
    -1,
    -2,
    0.5,
    { $number: "NaN" },
    { $number: "Infinity" },
  ])
    add(`workflow.bounds-${JSON.stringify(index)}`, {
      kind: "workflow",
      steps,
      actions: [
        { op: "init" },
        { op: "current", index, id: 1 },
        { op: "autoOk", result: 9 },
        { op: "surviving" },
      ],
    });
  add("workflow.reverse-bounds", {
    kind: "workflow",
    steps,
    actions: [
      { op: "init" },
      { op: "autoOk", result: 1 },
      { op: "autoErr", failure: "bad" },
      { op: "current", index: null, id: 3 },
      { op: "autoOk" },
      { op: "surviving" },
    ],
  });
  add("workflow.lossless-text-and-absence", {
    kind: "workflow",
    steps: [
      { name: { $utf16: [0xd800] }, compensation: null },
      {
        name: "next",
        activity: { $object: [[{ $utf16: [0xdc00] }, { $undefined: true }]] },
      },
    ],
    actions: [
      { op: "init" },
      { op: "autoOk", result: { $utf16: [0xd800] } },
      { op: "roundTrip" },
      { op: "autoErr" },
      { op: "roundTrip" },
      { op: "autoOk" },
    ],
  });
  const history = [
    { type: "effect_owed", id: 1, effect: "gone" },
    { type: "effect_confirmed", id: 1 },
    { type: "effect_confirmed", id: 40 },
  ];
  for (const lastId of [
    undefined,
    { $undefined: true },
    null,
    0,
    2,
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
  ])
    add(`ledger.counter-${JSON.stringify(lastId)}`, {
      kind: "ledger",
      events: history,
      ...(lastId === undefined ? {} : { lastId }),
      actions: [
        { op: "owe", effect: "new" },
        { op: "confirm", id: 999 },
        { op: "query", id: 1 },
        { op: "roundTrip" },
        { op: "owe", effect: { $undefined: true } },
        { op: "recreate", lastId: null },
        { op: "owe", effect: null },
      ],
    });
  add("ledger.map-same-value-zero-and-order", {
    kind: "ledger",
    events: [],
    actions: [
      {
        op: "fold",
        events: [
          { type: "effect_owed", id: { $number: "-0" }, effect: "zero" },
          { type: "effect_owed", id: { $number: "NaN" }, effect: "old" },
          { type: "effect_owed", id: 2, effect: "two" },
          { type: "effect_owed", id: { $number: "NaN" }, effect: "new" },
          { type: "effect_owed", id: null, effect: null },
        ],
      },
      {
        op: "apply",
        event: { type: "effect_confirmed", id: { $number: "NaN" } },
      },
      {
        op: "apply",
        event: { type: "effect_owed", id: 0, effect: "replacement" },
      },
      { op: "apply", event: { type: "effect_confirmed", id: 99 } },
    ],
  });
  for (let run = 0; run < 24; run++) {
    const count = 1 + (run % 6),
      fail = run % 4 === 0 ? null : run % count,
      items = Array.from({ length: count }, (_, index) => ({
        name: `step-${index}`,
        activity: { run, index },
        ...(index % 3 === 0
          ? { compensation: null }
          : index % 3 === 1
            ? { compensation: { undo: index } }
            : {}),
      }));
    const actions: unknown[] = [{ op: "init" }];
    let id = 1;
    for (let index = 0; index < count; index++) {
      if (index === fail) {
        actions.push({
          op: "autoErr",
          failure: run % 2 === 0 ? { $undefined: true } : { forward: run },
        });
        const undo = items
          .slice(0, index)
          .filter((item) => Object.hasOwn(item, "compensation"))
          .reverse();
        for (let reverse = 0; reverse < undo.length; reverse++) {
          if (reverse === 1 && run % 5 === 0) {
            actions.push({ op: "autoErr", failure: { inverse: run } });
            break;
          }
          actions.push({ op: "autoOk" });
        }
        break;
      }
      actions.push({
        op: "deliver",
        route: index % 2 === 0,
        message: {
          type: "activity_ok",
          id: id++,
          result: index % 2 === 0 ? { $undefined: true } : { run, index },
        },
      });
      if (index % 2 === 0) actions.push({ op: "roundTrip" });
    }
    actions.push({ op: "surviving" });
    add(`workflow.generated-${run}`, {
      kind: "workflow",
      steps: items,
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
    "debug/workflow_driver",
  );
}
function build(cwd = process.cwd(), target?: string) {
  command(
    process.env.CARGO ?? "cargo",
    ["build", "--locked", "-p", "demlik-parity", "--bin", "workflow_driver"],
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
  const output = command(
    executable,
    [],
    `${cases.map((item) => JSON.stringify(item.script)).join("\n")}\n`,
  );
  return output
    .trim()
    .split("\n")
    .map((line) => response.parse(JSON.parse(line)));
}
const digest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const mutations = [
  {
    id: "ledger-seeds-from-survivors-only",
    file: "crates/tea/src/durable_effects.rs",
    needle: "for event in &restore.events {",
    replacement:
      "for event in restore.events.iter().filter(|event| is_owed(&ledger, match event.as_ref() { EffectLedgerEvent::Owed(event) => event.id, EffectLedgerEvent::Confirmed(event) => event.id })) {",
  },
  {
    id: "workflow-compensates-in-forward-order",
    file: "crates/tea/src/flow/workflow.rs",
    needle: "for index in (0..below).rev() {",
    replacement: "for index in 0..below {",
  },
  {
    id: "workflow-accepts-nonvoid-transport-output",
    file: "crates/tea/src/schema.rs",
    needle: "if matches!(value, PlainData::Undefined) {",
    replacement: "if true {",
  },
];
function controls(cases: Case[], expected: unknown[]) {
  return mutations.map((mutation) => {
    const temporary = mkdtempSync(join(tmpdir(), "demlik-workflow-control-")),
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
export async function verifyWorkflow(
  reportPath = "target/parity/workflow.json",
  binaryOverride?: string,
  mutationCheck = false,
) {
  if (!binaryOverride) build();
  const executable = binaryOverride ?? binary(),
    cases = corpus(),
    expected = await Promise.all(
      cases.map((item) => executeWorkflow(item.script)),
    ),
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
    const rows = z.array(z.unknown()).parse(expected[index]);
    return rows[position < 0 ? rows.length + position : position];
  };
  const forward = z
    .object({ state: z.object({ status: z.string(), output: z.unknown() }) })
    .parse(row("workflow.forward-duplicate-and-replay", -1));
  assert.equal(forward.state.status, "completed");
  assert.deepEqual(forward.state.output, { ok: true });
  for (const [caseId, issued] of [
    ["ledger.counter-undefined", 41],
    ["ledger.counter-null", 1],
  ] as const) {
    const first = z
      .object({ result: z.object({ id: z.number() }) })
      .parse(row(caseId, 0));
    assert.equal(first.result.id, issued);
  }
  const reversed = z
    .object({ cmds: z.array(z.object({ index: z.number() })) })
    .parse(row("workflow.rollback-ok-restored", 4));
  assert.deepEqual(
    reversed.cmds.map((command) => command.index),
    [2],
  );
  const settled = z.object({
    state: z.object({ messages: z.array(z.unknown()) }),
  });
  for (const command of ["activity", "compensation"]) {
    const promiseVoid = settled.parse(
      row(`workflow.transport.promise.${command}.undefined`, 0),
    );
    assert.deepEqual(promiseVoid.state.messages, []);
    const effectVoid = settled.parse(
      row(`workflow.transport.effect.${command}.undefined`, 0),
    );
    assert.equal(effectVoid.state.messages.length, 1);
    for (const profile of ["promise", "effect"]) {
      const malformed = settled.parse(
        row(`workflow.transport.${profile}.${command}.malformed`, 0),
      );
      const message = z
        .object({ type: z.string(), error: z.unknown(), at: z.number() })
        .parse(malformed.state.messages[0]);
      assert.equal(message.type, `workflow_${command}_err`);
      assert.equal(message.at, 17.25);
      assert.deepEqual(message.error, {
        _tag: "malformed_result",
        issues: [{ path: "", message: "expected no value" }],
      });
    }
  }
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  const report = {
    scope:
      "native durable workflow and pending-effect ledger; full port remains incomplete",
    passed: cases.length - failures.length,
    failures,
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      rustc: command(rustc, ["--version"]).trim(),
    },
    binary: { path: executable, sha256: digest(executable) },
    compared: cases.length,
    transitions: cases.reduce(
      (sum, item) =>
        sum +
        (item.script.kind === "transport" ? 1 : item.script.actions.length),
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
  const report = await verifyWorkflow(
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
      report: values.report ?? "target/parity/workflow.json",
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
