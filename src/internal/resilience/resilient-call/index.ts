/**
 * @packageDocumentation
 *
 * Internal to the package (`src/internal/resilience/`, #46); consumers reach it
 * through `@demlik/tea/resilience`.
 *
 * internal/resilience/resilient-call — the ROOT composition: a single resilience knob
 * that bundles cache → circuit-breaker → rate-limit → exponential-backoff retry
 * (with a deadline-driven retry timer) around one fallible piece of work.
 *
 * This is `examples/resilient-fetch.ts`'s hand-wired `attempt()` generalized:
 *
 *   - It is **keyed**. The example tracked one URL at a time; this tracks N
 *     concurrent logical calls, each under a string `key`. The cache, the
 *     waiting-retry bookkeeping, and the retry timers are all per-key, while the
 *     circuit breaker and token bucket are shared (one downstream target, one
 *     breaker / one bucket — the example's implicit single-target assumption
 *     made explicit).
 *   - It is **config-driven**. You hand `createResilientCall` a
 *     `ResilientConfig` and get back plain functions: `init()`, the verbs
 *     (`attempt` / `settle` / `onTimer` / `resume` / `settleFailed`), the
 *     `deadlines(state)` list and the `timer(state)` that arms it, and `run` —
 *     the `Cmd.define`d Cmd the knob emits. You call them from your own
 *     `update` (ADR 0022); nothing mounts or wraps your machine.
 *   - Every brick is **optional**. Omit `cache` and the cache gate disappears
 *     (`get` is never consulted); omit `circuit` and every call passes the
 *     breaker; omit `rateLimit` and the bucket never throttles; omit `retry`
 *     and a failure is terminal (no backoff, no timer); omit `deadline` and no
 *     overall time budget is armed. "Omit a brick → omit its gate" is the
 *     whole config story — there are no other modes.
 *
 * Four later compositions (`llm-call`, `paginated-walk`, `authed-call`,
 * `reconciler`) inherit THIS slice + verb shape, so the contract here is
 * load-bearing: the slice is a flat record of brick states, every verb returns
 * `readonly [State, Cmd[]]`, time is always an `at` / `now` parameter, and the
 * RNG used for jitter is injected on the config (never read inside a verb).
 *
 * ## The two non-negotiables (canon)
 *
 *   - **Durable** — the slice is a plain-data Model field (brick states are all
 *     JSON-serializable), so it survives DO eviction / reload.
 *   - **Replayable** — every transition is a verb returning new state + Cmds;
 *     `replay` reconstructs it exactly. Nothing here closes over time or RNG.
 *
 * ## The work runs in your handler (ADR 0021)
 *
 * The knob ships no engine code. Its one effect is the `run` Cmd
 * (`<name>_run`), built with `Cmd.define`, and you interpret it in your
 * engine's own style. The handler returns an outcome and the engine mints
 * `<name>_run_ok` / `<name>_run_err`, which `settle` reads:
 *
 *   interpret: {
 *     resilient_run: async (cmd, { ok, err }) => {
 *       try { return ok(await fetchUser(cmd.input)); }
 *       catch (cause) { return err({ _tag: "port_rejected", cause }); }
 *     },
 *   }
 *
 * A failure the handler does not return as a declared tag (a throw, an
 * undeclared tag) is a contract breach: it goes to the error sink and never
 * reaches `settle`, so it is never retried.
 *
 * ## Where the clock / RNG live
 *
 * Inside the verbs: nowhere. Time arrives as `at` on `attempt` / `resume` /
 * `settleFailed`, as the `at` the engine stamps on a settled Msg, and as `atMs`
 * on a timer Msg. Jitter RNG is injected once at
 * `createResilientCall(config, rng)` and threaded into `nextDelayMs` at the
 * verb boundary — deterministic in tests, `Math.random` by default.
 *
 * Every clocked verb also records its instant on the slice (`clockMs`). That is
 * what lets `timer(state)` hand the built-in `timer` Sub a RELATIVE countdown to
 * the soonest deadline without reading a clock: the Sub's deps change whenever
 * the slice's clock moves, so the engine restarts the countdown from that
 * instant.
 *
 * That same `at` is what makes a DURATION-bounded retry budget reachable here:
 * `recordFailure` / `shouldRetry` are fed the failure's observation instant,
 * so `config.retry` accepts any `AnyRetryPolicy` — a count, a wall-clock outage
 * budget (`maxElapsedMs`), or explicit `unbounded: true` — with no new argument
 * on any verb and no clock read inside one.
 *
 * ## Typical wiring
 *
 *   const rc = createResilientCall<string, Result>({
 *     cache: { ttlMs: 60_000 },
 *     circuit: { threshold: 5, cooldownMs: 30_000 },
 *     rateLimit: { capacity: 10, refillPerSec: 5 },
 *     retry: defaultRetryPolicy,
 *     deadline: { ms: 5_000 },
 *   });
 *
 *   // One helper of your own folds the outcome into your Model. The value is
 *   // only reachable through `r.outcome`, so the slice has always settled first.
 *   function onSettle(s: Model, r: ReturnType<typeof rc.settle>) {
 *     const next = { ...s, resilience: r.call };
 *     switch (r.outcome.kind) {
 *       case "done":     return [{ ...next, result: r.outcome.value }, r.cmds] as const;
 *       case "failed":   return [next, r.cmds] as const;
 *       case "retrying": return [next, r.cmds] as const;
 *     }
 *   }
 *
 *   // in the machine:
 *   update: {
 *     fetch: (s, m) => liftResilience(s, rc.attempt(s.resilience, m.key, m.input, m.at)),
 *     resilient_run_ok:  (s, m) => onSettle(s, rc.settle(s.resilience, m)),
 *     resilient_run_err: (s, m) => onSettle(s, rc.settle(s.resilience, m)),
 *     deadline_exceeded: (s, m) => liftResilience(s, rc.onTimer(s.resilience, m)),
 *   },
 *   subs: [{ type: "timer", deps: (s) => rc.timer(s.resilience) }],
 *
 * `timer` is the engine's built-in Sub, so `run` needs no `subscribe` for it.
 * `docs/how-to/hand-wire-a-resilient-call.md` walks the whole machine.
 *
 * ## Naming a knob, when a machine holds more than one
 *
 * Every knob above speaks `resilient_run` / `resilient_run_ok` /
 * `resilient_run_err`, so TWO of them in one machine meet in one
 * `resilient_run_ok` cell whose `value` is the union of both payloads —
 * discriminated by hand on `cmd.key`, which the type checker cannot grade.
 * `config.name` renames the whole family, Cmd and both settle Msgs together:
 *
 *   const jev = createResilientCall<JevRequest, JevOk, "jev">({ name: "jev" });
 *   const llm = createResilientCall<LlmCall, LlmOk, "llm">({ name: "llm" });
 *
 *   update: {
 *     jev_run_ok: (s, m) => …,   // m.value is JevOk — no `key` switch
 *     llm_run_ok: (s, m) => …,   // m.value is LlmOk
 *   }
 *
 * The name leads the retry / deadline ids too (`jev:retry:<key>`), because a
 * fired timer is routed by its id and two knobs would otherwise answer each
 * other's timer on a shared key, and it names the timer Msg (`jev_deadline`).
 * `N` is not inferable from `I` / `R`, so an opted-in knob spells all three
 * type arguments; `config.name` is typed at `N`, so value and type cannot
 * drift. Omit `name` and every one of those strings is `resilient*`.
 */

