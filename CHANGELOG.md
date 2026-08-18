# @demlik/tea

## 0.7.0

### Minor Changes

- 1c71a68: Add `./chart` (**experimental**): author a machine as data — one `defineChart` value holding `ctx`, the event alphabet, the Cmd alphabet and the states grouped by phase — and `compile` it into a real `Transitions` table that drops into `defineMachine` with no cast. The State/Msg/Cmd unions, the entry state, the `was` field on parking states and the mermaid drawing are all derived from that one value, so the types, the runtime table and the diagram cannot drift apart.

  The point is that the config form keeps full narrowing, which is what config-authored machines normally give up. Guards, Cmd builders and cells are typed by scanning the graph for the edges that reference them: a guard used only at `review.FAIL` receives exactly the `review` state and the `FAIL` message, and one used at two sites receives a third `at` argument carrying the site tag, so a single `switch (at)` narrows the state and the message together. Totality is enforced — every (state, event) pair is declared or explicitly refused, with the event's `scope` quantifying the refusal instead of enumerating it — and the diagnostic names the open pair and every way to close it.

  For transitions a declarative edge cannot express, `{ to: [...], cell: "name" }` lets code pick the next state from a set the chart still declares and draws, which is what lets a retry ladder, circuit breaker, cache or rate limiter compose inside a chart. `foreign: true` keeps a library-minted Msg's name bare under namespacing, so N instances of one chart can share a dispatch surface. `defineReducerChart` / `compileReducer` are the flat, msg-keyed form for machines with no phase dimension; they trade away the per-state refusal in the drawing.

  `./chart` itself is a new subpath — experimental tier, no stability promise yet.

  **`./poller` has a TYPE-LEVEL BREAKING CHANGE.** The runtime JS is byte-identical; nothing you can observe at run time changed. But making the poller chart draw 16 edges instead of 30 meant narrowing three verbs' declared return types, and a narrowed `.d.ts` is a break for anyone reading them. On 0.x a `minor` is the correct bump for that, but it is not additive, so here is exactly what breaks and what to do:

  1. **You implement or mock the `Poller` interface.** `start`, `tickResult` and `tickErr` now declare the phases they actually reach (`PollerPolling`, `PollerPolling | PollerDone`, `PollerPolling | PollerGaveUp`) instead of the whole `PollerState` union, so a stub returning the full union no longer satisfies them. _Fix:_ return the narrow arm — every real implementation already did — or import the new `PollerPolling` / `PollerDone` / `PollerGaveUp` types and annotate with those. (`tick` is deliberately NOT narrowed: a generic `tick<S extends PollerState<R>>(state: S) => [S, …]` states an identity no non-generic body can satisfy, and would have made the whole interface unimplementable.)

  2. **You `switch` exhaustively on a `tickResult` / `tickErr` result's `phase`.** The arm that can no longer occur — `gave_up` after `tickResult`, `done` after `tickErr` — is now a hard `TS2678` ("type is not comparable"), not a dead-code hint. _Fix:_ delete the impossible arm. It was already unreachable; the signature just says so now.

  3. **You spell a type as `ReturnType<Poller<R>["tickErr"]>` (or `["start"]` / `["tickResult"]`) and use it as a target type.** That alias is now narrower, so assigning a full-union value into it fails. _Fix:_ widen the annotation to `PollerState<R>` where you genuinely hold the union, or narrow the producer.

  If none of those three describe your code — you call the poller verbs and read `phase` — this release is additive for you.

