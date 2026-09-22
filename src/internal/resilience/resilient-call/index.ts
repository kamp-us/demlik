/**
 * @packageDocumentation
 *
 * Internal to the package (`src/internal/resilience/`, #46). The published
 * `./resilient-call` door is closed; the consumer-facing shape is the
 * higher-order `withResilience(base, config)` wrapper in `../with-resilience`
 * (TEA-idiomatic: it wraps any existing machine instead of forcing a bespoke
 * embedded slice), and this module is its implementation. The APIs are NOT
 * drop-in; migration map, for the in-tree embedded-slice consumers:
 *
 *   - `createResilientCall(config, rng)` + hand-wiring `init` / the verbs /
 *     `subs` / `handlers` into your machine → `withResilience(base, { target,
 *     ...bricks }, rng)`. Nothing is wired by hand anymore: the wrapper
 *     intercepts the `target` base Cmd and routes it through the gate.
 *   - `ResilientConfig` bricks (`retry` / `circuit` / `rateLimit` / `cache` /
 *     `deadline`) → unchanged; `ResilienceConfig` extends the same knob and
 *     adds `target` (required), `keyOf?` (per-call key — was `attempt`'s `key`
 *     argument), and `at?` (time-as-data reader — REQUIRED with any
 *     time-sensitive brick; `withResilience` throws at construction without it).
 *   - The slice at your chosen Model field + `liftResilience` → the wrapper
 *     owns `model.$resilience`; there is nothing to lift.
 *   - Verbs `attempt` / `succeed` / `fail` / `onTimer` → internal to the
 *     wrapper; results route as `$resilience:ok` / `$resilience:err` /
 *     `$resilience:timer` Msgs through the merged `update` (the old
 *     `resilient_run` / `resilient_ok` / `resilient_err` vocabulary is renamed
 *     into the `$resilience:` namespace).
 *   - `settleFailed` → NO equivalent. It exists for embedded-slice consumers
 *     (`authed-call`, `paginated-walk`) that settle a call without touching the
 *     breaker; the wrapper exposes no caller-facing settle verb.
 *   - `handlers(ports)` / `subs(state)` / the `subscribeDeadline` re-export →
 *     handled by the wrapper; run the returned machine like any other.
 *
 * The in-tree modules that embed the slice (`with-resilience` itself, `agent`,
 * `llm-call`, `authed-call`, `reconciler`, `paginated-walk`) import this module
 * directly — that is its role.
 *
 * internal/resilience/resilient-call — the ROOT composition: a single resilience knob
 * that bundles cache → circuit-breaker → rate-limit → exponential-backoff retry
 * (with a deadline-driven retry timer) around any fallible `(input) => Promise`
 * port.
 *
 * This is `examples/resilient-fetch.ts`'s hand-wired `attempt()` generalized:
 *
 *   - It is **keyed**. The example tracked one URL at a time; this tracks N
 *     concurrent logical calls, each under a string `key`. The cache, the
 *     waiting-retry bookkeeping, and the retry timers are all per-key, while the
 *     circuit breaker and token bucket are shared (one downstream target, one
 *     breaker / one bucket — the example's implicit single-target assumption
 *     made explicit).
 *   - It is **config-driven**, not hand-wired. You hand `createResilientCall`
 *     a `ResilientConfig` and get back the uniform knob contract every L2
 *     composition exposes: `init()`, the four verbs (`attempt` / `succeed` /
 *     `fail` / `onTimer`), `subs(state)`, and `handlers(ports)`.
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
 * ## Where the clock / RNG live
 *
 * Inside the verbs: nowhere. Time arrives as `at` on `attempt` / `onTimer` and
 * is carried on the result / timer Msgs the consumer dispatches. Jitter RNG is
 * injected once at `createResilientCall(config, rng)` and threaded into
 * `nextDelayMs` at the verb boundary — deterministic in tests, `Math.random`
 * by default. The ONLY clock read is `Date.now()` inside the `handlers` port
 * (the effect boundary), exactly as `resilient-fetch.ts` stamps its result Msgs.
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
 *   // `mountResilientCall` pre-assembles the wiring; the one cell it cannot
 *   // write is `attempt`, whose arguments only the consumer's Msg knows. This
 *   // knob's `handlers` takes ports, so it is bound before the mount reads it —
 *   // `../../jev/ask` and `../../llm-call` expose a nullary `handlers()` and
 *   // are passed straight in.
 *   const mounted = mountResilientCall({
 *     ...rc,
 *     handlers: () => rc.handlers({ run: ctx.call }),
 *   }, {
 *     slice: "resilience",
 *     attempt: {
 *       on: "fetch",
 *       run: (slice, m: Fetch) => rc.attempt(slice, m.key, m.input, m.at),
 *     },
 *     onOk: (model, m) => [{ ...model, result: m.result }, []],
 *   });
 *
 *   // in the machine:
 *   init: () => [{ ...mounted.init(), result: null }, []],
 *   update: { ...mounted.update },
 *   subscriptions: mounted.subscriptions,
 *   subscribe: mounted.subscribe,
 *   interpret: mounted.interpret,
 *
 * The six verbs stay exported and callable by hand for a consumer that wants a
 * cell the mount cannot express (ADR 0015's escape hatch): `rc.succeed(...)`,
 * `rc.fail(...)`, `rc.onTimer(...)` and `liftResilience` splice exactly as
 * before.
 *
 * ## Naming a knob, when a machine mounts more than one
 *
 * Every knob above speaks `resilient_run` / `resilient_ok` / `resilient_err`,
 * so TWO of them in one machine meet in one `resilient_ok` cell whose `result`
 * is the union of both payloads — discriminated by hand on `key`, which the
 * type checker cannot grade. `config.name` renames the whole family, Cmd and
 * both settle Msgs together:
 *
 *   const jev = createResilientCall<JevRequest, JevOk, "jev">({ name: "jev" });
 *   const llm = createResilientCall<LlmCall, LlmOk, "llm">({ name: "llm" });
 *
 *   update: {
 *     jev_ok: (s, m) => …,   // m.result is JevOk — no `key` switch
 *     llm_ok: (s, m) => …,   // m.result is LlmOk
 *   }
 *
 * The name leads the retry / deadline Sub ids too (`jev:retry:<key>`), because
 * Subs reconcile by id and two knobs would otherwise share one timer per key.
 * `N` is not inferable from `I` / `R`, so an opted-in knob spells all three
 * type arguments; `config.name` is typed at `N`, so value and type cannot
 * drift. Omit `name` and every one of those strings is `resilient*` exactly as
 * it has always been — no existing machine changes.
 *
 * `mountResilientCall` reads the same name off the knob, so a mounted named
 * knob's settle cells are `jev_ok` / `jev_err` too — the mount never spells the
 * `resilient_*` literals, and two named knobs mounted into one machine spread
 * into four distinct cells.
 */

