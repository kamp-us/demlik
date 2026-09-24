/**
 * @demlik/tea/agent — the model ports and the brain call's Promise handler.
 *
 * `../internal/llm-call` is pure: it owns the brain call's slice, its
 * `Cmd.define`d run Cmd and the parse that turns a model's answer into that
 * Cmd's outcome, and it ships no engine code (ADR 0021). The agent is a Promise
 * host — `toMachine` hands its caller an `interpret` table and `defineAgent`
 * runs itself — so the one handler that actually invokes the model lives here:
 * the two DI ports (`model`, `loadMessages`) and {@link brainHandler}, which
 * calls them and returns the outcome `llm.decode` builds.
 */

import type { Outcome } from "../index";
import type {
  createLlmCall,
  LlmCall,
  LlmOk,
  LlmRejected,
  LlmRunCmd,
  Schema,
} from "../internal/llm-call";

/**
 * The minimal chat-model contract every model the handler talks to must
 * satisfy — the seed's `InjectableChatModel`, trimmed to the one operation
 * the brain call drives for brain-only stages:
 *
 *   `withStructuredOutput(schema)` → a runnable whose `invoke(messages)`
 *   resolves to a typed object matching `schema`.
 *
 * `BaseChatModel` from `@langchain/core` is the runtime type; this surface
 * names only what the handler calls so a test fake can ignore the rest. Generic
 * over the message shape `Msg` so a consumer's loader and model agree on it
 * without the agent inspecting messages.
 */
export interface Llm<Msg> {
  withStructuredOutput<T>(schema: Schema<T>): {
    invoke(messages: readonly Msg[]): Promise<T>;
  };
}

/**
 * Build the `Msg[]` the handler hands to the bound model for a given call. The
 * SDK / message-assembly seam — the seed's `buildBaseMessages` + the lazy
 * `loadMessages` loader rolled into one injected port. Async because the seed
 * lazy-imports the SDK (a top-level `import type` of the langchain messages
 * package explodes the workers test runner). Receives the full `LlmCall` so it
 * can branch on `purpose` exactly as the seed's `buildBaseMessages` did.
 */
export type MessageLoader<P extends string, Msg> = (
  call: LlmCall<P>,
) => Promise<readonly Msg[]>;

/**
 * The model factory — the first DI port. `(modelId) => Llm`. Tests pass a fake
 * builder; production wires `createChatModel(env, getModelConfig(id))`. `null`
 * means "the host's default model" (the seed's `string | null`).
 */
export type ModelFactory<Msg> = (modelId: string | null) => Llm<Msg>;

/**
 * The plain-function model port — the common path. One async function
 * from the assembled messages to the model's answer; the handler validates the
 * answer through the purpose's `Schema` exactly as it re-validates the
 * structured-output path, so a malformed answer is a `resilient_run_err`, never
 * a corrupt success. `ModelFactory` → `withStructuredOutput(schema).invoke(...)`
 * stays the advanced form for a model that binds the schema itself.
 *
 * `T` is the answer type the schema narrows to — for the agent, an `AgentTurn`.
 */
export type PlainModel<Msg, T = unknown> = (
  messages: readonly Msg[],
) => Promise<T>;

/**
 * Either model port. A bare `async` function is read as a `PlainModel` (see
 * {@link asModelFactory}); a sync function is the factory.
 */
export type ModelPort<Msg, T = unknown> =
  | ModelFactory<Msg>
  | PlainModel<Msg, T>;

/**
 * Lift a plain-function model into the `ModelFactory` port. The factory ignores
 * `modelId` (the function IS the model) and its `Llm` runs the bound schema over
 * the function's answer, so both ports meet the handler as one shape.
 *
 * Reach for this explicitly when the function is not declared `async` — a sync
 * function that returns a promise (`(m) => client.chat(m)`) carries no runtime
 * mark that tells it apart from a factory. Passed bare, `asModelFactory`
 * refuses it on the first call with an `LlmErr` whose reason is
 * {@link PLAIN_MODEL_MISROUTE_REASON}.
 */
