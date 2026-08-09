# @demlik/tea

## 0.4.0

### Minor Changes

- a82bec2: Loud on discard: `stop()` now reports a runtime torn down with Cmds in flight

  A runtime stopped while `interpret` handlers were still awaiting used to go
  quiet — `stop()` drains the tail, but every consumer of the resulting
  transitions is being torn down with it, so those Cmds' results reached nobody
  and nothing said so. The shape that bites is `@demlik/tea/react`'s `useMachine`,
  memoized on `[machine, ctx, store]`: a `ctx` re-derived mid-flight replaces the
  runtime, the in-flight mutation's response arrives for a runtime the UI no
  longer renders, and the visible state silently rewinds.

  `stop()` now samples the in-flight Cmd count before draining and, when it is
  non-zero, reports `new RuntimeDiscardedError(pendingCmds)` through the existing
  `OnError` sink under the new `RuntimeErrorPhase` member `"discard"`.

  The teardown is loud end to end, not just at its first instant. A Msg that
  arrives while `stop()` is draining — an in-flight Cmd's follow-up, a detached
  handler's terminal Msg, a Sub that is still live — is refused (the stop barrier
  is absolute, and refusing is what makes the drain terminate) and reported as
  `DispatchDiscardedError` under the same `"discard"` phase. The same refusal
  AFTER `stop()` has returned stays a loud error: that is a consumer dispatching
  into a runtime it already retired. The distinction is the runtime's own state at
  refusal time, so it never depends on reading an error message.

  Additive and non-fatal. A discard is a lifecycle report, not a contract failure
  — tearing a runtime down mid-flight is legal — so the default sink
  `console.warn`s the new `RuntimeDiscardNotice` errors instead of rethrowing on a
  macrotask the way it does for everything else; a consumer who never configured
  `onError` gains a warning, never a crash, for the whole teardown. A configured
  sink sees `"discard"` like any other phase and may route or ignore it. The
  default sink decides fatality from the ERROR CLASS rather than the phase, so a
  consumer sink that itself throws while handling a discard report still surfaces
  to the host instead of being demoted to a warning.

## 0.3.0

### Minor Changes

