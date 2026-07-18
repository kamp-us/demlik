/**
 * @packageDocumentation
 * @demlik/tea/llm-call — `resilient-call` + structured-output parse + a typed
 * failure variant, around a purpose-discriminated LLM invocation.
 *
 * This is the ~60-line `call_llm` handler from the audit-agent seed
 * (`interpret.ts` / `effects.ts`) collapsed into the uniform L2 knob: a config
 * object, the resilient-call slice it inherits, and one interpret handler that
 * assembles messages, binds the structured-output schema for the call's
 * `purpose`, invokes the model (retry composed from `../resilient-call`, NOT
 * reinvented), parses the output, and RETURNS the enriched resilient settle Msg
 * (`resilient_ok` / `resilient_err`) so it re-enters the host reducer and drives
 * the inherited succeed/fail → backoff → onTimer loop.
 *
 * ## What it adds over `../resilient-call`
 *
 *   - **Two DI ports** (the seed's two seams):
 *       1. `model: (modelId) => LLM` — the model factory. Tests pass a fake so
 *          the handler runs end-to-end without touching a real provider; the
 *          production worker wires `createChatModel(env, …)`.
 *       2. `loadMessages: Loader` — the SDK / message loader. The seed lazy-
 *          imports `@langchain/core/messages` (a top-level `import type` blows
 *          up the workers test runner); the loader keeps that import lazy and
 *          stubbable. It produces the `BaseMessage[]` for a given call.
 *   - **Structured-output parse** — each `purpose` maps to a `Schema` in
 *     `config.schemas`. The handler binds `model.withStructuredOutput(schema)`
 *     so the invoke resolves to a typed object; a `Schema.parse` that throws
 *     becomes a `resilient_err` carrying an `LlmErr` (a parse failure is a
 *     failure, not a stall — "errors are data"). `withStructuredOutput` is the
 *     seed's brain-only path; the fake model in tests returns the typed object
 *     directly.
 *   - **A typed failure variant** — every failure (model throw, timeout-via-
 *     retry-exhaustion, schema parse) is surfaced as the `LlmErr` carried on the
 *     enriched `resilient_err` settle Msg, tagged with the `purpose` so the
 *     consumer's reducer routes per-stage. The seed dispatched
 *     `llm_failed{purpose}`; the consumer rebuilds that shape in its reducer arm
 *     from `m.error: LlmErr`.
 *
 * ## Inheriting resilient-call by composition (not reinvention)
 *
 * The retry / backoff lives in `../resilient-call`: `createLlmCall` builds a
 * `createResilientCall` knob over the model-invoke port and DELEGATES `init`,
 * `attempt`, `succeed`, `fail`, `onTimer`, `subs` to it verbatim — the slice is
 * literally resilient-call's slice (the spec's "retry lives here"). There is no
 * second backoff implementation here. The handler runs the invoke through the
 * resilient-call handler so a transient model failure backs off exactly as a
 * resilient HTTP call would; the `purpose`-branch + structured parse wrap the
 * port the resilient handler drives.
 *
 * ## The two non-negotiables (canon, inherited)
 *
 *   - **Durable** — the slice is resilient-call's plain-data slice (a Model
 *     field). Input carried on the `resilient_run` Cmd is the plain
 *     `LlmCall` request (purpose + modelId + payload) — no closures.
 *   - **Replayable** — every transition is a resilient-call verb; the handler
 *     is the only impurity, and the one clock read is `Date.now()` at the
 *     effect boundary (inside the handler), exactly as the seed stamped its
 *     `llm_responded` / `llm_failed` Msgs.
 *
 * ## Typical wiring
 *
 *   const llm = createLlmCall<MyPurpose, MyOutputs>({
 *     model: (id) => createChatModel(env, id),
 *     schemas: { plan: planSchema, report: reportSchema },
 *     retry: defaultRetryPolicy,
 *     loadMessages: defaultMessagesLoader,
 *   });
 *
 *   // in the machine:
 *   init: () => [{ resilience: llm.init() }, []],
 *   update: {
 *     call_llm:  (s, m) => lift(s, llm.attempt(s.resilience, m.input, m.at)),
 *     // `resilient_ok` / `resilient_err` RE-ENTER from `handlers` (the settle
 *     // Msg the interpret handler returns). Run the inherited verb FIRST so the
 *     // succeed/fail → backoff → onTimer loop advances, THEN fold the enriched
 *     // payload (`m.result: LlmOk` / `m.error: LlmErr`) into the host's own
 *     // state — the enrichment lives in the reducer arm, not the handler.
 *     resilient_ok:  (s, m) => {
 *       const [slice, cmds] = llm.succeed(s.resilience, m.key, m);
 *       return [{ ...s, resilience: slice, output: m.result.output }, cmds];
 *     },
 *     resilient_err: (s, m) => {
 *       const [slice, cmds] = llm.fail(s.resilience, m.key, m);
 *       return [{ ...s, resilience: slice, failure: m.error }, cmds];
 *     },
 *     deadline_exceeded: (s, m) => lift(s, llm.onTimer(s.resilience, m)),
 *   },
 *   subscriptions: (s) => llm.subs(s.resilience),
 *   subscribe: { deadline: subscribeDeadline },
 *   interpret: llm.handlers(),
 */