import { z } from "zod";
import { Cmd, type CmdOf, type NoCtx, tryInterpret } from "../../../index";
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
  subscribeDeadline,
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
 * The family every unnamed knob speaks: `resilient_run` / `resilient_ok` /
 * `resilient_err`. Identical to the `MsgType.Resilient*` literals, which stay
 * the vocabulary of every knob that passes no name.
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
  `${DEFAULT_RESILIENT_NAME}_ok` as const;
const _errIsProtocol: typeof MsgType.ResilientErr =
  `${DEFAULT_RESILIENT_NAME}_err` as const;
void [_runIsProtocol, _okIsProtocol, _errIsProtocol];

/** The run Cmd's `type` for the `N` family. */
export type ResilientRunType<N extends string> = `${N}_run`;
/** The success settle Msg's `type` for the `N` family. */
export type ResilientOkType<N extends string> = `${N}_ok`;
/** The failure settle Msg's `type` for the `N` family. */
export type ResilientErrType<N extends string> = `${N}_err`;

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
   * `fail`'s `msg.at` (stamped at the interpret boundary) and `gate`'s `at`
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
 *   - `running`       — the effect Cmd is out; awaiting `succeed` / `fail`.
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
}

// ===========================================================================
// Cmds + Msgs the knob speaks. Generic over the port input `I`.
// ===========================================================================

