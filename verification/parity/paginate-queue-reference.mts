import { createInterface } from "node:readline";
import { z } from "zod";
import {
  defaultPaginatorPolicy,
  drain,
  initPaginator,
  isDone,
  type PaginatorState,
  recordPage,
  resume,
  start,
} from "../../packages/tea/src/internal/paginate/paginator/index.ts";
import { queueAdapter } from "../../packages/tea/src/internal/work-queue/adapter.ts";
import {
  createQueue,
  type QueueItem,
} from "../../packages/tea/src/internal/work-queue/index.ts";
import {
  claimNextOp,
  enqueueOp,
  markDoneOp,
  patchItemOp,
  removeOp,
  resetRunningOp,
} from "../../packages/tea/src/internal/work-queue/ops.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";
import {
  refuse,
  StoreRefusedError,
} from "../../packages/tea/src/runtime-types.ts";
import { decode, normalize, numeric } from "./timing-clock.mts";

const pageAction = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["start", "resume", "done", "roundTrip"]) }),
  z.object({
    op: z.literal("record"),
    count: numeric,
    next: z.unknown().optional(),
  }),
  z.object({ op: z.literal("drain"), n: numeric }),
]);
const counter = { seen: numeric, pages: numeric };
const pageState = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle"), ...counter }),
  z.object({ phase: z.literal("done"), ...counter }),
  z.object({ phase: z.literal("fetching"), cursor: z.unknown(), ...counter }),
  z.object({ phase: z.literal("paused"), cursor: z.unknown(), ...counter }),
]);
function paginator(raw: unknown) {
  const input = z
    .object({
      first: z.unknown().optional(),
      highWaterMark: numeric.default(1000),
      defaults: z.boolean().default(false),
      seedRaw: z.string().optional(),
      initial: pageState.optional(),
      actions: z.array(pageAction),
    })
    .parse(raw);
  const policy = input.defaults
    ? defaultPaginatorPolicy
    : {
        firstCursor: decode(input.first),
        highWaterMark: input.highWaterMark,
      };
  let state: PaginatorState<unknown> =
    input.seedRaw === undefined
      ? (input.initial ?? initPaginator())
      : JSON.parse(input.seedRaw);
  if (
    input.seedRaw === undefined &&
    (state.phase === "fetching" || state.phase === "paused")
  )
    state = { ...state, cursor: decode(state.cursor) };
  const initial = normalize(state);
  const observations: unknown[] = [];
  const cursor = (s: PaginatorState<unknown>) =>
    s.phase === "fetching" || s.phase === "paused" ? s.cursor : undefined;
  for (const action of input.actions) {
    const old = state;
    let json: string | undefined;
    switch (action.op) {
      case "start":
        state = start(state, policy);
        break;
      case "resume":
        state = resume(state, policy);
        break;
      case "record":
        state = recordPage(state, action.count, decode(action.next), policy);
        break;
      case "drain":
        state = drain(state, action.n);
        break;
      case "roundTrip":
        json = JSON.stringify(state);
        state = JSON.parse(json);
        break;
      case "done":
        break;
    }
    observations.push({
      op: action.op,
      state: normalize(state),
      same: old === state,
      cursorSame: cursor(old) === cursor(state),
      done: isDone(state),
      ...(json === undefined ? {} : { json }),
    });
  }
  return { initial, observations };
}