import { describeError } from "../describe-error";
import type { Cmd } from "../index";
import { MsgType } from "../protocol";
import {
  createResilientCall,
  type DeadlineExceeded,
  type DeadlineSub,
  deadlineSub,
  type FailMsg,
  liftResilience,
  type ResilientConfig,
  type ResilientState,
  type RunCmd,
  type SucceedMsg,
  subscribeDeadline,
} from "../resilient-call";
import type { RetryPolicy } from "../retry-backoff";

// ===========================================================================
// The DI port surfaces — model factory + structured output + message loader.
// ===========================================================================

/**
 * The minimal structured-output schema contract: `parse(unknown) => T`, the
 * zod-style call the handler uses to validate the model's output before it
 * settles `resilient_ok`. A throwing `parse` (the zod contract on invalid
 * input) propagates out of `invokeOne` and is caught by the resilient handler,
 * which settles `resilient_err` (enriched to `LlmErr`) — a parse failure is a
 * failure, never a silent pass. Structural so a real `z.ZodType<T>` satisfies
 * it without an import.
 */
export interface Schema<T> {
  /** Validate + narrow `value` to `T`, or throw on mismatch (the zod contract). */
  parse(value: unknown): T;
}

/**
 * The minimal chat-model contract every model the handler talks to must
 * satisfy — the seed's `InjectableChatModel`, trimmed to the one operation
 * llm-call drives for brain-only stages:
 *
 *   `withStructuredOutput(schema)` → a runnable whose `invoke(messages)`
 *   resolves to a typed object matching `schema`.
 *
 * `BaseChatModel` from `@langchain/core` is the runtime type; this surface
 * names only what llm-call calls so a test fake can ignore the rest. Generic
 * over the message shape `Msg` so a consumer's loader and model agree on it
 * without llm-call inspecting messages.
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

// ===========================================================================
// Config — the knob. `model` + `schemas` required (the two DI ports + the
// per-purpose parse target); `retry` + `loadMessages` optional.
// ===========================================================================

/**
 * The llm-call knob. `model` and `schemas` are the load-bearing pair — the
 * model factory DI port and the per-purpose structured-output targets; the
 * rest is optional, exactly the resilient-call "omit a brick → omit its gate"
 * story for `retry`:
 *
 *   - `model`        — DI port 1: the model factory.
 *   - `schemas`      — one `Schema` per `Purpose`. The handler binds
 *                      `schemas[call.purpose]` as the structured-output target.
 *   - `retry`        — backoff policy, composed straight into `../resilient-
 *                      call`. Omit it and a model failure is terminal (no
 *                      backoff), exactly as resilient-call with no retry brick.
 *   - `loadMessages` — DI port 2: the SDK / message loader. Omit it and the
 *                      handler invokes the bound model with `[]` (a degenerate
 *                      but valid call) — provide it to assemble real messages.
 *
 * `P` is the purpose union (e.g. `"plan" | "report"`); `O` maps each purpose to
 * its parsed output type; `Msg` is the model's message shape (threaded through
 * the loader + model so llm-call never inspects a message).
 */