/**
 * The one effect this knob emits: "run the port for `key` with `input`". The
 * consumer's `handlers(ports)` interprets it; it carries no closure — `input`
 * is plain data (invariant 3).
 */
export function runCmdDef<I, R, N extends string = DefaultResilientName>(
  name: N = DEFAULT_RESILIENT_NAME as N,
) {
  return Cmd.define(`${name}_run` as ResilientRunType<N>, {
    input: z.custom<{ readonly key: string; readonly input: I }>(),
    ok: z.custom<R>(),
    err: ["port_rejected", "deadline_exceeded"],
  });
}
export type RunCmdDef<
  I,
  R,
  N extends string = DefaultResilientName,
> = ReturnType<typeof runCmdDef<I, R, N>>;
export type RunCmd<I, N extends string = DefaultResilientName> = CmdOf<
  RunCmdDef<I, unknown, N>
>;

/**
 * Settle Msgs the `handlers` port dispatches back. `at` is stamped at the
 * boundary. Both are generic in the knob's name family `N`, so two knobs named
 * apart land in two `update` cells whose payloads are already narrowed — the
 * `key` switch a single shared cell forces is gone.
 */
export type SucceedMsg<R, N extends string = DefaultResilientName> = {
  readonly type: ResilientOkType<N>;
  readonly key: string;
  readonly result: R;
  readonly at: number;
};
export type FailMsg<N extends string = DefaultResilientName> = {
  readonly type: ResilientErrType<N>;
  readonly key: string;
  readonly error: unknown;
  readonly at: number;
};

/** The retry / deadline timer Msg — `DeadlineExceeded`, keyed by the call `key`. */
export type ResilientTimerMsg = DeadlineExceeded;

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

/**
 * What `handlers(ports)` returns: the interpret cell for this knob's run Cmd,
 * under that Cmd's own name. A named knob contributes `<name>_run`, so two
 * knobs' handler records merge into one `interpret` without either shadowing
 * the other.
 */
export type ResilientHandlers<I, R, N extends string = DefaultResilientName> = {
  readonly [K in ResilientRunType<N>]: (
    cmd: RunCmd<I, N>,
    ctx: NoCtx,
  ) => Promise<SucceedMsg<R, N> | FailMsg<N>>;
};

/** Ports the consumer supplies to `handlers`. */
export interface ResilientPorts<I, R> {
  /** The fallible work this knob wraps. Throws on failure → routed to `fail`. */
  readonly run: (input: I, key: string) => Promise<R>;
}

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

