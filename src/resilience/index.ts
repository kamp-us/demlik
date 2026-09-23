/**
 * @packageDocumentation
 * @demlik/tea/resilience — the call-hardening batteries: deadlines, retries,
 * circuit breakers, rate limits, TTL caches, credential refresh, and the
 * wrappers that bolt them onto a machine you already have.
 *
 * A DOOR, not a module. Every name here is declared under
 * `src/internal/resilience/` and re-exported unchanged; nothing moved to open
 * it, and the one renamed pair is named below. The modules behind it:
 *
 * - `authed-call` — a resilient call plus a bearer credential minted before it
 *   goes out and re-minted when the server says it is no longer good.
 * - `cache` — a TTL cache as pure state, plus a periodic eviction Sub.
 * - `circuit-breaker` — per-target failure tracking as pure state + ops.
 * - `deadline` — a one-shot Sub that fires when an absolute wall-clock
 *   deadline is reached.
 * - `rate-limit` — a token bucket and a sliding window, both as pure state.
 * - `resilient-call` — the embedded resilient-call machine the wrappers below
 *   are built over.
 * - `retry-to-success` — run a fallible port through bounded retry + backoff
 *   to success or a checkable `RetryExhaustedError`.
 * - `token-refresh` — a credential's lifecycle as pure state + verbs, with the
 *   fetch deferred to one injected port.
 * - `with-deadline` — wrap any machine so it auto-fails at T+N and re-arms on
 *   progress.
 * - `with-resilience` — wrap any machine so a chosen Cmd is retried, capped,
 *   cached and breaker-guarded on its way out.
 *
 * `battery` tier (MAINTAINING.md): a published named pattern over the kernel,
 * which may break in a minor provided the changelog for that minor says so.
 *
 * ── THE ONE RENAMED NAME ───────────────────────────────────────────────────
 * `resilient-call` and `with-deadline` each declare a DIFFERENT type called
 * `DeadlineConfig`: the first is a budget of in-process time per in-flight
 * call, the second is an inactivity window with a progress predicate. That is
 * the only name in this door with two declarations behind it, and `export *`
 * from both is a hard `TS2308` rather than a silent drop — so the door names
 * the winner rather than letting the ordering pick one.
 *
 * `DeadlineConfig` is `with-deadline`'s: that module is the consumer-facing
 * wrapper (`withDeadline(base, config)`), and `resilient-call` is the tier
 * below the lid its own docblock says to reach for `withResilience` instead
 * of. `resilient-call` is therefore enumerated by hand below, with its knob
 * carried through as {@link ResilientCallDeadlineConfig}. Nothing is dropped:
 * both types are reachable, one under a qualified name.
 *
 * Hand-enumerating a module is a drift risk a star export does not carry, so
 * `src/battery-doors.test.ts` walks every module behind every door and fails
 * when a name it exports is not reachable through the door.
 */

export * from "../internal/resilience/authed-call";
export * from "../internal/resilience/cache";
export * from "../internal/resilience/circuit-breaker";
export * from "../internal/resilience/deadline";
export * from "../internal/resilience/rate-limit";
// `resilient-call`, enumerated rather than starred, so `DeadlineConfig` stays
// `with-deadline`'s. The deadline Sub primitives it also re-exports are
// omitted from both blocks below only because `../internal/resilience/deadline`
// above is the one declaration of each and already carries them through.
export type {
  CacheConfig,
  CallBudget,
  CallPhase,
  CircuitConfig,
  DeadlineConfig as ResilientCallDeadlineConfig,
  DeadlineExceededError,
  DeadlineNameOf,
  DeadlineSettled,
  DefaultResilientName,
  FailMsg,
  MountableKnob,
  MountConfig,
  MountedCell,
  MountedResilientCall,
  RateLimitConfig,
  ResilientConfig,
  ResilientDeadlineType,
  ResilientErrType,
  ResilientHandlers,
  ResilientOkType,
  ResilientPorts,
  ResilientRunType,
  ResilientState,
  ResilientTimerMsg,
  RunCmd,
  RunCmdDef,
  Settle,
  SettleFold,
  SettleOutcome,
  SettleResult,
  SucceedMsg,
} from "../internal/resilience/resilient-call";
export {
  createResilientCall,
  DEFAULT_RESILIENT_NAME,
  liftResilience,
  mountResilientCall,
  runCmdDef,
} from "../internal/resilience/resilient-call";
export * from "../internal/resilience/retry-to-success";
export * from "../internal/resilience/token-refresh";
export * from "../internal/resilience/with-deadline";
export * from "../internal/resilience/with-resilience";
