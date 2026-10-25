import { createInterface } from "node:readline";
import { z } from "zod";
import {
  createPaginatedWalk,
  liftWalk,
  type PageErrMsg,
  type PageOkMsg,
  type PaginatedWalkState,
} from "../../packages/tea/src/internal/paginate/paginated-walk/index.ts";
import { decode, errorValue, normalize } from "./timing-clock.mts";

const number = z.custom<number>((value) => typeof value === "number");
const config = z.object({
  firstPage: z.unknown().optional(),
  highWaterMark: number.optional(),
  retry: z
    .object({
      baseMs: number,
      factor: number,
      capMs: number,
      jitter: z.enum(["none", "full", "equal"]),
      maxAttempts: number,
    })
    .optional(),
  circuit: z
    .object({
      threshold: number,
      cooldownMs: number,
      halfOpenMaxProbes: number.optional(),
    })
    .optional(),
  rateLimit: z.object({ capacity: number, refillPerSec: number }).optional(),
  deadline: z.object({ ms: number }).optional(),
});
const callbacks = z.object({
  next: z.enum(["field", "end", "undefined"]).default("field"),
  pageSize: z.enum(["default", "field", "literal"]).default("default"),
  size: number.default(1),
  onPage: z.enum(["emit", "none"]).default("emit"),
  emits: z.number().int().min(0).max(4).default(1),
  throw: z.enum(["size", "next", "onPage"]).optional(),
  cause: z.unknown().default({ code: "sentinel" }),
});
const action = z.object({
  op: z.enum([
    "start",
    "resume",
    "ok",
    "err",
    "timer",
    "fireNext",
    "drain",
    "roundtrip",
    "inspect",
    "fetchCtor",
    "lift",
  ]),
  at: number.default(0),
  key: z.string().default("page"),
  id: z.string().optional(),
  n: number.optional(),
  input: z.unknown().optional(),
  value: z.unknown().optional(),
  error: z.unknown().optional(),
});
const request = z.object({
  id: z.string(),
  input: z.object({
    config: config.default({}),
    callbacks: callbacks.prefault({}),
    rng: z.array(number).default([0.5]),
    seedRaw: z.string().optional(),
    actions: z.array(action),
  }),
});
function okMessage(value: unknown): asserts value is PageOkMsg<unknown> {
  z.object({
    type: z.literal("resilient_run_ok"),
    cmd: z.object({ type: z.literal("resilient_run"), key: z.string() }),
    at: number,
    value: z.unknown(),
  }).parse(value);
}
function errMessage(value: unknown): asserts value is PageErrMsg {
  // Raw terminal frames are deliberately observed here as well as typed engine
  // completions in the native Runtime consumer. The pure verb does not parse E.
  z.object({
    type: z.literal("resilient_run_err"),
    cmd: z.object({ type: z.literal("resilient_run"), key: z.string() }),
    at: number,
    error: z.unknown(),
  }).parse(value);
}
function execute(input: z.infer<typeof request>["input"]) {
  const trace: string[] = [];
  const failed = (phase: string) => ({
    kind: "callback_failed",
    phase,
    cause: input.callbacks.cause,
  });
  function pageField(page: unknown, field: string): unknown {
    if (page === null || typeof page !== "object" || Array.isArray(page))
      throw { kind: "invalid_page", field };
    return Reflect.get(page, field);
  }
  let rngCalls = 0;
  const knob = createPaginatedWalk<
    unknown,
    unknown,
    { type: "process_page"; page: unknown; ordinal: number }
  >(
    {
      ...input.config,
      firstPage: input.config.firstPage,
      nextCursor: (page) => {
        trace.push("next");
        if (input.callbacks.throw === "next") throw failed("next");
        if (input.callbacks.next === "end") return null;
        if (input.callbacks.next === "undefined") return undefined;
        return pageField(page, "next");
      },
      onPage: (page) => {
        trace.push("onPage");
        if (input.callbacks.throw === "onPage") throw failed("onPage");
        return input.callbacks.onPage === "none"
          ? []
          : Array.from({ length: input.callbacks.emits }, (_, ordinal) => ({
              type: "process_page",
              page,
              ordinal,
            }));
      },
      ...(input.callbacks.pageSize === "default"
        ? {}
        : {
            pageSize: (page: unknown) => {
              trace.push("size");
              if (input.callbacks.throw === "size") throw failed("size");
              if (input.callbacks.pageSize === "literal")
                return input.callbacks.size;
              const value = pageField(page, "size");
              if (value === undefined) return 1;
              if (typeof value !== "number")
                throw { kind: "invalid_page", field: "size" };
              return value;
            },
          }),
    },
    () => input.rng[Math.min(rngCalls++, input.rng.length - 1)] ?? 0.5,
  );
  let state: PaginatedWalkState<unknown, unknown> =
    input.seedRaw === undefined ? knob.init() : JSON.parse(input.seedRaw);
  const initial = normalize(state),
    history: unknown[] = [];
  for (const action of input.actions) {
    const before = state,
      beforeData = JSON.stringify(normalize(before));
    trace.length = 0;
    let cmds: readonly unknown[] = [],
      error: unknown,
      message: unknown,
      json: string | undefined;
    try {
      switch (action.op) {
        case "start":
          [state, cmds] = knob.start(state, action.at);
          break;
        case "resume":
          [state, cmds] = knob.resume(state, action.at);
          break;
        case "ok": {
          const msg = {
            type: "resilient_run_ok",
            cmd: knob.fetch({ key: action.key, input: action.input }),
            value: action.value,
            at: action.at,
          };
          okMessage(msg);
          [state, cmds] = knob.pageOk(state, msg);
          break;
        }
        case "err": {
          const msg = {
            type: "resilient_run_err",
            cmd: knob.fetch({ key: action.key, input: action.input }),
            error: action.error,
            at: action.at,
          };
          errMessage(msg);
          [state, cmds] = knob.pageErr(state, msg);
          break;
        }
        case "timer":
          if (action.id === undefined) throw new Error("timer requires id");
          [state, cmds] = knob.onTimer(state, {
            type: "deadline_exceeded",
            id: action.id,
            atMs: action.at,
          });
          break;
        case "fireNext": {
          const timer = knob.timer(state);
          if (timer !== null) [state, cmds] = knob.onTimer(state, timer.msg);
          break;
        }
        case "drain":
          if (action.n === undefined) throw new Error("drain requires n");
          [state, cmds] = knob.drain(state, action.n);
          break;
        case "roundtrip":
          json = JSON.stringify(state);
          state = JSON.parse(json);
          break;
        case "fetchCtor":
          message = knob.fetch({ key: action.key, input: action.input });
          break;
        case "lift": {
          const [host, commands] = liftWalk({ marker: "kept", walk: state }, [
            state,
            [],
          ]);
          message = host;
          state = host.walk;
          cmds = commands;
          break;
        }
        case "inspect":
          break;
      }
    } catch (cause) {
      error = errorValue(cause);
    }
    history.push(
      normalize({
        op: action.op,
        state,
        cmds,
        same: state === before,
        walkSame: state.walk === before.walk,
        resilienceSame: state.resilience === before.resilience,
        beforeUnchanged: beforeData === JSON.stringify(normalize(before)),
        callbacks: [...trace],
        complete: knob.isComplete(state),
        stuck: knob.isStuck(state),
        failure: knob.failure(state),
        deadlines: knob.deadlines(state),
        timer: knob.timer(state),
        ...(error === undefined ? {} : { error }),
        ...(message === undefined ? {} : { message }),
        ...(json === undefined ? {} : { json }),
      }),
    );
  }
  return {
    fetch: {
      cmdType: knob.fetch.cmdType,
      okType: knob.fetch.okType,
      errType: knob.fetch.errType,
      errorTags: knob.fetch.errTags,
    },
    initial,
    history,
    rngCalls,
  };
}
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const test = request.parse(decode(JSON.parse(line)));
    process.stdout.write(
      `${JSON.stringify({ id: test.id, ok: true, output: execute(test.input) })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: errorValue(error) })}\n`,
    );
  }
}