- 1c71a68: Three kernel primitives for callers that drive a machine themselves instead of through `run`.

  **Fix: `msgKeysOf` under-reported the Msg union for a ragged Transitions table.**
  It read `Object.keys(update)[0]` and returned that one row's inner keys, justified by
  `Transitions<S, M, C>`'s mapped type making the Msg key set uniform across phases. That
  holds for a hand-written TOTAL table, and not for a table built dynamically with the
  state/msg discriminants widened to plain `string` — where the mapped type enforces
  nothing and the rows are genuinely ragged. It now unions the inner keys across every
  row, first-seen order, deduped.

  Not cosmetic: all three `withX` wrappers (`withResilience`, `withDeadline`,
  `withTelemetry`) build their merged flat Reducer by iterating `msgKeysOf(base)`, so a
  Msg that appeared only in a later row got **no cell** in the wrapped machine and threw
  `NoCellError` at dispatch for a Msg the base handles fine. `withDeadline`'s
  reserved-namespace scan missed a `$deadline:`-prefixed base Msg for the same reason.
  The change is a pure widening — for any total table the result is identical (same keys,
  same order) — and the O(states × msgs) walk runs once per wrapper construction, never in
  the dispatch loop.

  **New: `describeMachine(machine)` / `acceptsOf(machine, stateType)`** (`@demlik/tea` and
  `@demlik/tea/pure`) — the per-state accept-sets as a public reading, replacing the
  `machine.update as Record<string, Record<string, unknown>>` cast a consumer had to write
  to recover "which Msgs does each state accept". A derived function over the table, not a
  property on the machine: every `withX` wrapper returns a fresh object literal, so a
  property would not survive the first wrap. The returned `MachineShape` is discriminated
  on `form` — the `transitions` variant carries `states` + `accepts`, the `reducer` variant
  carries neither, because a flat reducer has no per-state accept-sets to report.

  **New: `tryApplyCell` / `tryFoldMsgs`** (`@demlik/tea`) — `applyCell` and `foldMsgs` with
  the missing-cell refusal in the return type instead of thrown, using `better-result` the
  same way `tryInterpret` already does. `tryFoldMsgs` reports **which** message failed
  (`{ index, msg, error }`), the fact a log-replay validator needs and a bare error cannot
  carry. `applyCell` and `tryApplyCell` are both thin skins over one new shared
  `lookupCell` selection, so the throwing and `Result` paths can never disagree about which
  cell a `(machine, state, msg)` triple picks. A cell that throws from its own body is
  still a bug and still propagates — only the absence of a cell is data.

## 0.6.0

### Minor Changes

- 1f5ee80: Export `applyCellChecked` and `foldUpdates` from the root, and `routeWorkflowMsg` from `./workflow`.

  All three already existed internally and were reachable only by re-implementing them. `applyCellChecked` is the DEV-checked twin of `applyCell`, for a consumer driving its own fold rather than `run`. `foldUpdates` is the fold beneath `foldMsgs` and returns `{ state, cmds }` rather than state alone, which is what a caller folding a log needs when it must also act on the emitted Cmds. `routeWorkflowMsg` is the single `WorkflowMsg` → verb routing table, so a consumer driving a workflow from its own host no longer re-derives the mapping by hand — where a fifth Msg variant would have broken it silently instead of at compile time.

  Additive only; no existing behaviour changes.

## 0.5.1

### Patch Changes

- 7a947bc: Republish from the package's new home, `kamp-us/demlik`.

  `@demlik/tea` was extracted out of a private monorepo into its own public repo.
  No runtime behavior changes. What does change in the published artifact:

  - `repository` now points at `kamp-us/demlik`, so the npm page links to the code.
  - `bugs` gains an issue-tracker URL.
  - Doc comments that referenced private consumer codebases, incident numbers and
    issue numbers are genericized. Those comments ship in the `.d.ts` files and the
    sourcemaps, so this is a visible change to the tarball even though no code moved.

## 0.5.0

### Minor Changes

