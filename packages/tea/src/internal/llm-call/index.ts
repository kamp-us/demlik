/**
 * @packageDocumentation
 * internal/llm-call — `resilient-call` + structured-output parse + a typed
 * failure variant, around a purpose-discriminated LLM invocation. Internal
 * since #49 — not published on any subpath; `@demlik/tea/agent` re-exports
 * the types a consumer meets.
 *
 * This is the ~60-line `call_llm` handler from the audit-agent seed collapsed
 * into plain functions (ADR 0022): a config object, the resilient-call slice it
 * inherits, the `Cmd.define`d run Cmd, and the pure pieces a handler needs to
 * turn a model's raw answer into that Cmd's outcome. It ships no I/O (ADR
 * 0021): invoking the model is the handler YOU write, in your engine's style —
 * `@demlik/tea/agent` writes the Promise one — and it hands the model's raw
 * answer to `decode`.
 *
 * ## What it adds over `../resilient-call`
 *
 *   - **Structured-output parse** — each `purpose` maps to a `Schema` in
 *     `config.schemas`. `decode(cmd, raw)` runs `schemas[purpose].parse` over
 *     the model's answer: a pass is the parsed, purpose-tagged `LlmOk`; a throw
 *     is a `port_rejected` failure (a parse failure is a failure, not a stall —
 *     "errors are data"), and a malformed answer never becomes a corrupt
 *     success.
 *   - **A typed failure variant** — every failure (model throw, schema parse)
 *     settles as `resilient_run_err`, and `fail` / `errOf` read it back as the
 *     typed `LlmErr`, tagged with the `purpose` so the consumer's reducer routes
 *     per-stage.
 *
 * ## Inheriting resilient-call by composition (not reinvention)
 *
 * The retry / backoff lives in `../resilient-call`: `createLlmCall` builds a
 * `createResilientCall` knob and DELEGATES `init`, `attempt`, `onTimer`,
 * `deadlines`, `timer` to it verbatim, and `succeed` / `fail` to its `settle`
 * — the slice is literally resilient-call's slice. There is no second backoff
 * implementation here.
 *
 * ## The two non-negotiables (canon, inherited)
 *
 *   - **Durable** — the slice is resilient-call's plain-data slice (a Model
 *     field). Input carried on the `resilient_run` Cmd is the plain `LlmCall`
 *     request (purpose + modelId + payload) — no closures.
 *   - **Replayable** — every transition is a resilient-call verb; nothing here
 *     reads a clock. The settled Msgs carry the `at` the engine stamps.
 *
 * ## Typical wiring
 *
 *   const llm = createLlmCall<MyPurpose, MyOutputs>({
 *     schemas: { plan: planSchema, report: reportSchema },
 *     retry: defaultRetryPolicy,
 *   });
 *
 *   // in the machine:
 *   cmds: [llm.run],
 *   update: {
 *     call_llm: (s, m) => liftLlmCall(s, llm.attempt(s.resilience, m.input, m.at)),
 *     resilient_run_ok: (s, m) => …llm.succeed(s.resilience, m)… m.value.output …,
 *     resilient_run_err: (s, m) => …llm.fail(s.resilience, m)… llm.errOf(m) …,
 *     deadline_exceeded: (s, m) => liftLlmCall(s, llm.onTimer(s.resilience, m)),
 *   },
 *   subs: [{ type: "timer", deps: (s) => llm.timer(s.resilience) }],
 *
 *   // and where it runs — invoking the model is your handler:
 *   run(machine, {
 *     interpret: {
 *       resilient_run: async (cmd) => {
 *         try { return llm.decode(cmd, await model(cmd.input)); }
 *         catch (cause) { return llm.rejected(cause); }
 *       },
 *     },
 *   });
 */

import { describeError } from "../../describe-error";
import { type Cmd, Outcome } from "../../index";
import type { RetryPolicy } from "../../retry-backoff";
import type { DeadlineExceeded, DeadlineSub } from "../resilience/deadline";
import {
  createResilientCall,
  type FailMsg,
  liftResilience,
  type ResilientConfig,
  type ResilientState,
  type RunCmd,
  type SucceedMsg,
} from "../resilience/resilient-call";

// ===========================================================================
// The structured-output schema contract.
// ===========================================================================