import { liftSlice } from "../../../compose";
import {
  Cmd,
  type CmdOf,
  type MalformedResult,
  type TaggedError,
  type TimerDeps,
} from "../../../index";
import type { MsgType } from "../../../protocol";
import { without } from "../../../pure/core";
import {
  type AnyRetryPolicy,
  asRng,
  initRetry,
  nextDelayMs,
  type RetryState,
  recordFailure,
  shouldRetry,
} from "../../../retry-backoff";
import { unchecked } from "../../schema";
import {
  get as cacheGet,
  set as cacheSet,
  initCache,
  type TtlCache,
} from "../cache";
import {
  type CircuitState,
  canPass,
  initCircuit,
  onFailure,
  onSuccess,
} from "../circuit-breaker";
import {
  type DeadlineExceeded,
  type DeadlineSub,
  deadlineSub,
  nextTimer,
} from "../deadline";
import { initBucket, type TokenBucket, tryConsume } from "../rate-limit";

// ===========================================================================
// Config — the knob. Every brick optional; omit a brick → omit its gate.
// ===========================================================================

/** Circuit-breaker knob — only the two numbers a consumer ever tunes. */
export interface CircuitConfig {
  /** Consecutive failures that trip the breaker open. */
  readonly threshold: number;
  /** How long the breaker stays open before admitting a probe, in ms. */
  readonly cooldownMs: number;
  /**
   * Probes admitted in `half_open` before fast-failing the rest of the round.
   * Defaults to 1 (a single probe decides recovery) — matches the circuit-
   * breaker module's `defaultCircuitPolicy`.
   */
  readonly halfOpenMaxProbes?: number;
}

/** Token-bucket rate-limit knob. */
export interface RateLimitConfig {
  /** Burst size — the bucket starts full at `capacity`. */
  readonly capacity: number;
  /** Steady-state refill rate, tokens per second. */
  readonly refillPerSec: number;
}

/** Per-entry TTL cache knob. */
export interface CacheConfig {
  /** How long a cached success stays fresh, in ms. */
  readonly ttlMs: number;
}

/**
 * Overall deadline knob — a budget of IN-PROCESS time per in-flight call.
 *
 * The budget is charged in elapsed time this process actually observed, not by
 * a position on the host's wall clock. Time in which no process exists — a DO
 * eviction, a crash between attempts, a redeploy — is NOT charged: `resume`
 * re-anchors every live call's charging clock, so downtime lands outside every
 * segment. A timeout therefore means "the tool took too long", never "the host
 * was away too long" (#144).
 */
export interface DeadlineConfig {
  /** Budget of in-process time from the moment a call starts, in ms. */
  readonly ms: number;
}

// ===========================================================================
// The Msg-name family — one `name` derives the Cmd and both settle Msgs.
// ===========================================================================

/**
 * The family every unnamed knob speaks: `resilient_run` / `resilient_run_ok` /
 * `resilient_run_err`. Identical to the `MsgType.Resilient*` literals, which
 * stay the vocabulary of every knob that passes no name.
 */
export const DEFAULT_RESILIENT_NAME = "resilient";
export type DefaultResilientName = typeof DEFAULT_RESILIENT_NAME;

// The default family IS the protocol's `MsgType.Resilient*` vocabulary, not a
// parallel spelling of it. These three lines fail to compile the moment the two
// drift, which is the only thing keeping "omit the name and nothing changes"
// true for every machine wired before the name existed.
const _runIsProtocol: typeof MsgType.ResilientRun =
  `${DEFAULT_RESILIENT_NAME}_run` as const;
const _okIsProtocol: typeof MsgType.ResilientOk =
  `${DEFAULT_RESILIENT_NAME}_run_ok` as const;
const _errIsProtocol: typeof MsgType.ResilientErr =
  `${DEFAULT_RESILIENT_NAME}_run_err` as const;
void [_runIsProtocol, _okIsProtocol, _errIsProtocol];

/** The run Cmd's `type` for the `N` family. */
export type ResilientRunType<N extends string> = `${N}_run`;
/** The success settle Msg's `type` for the `N` family — minted by the engine. */
export type ResilientOkType<N extends string> = `${N}_run_ok`;
/** The failure settle Msg's `type` for the `N` family — minted by the engine. */
export type ResilientErrType<N extends string> = `${N}_run_err`;

/**
 * The resilience knob. EVERY field is optional: omit a brick and its gate is
 * skipped entirely (the slice still carries a default brick state so the shape
 * stays uniform across configs, but the gate is never consulted). An empty
 * config `{}` is a valid pass-through — a bare effect with no resilience at all.
 *
 * `N` is the knob's Msg-name family (see {@link ResilientName}); it is carried on
 * the config so the run Cmd and the two settle Msgs are named from ONE place.
 */