// Sub-id families. Each call's retry timer is a deadline keyed by `key`, so a
// machine running many concurrent calls reconciles each independently. The
// knob's `name` leads the id for the same reason it leads the Msg types: Subs
// reconcile by id, so two knobs sharing a key would otherwise share one timer.
// The default `resilient` name reproduces the ids exactly as they have always
// read.
function retryTimerId(name: string, key: string): string {
  return `${name}:retry:${key}`;
}
function deadlineTimerId(name: string, key: string): string {
  return `${name}:deadline:${key}`;
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
 * Returns the uniform L2 knob contract. `I` is the port input type, `R` the
 * port result type. Consumers outside the package reach this through
 * `withResilience` (`../with-resilience`) — see the migration map at the top
 * of this module.
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
  // The two settle names, derived once from the same `name` the Cmd def is
  // built from — so the Cmd and the Msgs it settles into can never disagree.
  const okType = `${name}_ok` as ResilientOkType<N>;
  const errType = `${name}_err` as ResilientErrType<N>;

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
    };
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
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N>[]] {
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
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N>[]] {
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
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N>[]] {
    return gate(s, key, input, at, budgetFor(s, key, at));
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
    return { ...s, calls };
  }

  // === Verb: succeed =======================================================

  /**
   * Record a success for `key`: close the breaker, fill the cache (if a cache
   * brick exists), reset this key's retry count, and settle `succeeded`. PURE —
   * `msg.at` is the cache write clock.
   */
  function succeed(
    s: ResilientState<I, R>,
    key: string,
    msg: SucceedMsg<R, N>,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N>[]] {
    const circuit =
      cPolicy !== null ? onSuccess(s.circuit, cPolicy) : s.circuit;
    const cache =
      config.cache !== undefined
        ? cacheSet(s.cache, key, msg.result, msg.at, config.cache.ttlMs)
        : s.cache;
    // Drop this key's retry counter — a success ends the retry run.
    const retry = without(s.retry, key);
    return [
      {
        ...setCall(s, key, { phase: "succeeded", result: msg.result }),
        circuit,
        cache,
        retry,
      },
      [],
    ];
  }

  // === Verb: fail ==========================================================

  /**
   * Record a failure for `key`: trip the breaker (it may open), then back off —
   * schedule a retry if `retry` permits, else settle `failed`. PURE — `msg.at`
   * stamps the breaker trip + the retry delay base. Re-issues from the call's
   * remembered `input` and carries the original budget forward, charged up to
   * `msg.at` — the attempt that just failed spent in-process time, and a retry
   * ladder shares ONE budget across its attempts rather than getting a fresh one
   * per attempt.
   */
  function fail(
    s: ResilientState<I, R>,
    key: string,
    msg: FailMsg<N>,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N>[]] {
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

  // === Verb: settleFailed ==================================================

  /**
   * Settle `key` to terminal `failed` with `error` WITHOUT touching the circuit
   * breaker or this key's retry counter. PURE.
   *
   * This is the verb for a failure that is NOT a downstream-health signal: the
   * call must end now, but the breaker must not trip and the backoff run must
   * not advance. `fail` is the opposite — it records the failure against the
   * breaker (it may open) and feeds the retry policy (it may back off). Use
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
   */
  function settleFailed(
    s: ResilientState<I, R>,
    key: string,
    error: unknown,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N>[]] {
    return [setCall(s, key, { phase: "failed", error }), []];
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
   * (deadline) is a no-op — the reconcile pass races the result; the verb must
   * tolerate a stale fire. PURE.
   */
  function onTimer(
    s: ResilientState<I, R>,
    msg: ResilientTimerMsg,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I, N>[]] {
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

  // === Subs ================================================================

  /**
   * Pre-wired subscriptions: a retry timer for every `waiting_retry` call, and
   * (when the `deadline` brick is configured) an overall deadline timer for
   * every still-active call. Both are `DeadlineSub`s reconciled by id, so a
   * phase change cancels the matching timer automatically — no manual
   * `clearTimeout`. Wire `subscribe: { deadline: subscribeDeadline }`.
   */
  function subs(s: ResilientState<I, R>): readonly DeadlineSub[] {
    const out: DeadlineSub[] = [];
    for (const [key, call] of Object.entries(s.calls)) {
      if (call.phase === "waiting_retry") {
        out.push(deadlineSub(retryTimerId(name, key), call.retryAtMs));
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
          ),
        );
      }
    }
    return out;
  }

  // === Handlers ============================================================

  /**
   * Pre-wired interpret handler for `resilient_run`. Wraps the consumer's
   * `run` port via `tryInterpret` (Railway): success → `resilient_ok`, failure
   * → `resilient_err`, each stamped with `Date.now()` at the effect boundary —
   * the ONE permitted clock read (interpret is impure; the reducer never reads
   * the clock). Assign to the machine's `interpret`:
   *
   *   interpret: rc.handlers({ run: (input, key) => ctx.callBackend(input) })
   */
  function handlers(ports: ResilientPorts<I, R>): ResilientHandlers<I, R, N> {
    const handle = tryInterpret<
      RunCmd<I, N>,
      R,
      SucceedMsg<R, N> | FailMsg<N>,
      // The work fn reads nothing from ctx — it forwards `cmd.input` to the
      // consumer-supplied `run` port. `NoCtx` (not `unknown`) marks this as a
      // DELIBERATE context-free seam, so callers see intent, not looseness.
      NoCtx
    >(
      (cmd) => ports.run(cmd.input, cmd.key),
      (result, cmd): SucceedMsg<R, N> => ({
        type: okType,
        key: cmd.key,
        result,
        at: Date.now(),
      }),
      (error, cmd): FailMsg<N> => ({
        type: errType,
        key: cmd.key,
        error,
        at: Date.now(),
      }),
    );
    // The key is `${name}_run`, a template-literal type TS cannot see through
    // in an object literal; the mapped return type above is the declaration
    // that carries it to the caller.
    return { [runCmd.cmdType]: handle } as ResilientHandlers<I, R, N>;
  }

  return {
    // The Msg-name family this knob speaks, as a VALUE typed at `N`. `mount`
    // keys its settle cells off this rather than off the `resilient_*`
    // literals, so a named knob mounts into its own cells (#229) and the Cmd,
    // the Msgs, the Sub ids and the mounted cells all derive from one name.
    name,
    init,
    attempt,
    resume,
    succeed,
    fail,
    settleFailed,
    onTimer,
    subs,
    handlers,
  };
}

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the
 * slice lives at `state.resilience`. A convenience for the common single-slice
 * host; consumers with a differently-named field spread by hand. Pure — a thin
 * record rebuild, no clock / RNG. Under `withResilience` the wrapper owns
 * `model.$resilience`, so there is nothing to lift; this is for the embedded
 * slice consumers only.
 */
