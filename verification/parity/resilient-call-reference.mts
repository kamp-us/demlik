import { createInterface } from "node:readline";
import { z } from "zod";
import {
  createResilientCall,
  liftResilience,
  runCmdDef,
  type SettleMsg,
} from "../../packages/tea/src/internal/resilience/resilient-call/index.ts";
import {
  cmdContractOver,
  type Outcome as HandlerOutcome,
  Outcome,
} from "../../packages/tea/src/pure/core.ts";

const number = z.custom<number>((value) => typeof value === "number");
const retry = z
  .object({
    baseMs: number,
    factor: number,
    capMs: number,
    jitter: z.enum(["none", "full", "equal"]),
  })
  .and(
    z.union([
      z.object({ maxElapsedMs: number, maxAttempts: number.optional() }),
      z.object({ maxAttempts: number }),
      z.object({ unbounded: z.literal(true) }),
    ]),
  );
const config = z.object({
  name: z.string().optional(),
  retry: retry.optional(),
  circuit: z
    .object({
      threshold: number,
      cooldownMs: number,
      halfOpenMaxProbes: number.optional(),
    })
    .optional(),
  rateLimit: z.object({ capacity: number, refillPerSec: number }).optional(),
  cache: z.object({ ttlMs: number }).optional(),
  deadline: z.object({ ms: number }).optional(),
});
const action = z.object({
  op: z.enum([
    "attempt",
    "ok",
    "err",
    "settleFailed",
    "resume",
    "timer",
    "fireNext",
    "engineOk",
    "engineErr",
    "runCtor",
    "runDef",
    "lift",
    "roundtrip",
    "inspect",
  ]),
  key: z.string().optional(),
  id: z.string().optional(),
  at: number.optional(),
  input: z.unknown().optional(),
  value: z.unknown().optional(),
  error: z.unknown().optional(),
});
const testCase = z.object({
  id: z.string(),
  input: z.object({
    config: config.default({}),
    rng: z.array(number).default([0.5]),
    actions: z.array(action),
  }),
});
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === "object") {
    if (Object.keys(value).length === 1 && "$number" in value) {
      switch (value.$number) {
        case "NaN":
          return NaN;
        case "Infinity":
          return Infinity;
        case "-Infinity":
          return -Infinity;
        default:
          throw new Error("unknown numeric marker");
      }
    }
    if (
      Object.keys(value).length === 1 &&
      "$undefined" in value &&
      value.$undefined === true
    )
      return undefined;
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, revive(value)]),
    );
  }
  return value;
}
function errorData(error: unknown) {
  if (!(error instanceof Error)) throw error;
  return {
    name: error.name,
    message: error.message,
    ...Object.fromEntries(Object.entries(error)),
  };
}
function settled(value: unknown): asserts value is SettleMsg<unknown, string> {
  z.object({ cmd: z.object({ key: z.string() }), at: number }).parse(value);
  if (
    value === null ||
    typeof value !== "object" ||
    !("value" in value || "error" in value)
  )
    throw new Error("engine outcome missing");
}
function declared(
  value: unknown,
): asserts value is { _tag: "port_rejected" | "deadline_exceeded" } {
  z.object({ _tag: z.enum(["port_rejected", "deadline_exceeded"]) }).parse(
    value,
  );
}
function execute(test: z.infer<typeof testCase>["input"]) {
  let rngCalls = 0;
  const rng = () => test.rng[Math.min(rngCalls++, test.rng.length - 1)] ?? 0.5;
  const rc = createResilientCall<unknown, unknown, string>(test.config, rng);
  let clock = 0;
  const edge = cmdContractOver([rc.run], () => clock);
  let state = rc.init();
  const history: unknown[] = [];
  for (const action of test.actions) {
    const before = state;
    const key = action.key ?? "key",
      at = action.at ?? 0;
    clock = at;
    let cmds: readonly unknown[] = [],
      outcome: unknown,
      message: unknown,
      error: unknown;
    try {
      switch (action.op) {
        case "attempt":
          [state, cmds] = rc.attempt(state, key, action.input, at);
          break;
        case "ok": {
          const result = rc.settle(state, {
            cmd: { key },
            value: action.value,
            at,
          });
          state = result.call;
          cmds = result.cmds;
          outcome = result.outcome;
          break;
        }
        case "err": {
          const result = rc.settle(state, {
            cmd: { key },
            error: action.error,
            at,
          });
          state = result.call;
          cmds = result.cmds;
          outcome = result.outcome;
          break;
        }
        case "settleFailed":
          [state, cmds] = rc.settleFailed(state, key, action.error, at);
          break;
        case "resume":
          state = rc.resume(state, at);
          break;
        case "timer":
          if (action.id === undefined) throw new Error("timer requires id");
          else [state, cmds] = rc.onTimer(state, { id: action.id, atMs: at });
          break;
        case "fireNext": {
          const timer = rc.timer(state);
          if (timer !== null) [state, cmds] = rc.onTimer(state, timer.msg);
          break;
        }
        case "engineOk":
        case "engineErr": {
          const command = rc.run({ key, input: action.input });
          let completion: HandlerOutcome<
            unknown,
            { _tag: "port_rejected" | "deadline_exceeded" }
          >;
          if (action.op === "engineOk") completion = Outcome.ok(action.value);
          else {
            declared(action.error);
            completion = Outcome.err(action.error);
          }
          message = edge.settle(command, completion);
          settled(message);
          const result = rc.settle(state, message);
          state = result.call;
          cmds = result.cmds;
          outcome = result.outcome;
          break;
        }
        case "runCtor":
          message = rc.run({ key, input: action.input });
          break;
        case "runDef":
          message = runCmdDef<unknown, unknown, string>(rc.name)({
            key,
            input: action.input,
          });
          break;
        case "lift": {
          const [host, commands] = liftResilience(
            { marker: "kept", resilience: state },
            [state, []],
          );
          message = host;
          state = host.resilience;
          cmds = commands;
          break;
        }
        case "roundtrip":
          state = JSON.parse(JSON.stringify(state));
          break;
        case "inspect":
          break;
      }
    } catch (cause) {
      error = errorData(cause);
    }
    history.push({
      state,
      cmds,
      same: state === before,
      deadlines: rc.deadlines(state),
      timer: rc.timer(state),
      ...(outcome === undefined ? {} : { outcome }),
      ...(message === undefined ? {} : { message }),
      ...(error === undefined ? {} : { error }),
    });
  }
  return {
    name: rc.name,
    run: {
      cmdType: rc.run.cmdType,
      okType: rc.run.okType,
      errType: rc.run.errType,
      errorTags: rc.run.errTags,
    },
    history,
    rngCalls,
  };
}
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const test = testCase.parse(revive(JSON.parse(line)));
    process.stdout.write(
      `${JSON.stringify({ id: test.id, ok: true, output: execute(test.input) })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: errorData(error) })}\n`,
    );
  }
}