export interface ResilientConfig<N extends string = DefaultResilientName> {
  /**
   * What this knob's Cmd and settle Msgs are called: `<name>_run`, `<name>_ok`,
   * `<name>_err`. Omit it and the family is `resilient` — `resilient_run` /
   * `resilient_ok` / `resilient_err`, exactly as before this parameter existed.
   *
   * Name a knob when a machine mounts more than one of the resilient family.
   * Two unnamed knobs meet in ONE `resilient_ok` cell whose payload is the union
   * of both results, and the consumer discriminates by hand on `key` — which the
   * type checker cannot see. Under distinct names each knob settles into its own
   * cell, already narrowed to its own payload.
   *
   * The name is a value AND a type: the settle Msg types are generic in `N`, and
   * `N` is not inferable from `I` / `R`, so an opted-in knob spells all three
   * type arguments — `createResilientCall<In, Out, "jev">({ name: "jev", … })`.
   * The `name` field is typed at `N`, so the two cannot drift apart.
   */
  readonly name?: N;
  /**
   * The backoff brick. Omit and a failure is terminal (no backoff, no timer).
   *
   * Any bound the `../retry-backoff` union admits: a count (`RetryPolicy`), a
   * wall-clock outage budget (`DurationRetryPolicy`), or explicit
   * `unbounded: true`. A duration bound needs no extra wiring: every path that
   * records a failure already holds the instant it was observed as DATA —
   * `settle`'s `msg.at` (stamped at the interpret boundary) and `gate`'s `at`
   * (the caller's `attempt` / the retry timer's `atMs`) — so the streak clock
   * is fed from a Msg, never from a `Date.now()` inside a verb (invariant 2).
   */
  readonly retry?: AnyRetryPolicy;
  readonly circuit?: CircuitConfig;
  readonly rateLimit?: RateLimitConfig;
  readonly cache?: CacheConfig;
  readonly deadline?: DeadlineConfig;
}

// ===========================================================================
// Slice — the Model field this knob owns. A flat record of brick states.
// ===========================================================================

/**
 * What is left of one call's deadline budget, and where the currently open
 * charging segment starts. Plain data, so it persists with the rest of the slice
 * — but the DURABLE fact is `remainingMs`, a duration, never an instant.
 *
 * The accounting has one rule, applied at every transition that carries a clock
 * (`attempt`'s `at`, a settle Msg's `at`, a timer's `atMs`): charge the segment
 * that just closed and open a new one at the same instant —
 * `remainingMs -= at - chargingSinceMs; chargingSinceMs = at`. See {@link charge}.
 *
 * `chargingSinceMs` is an IN-PROCESS anchor, not a persisted deadline. It is
 * meaningful only while the process that wrote it is alive, and `resume` re-bases
 * it on every live call before anything reads it after a reload — which is what
 * keeps downtime out of the budget. Nothing derives a timeout from it across a
 * resume; the only durable answer to "how much budget is left" is `remainingMs`.
 *
 * `remainingMs` is `0` when the `deadline` brick is absent, which is also the
 * "no cap armed" reading `subs` uses — a call with a real budget always has
 * `remainingMs > 0`, because `gate` settles a call whose budget reached zero
 * rather than letting it enter `running`.
 */
export interface CallBudget {
  /** In-process ms left when the open segment started. `0` = no deadline brick. */
  readonly remainingMs: number;
  /** The instant the open segment started, on the clock of the process that opened it. */
  readonly chargingSinceMs: number;
}

/**
 * Per-key call phase. `key` indexes a logical call; several can be in flight at
 * once (the generalization of the example's single `url`). Discriminated on
 * `phase` so each phase carries only its own data (pattern 11):
 *
 *   - `idle`          — never attempted, or fully settled and forgotten.
 *   - `running`       — the effect Cmd is out; awaiting `settle`.
 *                       Carries the deadline budget ({@link CallBudget}) and the
 *                       last `input` so a retry can re-issue it.
 *   - `waiting_retry` — a transient failure backed off; the retry timer is armed
 *                       for `retryAtMs`. Carries `input` for the re-attempt, and
 *                       the same budget — backoff is in-process time, so it is
 *                       charged like an attempt.
 *   - `circuit_open`  — the breaker fast-failed this attempt. Terminal for this
 *                       call until the consumer re-attempts after cooldown.
 *   - `succeeded`     — settled OK. `result` is the value the port produced.
 *   - `failed`        — settled Err (out of retries, or no retry brick). `error`
 *                       carries the last failure.
 */
export type CallPhase<I, R> =
  | { readonly phase: "idle" }
  | {
      readonly phase: "running";
      readonly input: I;
      readonly budget: CallBudget;
    }
  | {
      readonly phase: "waiting_retry";
      readonly input: I;
      readonly retryAtMs: number;
      readonly budget: CallBudget;
    }
  | { readonly phase: "circuit_open" }
  | { readonly phase: "succeeded"; readonly result: R }
  | { readonly phase: "failed"; readonly error: unknown };

/**
 * The slice. `circuit` / `bucket` are SHARED across keys (one downstream target
 * → one breaker, one bucket). `retry` and `cache` are PER KEY (each logical call
 * has its own backoff count + cached result), as is the per-call `CallPhase`.
 * Every field is plain data → the whole slice serializes into a `Store<S>`.
 *
 * `retry` / `cache` keep a default brick value even when the corresponding
 * config brick is omitted, so the slice shape is identical regardless of which
 * bricks the consumer enabled — the verbs simply never consult the unused brick.
 */
export interface ResilientState<I, R> {
  readonly circuit: CircuitState;
  readonly bucket: TokenBucket;
  /**
   * Per-key backoff counter. Entries minted by `backoff` are `TimedRetryState`s
   * (they carry the streak's `firstFailureAtMs`, since every failure path holds
   * the observation instant); the field is typed at the `RetryState` supertype
   * because a key that has never failed has no streak, and a slice persisted
   * before the origin existed rehydrates without one. Still plain data.
   */
  readonly retry: Readonly<Record<string, RetryState>>;
  readonly cache: TtlCache<R>;
  readonly calls: Readonly<Record<string, CallPhase<I, R>>>;
  /**
   * The instant of the latest clocked transition this slice saw — the `at` of
   * the last `attempt` / `resume` / `settleFailed`, settled Msg or timer fire.
   * `timer` counts the soonest deadline down from it, so the built-in `timer`
   * Sub gets a relative `ms` without anything reading a clock. `0` until the
   * first clocked transition.
   */
  readonly clockMs: number;
}

// ===========================================================================
// Cmds + Msgs the knob speaks. Generic over the port input `I`.
// ===========================================================================