export function plainModel<Msg, T>(fn: PlainModel<Msg, T>): ModelFactory<Msg> {
  return () => ({
    withStructuredOutput<U>(schema: Schema<U>) {
      return {
        invoke: async (messages: readonly Msg[]): Promise<U> =>
          schema.parse(await fn(messages)),
      };
    },
  });
}

/**
 * Narrow a `ModelPort` to its plain-function member. The two ports are both
 * unary functions, so the only runtime mark that separates them is the
 * `AsyncFunction` tag an `async` declaration carries — a factory is never
 * `async` (its `Llm` is read synchronously). A promise-returning sync function
 * goes through {@link plainModel} instead.
 */
export function isPlainModel<Msg, T>(
  model: ModelPort<Msg, T>,
): model is PlainModel<Msg, T> {
  return Object.prototype.toString.call(model) === "[object AsyncFunction]";
}

/**
 * The reason an `LlmErr` carries when a sync promise-returning function was
 * passed as `model` bare — the one runtime shape neither port can own.
 */
export const PLAIN_MODEL_MISROUTE_REASON =
  "model: a sync function returned a Promise where an Llm was expected — " +
  "a promise-returning model that is not declared `async` must be wrapped in " +
  "plainModel(fn) (see the agent's model ports)";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  );
}

/**
 * Resolve either model port to the factory the handler drives.
 *
 * A sync function that returns a promise (`(m) => client.chat(m)`) carries no
 * runtime mark, so it reaches here as a factory and is called with `modelId`.
 * The one thing that tells it apart is what it returns: an `Llm` is never a
 * thenable. The resolved factory refuses that answer with
 * {@link PLAIN_MODEL_MISROUTE_REASON} before anything touches
 * `.withStructuredOutput`, so the misroute surfaces as an `LlmErr` naming the
 * fix — never as a bare `TypeError` off a property that is not there.
 */
export function asModelFactory<Msg, T>(
  model: ModelPort<Msg, T>,
): ModelFactory<Msg> {
  if (isPlainModel(model)) return plainModel(model);
  return (modelId) => {
    const llm = model(modelId);
    if (isThenable(llm)) {
      // The misrouted call already happened; settle its promise quietly so a
      // rejection there is not an unhandled one beside the error we do raise.
      llm.then(undefined, () => undefined);
      throw new Error(PLAIN_MODEL_MISROUTE_REASON);
    }
    return llm;
  };
}

/** What {@link brainHandler} is built from: the two ports, beside the pure knob. */
export interface BrainPorts<
  P extends string,
  O extends Record<P, unknown>,
  Msg,
> {
  /** DI port 1 — `async (messages) => answer`, or the factory `(modelId) => Llm`. */
  readonly model: ModelPort<Msg, O[P]>;
  /** DI port 2 — the SDK / message loader. Omit → the model is invoked with `[]`. */
  readonly loadMessages?: MessageLoader<P, Msg>;
}

/**
 * The brain call's `resilient_run` handler: assemble the messages, bind the
 * purpose's structured-output schema, invoke the model, and return the outcome
 * `llm.decode` builds from its answer — `llm.rejected(cause)` when anything on
 * the way throws. The engine mints `resilient_run_ok` / `resilient_run_err`
 * from that outcome (ADR 0021), so the agent's `succeed` / `fail` arms drive
 * the inherited retry loop.
 *
 * `decode` re-validates the answer even on the structured-output path (a fake
 * model might skip validation, and a real provider can drift), so a malformed
 * structured response is a failure, never a corrupt success.
 */
export function brainHandler<
  P extends string,
  O extends Record<P, unknown>,
  Msg,
>(
  llm: ReturnType<typeof createLlmCall<P, O>>,
  ports: BrainPorts<P, O, Msg>,
): (cmd: LlmRunCmd<P>) => Promise<Outcome<LlmOk<P, O>, LlmRejected>> {
  const modelOf = asModelFactory(ports.model);
  return async (cmd) => {
    try {
      const model = modelOf(cmd.input.model);
      const messages = ports.loadMessages
        ? await ports.loadMessages(cmd.input)
        : [];
      const bound = model.withStructuredOutput(llm.schemaOf(cmd.input.purpose));
      return llm.decode(cmd, await bound.invoke(messages));
    } catch (cause) {
      return llm.rejected(cause);
    }
  };
}