export function liftResilience<
  S extends { resilience: ResilientState<I, R> },
  I,
  R,
  C extends Cmd,
>(
  state: S,
  [slice, cmds]: readonly [ResilientState<I, R>, readonly C[]],
): readonly [S, readonly C[]] {
  return [{ ...state, resilience: slice }, cmds];
}

// ===========================================================================
// mount — the eight hand-spliced wiring points, pre-assembled.
// ===========================================================================

/** What every verb of a knob in this family hands back. */
export type Settle<I, R> = readonly [
  ResilientState<I, R>,
  readonly RunCmd<I>[],
];

/**
 * The part of a resilient-call knob {@link mountResilientCall} needs. This knob
 * satisfies it, and so does every knob that delegates these verbs to it —
 * `internal/jev/ask` and `internal/llm-call` both do, which is why the mount is
 * written against the shape rather than against either door.
 *
 * `OkMsg` / `ErrMsg` are parameters rather than {@link SucceedMsg} /
 * {@link FailMsg} because an inheriting knob narrows them: jev-ask's `fail`
 * takes a `JevFailMsg` whose `error` is a typed `JevAskErr`, and a mount that
 * fixed the supertype would hand that verb a widened Msg.
 */
export interface MountableKnob<
  I,
  R,
  OkMsg,
  ErrMsg,
  Handlers,
  N extends string = DefaultResilientName,
> {
  /**
   * The Msg-name family this knob settles into — `<name>_ok` / `<name>_err`
   * (#229). The mount reads it rather than assuming `resilient_*`, so a named
   * knob mounts into the cells it actually emits; an unnamed one is
   * `resilient`, so nothing a machine already spread changes.
   */
  readonly name: N;
  init(): ResilientState<I, R>;
  succeed(s: ResilientState<I, R>, key: string, msg: OkMsg): Settle<I, R>;
  fail(s: ResilientState<I, R>, key: string, msg: ErrMsg): Settle<I, R>;
  onTimer(s: ResilientState<I, R>, msg: ResilientTimerMsg): Settle<I, R>;
  subs(s: ResilientState<I, R>): readonly DeadlineSub[];
  handlers(): Handlers;
}

/**
 * The consumer's half of a settle cell: fold the settled answer into the
 * machine's own Model.
 *
 * It is handed the Model the inherited verb ALREADY settled — the slice at
 * `slice` is the post-`succeed` / post-`fail` one — so the ordering that wedges
 * a call at `running` is not something this callback can express. It returns
 * the repo's universal cell shape so a fold that needs to chain an effect
 * (book the answer, then write it somewhere) returns that Cmd like any other
 * reducer cell would.
 */
export type SettleFold<Model, M, C extends Cmd> = (
  model: Model,
  msg: M,
) => readonly [Model, readonly C[]];

/** One cell of the update fragment {@link mountResilientCall} returns. */
export type MountedCell<Model, M, I, C extends Cmd> = (
  model: Model,
  msg: M,
) => readonly [Model, readonly (RunCmd<I> | C)[]];