/**
 * The failures a run handler may return (ADR 0021). `port_rejected` is the
 * work failing — carry the cause beside the tag (`err({ _tag: "port_rejected",
 * cause })`); `deadline_exceeded` is a handler that timed the work out itself.
 * Either one settles as `<name>_run_err` and feeds the retry / breaker. Any
 * other failure is a contract breach and goes to the error sink.
 */
export type RunErr = TaggedError<"port_rejected" | "deadline_exceeded">;

/**
 * The one effect this knob emits: "run the work for `key` with `input`". It is
 * `Cmd.define`d, so the handler you write for it returns an outcome and the
 * engine mints `<name>_run_ok` / `<name>_run_err` (ADR 0021). It carries no
 * closure — `input` is plain data (invariant 3).
 */
export function runCmdDef<I, R, N extends string = DefaultResilientName>(
  name: N = DEFAULT_RESILIENT_NAME as N,
) {
  return Cmd.define(`${name}_run` as ResilientRunType<N>, {
    input: unchecked<{ readonly key: string; readonly input: I }>(),
    ok: unchecked<R>(),
    err: ["port_rejected", "deadline_exceeded"],
  });
}
export type RunCmdDef<
  I,
  R,
  N extends string = DefaultResilientName,
> = ReturnType<typeof runCmdDef<I, R, N>>;
/**
 * The run Cmd value. `R` is its settle value — `unknown` reads any knob's run
 * Cmd; the knob's own verbs emit it at their `R`, which is what lets a machine
 * list `cmds: [rc.run]` and take the verbs' Cmds as its own.
 */
export type RunCmd<
  I,
  N extends string = DefaultResilientName,
  R = unknown,
> = CmdOf<RunCmdDef<I, R, N>>;

/**
 * The settle Msgs the engine mints from a run handler's outcome:
 * `<name>_run_ok` carrying the handler's `value`, `<name>_run_err` carrying its
 * declared `error`. Each carries the run Cmd it settles (`cmd.key` names the
 * call) and the `at` the engine stamped. Both are generic in the knob's name
 * family `N`, so two knobs named apart land in two `update` cells whose
 * payloads are already narrowed.
 *
 * They are the `SettledOk` / `SettledErr` pair `Cmd.define` mints, spelled out
 * so a helper that folds the error into a richer type of its own (llm-call's
 * `LlmErr`, jev-ask's `JevAskErr`) can hand `settle` its Msg with `E` widened.
 */
export type SucceedMsg<
  R,
  N extends string = DefaultResilientName,
  I = unknown,
> = {
  readonly type: ResilientOkType<N>;
  readonly cmd: RunCmd<I, N>;
  readonly value: R;
  readonly at: number;
};
export type FailMsg<
  N extends string = DefaultResilientName,
  I = unknown,
  E = RunErr | MalformedResult,
> = {
  readonly type: ResilientErrType<N>;
  readonly cmd: RunCmd<I, N>;
  readonly error: E;
  readonly at: number;
};

/**
 * What `settle` reads off a settled Msg: the call's `key` (on `cmd`), the
 * engine's `at`, and the handler's `value` or `error`. {@link SucceedMsg} and
 * {@link FailMsg} are both one of these, so an engine-minted Msg passes
 * straight in; a helper that settles from its own data (a fallback answer, a
 * compaction summary) builds the record without inventing a whole run Cmd.
 */
export type SettleMsg<R, N extends string = DefaultResilientName> =
  | {
      readonly type?: ResilientOkType<N>;
      readonly cmd: { readonly key: string };
      readonly value: R;
      readonly at: number;
    }
  | {
      readonly type?: ResilientErrType<N>;
      readonly cmd: { readonly key: string };
      readonly error: unknown;
      readonly at: number;
    };

/**
 * How a settled call ended — the third thing `settle` hands back, and the only
 * place the port's value can be read from.
 *
 *   - `done`     — the port answered; `value` is its result.
 *   - `failed`   — no retry is left (or no retry brick); `error` is the last
 *                  failure.
 *   - `retrying` — backed off; the retry timer is armed and the call is still
 *                  live.
 */
export type SettleOutcome<R> =
  | { readonly kind: "done"; readonly value: R }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "retrying" };

/**
 * What `settle` returns: the settled slice, the Cmds it emitted, and the
 * {@link SettleOutcome}. One record, so the slice update and the result read
 * cannot be split apart in a hand-wired `update` cell.
 */
export interface SettleResult<I, R, N extends string = DefaultResilientName> {
  readonly call: ResilientState<I, R>;
  readonly cmds: readonly RunCmd<I, N, R>[];
  readonly outcome: SettleOutcome<R>;
}

/**
 * The deadline Msg tag this knob's timers dispatch, derived from its name the
 * same way the settle Msgs are. The DEFAULT family keeps the bare
 * `"deadline_exceeded"` literal.
 */
export type ResilientDeadlineType<N extends string = DefaultResilientName> =
  N extends DefaultResilientName ? "deadline_exceeded" : `${N}_deadline`;

/**
 * The name a deadline carries for the `N` family — `undefined` for the
 * default family (no name at all, so the bare literal is dispatched), the name
 * itself otherwise. One conditional, so the value and {@link
 * ResilientDeadlineType} can never disagree about which family is unnamed.
 */
export type DeadlineNameOf<N extends string = DefaultResilientName> =
  N extends DefaultResilientName ? undefined : N;

/**
 * The retry / deadline timer Msg — a `DeadlineExceeded` whose tag is this
 * knob's ({@link ResilientDeadlineType}), keyed by the call `key` through the
 * Sub `id`. Bare `ResilientTimerMsg` is the default family's, so it is the same
 * `DeadlineExceeded` it has always been.
 */
export type ResilientTimerMsg<N extends string = DefaultResilientName> =
  DeadlineExceeded<DeadlineNameOf<N>>;

/**
 * The plain-data error a deadline-failed call settles with. A `{_tag, ...}`
 * sentinel — NEVER a `new Error(...)` — so the slice stays JSON-serializable
 * (Error objects round-trip to `{}` and carry a stack trace, both of which break
 * the slice's durability invariant). `id` / `atMs` echo the timer that fired so
 * a consumer can attribute the failure to its deadline.
 */
export type DeadlineExceededError = {
  readonly _tag: "deadline_exceeded";
  readonly id: string;
  readonly atMs: number;
};