/**
 * The minimal structured-output schema contract: `parse(unknown) => T`, the
 * zod-style call `decode` uses to validate the model's output before it
 * settles `resilient_run_ok`. A throwing `parse` (the zod contract on invalid
 * input) becomes a `port_rejected` outcome — a parse failure is a failure,
 * never a silent pass. Structural so a real `z.ZodType<T>` satisfies it
 * without an import.
 */
export interface Schema<T> {
  /** Validate + narrow `value` to `T`, or throw on mismatch (the zod contract). */
  parse(value: unknown): T;
}

// ===========================================================================
// Config — the knob. `schemas` required; `retry` optional.
// ===========================================================================

/**
 * The llm-call knob. `schemas` is the load-bearing field — the per-purpose
 * structured-output targets `decode` parses against; `retry` is the
 * resilient-call "omit a brick → omit its gate" story. Omit it and a model
 * failure is terminal (no backoff).
 *
 * `P` is the purpose union (e.g. `"plan" | "report"`); `O` maps each purpose to
 * its parsed output type.
 */
export interface LlmCallConfig<P extends string, O extends Record<P, unknown>> {
  /** One structured-output schema per purpose; the parse target `decode` binds. */
  readonly schemas: { readonly [K in P]: Schema<O[K]> };
  /** Backoff policy, composed into `../resilient-call`. Omit → no backoff. */
  readonly retry?: RetryPolicy;
}

// ===========================================================================
// The request / response shapes the knob speaks.
// ===========================================================================

/**
 * One LLM call request — the resilient-call `input` for this module, carried on
 * the `resilient_run` Cmd as plain data — no closures, so it survives
 * persistence and replay. Purpose-discriminated: a `purpose` selecting the
 * schema + prompt assembly, the `model` id, and the opaque per-purpose
 * `payload` the handler's message loader consumes.
 *
 * `key` defaults to `purpose` when the consumer calls `attempt(s, input, at)`,
 * so one in-flight call per purpose is tracked under the resilient-call slice —
 * the common single-call-per-stage shape. A consumer that fans out many calls
 * of one purpose passes a distinct `key`.
 */
export interface LlmCall<P extends string> {
  /** The stage / schema selector — drives both `schemas[purpose]` and message assembly. */
  readonly purpose: P;
  /** The model id to invoke; `null` = the host's default model. */
  readonly model: string | null;
  /** The per-purpose prompt payload the message loader consumes. Opaque to the knob. */
  readonly payload: unknown;
}

/** The parsed, typed success carried on `resilient_run_ok`, tagged with its purpose. */
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
 * How a failure crosses the handler: the run Cmd's declared `port_rejected`
 * tag with the raw failure on `cause`. `errOf` reads it back as {@link LlmErr}.
 */
export type LlmRejected = {
  readonly _tag: "port_rejected";
  readonly cause: unknown;
};

/**
 * The effect Cmd this module emits: run the LLM call for `key` with `input`. It
 * is `../resilient-call`'s `Cmd.define`d `RunCmd` specialized to the `LlmCall`
 * input — NOT a re-declared shape — so the resilient verbs' return tuples
 * thread through `attempt` / `succeed` / `fail` / `onTimer` with no cast.
 */
export type LlmRunCmd<P extends string> = RunCmd<LlmCall<P>>;

/** The success Msg the engine mints — resilient-call's, with the parsed `LlmOk`. */
export type LlmSucceedMsg<
  P extends string,
  O extends Record<P, unknown>,
> = SucceedMsg<LlmOk<P, O>, "resilient", LlmCall<P>>;

/**
 * The failure Msg the engine mints — resilient-call's. Its `error` is the
 * handler's `port_rejected` (an {@link LlmRejected} when the handler used
 * `decode` / `rejected`); read it as the typed {@link LlmErr} with `errOf`.
 */
export type LlmFailMsg<P extends string> = FailMsg<"resilient", LlmCall<P>>;

/** The retry / deadline timer Msg — `DeadlineExceeded`, inherited from resilient-call. */
export type LlmTimerMsg = DeadlineExceeded;

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build an llm-call knob from `config`. `rng` is injected for the inherited
 * retry jitter (pass a fixed `() => 0.5` in tests to pin backoff; defaults to
 * `Math.random`, read only at the resilient-call verb boundary).
 *
 * The slice + verbs (`init`, `attempt`, `succeed`, `fail`, `onTimer`,
 * `deadlines`, `timer`) are DELEGATED to a `../resilient-call` knob — no second
 * backoff here. `decode` / `rejected` / `errOf` are the pure pieces that turn a
 * model's answer into the run Cmd's outcome and read a failure back.
 *
 * `P` is the purpose union, `O` the purpose→output map.
 */