export interface LlmCallConfig<
  P extends string,
  O extends Record<P, unknown>,
  Msg = unknown,
> {
  /** DI port 1 — the model factory. `(modelId) => Llm`. */
  readonly model: ModelFactory<Msg>;
  /** One structured-output schema per purpose; the parse target the handler binds. */
  readonly schemas: { readonly [K in P]: Schema<O[K]> };
  /** Backoff policy, composed into `../resilient-call`. Omit → no backoff. */
  readonly retry?: RetryPolicy;
  /** DI port 2 — the SDK / message loader. Omit → the handler invokes with `[]`. */
  readonly loadMessages?: MessageLoader<P, Msg>;
}

// ===========================================================================
// The request / response shapes the knob speaks.
// ===========================================================================

/**
 * One LLM call request — the resilient-call `input` for this knob, carried on
 * the `resilient_run` Cmd as plain data (no closures, invariant 3). Mirrors the
 * seed's purpose-discriminated `CallLlmCmd`: a `purpose` selecting the schema +
 * prompt assembly, the `model` id, and the opaque per-purpose `payload` the
 * loader consumes.
 *
 * `key` defaults to `purpose` when the consumer calls `attempt(s, purpose, …)`,
 * so one in-flight call per purpose is tracked under the resilient-call slice —
 * the common single-call-per-stage shape. A consumer that fans out many calls
 * of one purpose passes a distinct `key`.
 */
export interface LlmCall<P extends string> {
  /** The stage / schema selector — drives both `schemas[purpose]` and message assembly. */
  readonly purpose: P;
  /** The model id to invoke; `null` = the host's default model. */
  readonly model: string | null;
  /** The per-purpose prompt payload the `MessageLoader` consumes. Opaque to the knob. */
  readonly payload: unknown;
}

/** The parsed, typed success carried on the `resilient_ok` settle Msg, tagged with its purpose. */
export interface LlmOk<P extends string, O extends Record<P, unknown>> {
  readonly key: string;
  readonly purpose: P;
  readonly output: O[P];
}

/** The typed failure variant — every failure path surfaces this, tagged by purpose. */
export interface LlmErr<P extends string> {
  readonly key: string;
  readonly purpose: P;
  /** A human-readable cause (model throw, retry-exhaustion, or schema parse). */
  readonly reason: string;
  /** The original error, carried untouched for the consumer to inspect. */
  readonly error: unknown;
}

/**
 * The settle Msgs llm-call's handler RETURNS from `interpret` so the substrate
 * enqueues them as follow-up Msgs (re-entry) into the host reducer — exactly as
 * `../resilient-call` does. They are the resilient-call settle Msgs with the
 * payloads ENRICHED to llm-call's typed variants: `result` is the parsed,
 * purpose-tagged `LlmOk`; `error` is the typed `LlmErr` (purpose + reason +
 * raw). The host wires `resilient_ok` → `succeed` and `resilient_err` → `fail`
 * reducer arms (the doc-comment wiring), and folds the enriched payload into its
 * own state there — llm-call never forces a Msg vocabulary on the host, and the
 * settle Msg drives the inherited succeed/fail → backoff → onTimer loop instead
 * of bypassing it.
 */