// ===========================================================================
// Internal brick-policy derivation — config → the L1 policy shapes.
// ===========================================================================

// A circuit policy is only built when the brick is configured; absence is
// represented as `null` so the gate can short-circuit to "always pass".
function circuitPolicy(config: ResilientConfig<string>) {
  if (config.circuit === undefined) return null;
  return {
    failureThreshold: config.circuit.threshold,
    cooldownMs: config.circuit.cooldownMs,
    halfOpenMaxProbes: config.circuit.halfOpenMaxProbes ?? 1,
  };
}

/**
 * Close the open charging segment at `at` and open the next one there: the ONE
 * place a {@link CallBudget} is debited. Every caller holds `at` as data (a
 * verb's argument, a Msg's stamp), so the budget advances without any verb
 * reading a clock. PURE.
 *
 * A budget with no deadline brick (`remainingMs` 0) is left alone — there is
 * nothing to spend, and debiting it would push it negative and read as "spent".
 * `at` before the anchor cannot happen on a monotonic feed, but a clamped charge
 * keeps a skewed one from CREDITING budget back.
 */
function charge(budget: CallBudget, at: number): CallBudget {
  if (budget.remainingMs <= 0) return { ...budget, chargingSinceMs: at };
  const elapsed = Math.max(0, at - budget.chargingSinceMs);
  return { remainingMs: budget.remainingMs - elapsed, chargingSinceMs: at };
}

// Deadline-id families. Each call's retry timer is a deadline keyed by `key`, so
// a machine running many concurrent calls arms and routes each independently.
// The knob's `name` leads the id for the same reason it leads the Msg types: a
// fired timer is routed by its id, so two knobs sharing a key would otherwise
// answer each other's timer.
// The default `resilient` name reproduces the ids exactly as they have always
// read.
function retryTimerId(name: string, key: string): string {
  return `${name}:retry:${key}`;
}
function deadlineTimerId(name: string, key: string): string {
  return `${name}:deadline:${key}`;
}

/**
 * The deadline Sub's `name` for a knob's family — the value side of
 * {@link DeadlineNameOf}. The default family maps to `undefined` (no name),
 * which is what keeps an unnamed knob dispatching the bare `deadline_exceeded`
 * literal rather than a `resilient_deadline` nobody is wired for.
 */
function deadlineNameOf<N extends string>(name: N): DeadlineNameOf<N> {
  return (
    name === DEFAULT_RESILIENT_NAME ? undefined : name
  ) as DeadlineNameOf<N>;
}

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build a resilient-call knob from `config`. `rng` is injected for retry
 * jitter — pass a fixed `() => 0.5` in tests to pin backoff; defaults to
 * `Math.random` (read at the verb boundary, never inside a brick op). It is
 * curried onto the factory rather than threaded through every verb so callers
 * spell the determinism choice once.
 *
 * Returns plain functions and the run Cmd def (ADR 0022) — see the module doc
 * for the wiring. `I` is the work's input type, `R` its result type.
 */
export function createResilientCall<
  I,
  R,
  N extends string = DefaultResilientName,