/**
 * What to mount, and where. `slice` names the Model field the knob's state
 * lives on — a plain, readable field, per
 * [ADR 0015](../../../../.decisions/0015-hide-the-wiring-never-the-state.md):
 * the mount absorbs the assembly and hides none of the durable state.
 */
export interface MountConfig<
  Model,
  Slice extends string,
  I,
  R,
  AttemptType extends string,
  AttemptMsg,
  OkMsg,
  ErrMsg,
  C extends Cmd,
> {
  /** The Model field carrying the knob's slice. */
  readonly slice: Slice;
  /**
   * The cell that starts a call. Its shape is the one wiring point the mount
   * cannot supply: each door's `attempt` takes its own arguments (jev-ask reads
   * a key, a state and an instant; llm-call reads a request), and only the
   * consumer knows which Msg field carries each. `run` is that one line.
   */
  readonly attempt: {
    /** The Msg type that starts a call — the key the cell lands on. */
    readonly on: AttemptType;
    readonly run: (
      slice: ResilientState<I, R>,
      msg: AttemptMsg,
    ) => Settle<I, R>;
  };
  /** Fold a settled success into the Model. Omit and only the slice advances. */
  readonly onOk?: SettleFold<Model, OkMsg, C>;
  /** Fold a settled failure into the Model. Omit and only the slice advances. */
  readonly onErr?: SettleFold<Model, ErrMsg, C>;
}

/**
 * The four fragments a consumer spreads into `defineMachine`. Together with
 * `init` they are the eight wiring points; none of them is optional at the type
 * level, so a consumer that mounts cannot omit `subscribe` (a backed-off retry
 * that never fires) or re-implement `interpret` as a dispatching handler.
 */
export interface MountedResilientCall<
  Model,
  Slice extends string,
  I,
  R,
  AttemptType extends string,
  AttemptMsg,
  OkMsg,
  ErrMsg,
  C extends Cmd,
  Handlers,
  N extends string = DefaultResilientName,
> {
  /** The starting slice under its field name — spread into the machine's `init`. */
  init(): { readonly [K in Slice]: ResilientState<I, R> };
  /**
   * The three settle cells plus the attempt cell, to spread into `update`.
   *
   * The two settle keys are the knob's OWN Msg names (#229), so a knob built as
   * `name: "jev"` mounts into `jev_ok` / `jev_err` and two named knobs in one
   * machine spread into four distinct cells instead of colliding on one. An
   * unnamed knob is `resilient`, so the keys read `resilient_ok` /
   * `resilient_err` exactly as they always have. `deadline_exceeded` is the
   * protocol's timer Msg and carries no name.
   */
  readonly update: Readonly<
    Record<AttemptType, MountedCell<Model, AttemptMsg, I, C>>
  > & {
    readonly [K in ResilientOkType<N>]: MountedCell<Model, OkMsg, I, C>;
  } & {
    readonly [K in ResilientErrType<N>]: MountedCell<Model, ErrMsg, I, C>;
  } & {
    readonly deadline_exceeded: MountedCell<Model, ResilientTimerMsg, I, C>;
  };
  subscriptions(model: Model): readonly DeadlineSub[];
  readonly subscribe: { readonly deadline: typeof subscribeDeadline };
  readonly interpret: Handlers;
}

/**
 * Pre-assemble a resilient-call knob into the fragments a machine definition
 * spreads, so mounting one is a spread instead of eight hand-spliced points.
 *
 * The three points that used to fail only at runtime are gone at the type
 * level rather than documented:
 *
 *   - The settle cells run the inherited `succeed` / `fail` verb and hand the
 *     already-settled Model to {@link SettleFold}. There is no cell for a
 *     consumer to write in the wrong order.
 *   - `interpret` is `knob.handlers()` — the form that RETURNS the settle Msg
 *     so it re-enters the reducer. A consumer that spreads the fragment cannot
 *     substitute a dispatching handler for it.
 *   - `subscribe` carries `subscribeDeadline`, so the retry timer is armed by
 *     construction rather than by remembering.
 *
 * Nothing is taken away. The slice stays a plain field at `slice` that the
 * consumer reads, `replay` sees and the journal prints, and every verb the
 * fragments call is still exported and callable by hand — a consumer that
 * wants a settle cell this shape cannot express writes that one cell itself and
 * spreads the rest. PURE: a record of closures over `knob` and `config`, no
 * clock and no RNG.
 */