//
// The success Msg is `../resilient-call`'s `SucceedMsg` specialized to the parsed
// `LlmOk` result — NOT a re-declared shape — so the verb returns (`succeed`'s
// argument, the handler's resolve) thread through with no cast. The failure Msg
// is the resilient `FailMsg` with its `error: unknown` NARROWED to the typed
// `LlmErr`: every value the handler enriches is an `LlmErr`, and `LlmErr` is
// assignable to `unknown`, so `LlmFailMsg` flows into `rc.fail` (which takes the
// wide `FailMsg`) directly while the host reducer reads the narrow `error` type.
export type LlmSucceedMsg<
  P extends string,
  O extends Record<P, unknown>,
> = SucceedMsg<LlmOk<P, O>>;
export type LlmFailMsg<P extends string> = Omit<FailMsg, "error"> & {
  readonly error: LlmErr<P>;
};

/** The retry / deadline timer Msg — `DeadlineExceeded`, inherited from resilient-call. */
export type LlmTimerMsg = DeadlineExceeded;

/**
 * The ports the LEGACY detached `handlers(ports)` form takes. Two outbound Msg
 * builders the handler hands the typed Ok / Err; the consumer returns its own
 * Msg (or `undefined`). KEPT only for `../agent`, which still inherits the
 * detached shape; that path does NOT drive the retry loop (it dispatches the
 * consumer's Msg directly and never re-enters the resilient settle Msg). New
 * consumers use the no-arg `handlers()` form, which RETURNS the settle Msg for
 * re-entry and drives the inherited succeed/fail → backoff → onTimer loop.
 * `../agent` carries the same retry-loop gap and is fixed separately.
 *
 * The builders return `M | undefined` — `undefined` is the "dispatch nothing"
 * sentinel the detached form checks (`!== undefined`), spelled as `undefined`
 * rather than `void` so the union is unambiguous (a `void` member of a union is
 * confusing and reads as "may return anything").
 */
export interface LlmCallPorts<
  P extends string,
  O extends Record<P, unknown>,
  M,
> {
  /** Build the Msg dispatched on a parsed success. Return `undefined` to dispatch nothing. */
  readonly onOk: (ok: LlmOk<P, O>) => M | undefined;
  /** Build the Msg dispatched on any failure (throw / retry-exhausted / parse). */
  readonly onErr: (err: LlmErr<P>) => M | undefined;
}

/**
 * The effect Cmd the knob emits: run the LLM call for `key` with `input`. The
 * `input` is the plain `LlmCall` request — the handler reads `purpose` /
 * `model` / `payload` off it (invariant 3: Cmds are data).
 *
 * It is `../resilient-call`'s `RunCmd` specialized to the `LlmCall` input — NOT a
 * re-declared shape — so the resilient verbs' return tuples (`[State, RunCmd[]]`)
 * are this exact type and thread through `attempt` / `succeed` / `fail` /
 * `onTimer` with no cast.
 */
export type LlmRunCmd<P extends string> = RunCmd<LlmCall<P>>;

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build an llm-call knob from `config`. `rng` is injected for the inherited
 * retry jitter (pass a fixed `() => 0.5` in tests to pin backoff; defaults to
 * `Math.random`, read only at the resilient-call verb boundary).
 *
 * Returns the uniform L2 knob contract. The slice + verbs (`init`, `attempt`,
 * `succeed`, `fail`, `onTimer`, `subs`) are DELEGATED to a `../resilient-call`
 * knob built over the structured-output model-invoke port — no second backoff
 * here. `handlers` is the one new piece: the purpose-branching, schema-parsing
 * wrapper that returns the enriched resilient settle Msg for re-entry.
 *
 * `P` is the purpose union, `O` the purpose→output map, `Msg` the model's
 * message shape.
 */
export function createLlmCall<
  P extends string,
  O extends Record<P, unknown>,
  Msg = unknown,
