import readline from "node:readline";
import { Effect, Exit, Scope } from "effect";
import { z } from "zod";
import {
  brainHandler,
  PLAIN_MODEL_MISROUTE_REASON,
  plainModel,
} from "../../packages/tea/src/agent/model.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import type {
  LlmFailMsg,
  LlmRunCmd,
  LlmSucceedMsg,
} from "../../packages/tea/src/internal/llm-call/index.ts";
import {
  createLlmCall,
  type LlmCall,
  type Schema,
} from "../../packages/tea/src/internal/llm-call/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import type { Machine, Sub } from "../../packages/tea/src/pure/core.ts";

const scriptSchema = z
  .object({
    style: z.enum(["factory", "plain", "wrapped"]),
    noLoader: z.boolean().default(false),
    failure: z
      .enum(["factory", "loader", "bind", "invoke", "parse1", "parse2"])
      .optional(),
    transform: z.boolean().default(false),
    validateModel: z.boolean().default(false),
    differentSchema: z.boolean().default(false),
    value: z.number().default(0),
    model: z.string().nullable().default(null),
    purpose: z.string().default("turn"),
    key: z.string().nullable().optional(),
    reason: z.string().default("original"),
    repeats: z.number().int().min(1).max(3).default(1),
    undefinedCause: z.boolean().default(false),
  })
  .strict();