const queueAction = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("enqueue"),
    input: z.unknown(),
    id: z.unknown(),
    at: numeric.default(0),
  }),
  z.object({
    op: z.literal("mutateList"),
    input: z.unknown(),
    id: z.unknown(),
    at: numeric.default(0),
  }),
  z.object({ op: z.literal("claim"), at: numeric.default(0) }),
  z.object({
    op: z.enum(["done", "remove", "cancel", "retry"]),
    id: z.unknown(),
    at: numeric.default(0),
  }),
  z.object({
    op: z.literal("fail"),
    id: z.unknown(),
    error: z.unknown(),
    at: numeric.default(0),
  }),
  z.object({ op: z.literal("bind"), id: z.unknown(), value: z.unknown() }),
  z.object({
    op: z.literal("patch"),
    id: z.unknown(),
    same: z.boolean().default(false),
    status: z
      .enum(["pending", "running", "done", "failed", "cancelled"])
      .optional(),
  }),
  z.object({
    op: z.literal("mutateInput"),
    index: z.number().int().nonnegative(),
    key: z.unknown(),
    value: z.unknown(),
  }),
  z.object({ op: z.enum(["reset", "roundTrip", "list"]) }),
]);
type Action = z.output<typeof queueAction>;
function inputQueue(seedRaw?: string): QueueItem<unknown>[] {
  return seedRaw === undefined ? [] : JSON.parse(seedRaw);
}
function patch(
  queue: readonly QueueItem<unknown>[],
  action:
    | Extract<Action, { op: "fail" }>
    | Extract<Action, { op: "bind" }>
    | Extract<Action, { op: "cancel" | "retry" | "done" | "remove" }>,
) {
  return patchItemOp(queue, String(decode(action.id)), (item) => {
    if (action.op === "fail")
      return {
        ...item,
        status: "failed",
        finishedAt: action.at,
        error: String(decode(action.error)),
      };
    if (action.op === "cancel")
      return { ...item, status: "cancelled", finishedAt: action.at };
    if (action.op === "bind")
      return { ...item, output: String(decode(action.value)) };
    if (action.op === "retry")
      return {
        ...item,
        status: "pending",
        startedAt: undefined,
        finishedAt: undefined,
        error: undefined,
        output: undefined,
      };
    return item;
  });
}
function queue(raw: unknown) {
  const input = z
    .object({
      seedRaw: z.string().optional(),
      adapter: z.boolean().default(false),
      actions: z.array(queueAction),
    })
    .parse(raw);
  const verbs = queueAdapter<unknown>();
  let state = inputQueue(input.seedRaw);
  const initial = normalize(state),
    history = [state];
  const observations: unknown[] = [];
  for (const action of input.actions) {
    const old = state;
    let changed: boolean | null = null,
      item: QueueItem<unknown> | null = null,
      json: string | undefined;
    switch (action.op) {
      case "enqueue": {
        const result = (input.adapter ? verbs.enqueue : enqueueOp)(
          state,
          decode(action.input),
          action.at,
          String(decode(action.id)),
        );
        state = result.next;
        item = result.item;
        break;
      }
      case "mutateList":
        state.push(
          enqueueOp(
            [],
            decode(action.input),
            action.at,
            String(decode(action.id)),
          ).item,
        );
        break;
      case "claim": {
        const result = (input.adapter ? verbs.claim : claimNextOp)(
          state,
          action.at,
        );
        if (result) {
          state = result.next;
          item = result.claimed;
        }
        break;
      }
      case "done":
      case "remove": {
        const result = (
          action.op === "remove"
            ? removeOp
            : input.adapter
              ? verbs.markDone
              : markDoneOp
        )(state, String(decode(action.id)));
        state = result.next;
        changed = result.changed;
        break;
      }
      case "patch": {
        const result = (input.adapter ? verbs.patch : patchItemOp)(
          state,
          String(decode(action.id)),
          (item) =>
            action.same
              ? item
              : { ...item, status: action.status ?? item.status },
        );
        state = result.next;
        changed = result.changed;
        break;
      }
      case "reset": {
        const result = resetRunningOp(state);
        state = result.next;
        changed = result.changed;
        break;
      }
      case "cancel":
      case "retry":
      case "fail":
      case "bind": {
        const result = patch(state, action);
        state = result.next;
        changed = result.changed;
        break;
      }
      case "mutateInput": {
        const payload = state[action.index]?.input;
        if (payload !== null && typeof payload === "object")
          Reflect.set(
            payload,
            String(decode(action.key)),
            decode(action.value),
          );
        break;
      }
      case "roundTrip":
        json = JSON.stringify(state);
        state = JSON.parse(json);
        break;
      case "list":
        break;
    }
    observations.push({
      op: action.op,
      state: normalize(state),
      same: old === state,
      oldItems: state.map((item) => old.indexOf(item)),
      changed,
      item: normalize(item),
      itemIndex: item === null ? null : state.indexOf(item),
      ...(json === undefined ? {} : { json }),
    });
    history.push(state);
  }
  return { initial, observations, historyAtEnd: normalize(history) };
}