- f7c2635: Kernel: dep-keyed Subs, the instance-identity filter, `structuralHash`,
  `schemaMigrate`, and the typed detached Cmd→Msg edge — plus a host-pluggable
  timer backing for `@demlik/tea/deadline`.

  Five kernel primitives, all additive and opt-in; every existing machine keeps
  compiling and behaving identically.

  - **`structuralHash(deps)`** — the one deterministic, order-independent id for a
    plain JSON-compatible value. Object keys are sorted, so `{ runId, phase }` and
    `{ phase, runId }` are ONE key; a function / symbol / bigint throws rather than
    producing an unstable id. It replaces the scoped `subKeyString` stand-in the
    `@demlik/tea/subs` batteries carried, so a battery's handle-table key and the
    kernel's Sub identity are one definition instead of two.

  - **`DepKeyedSub` + `Machine.subs`** — a Sub that declares the state slice it
    depends on (`deps`, `null` meaning inactive) and how to open its resource
    (`source`, returning a `Dispose`). The kernel derives BOTH the id
    (`structuralHash(deps)`) and the active-set gate, so the author never writes a
    `subId(...)` and never edits a central `subscriptions(state)` list — a per-Sub
    gate travels with the Sub. Same reconcile pass as the manual path: dispose on
    null, dispose-then-re-arm on change, leave running when unchanged.
    `subscriptions` / `subscribe` stay as the documented escape hatch, and both
    paths feed ONE reconcile. `replay(...)` now also reports `depSubs` (the active
    entries' index + derived id) without starting any source.

  - **`Machine.identity`** — declare `{ ofState, ofMsg }` once and the kernel drops
    a message addressed to a different identity BEFORE `update` runs, at one
    observable point, retiring the per-cell `if (msg.runId !== state.runId)` guard.
    A machine that declares no `identity` skips the filter entirely.

  - **`schemaMigrate(schema, upcast?)`** — build `Store.migrate` from a
    Standard-Schema-shaped `Schema<S>` (structural validation, derived) plus a thin
    explicit `upcast` (version migration, genuine logic). Never throws: an
    unrecognized shape — or a throwing `upcast` — returns `null`, the fresh-boot
    path.

  - **`wrapDetached` + `InterpretDetached`** — the typed Cmd→Msg edge for a handler
    that detaches its work and cannot return its terminal Msg inline. `interpret`
    cells now receive an optional third argument, the kernel-injected `dispatch`;
    `wrapDetached` narrows it to the Cmd's declared result-Msg set, so a wrong
    terminal Msg fails to compile. Leaf handlers that return `Promise<M | void>`
    are unaffected.

  - **`@demlik/tea/deadline`** gains the host-pluggable `ArmTimer` seam —
    `subscribeWith(armTimer)` plus the default `setTimeoutArmTimer()`. A hibernating
    host (a Durable Object backing its deadline with `do_alarm`) can now supply its
    own timer without a second deadline surface: `subscribeDeadline` is exactly
    `subscribeWith(setTimeoutArmTimer())`, unchanged for callers. The Sub still
    carries the ABSOLUTE `atMs`, so every backing arms to the same anchor and a
    deadline re-derived after a rehydrate targets the original instant.

  - The `@demlik/tea/subs` `fromTransport` and `defineManagedResource` batteries
    regain `.depKeyed(when)`, expressing a seam or a managed resource as ONE `subs`
    entry — no `subscriptions` line, no `subscribe` cell, and for managed resources
    no `combineManagedResources` router (each resource owns its own reconcile slot).

- f7c2635: **`retry-backoff`: bound retrying by wall-clock outage duration, not only by attempt count.**

  A retry policy may now declare `maxElapsedMs` — how long the far side may stay
  unreachable before you give up — instead of, or in addition to, `maxAttempts`:

  ```ts
  const policy: DurationRetryPolicy = {
    baseMs: 250,
    factor: 2,
    capMs: 4_000,
    maxElapsedMs: PEER_GIVE_UP_MS, // derived from the peer's own patience
    jitter: "full",
  };

  const retry = recordFailure(state.retry, err, msg.at); // `at` starts the streak clock
  if (!shouldRetry(retry, policy, msg.at))
    return giveUp(retryElapsedMs(retry, msg.at));
  ```

  Why: an attempt count is the wrong bound whenever your ladder nests inside
  somebody else's. Four retries up a 250ms→4s ladder is ~3.75s of patience —
  against a peer that waits minutes before it gives up on you, that is a deploy
  blip finalizing runs that would have resumed. What a count of attempts costs in
  seconds depends on how long each attempt takes, which is the carrier's business,
  not the policy's; "how long do we tolerate an outage" has an answer in seconds,
  so the bound should be denominated in seconds.

  New exports: `DurationRetryPolicy`, `UnboundedRetryPolicy`, `AnyRetryPolicy`,
  `RetryBudget`, `BackoffCurve`, `CountBound`, `DurationBound`, `Unbounded`,
  `TimedRetryState`, `retryElapsedMs`.

  Two shapes are now impossible to write by accident:

  - **A policy with no bound at all.** Forever-retry must be spelled
    `unbounded: true`; a policy declaring neither bound does not type-check.
  - **An outage budget with no clock.** A policy carrying `maxElapsedMs` only
    matches the `shouldRetry` overload that demands both a `TimedRetryState` (minted
    by passing the observation instant to `recordFailure`) and a `nowMs`, so a
    declared bound can never be one that silently never fires.

  When both bounds are declared, retry continues only while **every** declared
  bound still permits it.

  Fully backwards compatible: `RetryPolicy` still means the count-bounded shape,
  `policy.maxAttempts` is still a `number`, and `shouldRetry(state, policy)` still
  takes no clock. Existing call sites compile and behave identically. The module
  still reads no clock and no RNG of its own — time is injected exactly as
  randomness always was.

- f7c2635: **`poller`, `resilient-call` and `with-resilience` now accept a duration-bounded
  retry policy — the outage budget reaches the batteries.**

  `retry-backoff` grew a wall-clock bound (`maxElapsedMs`), but the three wrappers
  most consumers actually import still took the count-bounded `RetryPolicy` and
  called `shouldRetry` with no clock. So the primitive was real, tested, and
  reachable only by a consumer folding the ops by hand. Now the policy flows end
  to end:

  ```ts
  const policy: DurationRetryPolicy = {
    baseMs: 250,
    factor: 2,
    capMs: 4_000,
    maxElapsedMs: PEER_GIVE_UP_MS, // derived from the peer's own patience
    jitter: "full",
  };

  createPoller({ everyMs: 5_000, until, onTick, retry: policy });
  withResilience(base, { target: "do_fetch", retry: policy });
  createResilientCall({ retry: policy });
  ```

  `PollerConfig.retry` and `ResilientConfig.retry` (which `ResilienceConfig`
  extends) widened from `RetryPolicy` to `AnyRetryPolicy` — a count, a wall-clock
  outage budget, or an explicit `unbounded: true`.

  **No new argument, and no clock read.** Every path that records a failure
  already held the instant it was observed as DATA — `poller.tickErr(state,
error, at)`, `resilient-call`'s `fail(…, msg.at)` and the retry timer's `atMs`,
  and `withResilience`'s own `$resilience:err.at` / `$resilience:timer.atMs`,
  stamped at the interpret boundary. That instant is now fed to `recordFailure`
  (minting the streak's `firstFailureAtMs`) and to `shouldRetry`. The reducers
  stay pure; time remains an argument, exactly as randomness always was.

  Consequently `withResilience`'s `config.at` rule is unchanged: a duration-bounded
  retry does NOT make it required, because the cold attempt is not a failure
  observation.

  **Purely additive.** Every existing consumer passing a count-bounded
  `RetryPolicy` compiles untouched and behaves identically — the widened field is
  a parameter position, and `shouldRetry` ignores a streak origin a count bound
  never consults. A success still resets the streak, so an operation that fails
  intermittently never accumulates outage and pays nothing for a wide
  `maxElapsedMs`.

  **The wrong path still fails to compile**, inherited from the overload
  `shouldRetry` already declares: a wrapper holding an `AnyRetryPolicy` cannot
  call it without a `nowMs`, so "declared an outage budget, never fed it a clock"
  is a type error inside the wrappers, not a bound that silently never fires.

- f7c2635: Add three open-ended Sub batteries to `@demlik/tea/subs`. Where the existing
  `from*` factories each bind one concrete platform API, these take the platform
  as a parameter — one call covers a whole topology.

  - **`defineListener`** — listener-as-resource. Give it the imperative
    `add`/`remove` pair and it returns a `SubscribeHandler` whose disposer is
    _derived_, not authored. The listener the substrate builds is the identical
    reference handed to both halves, so the two silent leaks you can hand-roll —
    a no-op cleanup, and a `remove` called with a different function than `add`
    saw — become unrepresentable. Carries the platform's native argument tuple,
    so the listener registers directly with no wrapper.

  - **`fromTransport`** — the duplex seam battery. One call wires the inbound
    frame stream, the transport-close → `*_lost` Msg, and an outbound handle
    table a Cmd handler can `send()` through without a hand-written socket
    registry. Transport-agnostic: pass a workerd `WebSocket` adapter, a
    `MessagePort` adapter, or an in-process stub behind the same `Transport`
    port. Complements `fromWebSocket`, which owns a concrete socket and is
    inbound-only.

  - **`defineManagedResource`** + **`combineManagedResources`** — a Model-gated
    resource with a mandatory `release`. Write `{ name, acquire, release }` and
    the resource's lifetime rides the reconcile pass: acquired when its Sub
    enters `subscriptions(state)`, released when the phase is left or the key
    changes. `release` receives only what `acquire` returned, so an `acquire`
    that throws can never hand teardown a half-built resource. `.get(key)` reads
    the live handle the reconciler holds, and `combineManagedResources` folds N
    gated resources into one `subscribe` cell plus a derived active-sub list, so
    the list and the routing cannot drift apart.

  All three are additive — no existing export changes.

## 0.2.0

### Minor Changes

- a703b7b: feat(tea/do): stepHost gains a working/pending arm + an opt-in defer-resume hook

  `stepHost` was a 2-arm `/step` contract (`{done:false, step}` / `{done:true, output}`)
  that resumed the engine INLINE inside the held request. A non-blocking host cannot
  adopt that — it must answer a pull with an explicit "computing, poll again" instead of
  holding the request across a multi-second step.

  Additive, backward-compatible:

  - New `StepWorking` not-ready arm (`{done:false, working:true, retryAfterMs?}`) — a
    first-class discriminated member, not a hollow `done:false`. Reachable only through
    the opt-in `DeferResumeHook`, so inline adopters keep the byte-identical 2-arm
    `StepResponse`.
  - New `DeferResumeHook<R>` (`enqueue` + `settled`) drives `engine.resume` OUT of the
    held request: the pull settles-and-enqueues and returns `working` promptly; a
    returning activation lands the compute in the durable checkpoint; a later pull reads
    the next step. Selected by an overload — passing `deferResume` widens the response to
    the 3-arm `DeferredStepResponse`; omitting it leaves the inline path unchanged.
  - `runStepLoop` re-polls the working arm (honoring `retryAfterMs`) until a real step
    arrives; an inline host never returns the arm, so its drive is unchanged.

### Patch Changes

- f3d1278: Deprecate `@demlik/tea/resilient-call` in favor of `@demlik/tea/with-resilience`
  (export-consolidation verdict: the two collapse, survivor `with-resilience`). The
  subpath still ships and its API is unchanged, but the module doc and its primary
  entries (`createResilientCall`, `liftResilience`) now carry `@deprecated` JSDoc
  with a migration map — the APIs are not drop-in, so there is no re-export shim.
  Per the "deprecate, don't delete" window, the `./resilient-call` export survives
  one minor release after this deprecation and is then removed.

## 0.1.1

### Patch Changes

- c470364: Ship the `./parity` subpath export to the registry. The export map already declares
  `@demlik/tea/parity` (built to `dist/parity`), but the published `0.1.0` predates it —
  so a cross-repo consumer installing the tarball hard-fails on `import "@demlik/tea/parity"`.
  This changeset bumps the package so trusted publishing republishes a version that actually
  carries the export.