export function mountResilientCall<
  Slice extends string,
  I,
  R,
  Model extends { readonly [K in Slice]: ResilientState<I, R> },
  AttemptType extends string,
  AttemptMsg,
  OkMsg extends { readonly key: string },
  ErrMsg extends { readonly key: string },
  Handlers,
  C extends Cmd = never,
  N extends string = DefaultResilientName,
>(
  knob: MountableKnob<I, R, OkMsg, ErrMsg, Handlers, N>,
  config: MountConfig<
    Model,
    Slice,
    I,
    R,
    AttemptType,
    AttemptMsg,
    OkMsg,
    ErrMsg,
    C
  >,
): MountedResilientCall<
  Model,
  Slice,
  I,
  R,
  AttemptType,
  AttemptMsg,
  OkMsg,
  ErrMsg,
  C,
  Handlers,
  N
> {
  const { slice, attempt, onOk, onErr } = config;

  // A computed key of a generic literal type widens to a string index
  // signature, which is the one place this file asserts: the assertion says
  // only what `Slice extends string` already pins.
  function put(model: Model, next: ResilientState<I, R>): Model {
    return {
      ...model,
      ...({ [slice]: next } as { readonly [K in Slice]: ResilientState<I, R> }),
    };
  }

  // The settle shape both `resilient_ok` and `resilient_err` have: inherited
  // verb, then the consumer's fold over the Model it settled.
  function settle<M extends { readonly key: string }>(
    verb: (s: ResilientState<I, R>, key: string, msg: M) => Settle<I, R>,
    fold: SettleFold<Model, M, C> | undefined,
  ): MountedCell<Model, M, I, C> {
    return (model, msg) => {
      const [next, cmds] = verb(model[slice], msg.key, msg);
      const settled = put(model, next);
      if (fold === undefined) return [settled, cmds];
      const [folded, extra] = fold(settled, msg);
      return [folded, [...cmds, ...extra]];
    };
  }

  const update = {
    [attempt.on]: (model: Model, msg: AttemptMsg) => {
      const [next, cmds] = attempt.run(model[slice], msg);
      return [put(model, next), cmds] as const;
    },
    // Keyed off the knob's own name, not the `resilient_*` literals: a knob
    // built with `name: "jev"` emits `jev_ok` / `jev_err`, and a mount that
    // spelled the literals would spread cells nothing ever dispatches to.
    [`${knob.name}_ok`]: settle<OkMsg>(
      (s, key, msg) => knob.succeed(s, key, msg),
      onOk,
    ),
    [`${knob.name}_err`]: settle<ErrMsg>(
      (s, key, msg) => knob.fail(s, key, msg),
      onErr,
    ),
    deadline_exceeded: (model: Model, msg: ResilientTimerMsg) => {
      const [next, cmds] = knob.onTimer(model[slice], msg);
      return [put(model, next), cmds] as const;
    },
  } as MountedResilientCall<
    Model,
    Slice,
    I,
    R,
    AttemptType,
    AttemptMsg,
    OkMsg,
    ErrMsg,
    C,
    Handlers,
    N
  >["update"];

  return {
    init: () =>
      ({ [slice]: knob.init() }) as {
        readonly [K in Slice]: ResilientState<I, R>;
      },
    update,
    subscriptions: (model) => knob.subs(model[slice]),
    subscribe: { deadline: subscribeDeadline },
    interpret: knob.handlers(),
  };
}

/**
 * Re-export the deadline Sub primitives so consumers (and tests) wire one
 * import: `subscribeDeadline` is the `subscribe` cell, `deadlineSub` builds the
 * Sub literal this knob's `subs` emits.
 */
export { subscribeDeadline, deadlineSub };
export type { DeadlineSub, DeadlineExceeded };