async function stored(raw: unknown) {
  const input = z
    .object({
      seedRaw: z.string().optional(),
      actions: z.array(queueAction),
      migrate: z
        .enum(["identity", "refuse", "fresh", "throw"])
        .default("identity"),
      reason: z.string().default("unsupported queue"),
      fault: z.unknown().optional(),
      failLoadAt: z.number().int().optional(),
      failSaveAt: z.number().int().optional(),
    })
    .parse(raw);
  const fault = decode(input.fault);
  const events: unknown[] = [];
  let loads = 0,
    saves = 0,
    clockCalls = 0,
    idCalls = 0,
    now = 0,
    id = "generated";
  const memory = memoryStore<QueueItem<unknown>[]>(
    input.seedRaw === undefined ? null : inputQueue(input.seedRaw),
  );
  const store = {
    async load() {
      loads++;
      events.push({ kind: "load" });
      if (loads === input.failLoadAt) throw fault;
      return memory.load();
    },
    migrate(raw: unknown) {
      events.push({ kind: "migrate" });
      if (input.migrate === "refuse") return refuse(input.reason);
      if (input.migrate === "fresh") return null;
      if (input.migrate === "throw") throw fault;
      return memory.migrate(raw);
    },
    async save(state: QueueItem<unknown>[]) {
      saves++;
      events.push({ kind: "save", state: normalize(state) });
      if (saves === input.failSaveAt) throw fault;
      await memory.save(state);
    },
  };
  const originalNow = Date.now;
  const originalCrypto = globalThis.crypto;
  Date.now = () => {
    clockCalls++;
    return now;
  };
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      randomUUID: () => {
        idCalls++;
        return id;
      },
    },
  });
  try {
    const queue = createQueue(store),
      observations: unknown[] = [];
    for (const action of input.actions) {
      let result: unknown, error: unknown;
      if ("at" in action) now = action.at;
      if (action.op === "enqueue") id = String(decode(action.id));
      try {
        switch (action.op) {
          case "enqueue":
            result = await queue.enqueue(decode(action.input));
            break;
          case "mutateList": {
            const list = await queue.list();
            list.push(
              enqueueOp(
                [],
                decode(action.input),
                action.at,
                String(decode(action.id)),
              ).item,
            );
            break;
          }
          case "mutateInput": {
            const list = await queue.list(),
              payload = list[action.index]?.input;
            if (payload !== null && typeof payload === "object")
              Reflect.set(
                payload,
                String(decode(action.key)),
                decode(action.value),
              );
            break;
          }
          case "claim":
            result = await queue.claimNext();
            break;
          case "done":
            await queue.markDone(String(decode(action.id)));
            break;
          case "remove":
            await queue.removeItem(String(decode(action.id)));
            break;
          case "fail":
            await queue.markFailed(
              String(decode(action.id)),
              String(decode(action.error)),
            );
            break;
          case "cancel":
            await queue.markCancelled(String(decode(action.id)));
            break;
          case "retry":
            await queue.retryItem(String(decode(action.id)));
            break;
          case "bind":
            await queue.bindOutput(
              String(decode(action.id)),
              String(decode(action.value)),
            );
            break;
          case "reset":
            await queue.resetRunningToPending();
            break;
          case "list":
            result = await queue.list();
            break;
          default:
            throw new Error("action is not a stored queue verb");
        }
      } catch (cause) {
        error =
          cause instanceof StoreRefusedError
            ? {
                kind: "restore",
                name: cause.name,
                tag: cause._tag,
                reason: cause.reason,
                ...(Object.hasOwn(cause, "cause")
                  ? { cause: normalize(cause.cause) }
                  : {}),
              }
            : { kind: "save", cause: normalize(cause) };
      }
      observations.push({
        op: action.op,
        ...(error === undefined ? { result: normalize(result) } : { error }),
        cell: normalize(await memory.load()),
        clockCalls,
        idCalls,
      });
    }
    return { observations, events, loads, saves };
  } finally {
    Date.now = originalNow;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: originalCrypto,
    });
  }
}
async function defaults() {
  const queue = createQueue(memoryStore<QueueItem<string>[]>());
  const first = await queue.enqueue("first"),
    second = await queue.enqueue("second");
  const list = await queue.list();
  const uuid =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  return {
    unique: first.id !== second.id,
    uuidV4: [first, second].map((item) => uuid.test(item.id)),
    integerEpoch: [first, second].map(
      (item) => Number.isInteger(item.enqueuedAt) && item.enqueuedAt > 1e12,
    ),
    input: list.map((item) => item.input),
    statuses: list.map((item) => item.status),
    sharedItem: list[0] === first,
  };
}
const operations: Record<string, (input: unknown) => unknown> = {
  "paginate.paginator": paginator,
  "queue.pure": queue,
  "queue.store": stored,
  "queue.defaults": defaults,
};
for await (const line of createInterface({ input: process.stdin })) {
  const input = z
    .object({ id: z.string(), operation: z.string(), input: z.unknown() })
    .parse(JSON.parse(line));
  try {
    const execute = operations[input.operation];
    if (!execute) throw new Error(`unsupported operation ${input.operation}`);
    process.stdout.write(
      `${JSON.stringify({ id: input.id, ok: true, output: await execute(input.input) })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id: input.id, ok: false, error: { kind: "driver_error", message: String(error) } })}\n`,
    );
  }
}
