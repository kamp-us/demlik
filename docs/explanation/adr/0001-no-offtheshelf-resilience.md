# ADR 0001 — Resilience is built in-house, not installed

- **Status:** Accepted
- **Date:** 2026-06-09
- **Scope:** the wrapper tier (`with-resilience`, `with-deadline`, `resilient-call`,
  `deadline`) and the L1 bricks it composes (`circuit-breaker`, `rate-limit`,
  `retry-backoff`, `cache`).

## Context

The wrapper tier reimplements policies that mature libraries already ship: retry
with exponential backoff + jitter, a circuit breaker with half-open probes, a
token-bucket rate limiter, a TTL cache, an overall deadline. The obvious
objection — and our own standing rule, **"NEVER build what you can install"** —
says reach for cockatiel / Polly / p-retry / Effect `Schedule` instead.

We evaluated that and rejected it. This record exists so the question is not
re-litigated every time someone opens `with-resilience/index.ts` and recoils at
its ~770 lines.

## The constraint the install must satisfy

tea's value rests on two invariants the resilience tier MUST preserve:

1. **Durable.** Wrapper state is a plain-data Model slice (`$resilience`,
   `$deadline`), JSON-serializable end to end — the deadline failure is a
   `{_tag}` sentinel, never `new Error`; the jitter RNG is injected, never closed
   over; even the placeholder bucket (`initBucket(1, 1, 0)`) keeps the slice
   shape uniform. It survives Durable Object eviction and reload **mid-flight**: a
   breaker that tripped before eviction resumes its cooldown correctly after
   reload, because the slice carries `openedAtMs` and the remaining delay is
   recomputed from the current clock at the Sub boundary.
2. **Replayable.** The merged `update` never reads the clock or RNG. Time enters
   as `at` Msg data; jitter is injected at construction. `replay()` reconstructs
   the breaker / bucket / retry / cache state byte-exactly, and
   `assertWrapperFaithful` proves two replays under distinct ambient clocks are
   identical.

A resilience policy that cannot be persisted mid-flight and replayed
deterministically cannot live inside a tea reducer. That is the entire bar.

## Decision

Build the resilience tier in-house as **pure functions over machine data**. Do
not take an off-the-shelf resilience library for the policy mechanics.

## Alternatives considered

| Option | Durable (DO-survivable) | Replayable (deterministic) | Verdict |
|---|---|---|---|
| cockatiel / Polly / p-retry | ✗ closure state + live timers | ✗ reads `Date.now()` / `setTimeout` internally | Cannot live in a replayable reducer. |
| Effect `Schedule` / `retry` / `timeout` | ✗ fiber state, no mid-flight persist | ~ deterministic in tests via TestClock, but not log-replay reconstruction | Breaks durability; competes with TEA as a paradigm-level dependency. |
| XState v5 | ~ snapshots persist, but in-flight invoked promises restart on restore | ~ `after` delays read real time | No resilience tier; partial on both axes. |
| Temporal / Cloudflare Workflows | ✓ | ✓ (deterministic replay is its core) | External orchestrators, not an in-DO reducer — wrong granularity for a sub-second heartbeat control loop. |
| **In-house tea wrapper tier** | ✓ slice is JSON | ✓ `at`-as-Msg-data + injected RNG | **Chosen.** |

The only paradigms that share both properties are durable-execution engines
(Temporal, Cloudflare Workflows), and those are external orchestrators — they do
not run inside the Durable Object as the reducer driving the protocol loop.

## Consequences

This is the sanctioned exception to "NEVER build what you can install": **the
install breaks the core invariant, so we build.** Owning the code carries two
obligations:

1. **Inherit the battle-testing without inheriting the implementation.** The L1
   bricks (half-open probe accounting, bucket refill math, jitter distribution,
   TTL eviction) are where edge-case bugs hide, and the real value of a mature
   library is *years of those edges being found*. Port the upstream test vectors
   (cockatiel / Polly) against our pure verbs. We keep durable + replayable AND
   get the coverage.
2. **`assertWrapperFaithful` is the law, not a courtesy.** ~770 dense lines per
   wrapper is a faithfulness-drift risk as the substrate evolves. Every wrapper
   passes the conformance gate every release, so the complexity is *guarded by a
   test*, not trusted to stay correct by reading.

## Note — the exception is narrow

This is not a license to reinvent freely. It applies only where durability or
replayability is at stake. A concern that touches neither the Model slice nor the
reducer's purity (a logging sink, a JSON codec, a date formatter) is still
installed, not built.