export function createLlmCall<P extends string, O extends Record<P, unknown>>(
  config: LlmCallConfig<P, O>,
  rng: () => number = Math.random,
) {
  // Only the `retry` brick is forwarded — a stage call is a single brain
  // invocation, not a keyed downstream target, so llm-call exposes no circuit /
  // rate-limit / cache / deadline knobs.
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
   * Start (or restart) an LLM call. `key` defaults to the call's `purpose` so
   * one in-flight call per stage is tracked under the slice (the common shape);
   * pass a distinct key to fan out. PURE — delegates straight to
   * resilient-call's gate.
   */
  function attempt(
    s: State,
    input: LlmCall<P>,
    at: number,
    key: string = input.purpose,
  ): readonly [State, readonly LlmRunCmd<P>[]] {
    return rc.attempt(s, key, input, at);
  }

  /** Record a parsed success. PURE — resilient-call's `settle`. */
  function succeed(
    s: State,
    msg: LlmSucceedMsg<P, O>,
  ): readonly [State, readonly LlmRunCmd<P>[]] {
    const { call, cmds } = rc.settle(s, msg);
    return [call, cmds];
  }

  /**
   * Read a settled failure as the typed {@link LlmErr}: the call's key and
   * purpose off the run Cmd, and the handler's `cause` (or the whole error,
   * when the handler returned no `cause`). PURE.
   */
  function errOf(msg: LlmFailMsg<P>): LlmErr<P> {
    const error = msg.error;
    const cause = "cause" in error ? error.cause : error;
    return {
      key: msg.cmd.key,
      purpose: msg.cmd.input.purpose,
      reason: describeError(cause),
      error: cause,
    };
  }

  /**
   * Record a failure: back off via the inherited retry, or settle `failed`.
   * PURE — resilient-call's `settle`. The `failed` phase carries the typed
   * {@link LlmErr}, never the handler's carrier.
   */
  function fail(
    s: State,
    msg: LlmFailMsg<P>,
  ): readonly [State, readonly LlmRunCmd<P>[]] {
    const { call, cmds } = rc.settle(s, { ...msg, error: errOf(msg) });
    return [call, cmds];
  }

  /** A retry / deadline timer fired. PURE — resilient-call's `onTimer`. */
  function onTimer(
    s: State,
    msg: LlmTimerMsg,
  ): readonly [State, readonly LlmRunCmd<P>[]] {
    return rc.onTimer(s, msg);
  }

  /** The call's deadlines — resilient-call's retry and deadline timers. */
  function deadlines(s: State): readonly DeadlineSub[] {
    return rc.deadlines(s);
  }

  /**
   * Turn a model's raw answer into the run Cmd's outcome. PURE: parse it with
   * the call's purpose schema. A pass is the parsed, purpose-tagged `LlmOk`,
   * keyed by the Cmd's own `key` (so a fanned-out success carries the key its
   * failure would); a `parse` throw is a `port_rejected` outcome carrying the
   * throw.
   */
  function decode(
    cmd: LlmRunCmd<P>,
    raw: unknown,
  ): Outcome<LlmOk<P, O>, LlmRejected> {
    const { purpose } = cmd.input;
    try {
      const output = config.schemas[purpose].parse(raw);
      return Outcome.ok({ key: cmd.key, purpose, output });
    } catch (cause) {
      return rejected(cause);
    }
  }

  /** The outcome for a model call that threw. PURE. */
  function rejected(cause: unknown): Outcome<never, LlmRejected> {
    return Outcome.err({ _tag: "port_rejected", cause });
  }

  return {
    name: rc.name,
    /** The `Cmd.define`d run Cmd — list it in the machine's `cmds`. */
    run: rc.run,
    init,
    attempt,
    succeed,
    fail,
    errOf,
    onTimer,
    deadlines,
    /** The built-in `timer` Sub's deps — resilient-call's `timer`. */
    timer: rc.timer,
    decode,
    rejected,
    /** The structured-output schema for `purpose`. */
    schemaOf: <K extends P>(purpose: K): Schema<O[K]> =>
      config.schemas[purpose],
  };
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

export type { DeadlineSub, DeadlineExceeded, ResilientState };