type Script = z.infer<typeof scriptSchema>;
type Token = { value: number };
type Message = { token: Token };
type Answer = { value: number; opaque: Token };
function snapshotError(cause: unknown) {
  if (cause === undefined) return { $value: "undefined" };
  if (cause instanceof Error)
    return { error: { name: cause.name, message: cause.message } };
  return cause;
}
function setup(script: Script) {
  const token = { value: 1 },
    raw: Answer = { value: script.value, opaque: token },
    cause = script.undefinedCause ? undefined : new Error(script.reason),
    messages = [{ token }];
  const trace: string[] = [],
    seenMessages: Array<readonly Message[]> = [],
    factoryModels: Array<string | null> = [],
    retainedCalls: Array<LlmCall<string>> = [];
  let reads = 0,
    parses = 0,
    lastParsed: Answer | undefined,
    firstParsed: Answer | undefined,
    boundSame = false,
    modelSame = false,
    inputSame = false,
    payloadSame = false;
  const parser = (second: boolean): Schema<Answer> => ({
    parse(value: unknown) {
      trace.push(second ? "parse:second" : "parse:first");
      parses++;
      if (
        (script.failure === "parse1" && parses === 1) ||
        (script.failure === "parse2" && parses === 2)
      )
        throw cause;
      const parsed = z
        .custom<Answer>(
          (value) =>
            value !== null &&
            typeof value === "object" &&
            typeof Reflect.get(value, "value") === "number" &&
            Reflect.get(value, "opaque") === token,
        )
        .parse(value);
      const result = script.transform
        ? { value: parsed.value + (second ? 2 : 1), opaque: parsed.opaque }
        : parsed;
      if (parses === 1) firstParsed = result;
      lastParsed = result;
      return result;
    },
  });
  const first = parser(false),
    second = script.differentSchema ? parser(true) : first;
  const schemas = Object.defineProperty(Object.create(null), script.purpose, {
    get() {
      trace.push(`schema:${++reads}`);
      return reads === 1 ? first : second;
    },
  });
  const llm = createLlmCall<string, Record<string, Answer>>({ schemas });
  const input: LlmCall<string> = {
    purpose: script.purpose,
    model: script.model,
    payload: token,
  };
  const [initial, commands] = llm.attempt(
    llm.init(),
    input,
    0,
    script.key ?? script.purpose,
  );
  const cmd = commands[0];
  const invoke = (received: readonly Message[], plain: boolean) => {
    trace.push(
      plain
        ? script.style === "wrapped"
          ? "plain-sync-prefix"
          : "plain"
        : "invoke",
    );
    for (const message of received)
      if (message.token !== token) throw new Error("message identity changed");
    seenMessages.push(received);
    if (script.failure === "invoke") throw cause;
    return raw;
  };
  const client = {
    withStructuredOutput<T>(schema: Schema<T>) {
      trace.push("bind");
      boundSame = schema === first;
      modelSame = this === client;
      if (script.failure === "bind") throw cause;
      return {
        invoke: async (received: readonly Message[]) => {
          const value = invoke(received, false);
          return (script.validateModel ? schema.parse(value) : value) as T;
        },
      };
    },
  };
  const factory = (modelId: string | null) => {
    trace.push("factory");
    factoryModels.push(modelId);
    if (script.failure === "factory") throw cause;
    return client;
  };
  const plain = async (received: readonly Message[]) => invoke(received, true);
  const wrapped = (received: readonly Message[]) => {
    try {
      return Promise.resolve(invoke(received, true));
    } catch (cause) {
      return Promise.reject(cause);
    }
  };
  const model =
    script.style === "factory"
      ? factory
      : script.style === "plain"
        ? plain
        : plainModel(wrapped);
  const handler = brainHandler(llm, {
    model,
    ...(script.noLoader
      ? {}
      : {
          loadMessages: async (call) => {
            trace.push("loader");
            retainedCalls.push(call);
            inputSame = call === input;
            payloadSame = call.payload === token;
            if (script.failure === "loader") throw cause;
            return messages;
          },
        }),
  });
  const view = (out: Awaited<ReturnType<typeof handler>>) => {
    if (out._tag === "Ok")
      return {
        kind: "ok",
        key: out.value.key,
        purpose: out.value.purpose,
        output: out.value.output,
        rawSame: out.value.output === raw,
        lastParsedSame: out.value.output === lastParsed,
        firstParsedSame: out.value.output === firstParsed,
        tokenSame: out.value.output.opaque === token,
      };
    else
      return {
        kind: "error",
        tag: out.error._tag,
        causeSame: Object.is(out.error.cause, cause),
        cause: snapshotError(out.error.cause),
      };
  };
  const snapshot = (outcomes: unknown[]) => ({
    trace,
    parses,
    schemaReads: reads,
    boundSame: script.style === "factory" ? boundSame : null,
    modelSame: script.style === "factory" ? modelSame : null,
    inputSame,
    payloadSame,
    retainedCalls: retainedCalls.map((call) => ({
      inputSame: call === input,
      payloadSame: call.payload === token,
      value: (call.payload as Token).value,
    })),
    messagesSame: seenMessages.map((value) => value === messages),
    defaultEmpty: script.noLoader
      ? seenMessages.every((value) => value.length === 0)
      : null,
    defaultFresh: script.noLoader
      ? seenMessages.every((one, index) =>
          seenMessages.slice(index + 1).every((two) => one !== two),
        )
      : null,
    factoryModels,
    outcomes,
  });
  return {
    input,
    initial,
    cmd,
    llm,
    token,
    cause,
    raw,
    handler,
    snapshot,
    view,
  };
}
export async function scenario(script: Script) {
  const ctx = setup(script);
  const outcomes = [];
  for (let i = 0; i < script.repeats; i++)
    outcomes.push(ctx.view(await ctx.handler(ctx.cmd)));
  return ctx.snapshot(outcomes);
}
async function runtimeScenario(script: Script, profile: "promise" | "effect") {
  if (script.repeats !== 1) throw new Error("runtime accepts one call");
  const ctx = setup(script),
    errors: string[] = [];
  type Outputs = Record<string, Answer>;
  type Msg = LlmFailMsg<string> | LlmSucceedMsg<string, Outputs>;
  type State = {
    call: typeof ctx.initial;
    context: Token;
    settled: unknown;
    done: boolean;
  };
  const reduce = (
    state: State,
    msg: Msg,
  ): readonly [State, readonly LlmRunCmd<string>[]] => {
    if ("error" in msg) {
      const error = ctx.llm.errOf(msg);
      const [call, commands] = ctx.llm.fail(state.call, msg);
      return [
        {
          ...state,
          call,
          done: true,
          settled: {
            tag: msg.type,
            key: error.key,
            purpose: error.purpose,
            reason: error.reason,
            sameCause: Object.is(error.error, ctx.cause),
            at: msg.at,
          },
        },
        commands,
      ];
    }
    const [call, commands] = ctx.llm.succeed(state.call, msg);
    return [
      {
        ...state,
        call,
        done: true,
        settled: {
          tag: msg.type,
          key: msg.value.key,
          purpose: msg.value.purpose,
          output: msg.value.output,
          sameRaw: msg.value.output === ctx.raw,
          sameToken: msg.value.output.opaque === ctx.token,
          at: msg.at,
        },
      },
      commands,
    ];
  };
  const machine: Machine<
    State,
    Msg,
    LlmRunCmd<string>,
    Sub<never>,
    undefined
  > = {
    cmds: [ctx.llm.run],
    init: () => [
      { call: ctx.initial, context: ctx.token, settled: null, done: false },
      [ctx.cmd],
    ],
    update: { resilient_run_ok: reduce, resilient_run_err: reduce },
  };
  const options = {
    ctx: undefined,
    clock: () => 100.25,
    terminal: (state: State) => state.done,
    onError: (_error: unknown, context: { phase: string }) =>
      errors.push(context.phase),
  };
  let result: State;
  if (profile === "promise") {
    const handle = runPromise(machine, {
      ...options,
      interpret: { resilient_run: (cmd) => ctx.handler(cmd) },
    });
    const ready = await handle.ready;
    result = await ready.done();
    await ready.stop();
  } else {
    const scope = await Effect.runPromise(Scope.make());
    const handle = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(machine, {
          ...options,
          interpret: {
            resilient_run: (cmd) =>
              Effect.flatMap(
                Effect.promise(() => ctx.handler(cmd)),
                (outcome) =>
                  outcome._tag === "Ok"
                    ? Effect.succeed(outcome.value)
                    : Effect.fail(outcome.error),
              ),
          },
        }),
      ),
    );
    const ready = await Effect.runPromise(handle.ready);
    result = await Effect.runPromise(ready.done());
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  const key = script.key ?? script.purpose;
  return {
    ports: ctx.snapshot([]),
    settled: result.settled,
    phase: result.call.calls[key].phase,
    contextSame: result.context === ctx.token,
    done: result.done,
    errors,
  };
}
const requestSchema = z
  .object({
    id: z.string(),
    operation: z.enum([
      "scenario",
      "runtime-promise",
      "runtime-effect",
      "input-boundary",
      "vocabulary",
    ]),
    input: z.unknown(),
  })
  .strict();
