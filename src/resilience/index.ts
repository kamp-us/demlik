/**
 * @packageDocumentation
 * @demlik/tea/resilience — the call-hardening batteries: deadlines, retries,
 * circuit breakers, rate limits, TTL caches and credential refresh, as plain
 * functions and `Cmd.define`d Cmds you call from your own `update` (ADR 0022).
 *
 * A DOOR, not a module. Every name here is declared under
 * `src/internal/resilience/` and re-exported unchanged; the one renamed name is
 * named below. The modules behind it:
 *
 * - `authed-call` — a resilient call plus a bearer credential minted before it
 *   goes out and re-minted when the server says it is no longer good.
 * - `cache` — a TTL cache as pure state, plus a periodic eviction Sub.
 * - `circuit-breaker` — per-target failure tracking as pure state + ops.
 * - `deadline` — absolute wall-clock deadlines, and `nextTimer`, which arms the
 *   soonest of a list through the engine's built-in `timer` Sub.
 * - `rate-limit` — a token bucket and a sliding window, both as pure state.
 * - `resilient-call` — cache → breaker → rate limit → retry around one
 *   `Cmd.define`d run Cmd, as pure verbs over a slice you own.
 * - `retry-to-success` — run a fallible port through bounded retry + backoff
 *   to success or a checkable `RetryExhaustedError`.
 * - `token-refresh` — a credential's lifecycle as pure state + verbs, with the
 *   fetch as one `Cmd.define`d Cmd.
 *
 * `battery` tier (MAINTAINING.md): a published named pattern over the kernel,
 * which may break in a minor provided the changelog for that minor says so.
 *
 * ── THE ONE RENAMED NAME ───────────────────────────────────────────────────
 * `resilient-call`'s `DeadlineConfig` (a budget of in-process time per
 * in-flight call) is published as {@link ResilientCallDeadlineConfig}. It was
 * qualified when `with-deadline` declared a second `DeadlineConfig`; that
 * module is gone, and the qualified name stays so the published one does not
 * churn. `resilient-call` is therefore enumerated by hand below.
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
// `resilient-call`, enumerated rather than starred, so its `DeadlineConfig`
// keeps its qualified published name.
export type {
  CacheConfig,
  CallBudget,
  CallPhase,
  CircuitConfig,
  DeadlineConfig as ResilientCallDeadlineConfig,
  DeadlineExceededError,
  DeadlineNameOf,
  DefaultResilientName,
  FailMsg,
  RateLimitConfig,
  ResilientConfig,
  ResilientDeadlineType,
  ResilientErrType,
  ResilientOkType,
  ResilientRunType,
  ResilientState,
  ResilientTimerMsg,
  RunCmd,
  RunCmdDef,
  RunErr,
  SettleMsg,
  SettleOutcome,
  SettleResult,
  SucceedMsg,
} from "../internal/resilience/resilient-call";
export {
  createResilientCall,
  DEFAULT_RESILIENT_NAME,
  liftResilience,
  runCmdDef,
} from "../internal/resilience/resilient-call";
export * from "../internal/resilience/retry-to-success";
export * from "../internal/resilience/token-refresh";