>(config: ResilientConfig<N>, rng: () => number = Math.random) {
  const name = config.name ?? (DEFAULT_RESILIENT_NAME as N);
  const cPolicy = circuitPolicy(config);
  // Re-affirm the `[0, 1)` contract at the seam where the injected generator
  // feeds the backoff math (brand from `../retry-backoff`). The factory's
  // public param stays a plain `() => number` so transitive callers are
  // unchanged; `asRng` is the single point it's branded for `nextDelayMs`.
  const rngBranded = asRng(rng);
  const runCmd = runCmdDef<I, R, N>(name);
  // The name each deadline carries, which is what fixes the Msg tag it
  // dispatches. `undefined` for the DEFAULT family: an unnamed knob must keep
  // dispatching the bare `deadline_exceeded` literal every existing machine is
  // wired against, so the default is not merely spelled the same — it is the
  // absence of a name, exactly as before this parameter existed.
  const deadlineName = deadlineNameOf(name);

  /** The starting slice. Bricks not in `config` still get a default value. */
  function init(): ResilientState<I, R> {
    return {
      circuit: initCircuit(),
      // The bucket carries a default value even without the rateLimit brick so
      // the slice shape is uniform, but the rate-limit GATE is skipped entirely
      // when the brick is absent (see `gate`) — the bucket is simply never
      // consulted. A `0/0` placeholder bucket would be touched by `tryConsume`;
      // a `1-cap` default is harmless because the gate never calls it.
      bucket: config.rateLimit
        ? initBucket(
            config.rateLimit.capacity,
            config.rateLimit.refillPerSec,
            0,
          )
        : initBucket(1, 1, 0),
      retry: {},
      cache: initCache<R>(),
      calls: {},
      clockMs: 0,
    };
  }

  /** Record `at` as the latest instant this slice saw (see `clockMs`). */
  function tick(s: ResilientState<I, R>, at: number): ResilientState<I, R> {
    return s.clockMs === at ? s : { ...s, clockMs: at };
  }

  /** Read this key's retry state, defaulting to a fresh one. */
  function retryOf(s: ResilientState<I, R>, key: string): RetryState {
    return s.retry[key] ?? initRetry();
  }

  /** A fresh full budget for a call starting at `at` (`remainingMs` 0 = no cap). */
  function freshBudget(at: number): CallBudget {
    return {
      remainingMs: config.deadline ? config.deadline.ms : 0,
      chargingSinceMs: at,
    };
  }

  /**
   * The budget a call already live under `key` carries forward, charged up to
   * `at`; a fresh full budget when the key has no live call. This is what makes a
   * re-attempt share ONE budget with the attempts before it rather than buying a
   * new one — the in-process invariant the deadline brick has always had.
   */
  function budgetFor(
    s: ResilientState<I, R>,
    key: string,
    at: number,
  ): CallBudget {
    const call = s.calls[key];
    if (call?.phase === "running" || call?.phase === "waiting_retry") {
      return charge(call.budget, at);
    }
    return freshBudget(at);
  }

  /**
   * The shared decision: budget → cache → rate-limit → circuit gate, then either
   * emit the effect or schedule a retry. `budget` is threaded so a re-attempt
   * (from `onTimer`) keeps the ORIGINAL overall budget rather than restarting it.
   * PURE — `at` is the only clock; `rng` is the injected jitter source.
   *
   * ## Why the budget is checked BEFORE the effect is emitted
   *
   * The check is step 0 and it settles rather than dispatches. A call whose
   * budget is spent must not reach the port at all: the port is a real side
   * effect, and re-issuing an attempt only to settle `deadline_exceeded` when it
   * returns spends that effect for an answer nobody reads. This is exactly the
   * resume path's shape — a process that comes back to a spent budget settles
   * here, with zero further port calls (#144).
   *
   * Used by both `attempt` (fresh call) and `onTimer` (retry timer fired) so
   * the gate logic lives in exactly one place — the example's shared `attempt`
   * helper, lifted to a keyed knob.
   *
   * ## Why rate-limit is gated BEFORE the circuit probe
   *
   * The circuit-breaker's `canPass` is not a passive read: in `half_open` it
   * *consumes* a probe slot (advancing `probes`), and the consumed slot is only
   * released when a probe RESOLVES via `onSuccess` / `onFailure`. So a probe
   * slot may only be taken when this attempt is actually going to reach the
   * backend (i.e. emit the `resilient_run` Cmd). The rate-limit gate can reject
   * an attempt and return a backoff WITHOUT any Cmd — no backend call, so no
   * settle Msg ever comes back. If the circuit probe were consumed first, that
   * rate-limited attempt would burn the half-open probe budget on a call that
   * never happened, wedging the breaker `half_open` at its probe cap forever
   * (nothing moves it out of `half_open` but a resolved probe). Running the
   * rate-limit gate first means the circuit probe is consumed ONLY on the path
   * that emits the effect.
   */
  function gate(
    s: ResilientState<I, R>,
    key: string,
    input: I,
    at: number,
    budget: CallBudget,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N, R>[]] {
    // 0) Budget gate. Skipped without the deadline brick (`remainingMs` stays 0
    // and never moves). A spent budget settles here — before the cache read, the
    // token spend and the circuit probe, none of which a dead call should touch.
    if (config.deadline !== undefined && budget.remainingMs <= 0) {
      return [
        setCall(s, key, {
          phase: "failed",
          error: {
            _tag: "deadline_exceeded",
            id: deadlineTimerId(name, key),
            atMs: at,
          } satisfies DeadlineExceededError,
        }),
        [],
      ];
    }

    // 1) Serve from cache if fresh — no effect at all. Skipped when no cache brick.
    if (config.cache !== undefined) {
      const cached = cacheGet(s.cache, key, at);
      if (cached !== undefined) {
        return [setCall(s, key, { phase: "succeeded", result: cached }), []];
      }
    }

    // 2) Rate-limit gate FIRST — it may reject with no Cmd, so it must run
    // before any circuit probe is consumed (see header note). Skipped entirely
    // when no rateLimit brick — the bucket is never consulted, so the default
    // placeholder bucket stays untouched.
    let bucket = s.bucket;
    if (config.rateLimit !== undefined) {
      const [next, hasToken] = tryConsume(bucket, at);
      bucket = next;
      if (!hasToken) {
        // Rate-limited: treat as a transient failure and back off via retry.
        // The circuit is untouched — no probe is spent on a call that never ran.
        return backoff(
          { ...s, bucket },
          key,
          input,
          "rate_limited",
          at,
          budget,
        );
      }
    }

    // 3) Circuit-breaker gate. `null` policy → no breaker → always pass. Reached
    // only once a token is secured, so a half-open probe is consumed exclusively
    // on the path that emits the effect below.
    let circuit = s.circuit;
    if (cPolicy !== null) {
      const [next, ok] = canPass(circuit, cPolicy, at);
      circuit = next;
      if (!ok) {
        return [
          { ...setCall(s, key, { phase: "circuit_open" }), bucket, circuit },
          [],
        ];
      }
    }

    // 4) All gates passed — emit the effect as data.
    return [
      {
        ...setCall(s, key, { phase: "running", input, budget }),
        circuit,
        bucket,
      },
      [runCmd({ key, input })],
    ];
  }

  /**
   * Back off after a transient failure: record it, and if `retry` permits
   * another attempt, enter `waiting_retry` with the retry timer armed; else
   * settle `failed`. When no `retry` brick is configured the call fails on the
   * first failure (no backoff, no timer). PURE.
   *
   * `at` is both the backoff anchor AND the streak clock: it is passed to
   * `recordFailure` (which starts `firstFailureAtMs` on the streak's first
   * failure and preserves it on every later one) and to `shouldRetry`, so a
   * `DurationRetryPolicy` on `config.retry` is honoured with no extra wiring.
   * A success drops `retry[key]` entirely, which drops the origin with it —
   * only an unbroken run of failures grows toward a duration budget.
   */
  function backoff(
    s: ResilientState<I, R>,
    key: string,
    input: I,
    error: unknown,
    at: number,
    budget: CallBudget,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N, R>[]] {
    if (config.retry === undefined) {
      return [setCall(s, key, { phase: "failed", error }), []];
    }
    const retry = recordFailure(retryOf(s, key), error, at);
    const withRetry = { ...s, retry: { ...s.retry, [key]: retry } };
    if (!shouldRetry(retry, config.retry, at)) {
      return [setCall(withRetry, key, { phase: "failed", error }), []];
    }
    const retryAtMs = at + nextDelayMs(retry, config.retry, rngBranded);
    return [
      setCall(withRetry, key, {
        phase: "waiting_retry",
        input,
        retryAtMs,
        budget,
      }),
      [],
    ];
  }

  // Set the phase for one key, leaving every other field untouched.
  function setCall(
    s: ResilientState<I, R>,
    key: string,
    phase: CallPhase<I, R>,
  ): ResilientState<I, R> {
    return { ...s, calls: { ...s.calls, [key]: phase } };
  }

  // === Verb: attempt =======================================================

  /**
   * Start (or restart) the call for `key` with `input` at time `at`. Runs the
   * cache → circuit → rate-limit gate and either emits the `resilient_run`
   * effect, schedules a retry, fast-fails (circuit open), or serves the cache.
   * PURE.
   *
   * A key already live keeps the budget it is under (charged up to `at`) rather
   * than being handed a fresh one, so re-issuing an in-flight call — the boot
   * path's move — cannot silently extend its deadline. Only a key with no live
   * call starts a full budget.
   */
  function attempt(
    s: ResilientState<I, R>,
    key: string,
    input: I,
    at: number,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N, R>[]] {
    return gate(tick(s, at), key, input, at, budgetFor(s, key, at));
  }

  // === Verb: resume ========================================================

  /**
   * Re-anchor every live call's charging clock to `at`: the verb a host calls
   * once on the boot path, before any Sub is armed or any attempt re-issued.
   *
   * This is what keeps DOWNTIME out of the budget. `chargingSinceMs` is an
   * instant on the clock of the process that wrote it; after an eviction, a crash
   * or a redeploy, the gap between it and now is time in which no attempt ran and
   * no port was called, so charging it would time a call out on the host's
   * absence rather than on the tool's slowness. `remainingMs` — the durable half
   * of the budget — is left exactly as the last live transition set it. PURE.
   */
  function resume(s: ResilientState<I, R>, at: number): ResilientState<I, R> {
    const calls: Record<string, CallPhase<I, R>> = { ...s.calls };
    for (const [key, call] of Object.entries(calls)) {
      if (call.phase !== "running" && call.phase !== "waiting_retry") continue;
      calls[key] = {
        ...call,
        budget: { ...call.budget, chargingSinceMs: at },
      };
    }
    return { ...s, calls, clockMs: at };
  }

  // === The two record steps `settle` is built from ==========================

  /**
   * Record a success for `msg.key`: close the breaker, fill the cache (if a
   * cache brick exists), reset this key's retry count, and settle `succeeded`.
   * PURE — `msg.at` is the cache write clock. Private: {@link settle} is the
   * verb.
   */
  function recordOk(
    s: ResilientState<I, R>,
    msg: Extract<SettleMsg<R, N>, { readonly value: R }>,
  ): ResilientState<I, R> {
    const { key } = msg.cmd;
    const circuit =
      cPolicy !== null ? onSuccess(s.circuit, cPolicy) : s.circuit;
    const cache =
      config.cache !== undefined
        ? cacheSet(s.cache, key, msg.value, msg.at, config.cache.ttlMs)
        : s.cache;
    // Drop this key's retry counter — a success ends the retry run.
    const retry = without(s.retry, key);
    return {
      ...setCall(s, key, { phase: "succeeded", result: msg.value }),
      circuit,
      cache,
      retry,
    };
  }

  /**
   * Record a failure for `msg.key`: trip the breaker (it may open), then back
   * off — schedule a retry if `retry` permits, else settle `failed`. PURE —
   * `msg.at` stamps the breaker trip + the retry delay base. Re-issues from the
   * call's remembered `input` and carries the original budget forward, charged
   * up to `msg.at` — the attempt that just failed spent in-process time, and a
   * retry ladder shares ONE budget across its attempts rather than getting a
   * fresh one per attempt. Private: {@link settle} is the verb.
   */
  function recordErr(
    s: ResilientState<I, R>,
    msg: Extract<SettleMsg<R, N>, { readonly error: unknown }>,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N, R>[]] {
    const { key } = msg.cmd;
    const circuit =
      cPolicy !== null ? onFailure(s.circuit, cPolicy, msg.at) : s.circuit;
    const withCircuit = { ...s, circuit };
    const call = s.calls[key];
    const input = call?.phase === "running" ? call.input : undefined;
    const budget = budgetFor(s, key, msg.at);
    // No remembered input (e.g. a stray fail for a key not running) → just
    // settle failed after tripping the breaker; nothing to re-issue.
    if (input === undefined) {
      return [
        setCall(withCircuit, key, { phase: "failed", error: msg.error }),
        [],
      ];
    }
    return backoff(withCircuit, key, input, msg.error, msg.at, budget);
  }

  function isOk(
    msg: SettleMsg<R, N>,
  ): msg is Extract<SettleMsg<R, N>, { readonly value: R }> {
    return "value" in msg;
  }

  // === Verb: settle ========================================================

  /**
   * Settle the call a `<name>_run_ok` / `<name>_run_err` Msg answers, keyed off
   * `msg.cmd.key`, and say how it ended. PURE.
   *
   * A success closes the breaker, fills the cache and ends the retry run; the
   * outcome is `done` with the handler's value. A failure trips the breaker and
   * backs off: `retrying` while the retry policy allows another attempt, and
   * `failed` with the error once it does not. A `retrying` call waits on the
   * retry timer `timer` arms; its fire re-issues the run Cmd through `onTimer`.
   *
   * The settled slice, its Cmds and the outcome come back together, and the
   * result value is reachable ONLY through `outcome`. So a hand-wired settle
   * cell cannot fold the answer into its Model before the slice has settled —
   * the order that used to leave a call stuck at `running` cannot be written.
   */
  function settle(
    s: ResilientState<I, R>,
    msg: SettleMsg<R, N>,
  ): SettleResult<I, R, N> {
    const now = tick(s, msg.at);
    if (isOk(msg)) {
      return {
        call: recordOk(now, msg),
        cmds: [],
        outcome: { kind: "done", value: msg.value },
      };
    }
    const [call, cmds] = recordErr(now, msg);
    return {
      call,
      cmds,
      outcome:
        call.calls[msg.cmd.key]?.phase === "waiting_retry"
          ? { kind: "retrying" }
          : { kind: "failed", error: msg.error },
    };
  }

  // === Verb: settleFailed ==================================================

  /**
   * Settle `key` to terminal `failed` with `error` WITHOUT touching the circuit
   * breaker or this key's retry counter. PURE.
   *
   * This is the verb for a failure that is NOT a downstream-health signal: the
   * call must end now, but the breaker must not trip and the backoff run must
   * not advance. `settle` on an `_err` Msg is the opposite — it records the
   * failure against the breaker (it may open) and feeds the retry policy (it
   * may back off). Use
   * `settleFailed` when the *reason* the call cannot proceed has nothing to do
   * with downstream health:
   *
   *   - `authed-call` settles a 401 it cannot fix (e.g. the refresh budget is
   *     spent): a bad token is the caller's problem, not the backend's —
   *     tripping the breaker on it would punish a healthy target, and backing
   *     off would just retry a request that will 401 again.
   *   - `paginated-walk` settles a terminal walk error (e.g. a malformed page
   *     the consumer rejects) that should stop the walk without poisoning the
   *     shared breaker the next page fetch passes through.
   *
   * Because it leaves `circuit` and `retry[key]` untouched, the breaker keeps
   * its health view of the actual backend and a later `attempt` for this key
   * starts a fresh retry run. Both sibling knobs previously hand-rolled this by
   * splicing `calls` directly; this verb gives them one named, tested entry
   * point so the slice's settle invariants live in exactly one place.
   *
   * `at` is the instant the caller decided it — recorded as the slice's clock,
   * since ending a call can change which deadline `timer` counts down to.
   */
  function settleFailed(
    s: ResilientState<I, R>,
    key: string,
    error: unknown,
    at: number,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N, R>[]] {
    return [setCall(tick(s, at), key, { phase: "failed", error }), []];
  }

  // === Verb: onTimer =======================================================

  /**
   * A timer fired for some key. Two kinds, disambiguated by the Sub id:
   *
   *   - retry timer    → re-run the gate for that key's remembered input,
   *                      re-checking the circuit + bucket at THIS time.
   *   - deadline timer → the overall budget elapsed → settle `failed` with a
   *                      deadline error, no matter the current phase.
   *
   * A timer for a key no longer `waiting_retry` (retry) / no longer in flight
   * (deadline) leaves the calls alone — the reconcile pass races the result;
   * the verb must tolerate a stale fire. Every fire records `msg.atMs` as the
   * slice's clock, so `timer` re-arms from it. PURE.
   */
  function onTimer(
    slice: ResilientState<I, R>,
    msg: { readonly id: string; readonly atMs: number },
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N, R>[]] {
    const s = tick(slice, msg.atMs);
    for (const [key, call] of Object.entries(s.calls)) {
      if (msg.id === retryTimerId(name, key)) {
        if (call.phase !== "waiting_retry") return [s, []];
        // The backoff wait was in-process time, so it is charged before the gate
        // reads the budget — and the gate settles rather than dispatching when
        // that leaves nothing, which is how a resumed ladder ends without one
        // more port call.
        return gate(
          s,
          key,
          call.input,
          msg.atMs,
          charge(call.budget, msg.atMs),
        );
      }
      if (msg.id === deadlineTimerId(name, key)) {
        // Deadline only fires for a still-active call. A settled call has no
        // armed deadline Sub, but tolerate a stale fire defensively.
        if (call.phase !== "running" && call.phase !== "waiting_retry")
          return [s, []];
        // Plain-data sentinel, NOT a `new Error(...)`: an Error object is not
        // JSON-serializable (it round-trips to `{}`) and captures a stack trace,
        // both of which break the slice's durability invariant once it is
        // persisted into a `Store<S>` and reloaded. A `{_tag, ...}` record keeps
        // the slice round-trip-equal under JSON.parse(JSON.stringify(...)).
        return [
          setCall(s, key, {
            phase: "failed",
            error: {
              _tag: "deadline_exceeded",
              id: msg.id,
              atMs: msg.atMs,
            } satisfies DeadlineExceededError,
          }),
          [],
        ];
      }
    }
    return [s, []];
  }

  // === Timers ==============================================================

  /**
   * The deadlines this slice is waiting on: a retry timer for every
   * `waiting_retry` call, and (when the `deadline` brick is configured) an
   * overall deadline timer for every still-active call. Each is an absolute
   * instant; `timer` arms the soonest. PURE.
   */
  function deadlines(
    s: ResilientState<I, R>,
  ): readonly DeadlineSub<DeadlineNameOf<N>>[] {
    const out: DeadlineSub<DeadlineNameOf<N>>[] = [];
    for (const [key, call] of Object.entries(s.calls)) {
      if (call.phase === "waiting_retry") {
        out.push(
          deadlineSub(retryTimerId(name, key), call.retryAtMs, {
            name: deadlineName,
          }),
        );
      }
      if (
        config.deadline !== undefined &&
        (call.phase === "running" || call.phase === "waiting_retry") &&
        call.budget.remainingMs > 0
      ) {
        // The absolute instant the timer arms at is DERIVED here, from the open
        // segment's anchor plus what is left — it is never persisted, so a slice
        // that came back from storage arms off the anchor `resume` just re-based
        // rather than off a stamp the downtime ran past.
        out.push(
          deadlineSub(
            deadlineTimerId(name, key),
            call.budget.chargingSinceMs + call.budget.remainingMs,
            { name: deadlineName },
          ),
        );
      }
    }
    return out;
  }

  /**
   * The built-in `timer` Sub's deps for this slice: the soonest of
   * {@link deadlines}, counted down from the slice's `clockMs`, or `null` when
   * nothing is waiting. Declare it in the machine and `run` needs no runner:
   *
   *   subs: [{ type: "timer", deps: (s) => rc.timer(s.call) }]
   *
   * Its fire is this knob's timer Msg (`deadline_exceeded`, or
   * `<name>_deadline` for a named knob); route it to `onTimer`. A phase change
   * drops the matching deadline, and the new deps restart the countdown — no
   * manual `clearTimeout`. PURE.
   */
  function timer(
    s: ResilientState<I, R>,
  ): TimerDeps<ResilientTimerMsg<N>> | null {
    return nextTimer(deadlines(s), s.clockMs);
  }

  return {
    // The Msg-name family this knob speaks, as a VALUE typed at `N`: the Cmd,
    // the settle Msgs and the timer ids all derive from it.
    name,
    /** The `Cmd.define`d run Cmd; list it in the machine's `cmds`. */
    run: runCmd,
    init,
    attempt,
    resume,
    settle,
    settleFailed,
    onTimer,
    deadlines,
    timer,
  };
}

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the
 * slice lives at `state.resilience`. A convenience for the common single-slice
 * host; consumers with a differently-named field spread by hand. Pure — a thin
 * record rebuild, no clock / RNG.
 *
 * The record rebuild itself is `liftSlice` from the root door (#231) — this
 * stays as the named, pre-keyed convenience for the `state.resilience` field,
 * unchanged in name, signature and subpath.
 */
export function liftResilience<
  S extends { resilience: ResilientState<I, R> },
  I,
  R,
  C extends Cmd,
>(
  state: S,
  result: readonly [ResilientState<I, R>, readonly C[]],
): readonly [S, readonly C[]] {
  return liftSlice("resilience", state, result);
}