for await (const line of readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    console.log(JSON.stringify({ id: null, ok: false, error: String(error) }));
    continue;
  }
  const id =
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, "id") === "string"
      ? Reflect.get(value, "id")
      : null;
  try {
    const request = requestSchema.parse(value);
    let output: unknown;
    if (request.operation === "input-boundary") {
      const input = z
        .object({ variant: z.enum(["missing", "undefined"]) })
        .strict()
        .parse(request.input);
      const trace: string[] = [];
      const llm = createLlmCall<"turn", { turn: unknown }>({
        schemas: { turn: { parse: (v) => v } },
      });
      const cmd = {
        type: "resilient_run",
        key: "turn",
        ...(input.variant === "missing" ? {} : { input: undefined }),
      };
      const handler = brainHandler(llm, {
        model: () => {
          trace.push("factory");
          return {
            withStructuredOutput<T>(_schema: Schema<T>) {
              return { invoke: async () => ({}) as T };
            },
          };
        },
      });
      const out = await Reflect.apply(handler, undefined, [cmd]);
      output = {
        outcome: out._tag,
        tag: out.error._tag,
        cause: snapshotError(out.error.cause),
        trace,
      };
    } else if (request.operation === "vocabulary") {
      z.object({}).strict().parse(request.input);
      output = { reason: PLAIN_MODEL_MISROUTE_REASON };
    } else {
      const input = scriptSchema.parse(request.input);
      output =
        request.operation === "scenario"
          ? await scenario(input)
          : await runtimeScenario(
              input,
              request.operation === "runtime-promise" ? "promise" : "effect",
            );
    }
    console.log(JSON.stringify({ id: request.id, ok: true, output }));
  } catch (error) {
    console.log(JSON.stringify({ id, ok: false, error: String(error) }));
  }
}
