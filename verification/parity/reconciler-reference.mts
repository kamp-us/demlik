import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  createReconciler,
  liftReconciler,
  type ReconcilerState,
  type ScanPageErrMsg,
  type ScanPageOkMsg,
} from "../../packages/tea/src/internal/flow/reconciler/index.ts";
import { decode, errorValue, normalize } from "./timing-clock.mts";

const number = z.custom<number>((value) => typeof value === "number");
const config = z.object({
  desired: z.unknown().default(null),
  firstPage: z.unknown().optional(),
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
  items: z.enum(["field", "empty", "one"]).default("field"),
  diff: z.enum(["plan", "actual"]).default("plan"),
  plan: z.array(z.unknown()).default([]),
  identity: z.enum(["json", "field", "constant"]).default("json"),
  constantId: z.string().default("id"),
  throw: z.enum(["next", "items", "diff", "id", "apply"]).optional(),
  cause: z.unknown().default({ code: "sentinel" }),
});
const action = z.object({
  op: z.enum([
    "scan",
    "ok",
    "err",
    "planned",
    "applyNext",
    "applied",
    "timer",
    "fireNext",
    "roundtrip",
    "fetchCtor",
    "lift",
    "setCursor",
    "inspect",
  ]),
  at: number.default(0),
  key: z.string().default("page"),
  id: z.string().optional(),
  input: z.unknown().optional(),
  value: z.unknown().optional(),
  error: z.unknown().optional(),
  change: z.unknown().optional(),
  changes: z.array(z.unknown()).nullish(),
  cursor: number.optional(),
});
const inputSchema = z.object({
  config: config.prefault({}),
  callbacks: callbacks.prefault({}),
  rng: z.array(number).default([0.5]),
  seedRaw: z.string().optional(),
  actions: z.array(action),
});
function okMessage(value: unknown): asserts value is ScanPageOkMsg<unknown> {
  z.object({
    type: z.literal("resilient_run_ok"),
    cmd: z.object({ type: z.literal("resilient_run"), key: z.string() }),
    at: number,
    value: z.unknown(),
  }).parse(value);
}
function errMessage(value: unknown): asserts value is ScanPageErrMsg {
  z.object({
    type: z.literal("resilient_run_err"),
    cmd: z.object({ type: z.literal("resilient_run"), key: z.string() }),
    at: number,
    error: z.unknown(),
  }).parse(value);
}
export function executeReconciler(raw: unknown) {
  const input = inputSchema.parse(decode(raw)),
    trace: string[] = [];
  let rngCalls = 0;
  const failed = (phase: string) => ({
    kind: "callback_failed",
    phase,
    cause: input.callbacks.cause,
  });
  function objectField(value: unknown, key: string, kind: string): unknown {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw { kind, field: key };
    return Reflect.get(value, key);
  }
  const rec = createReconciler<
    unknown,
    unknown,
    unknown,
    unknown,
    { type: "apply_change"; change: unknown },
    unknown
  >(
    {
      ...input.config,
      desired: input.config.desired ?? null,
      firstPage: input.config.firstPage,
      nextCursor: (page) => {
        trace.push("next");
        if (input.callbacks.throw === "next") throw failed("next");
        if (input.callbacks.next === "end") return null;
        if (input.callbacks.next === "undefined") return undefined;
        return objectField(page, "next", "invalid_page");
      },
      itemsOf: (page) => {
        trace.push("items");
        if (input.callbacks.throw === "items") throw failed("items");
        if (input.callbacks.items === "empty") return [];
        if (input.callbacks.items === "one") return [page];
        const items = objectField(page, "items", "invalid_page");
        if (!Array.isArray(items))
          throw { kind: "invalid_page", field: "items" };
        return items;
      },
      diff: (_desired, actual) => {
        trace.push("diff");
        if (input.callbacks.throw === "diff") throw failed("diff");
        return input.callbacks.diff === "plan"
          ? input.callbacks.plan
          : actual.map((value) => value);
      },
      apply: (change) => {
        trace.push("apply");
        if (input.callbacks.throw === "apply") throw failed("apply");
        return { type: "apply_change", change };
      },
      ...(input.callbacks.identity === "json"
        ? {}
        : {
            idOf: (change) => {
              trace.push("id");
              if (input.callbacks.throw === "id") throw failed("id");
              if (input.callbacks.identity === "constant")
                return input.callbacks.constantId;
              const id = objectField(change, "id", "invalid_change");
              if (typeof id !== "string")
                throw { kind: "invalid_change", field: "id" };
              return id;
            },
          }),
    },
    () => input.rng[Math.min(rngCalls++, input.rng.length - 1)] ?? 0.5,
  );
  let state: ReconcilerState<unknown, unknown, unknown, unknown> =
    input.seedRaw === undefined ? rec.init() : JSON.parse(input.seedRaw);
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
        case "scan":
          [state, cmds] = rec.scan(state, action.at);
          break;
        case "ok": {
          const msg = {
            type: "resilient_run_ok",
            cmd: rec.scanPage({ key: action.key, input: action.input }),
            value: action.value,
            at: action.at,
          };
          okMessage(msg);
          [state, cmds] = rec.pageOk(state, msg);
          break;
        }
        case "err": {
          const msg = {
            type: "resilient_run_err",
            cmd: rec.scanPage({ key: action.key, input: action.input }),
            error: action.error,
            at: action.at,
          };
          errMessage(msg);
          [state, cmds] = rec.pageErr(state, msg);
          break;
        }
        case "planned":
          [state, cmds] = rec.planned(
            state,
            action.at,
            action.changes ?? undefined,
          );
          break;
        case "applyNext":
          [state, cmds] = rec.applyNext(state, action.at);
          break;
        case "applied":
          [state, cmds] = rec.applied(state, action.change, action.at);
          break;
        case "timer":
          if (action.id === undefined) throw new Error("timer requires id");
          [state, cmds] = rec.onTimer(state, {
            type: "deadline_exceeded",
            id: action.id,
            atMs: action.at,
          });
          break;
        case "fireNext": {
          const timer = rec.timer(state);
          if (timer !== null) [state, cmds] = rec.onTimer(state, timer.msg);
          break;
        }
        case "roundtrip":
          json = JSON.stringify(state);
          state = JSON.parse(json);
          break;
        case "fetchCtor":
          message = rec.scanPage({ key: action.key, input: action.input });
          break;
        case "lift": {
          const [host, commands] = liftReconciler(
            { marker: "kept", rec: state },
            [state, []],
          );
          message = host;
          state = host.rec;
          cmds = commands;
          break;
        }
        case "setCursor":
          if (action.cursor === undefined)
            throw new Error("setCursor requires cursor");
          state = { ...state, appliedCursor: action.cursor };
          break;
        case "inspect":
          break;
      }
    } catch (cause) {
      error = errorValue(cause);
    }
    const call = state.walk.resilience.calls.page;
    history.push(
      normalize({
        op: action.op,
        state,
        cmds,
        callbacks: [...trace],
        same: state === before,
        walkSame: state.walk === before.walk,
        actualSame: state.actual === before.actual,
        planSame: state.plan === before.plan,
        ledgerSame: state.applied === before.applied,
        beforeUnchanged: beforeData === JSON.stringify(normalize(before)),
        complete: rec.isComplete(state),
        scanFailure: call?.phase === "failed" ? call.error : undefined,
        deadlines: rec.deadlines(state),
        timer: rec.timer(state),
        ...(error === undefined ? {} : { error }),
        ...(message === undefined ? {} : { message }),
        ...(json === undefined ? {} : { json }),
      }),
    );
  }
  return {
    scanPage: {
      cmdType: rec.scanPage.cmdType,
      okType: rec.scanPage.okType,
      errType: rec.scanPage.errType,
      errorTags: rec.scanPage.errTags,
    },
    initial,
    history,
    rngCalls,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      const request = z
        .object({ id: z.string(), input: z.unknown() })
        .parse(JSON.parse(line));
      process.stdout.write(
        `${JSON.stringify({ id: request.id, ok: true, output: executeReconciler(request.input) })}\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: errorValue(error) })}\n`,
      );
    }
  }
}