>(config: LlmCallConfig<P, O, Msg>, rng: () => number = Math.random) {
  // ---- The composed resilient-call knob ----------------------------------
  //
  // The resilient-call input is the full `LlmCall` request; its result is the
  // PARSED, typed `LlmOk`. Only the `retry` brick is forwarded — llm-call does
  // not expose circuit / rate-limit / cache / deadline knobs (a stage call is
  // a single brain invocation, not a keyed downstream target). Omitting those
  // bricks omits their gates, exactly as resilient-call documents.
  const resilientConfig: ResilientConfig = {
    ...(config.retry === undefined ? {} : { retry: config.retry }),
  };
  const rc = createResilientCall<LlmCall<P>, LlmOk<P, O>>(resilientConfig, rng);

  /** The slice this knob owns — resilient-call's slice verbatim. */
  type State = ResilientState<LlmCall<P>, LlmOk<P, O>>;

  /** The starting slice — resilient-call's. */
  function init(): State {
    return rc.init();
  }

  /**
   * Start (or restart) an LLM call. `keyOrPurpose` defaults the resilient-call
   * `key` to the call's `purpose` so one in-flight call per stage is tracked
   * under the slice (the common shape); pass a distinct key to fan out. PURE —
   * delegates straight to resilient-call's gate.
   */
  function attempt(
    s: State,
    input: LlmCall<P>,
    at: number,
    key: string = input.purpose,
  ): readonly [State, readonly LlmRunCmd<P>[]] {
    return rc.attempt(s, key, input, at);
  }

  /** Record a parsed success for `key`. PURE — resilient-call's `succeed`. */
  function succeed(
    s: State,
    key: string,
    msg: LlmSucceedMsg<P, O>,
  ): readonly [State, readonly LlmRunCmd<P>[]] {
    return rc.succeed(s, key, msg);
  }

  /**
   * Record a failure for `key`: back off via the inherited retry, or settle
   * `failed`. PURE — resilient-call's `fail`. The `error` is the typed
   * `LlmErr`, carried on the call's `failed` phase for the consumer to read.
   */
  function fail(
    s: State,
    key: string,
    msg: LlmFailMsg<P>,
  ): readonly [State, readonly LlmRunCmd<P>[]] {
    return rc.fail(s, key, msg);
  }

  /** A retry / deadline timer fired. PURE — resilient-call's `onTimer`. */
  function onTimer(
    s: State,
    msg: LlmTimerMsg,
  ): readonly [State, readonly LlmRunCmd<P>[]] {
    return rc.onTimer(s, msg);
  }

  /** Pre-wired subs — resilient-call's retry-timer subscriptions. */
  function subs(s: State): readonly DeadlineSub[] {
    return rc.subs(s);
  }

  // ---- The model-invoke port the resilient handler drives ----------------

  /**
   * Run ONE LLM call: assemble messages via the loader, bind the purpose's
   * structured-output schema, invoke, and parse. Returns the typed `LlmOk` on
   * success; throws on any failure (model throw OR schema parse) so the
   * resilient-call handler routes it to a failure Msg + backoff. This is the
   * single port resilient-call wraps — the retry / timeout machinery lives in
   * resilient-call, never here ("do NOT reinvent backoff").
   *
   * The seed's two paths collapse to one: every brain-only purpose goes through
   * `withStructuredOutput(schema)`. The `parse` re-validates the output (a fake
   * model might skip validation, and a real provider can drift) so a malformed
   * structured response is a failure, not a corrupt success.
   */
  async function invokeOne(input: LlmCall<P>): Promise<LlmOk<P, O>> {
    const model = config.model(input.model);
    const messages = config.loadMessages
      ? await config.loadMessages(input)
      : [];
    const schema = config.schemas[input.purpose];
    const structured = model.withStructuredOutput(schema);
    const raw = await structured.invoke(messages);
    // Re-validate at the boundary — a parse throw becomes a `resilient_err`
    // (enriched to `LlmErr`) settle Msg upstream, never a corrupt success.
    const output = schema.parse(raw);
    return { key: input.purpose, purpose: input.purpose, output };
  }

  // ---- Handlers — the one new piece, composed onto resilient-call --------

  /**
   * Pre-wired interpret handler for `resilient_run`. Composes
   * `../resilient-call`'s `resilient_run` handler over the `invokeOne` port and
   * RETURNS the resilient settle Msg — it does NOT dispatch the consumer's Msg
   * itself. Returning the settle Msg is the whole point: the substrate enqueues
   * an interpret handler's returned Msg as a FOLLOW-UP (re-entry) onto the
   * dispatch tail, so the host reducer's `resilient_ok` / `resilient_err` arms
   * run `succeed` / `fail`, which advances the inherited retry loop
   * (succeed/fail → backoff → onTimer → re-issue). A handler that instead
   * `dispatch`ed an enriched Msg directly would settle ONE invoke and bypass
   * that loop entirely — the slice would never leave `running`, the breaker
   * would never trip/close, and the retry counter would never reset.
   *
   * Resilience is composed, not reimplemented: the body delegates to the
   * resilient-call handler's Railway-routed invoke (Ok → `resilient_ok`, Err →
   * `resilient_err`), so a transient model failure backs off via the inherited
   * retry exactly as resilient-call decides. The ONE enrichment llm-call adds is
   * mapping the settle PAYLOADS into its typed variants:
   *
   *   - success → `result` is already the parsed `LlmOk` (`invokeOne` returns
   *     it), so the resilient `resilient_ok` Msg is the llm-call `LlmSucceedMsg`
   *     as-is.
   *   - failure → the resilient `resilient_err` carries the RAW throw (a model
   *     503 or a `schema.parse` throw). We rebuild it into the typed `LlmErr`
   *     (purpose + reason + raw) so the host reducer routes per-stage.
   *
   * The host folds the enriched payload into its own state in the reducer arm
   * (the doc-comment wiring), NOT here — the handler stays the one impurity
   * (the `invokeOne` await + the `Date.now()` stamp the resilient handler makes)
   * and the reducer stays pure.
   */
  // The resilient-call `resilient_run` handler over `invokeOne` — the shared
  // Railway-routed invoke (Ok → resilient_ok Msg, Err → resilient_err Msg). Both
  // handler forms below build on it; the settle shape is composed, not reinvented.
  const resilientRunHandler = rc.handlers({
    run: (input) => invokeOne(input),
  }).resilient_run;

  /**
   * Await one composed invoke and resolve to the ENRICHED resilient settle Msg
   * (`resilient_ok` carrying the parsed `LlmOk`, or `resilient_err` carrying the
   * typed `LlmErr`). The shared core both handler forms reuse.
   */
  async function settleOf(
    cmd: LlmRunCmd<P>,
  ): Promise<LlmSucceedMsg<P, O> | LlmFailMsg<P>> {
    // `resilientRunHandler` never rejects (tryInterpret contract) — it resolves
    // to a `resilient_ok` / `resilient_err` settle Msg stamped with `Date.now()`.
    // Its `ctx` slot is `NoCtx` (the resilient-call work fn reads no ctx — a
    // DELIBERATE context-free seam, not accidental `unknown`), so the empty
    // record satisfies it without a cast.
    const settle = await resilientRunHandler(cmd, {});
    if (settle.type === MsgType.ResilientOk) {
      // `result` is the parsed `LlmOk` from `invokeOne`, and the narrowed
      // `SucceedMsg<LlmOk>` IS `LlmSucceedMsg` — returned as-is, no cast.
      return settle;
    }
    // resilient_err — enrich the raw throw into the typed `LlmErr`, keeping the
    // resilient Msg's `key` / `at` so the host reducer's `fail` verb re-issues
    // from the remembered input and backs off on schedule.
    const rawError: unknown = settle.error;
    const err: LlmErr<P> = {
      key: cmd.key,
      purpose: cmd.input.purpose,
      reason: describeError(rawError),
      error: rawError,
    };
    return {
      type: MsgType.ResilientErr,
      key: settle.key,
      error: err,
      at: settle.at,
    };
  }

  /**
   * Pre-wired interpret handler for `resilient_run`. TWO forms:
   *
   *   - `handlers()` (no args, the FIXED primary) — RETURNS the enriched
   *     resilient settle Msg. The substrate enqueues an interpret handler's
   *     returned Msg as a FOLLOW-UP (re-entry) onto the dispatch tail, so the
   *     host reducer's `resilient_ok` / `resilient_err` arms run `succeed` /
   *     `fail`, advancing the inherited retry loop (succeed/fail → backoff →
   *     onTimer → re-issue). This is the correct wiring; the module doc shows it.
   *
   *   - `handlers(ports)` (LEGACY, detached) — runs the invoke inside
   *     `ctx.waitUntil` and dispatches the consumer's `onOk` / `onErr` Msg
   *     directly. KEPT only for `../agent`, which still inherits this shape. It
   *     does NOT drive the retry loop (it never re-enters the settle Msg, so
   *     `succeed` / `fail` never run) — `../agent` carries the same gap and is
   *     fixed in its own pass. New consumers MUST use the no-arg form.
   *
   * Resilience is composed, not reimplemented: both forms delegate to the
   * resilient-call handler's Railway-routed invoke and add only the typed
   * `LlmOk` / `LlmErr` enrichment. The ONE impurity is the `invokeOne` await +
   * the `Date.now()` stamp the resilient handler makes; the reducer stays pure.
   */
  function handlers(): {
    resilient_run: (
      cmd: LlmRunCmd<P>,
    ) => Promise<LlmSucceedMsg<P, O> | LlmFailMsg<P>>;
  };
  function handlers<M>(ports: LlmCallPorts<P, O, M>): {
    resilient_run: (
      cmd: LlmRunCmd<P>,
      ctx: { waitUntil(p: Promise<unknown>): void; dispatch(msg: M): unknown },
    ) => void;
  };
  function handlers<M>(ports?: LlmCallPorts<P, O, M>) {
    if (ports === undefined) {
      // FIXED primary: return the settle Msg for re-entry — drives the loop.
      return { resilient_run: (cmd: LlmRunCmd<P>) => settleOf(cmd) };
    }
    // LEGACY detached form — kept for `../agent` (see doc above). Dispatches the
    // consumer's Msg directly; does not re-enter the settle Msg.
    return {
      resilient_run: (
        cmd: LlmRunCmd<P>,
        ctx: {
          waitUntil(p: Promise<unknown>): void;
          dispatch(msg: M): unknown;
        },
      ): void => {
        const fired = (async () => {
          const settle = await settleOf(cmd);
          if (settle.type === MsgType.ResilientOk) {
            const msg = ports.onOk(settle.result);
            if (msg !== undefined) await ctx.dispatch(msg);
            return;
          }
          const msg = ports.onErr(settle.error);
          if (msg !== undefined) await ctx.dispatch(msg);
        })();
        ctx.waitUntil(fired);
      },
    };
  }

  return { init, attempt, succeed, fail, onTimer, subs, handlers, invokeOne };
}

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the
 * slice lives at `state.resilience` — the same convenience `../resilient-call`
 * ships, re-typed for the llm-call slice so consumers wire one import. Pure.
 */
export function liftLlmCall<
  S extends { resilience: ResilientState<LlmCall<P>, LlmOk<P, O>> },
  P extends string,
  O extends Record<P, unknown>,
  C extends Cmd,
>(
  state: S,
  result: readonly [ResilientState<LlmCall<P>, LlmOk<P, O>>, readonly C[]],
): readonly [S, readonly C[]] {
  return liftResilience(state, result);
}

/**
 * Re-export the deadline Sub primitives (inherited from resilient-call) so
 * consumers wire one import: `subscribeDeadline` is the `subscribe` cell,
 * `deadlineSub` builds the Sub literal `subs` emits.
 */
export { subscribeDeadline, deadlineSub };
export type { DeadlineSub, DeadlineExceeded, ResilientState };