- e469edb: Close eight silent-failure paths in the kernel: `structuralHash` collisions, the
  teardown dispatch, and the identity drop

  An adversarial review of 0.3.0/0.4.0 reproduced eight defects with runnable
  tests. All eight are fixed, each with the reproduction ported into the suite.

  **`structuralHash` collapsed every non-plain object onto one id (F1).** The
  `typeof value === "object"` branch walked `Object.keys`, which reports no own
  enumerable property on a `Date`, `Map`, `Set`, `Error`, or class instance — so
  all of them, and `{}`, hashed to `"{}"`. Three call sites already documented
  this as impossible ("non-JSON keys throw loudly"); the code never reached the
  throw. Three proven consequences fall out of the one bug: the `Identity` filter
  compared a foreign run's identity as EQUAL and applied its message (corruption
  with the guard switched on), a dep-keyed Sub keyed on a slice containing a
  `Date` never re-armed (it presented as the no-churn success case), and
  `defineManagedResource`'s handle table returned the previous key's handle.

  The walk now rejects any object whose prototype is neither `Object.prototype`
  nor `null`, naming the constructor. **This is a behaviour change:** a `deps`
  slice, an `Identity` projection, or a battery key that previously hashed
  silently now THROWS. That is the point — the previous behaviour was a collision,
  not a wrong-looking key — and with no known adopters of these primitives it is
  the right moment to make it loud. Project such a value to plain data first
  (`startedAt.toISOString()`). The guard is on the prototype rather than a list of
  known classes, so a user-defined key class is caught by the same rule. Rendering
  `Date`/`Map`/`Set` structurally was considered and rejected: `Map`/`Set`
  iteration is insertion-ordered, so any faithful rendering re-introduces the
  churn the hash exists to prevent.

  **A Sub dispatching during teardown produced an unhandled rejection (F2).**
  Dep-keyed sources and `subscribe[type]` handlers were handed the raw
  `enqueueDispatch`, whose promise rejects while the stop gate is shut — so a
  Sub firing during `stop()`'s drain bypassed `onError` entirely and surfaced as
  an `unhandledRejection` on the host. Both now receive the same wrapped
  `(msg) => void` interpret handlers get, so the rejection lands on the sink with
  its phase derived from the error class (`DispatchDiscardedError` → `"discard"`).

  **`fromTransport` leaked a socket per failed wiring (F3).** `live.set` ran
  BEFORE `onMessage`/`onClose` were wired, so an adapter over an already-CLOSING
  socket left the transport in the handle table with no sub registered: no cleanup
  ever ran, `send` wrote into a half-wired seam, and every reconcile opened
  another one. Wiring now happens first and the table is written last; a throw
  detaches what it wired, closes the transport, and rethrows — the
  acquire-as-success-value discipline `defineManagedResource` already followed.

  **The identity drop is now observable (F4).** A message addressed to another
  instance was dropped by a bare `return`: the dispatch RESOLVED, so the caller
  could not tell applied from discarded, and a reusable Durable Object serving run
  A then run B lost run B while reporting success. The drop now reports a new
  `IdentityDropNotice` (a `RuntimeDiscardNotice` — warn by default, never fatal)
  under the new `RuntimeErrorPhase` member `"identity-drop"`.

  **`stop()` waits for async teardown (F5).** `defineManagedResource` fired an
  async `release` and only attached `.catch`, and `stop()` returned without
  awaiting it — so a host doing `await runtime.stop(); env.evict()` dropped the
  isolate mid-release, which is the leak the battery exists to prevent, relocated
  to shutdown. The cleanup now RETURNS the release promise, the runtime tracks
  every async disposal (from `stop()` and from mid-run reconciles alike), and
  `stop()` drains them before resolving. Bounded by the new
  `run({ disposeTimeoutMs })` (default 5000ms) so a release that never settles
  cannot hang the host; on expiry `stop()` reports a `DisposeTimeoutNotice` and
  resolves anyway. A rejected teardown now reaches `onError` under
  `phase: "sub-cleanup"` instead of a `console.warn` at the battery.

  **The identity projection is supervised like the reducer (F6).** It ran ABOVE
  the `try` around the reducer, so a throwing `ofMsg` / `ofState` was neither
  reported nor supervised while an identical throw one line later was both — and
  since `structuralHash` throws on a bigint, a snowflake-style run id put EVERY
  dispatch on that unprotected path. Both halves of the transition's synchronous
  user code are now inside one `try`.

  **A throwing `deps` no longer strands its siblings (F7).** `reconcileDepSubs`
  guarded `entry.source` but not `entry.deps`, so one bad projection stranded
  every later dep-keyed entry and the manual `subscriptions` aggregate, which is
  only reached after the loop. `deps` and the hash are now collected into the same
  `firstError` the source path uses.

  **A nullish `deps` gates the Sub off (F8).** The gate was `deps === null`, so
  `(s) => s.optionalRunId` — the natural projection over an optional field —
  returned `undefined`, hashed to `"undefined"`, and ARMED the Sub, acquiring a
  resource under one shared key in a state that meant inactive. The gate is now
  `depsInactive` (nullish), single-sourced between the runtime's reconcile and
  `replay`'s desired-set projection.

  `Dispose` and the `Subscribe` cleanup are now typed `() => void | Promise<void>`
  (source-compatible: every existing `() => void` cleanup still fits).

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
