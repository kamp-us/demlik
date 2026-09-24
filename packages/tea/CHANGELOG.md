# @demlik/tea

## 0.18.0

### Minor Changes

- 039b3de: Trace an agent run as OpenTelemetry spans (#331).

  The new `@demlik/tea/otel` subpath (experimental) has `traceAgent(runtime, { tracer, mask? })`.
  It writes one span tree per run from the agent's events: a run span, a
  generation per brain call and a tool span per tool call. The spans carry the
  OpenTelemetry GenAI attributes (`gen_ai.*`), including a turn's reported token
  usage, and Langfuse's observation attributes, so Langfuse renders them
  natively. The trace id is derived from the
  `runId`, so a run resumed from its `Store` stays one trace. `agentSpans` is the
  same writer as an `onEvent` listener, for `defineAgent`. `@opentelemetry/api` is
  a new optional peer that only `@demlik/tea/otel` imports. No Langfuse package is
  a dependency.

  The agent's event stream (`./agent`, experimental) changes shape:

  - **New events.** `BrainStarted` (turn, purpose, model, payload) and
    `ToolStarted` (callId, name, args) fire when the call is issued. `ToolFailed`
    (callId, name, failure) fires when a call ends on a failure the model reads.
  - **`runId` and `at` on every event.** The `runId` is the durable one, so it is
    the same before and after a resume.
  - **`RunDone` fires on every ending, once.** It carries `status`, which is `done`
    with `output`, `failed` with `failure`, or `cancelled`. `RunDone.output` is
    gone: read `status.output` when `status.kind === "done"`. A failed or
    cancelled run now reports `RunDone` too. Before this change it reported
    nothing.
  - **`transcript().read().outcome`** is now `running`, or the ending `RunDone`
    carried.
  - **`AGENT_EVENT_TYPES`** lists every event type. `sseFromAgentEvents` and
    `defineAgent`'s `onEvent` subscribe to all of them.
  - **`AgentState` gains `lifecycle`.** This is the per-transition outbox the
    projector reads. A Model persisted before this change reads it as empty.

- a5dc8c2: `@demlik/tea/agent` exports `agentTool`, which wraps a child `defineAgent` as a
  tool a parent `defineAgent` calls and awaits. The child runs under its own Store
  and `runId`, both keyed `<namespace>/<callId>` from the parent's call, so a
  parent resumed after an eviction resumes its child rather than restarting it,
  and a child that had already ended gives back the outcome it recorded. A child
  that ends `failed` or `cancelled` settles the parent call as `child_failed` or
  `child_cancelled`, which the parent model reads as the call's reason (#333).
- 7049252: `./agent` carries provider-reported token usage (#332). A model turn may return
  `usage: TurnUsage` (`inputTokens`, `outputTokens`, and optionally
  `reasoningTokens` and `cachedInputTokens`). `agentTurnSchema` rejects a malformed
  report. The run keeps a running total in `state.usage`, which survives
  compaction folds, stage advances, a kill/resume and the end of the run. The
  conversation keeps the last turn's size in `conversation.contextTokens`.
  `defineAgent`'s `compaction` gains `afterContextTokens`, which folds on that
  size. It works alone or beside `afterTurns`, so `afterTurns` is now optional,
  but a budget must name at least one of the two. A token budget is a `stopWhen`
  over the total: `stopWhen: ({ usage }) => …`. `TurnSettled` carries the turn's
  `usage`. A Model persisted by 0.17.x resumes with its total starting from zero.
- 002f5b7: Add `DeletableStore<S>`, an optional widening of `Store<S>` with `delete()`.
  `fileStore`, `memoryStore` and `doStore` now return one, fenced and unfenced, so
  a host can forget a run without knowing how each store lays out its bytes.
  `delete()` is idempotent, and afterwards `load()` answers what a never-saved
  store answers. `fileStore` also removes the `.fence` stamp, and `doStore` the
  version cell. A fenced run still live on the store is refused with a
  `StoreConflictError` at its next save. `Store<S>` itself is unchanged (#314).
- b11a5fa: `drive` now has one entry point per engine, and the Effect engine gets one
  (#321).

  - `@demlik/tea/testing/promise` (stable) is the Promise `drive`, moved off
    `@demlik/tea/testing` with its types and errors (`DriveResult`,
    `DriveTraceEntry`, `DriveOptions`, `DriveCtxArg`, `DriveRoundsExceededError`,
    `DriveNoHandlerError`, `driveTraceOf`, `DEFAULT_MAX_ROUNDS`). Same signature,
    same rounds.
  - `@demlik/tea/testing/effect` (experimental) is a new `drive` for the Effect
    engine: `drive(machine, initial, msg, interpret, opts?)` takes the same
    `interpret` map as the Effect engine's `run`, runs the Subs the machine wants
    (through `opts.subscribe` or the built-in runner), and returns
    `Effect<{ state, trace }, DriveRoundsExceededError | DriveNoHandlerError |
<a hand-written cell's failure>, R>`. Provide `R` with `Effect.provide(layer)`.
    A hand-written cell may return a Msg, a list of Msgs or nothing (#324). It
    runs the same loop as the Promise `drive`, so the rounds and the trace match.
    Next to `@demlik/tea/effect`, it is the only entry point that imports `effect`.
  - `@demlik/tea/testing` keeps only the helpers that work with either engine:
    `expectFinalState`, `expectCmdEmitted`, `expectCmdSequence`,
    `expectActiveSubs`, `step`, `expectReplayDeterministic`, `bindMachine`,
    `noopRuntime` and `stateFactory`.
  - The Promise `drive` now refuses a `Cmd.define`d handler that dispatches its
    own `_ok` / `_err`, as `run` does (#304). It throws `OutcomeContractError`
    with the trace attached (`driveTraceOf`). A settle minted through
    `cmdEdgeOf(ctx)`, a defined handler's other Msgs, and anything a hand-written
    Cmd's handler dispatches still pass.

  **Breaking:** `drive` and its types are no longer exported from
  `@demlik/tea/testing`. Change the import to `@demlik/tea/testing/promise`:

  ```ts
  // before
  import { drive } from "@demlik/tea/testing";
  // after
  import { drive } from "@demlik/tea/testing/promise";
  ```

  A test whose defined handler dispatched its own `_ok` / `_err` now fails under
  `drive`, as that program already failed under `run`.

- 9864280: The Effect engine's `run` now yields an Effect handle instead of the Promise
  engine's (#308). The members keep the Promise engine's names; where that handle
  returns a Promise, this one returns an Effect with a typed error channel, so a
  host sorts failures with `Effect.catchTags` instead of wrapping every call in
  `Effect.tryPromise`.

  - `dispatch` and `dispatchOnce` return `Effect<void, Err | Stopped | StoreFailed>`,
    where `Err` is the declared failure of the run's hand-written `interpret`
    cells. `ready` returns `Effect<EffectRuntime, Err | StoreFailed>`. `idle`,
    `done` and `stop` return Effects that never fail. `getState`, `result` and the
    listeners (`subscribe`, `observe`, `onBoot`, `on`, the Port members) are
    unchanged.
  - New `Stopped` (`msgType`, and `when`: `"stopping"` or `"stopped"`): a dispatch
    into a run that is stopping or has stopped.
  - New `StoreFailed` (`operation`: `"load"` or `"save"`, `cause`): a save that
    threw, a fenced store's `StoreConflictError` included, or saved state `ready`
    could not restore (the `cause` is then the `StoreRefusedError`). This covers
    #319.
  - A hand-written cell's failure now fails the dispatch with that value, typed,
    instead of rejecting with it untyped. A reducer throw, a Msg with no cell and
    a livelock are still bugs, so they end the Effect as a defect.
  - New types `EffectBootingRuntime`, `EffectRuntime` and `CellErrors`.
  - `run` still needs a `Scope`, and closing it still stops the run and its Subs.
    The `onError` sink is handed the same values as before.

  **Breaking:** the Effect handle is no longer a `BootingRuntime` / `RunHandle`.
  Replace `yield* Effect.promise(() => handle.ready)` with `yield* handle.ready`,
  and `Effect.promise(() => runtime.dispatch(msg))` with
  `runtime.dispatch(msg)`. Hosts typed on the Promise handle, like `useRuntime`
  from `@demlik/tea/react`, no longer take it.

- 12d0080: A hand-written (non-`Cmd.define`d) Cmd handler may now return a list of Msgs,
  on both engines: `Promise<M | readonly M[] | void>` on the Promise engine and
  `Effect<M | readonly M[] | void>` on the Effect engine. The engine dispatches
  the list in order as follow-ups, before the next Cmd's handler runs, the way
  Elm's `Cmd.batch` answers with several Msgs. `drive` from
  `@demlik/tea/testing` folds a returned list the same way. A `Cmd.define`d
  handler still returns an outcome (ADR 0021); returning a list from one is an
  `OutcomeContractError`, as any non-outcome return already was (#324).
- 127a1aa: `run` now refuses saved state it cannot read instead of booting fresh over it
  (#316). Before, a `migrate` that returned `null` for bytes it did not recognize
  booted a fresh run, and the first save overwrote those bytes for good, so a
  buggy migration wiped the user's saved state.

  - **`Store.migrate` return type changed:** it now returns `Migrated<S>`, which is
    `S | null | Refusal`. `null` still means "nothing was saved, boot fresh". Return
    the new `refuse(reason)` for saved bytes you cannot read.
  - On a refusal, `ready` rejects with the new `StoreRefusedError` (`_tag:
"store_refused"`, `reason`) and nothing is written. A `load` or `migrate` that
    throws is refused the same way, with the throw as `cause` — so a corrupt
    `fileStore` / `doStore` file now rejects `ready` with a `StoreRefusedError`
    instead of the raw `SyntaxError`. Both engines behave the same.
  - `schemaMigrate` now refuses saved bytes the schema rejects, or that make
    `upcast` throw. It still returns `null` for `null` / `undefined` (nothing
    saved).
  - The `parse` argument of `fileStore`, `memoryStore`, `doStore` and
    `chromeStorageStore` may return a refusal too.
  - `createQueue` (`@demlik/tea/work-queue`) throws `StoreRefusedError` on a queue
    it cannot read, rather than treating it as empty and saving over it.

  There is no placeholder or "saving is off" mode. A host that wants a "couldn't
  restore" view catches `StoreRefusedError` and starts its own run with no store —
  see the new how-to "Show a 'couldn't restore' view".

  **Breaking:** code that reads `store.migrate(...)` directly now gets
  `S | null | Refusal`; narrow with `instanceof Refusal`. A custom `migrate` that
  returned `null` for unreadable bytes still boots fresh — switch it to
  `refuse(reason)` to get the protection.

- b6a282f: A Sub that fails with an error it did not handle now stops the run instead of
  being logged and left counted as running (#309). This is the Elm way: a Sub
  maps the errors it expects into Msgs itself, and anything else is fatal.

  - **Effect engine:** a Sub's `Stream` that fails (anything but an interrupt)
    reaches `onError` under the new `"sub"` phase, and the engine closes the run's
    Scope with that failure, which stops the run. Before, it was reported under
    `"follow-up"` and the dead Sub stayed registered, so the run looked healthy.
  - **Promise engine:** a runner that throws while it starts still rejects the
    dispatch (or `ready`) that started it, and now also reaches `onError` under
    `"sub"` and stops the run.

  There is no `subFailure` hook on the machine or on `run`. To keep a run going
  through an error you expect, turn it into a Msg in the Sub, e.g. with
  `Stream.catchTag` on the Effect engine. See "Turn a Sub's errors into Msgs" in
  the Effect engine how-to.

  **Breaking:** a Promise-engine runner that throws while starting used to leave
  the run alive; it now stops it. `RuntimeErrorPhase` gains `"sub"`, so an
  exhaustive `switch` over it needs a new case.

### Patch Changes

- 5b7f722: When a hand-written Cmd handler throws, the transition it ran in is no longer
  hidden from the run's listeners. `subscribe`, `observe`, `on`, the telemetry
  sink and `done()` now hear the State that was already installed and saved, and
  the dispatch still rejects with the handler's error. Both the Promise and the
  Effect engine are fixed (#311).
- 2e071c0: A Msg with no cell for the current state no longer halts the run under the
  default supervision. The reducer's `NoCellError` is reported to `onError` and
  that one Msg is dropped; the run keeps going, on both engines (#310).

## 0.17.0

### Minor Changes

- caced3c: **Breaking (stable tier, `@demlik/tea/testing`):** `assertWrapperFaithful` is
  removed, with its types `AssertWrapperFaithfulOpts`, `InterceptingOpt` and
  `WrapperModel`. It checked `withX` machine wrappers, and ADR 0022 removed every
  one of them, so nothing is left for it to check.

  Its clock/RNG half lives on as `expectReplayDeterministic`, the successor for
  any machine, wrapped or not. It replays a Msg list under two different global
  wall-clocks and RNG seeds and fails if the final state or the emitted Cmds
  differ, which is what happens when `init` or `update` reads `Date.now()` or
  `Math.random()`.

  ```ts
  // before
  assertWrapperFaithful(wired.machine, () => withX(wired, cfg).machine, {
    msgs,
    ctx,
  });

  // after
  import { expectReplayDeterministic } from "@demlik/tea/testing";
  expectReplayDeterministic(machine, { msgs, ctx });
  ```

  The other wrapper checks (base behaviour unchanged, wrapper decisions in the
  log, `$`-slice JSON round-trip) have no successor: there is no wrapper tier
  left to hold to them.

### Patch Changes

- 19a21fd: On the Promise engine, a `Cmd.define`d handler that `dispatch`es its own
  `<name>_ok` or `<name>_err` Msg now has that Msg dropped, and an
  `OutcomeContractError` goes to `onError`, as ADR 0021 requires: only the engine
  mints a defined Cmd's outcome Msg. Any other Msg the handler dispatches is still
  delivered, and hand-written Cmds are unaffected (#298).
- 19a21fd: A `Cmd.define`d handler on a machine whose ctx is `undefined` no longer gets a
  ctx typed `never`. `ok`, `err` and `emit` are callable again without a cast, on
  plain and detached handlers and on agent tool handlers alike (#296).
- 05b206a: The optional `vitest` peer now accepts `^4` and `^5` beside `^2` and `^3`
  (#293). npm 11 enforces optional peer ranges, so a project on vitest 4 or 5
  got `ERESOLVE` when installing `@demlik/tea` next to it. tea's own suite,
  including `@demlik/tea/testing`, now runs under vitest 5.

## 0.16.0

### Minor Changes

- cc5d9bb: **Breaking:** a `Cmd.define`d handler returns an outcome, and the engine mints
  the Msg (ADR 0021). `Cmd.define` takes any Standard Schema.

  A handler gets `ok` / `err` builders on its ctx and returns what they build.
  The engine turns it into `<name>_ok` or `<name>_err`:

  ```ts
  // before
  fetch: settle(fetch, async (cmd, ctx) =>
    Result.ok(await ctx.http.get(cmd.url))
  );
  // after
  fetch: async (cmd, { http, ok, err }) =>
    res.status === 404
      ? err({ _tag: "not_found" })
      : ok(await http.get(cmd.url));
  ```

  - New in `@demlik/tea`: `Outcome` (the `{ _tag: "Ok", value } | { _tag: "Err", error }`
    record, with `Outcome.ok` / `Outcome.err`), `OutcomeHelpers`, `InterpretCell`,
    `OkOfCmd`, `DeclaredErrorsOf`, and three thrown errors: `UndeclaredFailureError`,
    `OutcomeContractError` and `AsyncSchemaError`.
  - A throw, an `err` whose tag the def does not declare, or a handler returning
    any Msg goes to `onError` under the new `"interpret"` phase. No `_err` Msg is
    dispatched, and the dispatch still resolves. A defined handler returns an
    outcome or nothing: it can no longer answer with a follow-up Msg.
  - `Cmd.define`'s `input` / `ok` take any Standard Schema whose `validate` is
    synchronous: zod as it is, Effect Schema through `Schema.toStandardSchemaV1`.
    `MalformedResult` issues now come from the schema's Standard Schema issues.
  - Removed: `settle`. `tryApplyCell` and `tryFoldMsgs` return an `Outcome`
    instead of a `better-result` `Result` — read `r._tag === "Ok"` and
    `r.value` / `r.error`.
  - Dependencies: `better-result` and `zod` are gone. The one runtime dependency
    is `@standard-schema/spec` (types only). Install zod yourself if you use it.
  - `@demlik/tea/agent`: a `tool()` handler's `ok` / `fail` build an `Outcome`,
    a tool's `input` / `ok` take a Standard Schema, and `ToolDef.interpret`
    returns the outcome rather than the settled Msg.
  - Plain Cmds are unchanged: their handler still returns a Msg or nothing.

- cc5d9bb: The Effect engine lands at `@demlik/tea/effect` (#283, `experimental` tier,
  against Effect v4 RC). It runs the same machine file the Promise engine runs,
  with the same Msg / State trace.

  ```ts
  import { run } from "@demlik/tea/effect";

  const program = Effect.gen(function* () {
    const rt = yield* run(machine, {
      interpret: {
        fetch_user: (cmd) =>
          Effect.gen(function* () {
            const users = yield* Users;
            return yield* users.find(cmd.id);
          }),
      },
    });
    yield* Effect.promise(() => rt.dispatch({ type: "look", id: "u1" }));
  });

  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(UsersLive)));
  ```

  - `run(machine, { interpret, subscribe?, … })` returns an Effect that needs a
    `Scope` and the services its handlers and runners read, and yields the same
    run handle the Promise engine returns.
  - An `interpret` cell returns `Effect<Ok, E, R>`. A success settles
    `<cmd>_ok`, a declared failure settles `<cmd>_err`, and a defect or an
    undeclared failure goes to the error sink.
  - A `subscribe` runner returns a `Stream<Msg>`, drained on its own fiber and
    interrupted when the Sub stops. The built-in `timer` uses `Effect.sleep`; a
    `timer` entry in `subscribe` replaces it.
  - Closing the scope, or calling `stop()`, interrupts every handler still in
    flight (its finalizers run) and dispatches no Msg afterwards.
  - A fenced store is fenced exactly as on the Promise engine.
  - The other options (`store`, `onError`, `clock`, `events`, `supervision`,
    `terminal`, `telemetry`, `disposeTimeoutMs`) mean what they mean on the
    Promise engine: both engines run one shared core loop with the same
    built-ins in the same order.

- cc5d9bb: **Breaking:** a machine carries no Cmd handlers. `interpret` leaves `Machine`
  and moves to where the machine runs (#251 R1.1), so one machine file runs
  under whatever handlers the host hands it.

  ```ts
  // before
  const machine = defineMachine({ types, init, update, interpret });
  run(machine, { ctx });

  // after
  const machine = defineMachine({ types, init, update });
  run(machine, { ctx, interpret });
  ```

  - `Machine` has no `interpret` field. Passing one to `defineMachine` is a type
    error, and `run` ignores one left on a machine object.
  - `run` (`@demlik/tea/promise`) takes `interpret` in its options. It is
    required once the machine emits a Cmd, optional for a cmdless one, and each
    handler is checked against the machine's own Msg and Cmd unions.
  - `run` also takes optional `subscribe` runners. An entry replaces the
    machine's own runner of the same Sub type, so a test can swap one runner
    without redefining the machine. `subscribe` and `subscriptions` stay on
    `Machine` for now.
  - New in `@demlik/tea`: `InterpretArg<M, C, Ctx>` (the conditionally required
    `interpret` option) and `RunHandlers<M, C, U, Ctx>` (`interpret` plus
    `subscribe`).
  - `@demlik/tea/react`: `useMachine(machine, { ctx, interpret, subscribe?,
store? })`. The hook reads the latest render's handlers per call, so an
    inline handler table never reboots the runtime. `UseMachineOpts` is now
    `UseMachineOpts<S, M, C, U, Ctx>`.
  - `@demlik/tea/do`: `createAgentHost`'s `buildMachine` returns
    `{ machine, interpret }`.
  - `@demlik/tea/flow`: `runToTerminal`'s seed takes `interpret` beside `ctx`
    and `msgs`.
  - `@demlik/tea/resilience` (battery): `withResilience`, `withDeadline` and
    `withTelemetry` take `{ machine, interpret }` and return
    `{ machine, interpret }`. Run the result as
    `run(wrapped.machine, { interpret: wrapped.interpret, ctx })`.
  - `@demlik/tea/agent` (experimental): `createAgent(...).toMachine(opts)` and
    `defineAgent(...).machine(input)` return `{ machine, interpret }`
    (`DefinedAgentWired<T>` names the latter).

- 4f60603: **Breaking (`@demlik/tea/resilience`, `battery` tier):** resilient-call's
  `succeed` and `fail` verbs are replaced by one `settle(slice, msg)`.

  `createResilientCall(...)` no longer returns `succeed` or `fail`. Its new
  `settle` takes the knob's `_ok` or `_err` Msg, reads the key off `msg.key`, and
  returns `{ call, cmds, outcome }`:

  - `call` — the settled slice.
  - `cmds` — the Cmds the settle emitted.
  - `outcome` — `{ kind: "done", value }`, `{ kind: "failed", error }` or
    `{ kind: "retrying" }`.

  The port's value is only reachable through `outcome`, so a hand-wired settle
  cell can no longer fold the result into its Model before the slice has settled —
  the order that left a call stuck at `running`.

  Migrate each settle cell:

  ```ts
  // before
  resilient_ok: (s, m) => {
    const [call, cmds] = rc.succeed(s.call, m.key, m);
    return [{ ...s, call, user: m.result }, cmds];
  },
  resilient_err: (s, m) => {
    const [call, cmds] = rc.fail(s.call, m.key, m);
    return [{ ...s, call }, cmds];
  },

  // after — both cells route through one helper you write
  resilient_ok: (s, m) => onSettle(s, rc.settle(s.call, m)),
  resilient_err: (s, m) => onSettle(s, rc.settle(s.call, m)),
  ```

  `SettleOutcome` and `SettleResult` are exported for typing that helper. The new
  how-to, `docs/how-to/hand-wire-a-resilient-call.md`, shows the whole machine.

  Unchanged: `settleFailed`, and the `succeed` / `fail` verbs of the knobs built on
  resilient-call (`createJevAsk`, `createLlmCall`, `createAuthedCall`), which now
  settle through `settle` inside. `mountResilientCall` still takes a knob with
  `succeed` / `fail`, so mounting a bare resilient-call knob now means binding both
  to `settle` yourself.

- cc5d9bb: **Breaking (battery tier):** the battery layer is gone (ADR 0022). There are no
  `mount*` helpers and no `withResilience` / `withDeadline` wrappers. Reusable
  logic is plain functions plus `Cmd.define`d Cmds you call from your own
  `update`. The L2 helpers lose `handlers(ports)`: each ships its run Cmd, and you
  write that Cmd's handler in your engine's style. It returns an outcome, and the
  engine mints the settle Msg (ADR 0021). Their retry timers use the built-in
  `timer` Sub, so `run` needs no `subscribe` for them.

  ```ts
  // before
  const mounted = mountResilientCall(rc, {
    slice: "call",
    attempt,
    onOk,
    onErr,
  });
  run(machine, {
    interpret: rc.handlers({ run: fetchUser }),
    subscribe: { deadline: subscribeDeadline },
  });

  // after
  defineMachine({
    types,
    cmds: [rc.run],
    init,
    update: {
      load: (s, m) => {
        const [call, cmds] = rc.attempt(s.call, m.id, m.id, m.at);
        return [{ ...s, call }, cmds];
      },
      resilient_run_ok: (s, m) => onSettle(s, rc.settle(s.call, m)),
      resilient_run_err: (s, m) => onSettle(s, rc.settle(s.call, m)),
      deadline_exceeded: (s, m) => {
        const [call, cmds] = rc.onTimer(s.call, m);
        return [{ ...s, call }, cmds];
      },
    },
    subs: [{ type: "timer", deps: (s) => rc.timer(s.call) }],
  });
  run(machine, {
    interpret: {
      resilient_run: async (cmd, { ok, err }) => {
        try {
          return ok(await fetchUser(cmd.input));
        } catch (cause) {
          return err({ _tag: "port_rejected", cause });
        }
      },
    },
  });
  ```

  `docs/how-to/hand-wire-a-resilient-call.md` walks the whole machine.

  `./resilience`:

  - Removed: `withResilience` (with `resilienceRunCmdDef`, `ResilienceConfig`,
    `ResilienceModel`, `ResilienceCmd`, `ResilienceMsg`, `ResilienceOkMsg`,
    `ResilienceErrMsg`, `ResilienceRunCmd`, `ResilienceTimerMsg`,
    `ResilienceTimerSub`), `withDeadline` (with `deadlineDecision`,
    `deadlineExceededMsg`, its `DeadlineConfig`, `DeadlineExceededMsg`,
    `DeadlineModel`, `DeadlineSlice`, `DeadlineDecisionCmd`,
    `ProgressPredicate`), `mountResilientCall` (with `MountableKnob`,
    `MountConfig`, `MountedCell`, `MountedResilientCall`, `DeadlineSettled`,
    `Settle`, `SettleFold`), `ResilientHandlers` and `ResilientPorts`.
    `ResilientCallDeadlineConfig` keeps its name.
  - `createResilientCall`: `handlers` is gone; `run` is the `Cmd.define`d run
    Cmd (`<name>_run`). Its settle Msgs are the engine-minted `<name>_run_ok`
    (`{ cmd, value, at }`) and `<name>_run_err` (`{ cmd, error, at }`), so a
    named knob's `jev_ok` is now `jev_run_ok`. A handler fails with
    `err({ _tag: "port_rejected", … })` (or `"deadline_exceeded"`); a throw goes
    to the error sink and is not retried. New: `RunErr`, `SettleMsg`.
  - `subs(slice)` is renamed `deadlines(slice)`. New `timer(slice)` returns the
    built-in `timer` Sub's deps for the soonest deadline. The slice gains
    `clockMs`, the instant of its latest clocked transition, which `timer`
    counts down from. `settleFailed` takes `at`.
  - `SucceedMsg` / `FailMsg` are the minted shapes above; `FailMsg` takes an
    optional error type. `RunCmd` takes an optional result type.
  - New in `deadline`: `nextTimer(deadlines, nowMs)`, the built-in `timer` deps
    for the soonest of a deadline list.
  - `token-refresh`: `handlers` / `TokenRefreshPorts` and the
    `tokenRefreshedMsg` / `tokenRefreshFailedMsg` constructors are gone. `run`
    is the `refresh_token` def; `TokenRefreshedMsg` / `TokenRefreshFailedMsg`
    are its minted `refresh_token_ok` / `refresh_token_err`.
  - `authed-call`: `refresh` leaves the config, `handlers` and `AuthedPorts`
    are gone, `succeed(s, msg)` / `fail(s, msg)` read the key off `msg.cmd`,
    and the knob exposes `run`, `refresh`, `deadlines` and `timer`.

  `./paginate` / `./flow`:

  - `paginated-walk`: `handlers` and `PaginatedWalkPorts` are gone;
    `pageOk(s, msg)` / `pageErr(s, msg)` take the minted Msg; `fetch` is the
    page-fetch def; `subs` → `deadlines`, plus `timer`. The deadline
    re-exports are gone (import them from `./resilience`).
  - `reconciler`: the same — `ReconcilerPorts` and `handlers` gone,
    `pageOk(s, msg)` / `pageErr(s, msg)`, `scanPage` def, `deadlines` / `timer`.
  - `monitored-run`: `handlers` / `MonitoredRunPorts` gone; `checkpoint` is the
    `snapshot_write` def; `subs` → `deadlines`, plus `timer`.
  - `batch-window`: the knob's `handlers()` is gone; new `timer` / `timerFor`
    arm the window on the built-in `timer`. `subs` and `subscribeBatchWindow`
    stay for the absolute-deadline form.
  - `fan-out`: `handlers(ports)` is renamed `completion(ports)`.

  `./persistence`:

  - `snapshot`: `handlers`, `SnapshotStore`, `SnapshotPorts` and the
    `snapshotSaved` / `snapshotFailed` / `snapshotLoaded` / `snapshotLoadFailed`
    constructors are gone. `write` / `load` are the Cmd defs
    (`snapshotWriteDef<V>()`, new `snapshotLoadDef<V>()` replacing the
    `snapshotLoad` constant); their Msgs are the minted `snapshot_write_ok` /
    `_err` and `snapshot_load_ok` / `_err`. `confirm` reads `msg.cmd.seq`.

  `./jev`:

  - `JevPort`, the `port` config, `handlers`, `ask()`, `JevAskFailure`,
    `JevSub` and the deadline / mount re-exports are gone. The HTTP call is
    your `resilient_run` handler: it returns `ask.decode(request, reply)` (new
    pure `decodeJevReply`), `ask.rejected(cause)` (`jevCallThrew`) or
    `ask.offline(request)` (`offlineJevAnswer`). New: `JevHttpReply`,
    `JevRejected`, `jevAskErrOf`. `succeed(s, msg)` / `fail(s, msg)` take the
    minted Msg; `fail` stores the typed `JevAskErr`.
  - `classify-batch`: `port` and `handlers` gone; `ask` is the Cmd def and
    `decode` / `rejected` / `offline` build the handler's outcome. `subEntries`
    arms the window on the built-in `timer`; `subscribers()` returns only the
    cache eviction runner.

  `./agent` (experimental):

  - `unsafeDetachedHandlers`, `AgentPorts` and `AgentDetachedHandlers` are gone.
    New: `brainInterpret()` (the brain call's handler) and `brain` (its
    `Cmd.define`d def). `toMachine()` lists the brain def in `cmds`.
  - `succeed(s, msg, at)` / `fail(s, msg, at)` take no key. The brain settle
    Msgs are the minted `resilient_run_ok` / `resilient_run_err`; an `llm`
    failure's `error` is the `LlmErr` read off the Msg.

  `./testing`: `drive` now mints a `Cmd.define`d Cmd's outcome into its settle
  Msg through the machine's `cmds`, as `run` does, and takes an optional `clock`.

- cc5d9bb: **Breaking:** tea no longer does dependency injection (ADR 0020). The provider
  graph and the `R` (requirements) channel on Cmds are removed.

  Removed from `@demlik/tea`:

  - The provider graph: `provide`, `layer`, `value`, `dep`, `isProvided`,
    `Provided`, `ProvidedCtx`, `Provider`, `Scope`, `OnReleaseError`, `DepToken`,
    `DepsOf`, `ProvideFailedError`, `UnknownProviderError` and
    `ProviderCycleError`.
  - The `"provide"` runtime error phase and `RuntimeErrorContext.provider`.
  - `Cmd.requirements`, `Requirements`, `RequirementsOf` and `RequiredCtx`, and
    `Cmd.define`'s `requirements` field.
  - `ScopedCtxArg`. `run`'s `ctx` is a plain object only.

  A Cmd type is now `Cmd<Type, Ok, E>`: the tag, the value it settles with, and
  the `_tag` union it can fail with. `CmdValue` and `CmdDef` lose their `R`
  parameter too; `CmdValue` gains `Ok` in its place.

  Migrate:

  ```ts
  // before
  const fetch = Cmd.define("fetch", {
    input, ok, err: ["not_found"],
    requirements: Cmd.requirements<{ http: Http }>(),
  });
  defineMachine({ types: { model, msg }, cmds: [fetch], … });
  run(machine, { ctx: provide({ http: layer(openHttp, closeHttp) }) });

  // after — name the ctx on the machine and hand `run` the object
  const fetch = Cmd.define("fetch", { input, ok, err: ["not_found"] });
  defineMachine({ types: { model, msg, ctx: {} as { http: Http } }, cmds: [fetch], … });
  const http = await openHttp();
  try {
    const rt = await run(machine, { ctx: { http } }).ready;
    // …
  } finally {
    await closeHttp(http);
  }
  ```

  `@demlik/tea/agent` (experimental): `tool()` no longer takes `requirements`.
  Annotate the handler's `ctx` parameter instead — `async (args, ctx: { kb: Kb },
{ ok, fail }) => …` — and `defineAgent` / `toMachine({ tools })` still demand
  that ctx at `run`. `ToolsCtx<T>` names the ctx a tool set reads.

  The how-to "Scope a resource across a run" is removed with the API it taught.

- cc5d9bb: One run-handle type that every engine's `run` returns (#281, map finding #250).
  `@demlik/tea/react` and `@demlik/tea/do` are typed against it and import no
  engine.

  **Breaking (`./react`, `./do`, stable tier):** `useMachine` and
  `createAgentHost` take the engine's `run` as an input.

  ```ts
  // before
  useMachine(machine, { ctx, interpret });
  createAgentHost({ buildMachine, store, ctx, toSseFrame });

  // after
  import { run } from "@demlik/tea/promise";
  useMachine(machine, { run, ctx, interpret });
  createAgentHost({ run, buildMachine, store, ctx, toSseFrame });
  ```

  - New in `@demlik/tea`: `RunHandle<S, M, E>` (`dispatch`, `subscribe`,
    `observe`, `onBoot`, `on`, `ready`, `stop`), `BootedRunHandle<S, M, E>` (the
    handle `ready` resolves to, adding `getState`), `RunOptions` (the options
    every engine's `run` accepts: `ctx`, `interpret`, `subscribe`, `store`,
    `events`) and `EngineRun` (an engine's `run`, as a host adapter sees it).
    The Promise engine's `BootingRuntime` extends `RunHandle`, and its `Runtime`
    is a `BootedRunHandle`, so `run` from `@demlik/tea/promise` fits `EngineRun`
    as it is.
  - `useMachine` rebuilds the runtime when `run`'s identity changes, like
    `ctx` and `store`. Pass the engine's own function, not an inline wrapper.
  - `useRuntime` takes any `BootedRunHandle`. `bootResume` and `autoBoot` take
    any `RunHandle`. `driveProjections` and `sseFromAgentEvents` were already
    typed on the members they read, and accept any handle.
  - `AgentHost.runtime()` resolves to a `BootedRunHandle`, not the Promise
    engine's `Runtime`, so it has no `result()` / `done()` / `idle()`. Read the
    terminal State from `host.result()`, which now applies the host's `terminal`
    predicate itself.

- cc5d9bb: The Promise engine's loop is a small core now (#280, spike #264). It keeps one
  serial tail, saves before effects, reconciles Subs and runs Cmds, and it has
  no special case for any built-in. Each built-in (identity filter, supervision,
  dev checks, the `Cmd.define` edge, fenced stores, ports, `subscribe` /
  `observe` / `onBoot`, `on` events, `result` / `done`) is an internal extension
  of it, in a fixed order. `run` behaves as before.

  **Breaking (`./resilience`, battery tier):** `withTelemetry` is removed. It
  moved inside tea as the `telemetry` option of `run` (#268).

  ```ts
  // before
  const observed = withTelemetry(wired);
  run(observed.machine, { ...observed, ctx: { telemetrySink: (e) => log(e) } });

  // after
  run(wired.machine, { ...wired, telemetry: (e) => log(e) });
  ```

  - `run(machine, { telemetry })` hands the sink `{ seq, msgType, at }` after
    every applied transition. `seq` counts this run's transitions from 1, and
    `at` comes from `run`'s `clock`. The run never waits on the sink. A sink that
    throws or rejects reaches `onError` under `"observer"`.
  - The Model is no longer wrapped: state stays the machine's own, with no
    `{ base, $telemetry }` layer. The count is per run and is not persisted.
  - Removed from `./resilience`, with what replaces each: `withTelemetry` → the
    `telemetry` option; `TelemetryEvent` → `TelemetryEvent` from `@demlik/tea`
    (`at` is always set now); `TelemetryPorts` → nothing, the sink is the option
    itself; `TelemetryConfig` → nothing, the event shape is fixed;
    `TelemetryModel`, `TelemetrySlice`, `telemetryEmit`, `TelemetryEmitCmd` →
    nothing, there is no wrapper Model or Cmd.
  - New in `@demlik/tea`: `TelemetryEvent` and `TelemetrySink`.

- cc5d9bb: Split the package into three entry points: the core, the Promise engine and the Effect engine

  **Breaking:** `run`, `driveToDone` and `DriveToDoneOptions` moved from `@demlik/tea`
  to `@demlik/tea/promise`. The root no longer exports them. Change the import:

  ```ts
  // before
  import { defineMachine, run } from "@demlik/tea";
  // after
  import { defineMachine } from "@demlik/tea";
  import { run } from "@demlik/tea/promise";
  ```

  - `@demlik/tea` is the neutral core (`defineMachine`, `Cmd`, `replay`, the pure
    types). It imports no engine.
  - `@demlik/tea/promise` (stable) is today's engine, unchanged apart from where
    it lives.
  - `@demlik/tea/effect` (experimental) is published empty for now. The Effect
    engine lands there later. `effect` is a new **optional** peer dependency, so a
    Promise user installs nothing new.

  An import-graph test keeps the three apart: the core reaches neither engine,
  `./promise` and `./effect` never import each other, and only `./effect` may
  import `effect`.

- cc5d9bb: **Breaking:** a machine's Subs are data. The two Sub forms merge into one
  (#251 R1.4, spike #252), and the code that opens a resource moves to `run`.

  ```ts
  // before
  const machine = defineMachine({
    types,
    init,
    update,
    subscriptions: (s) =>
      s.waiting ? [{ id: subId("retry"), type: "retry", delayMs: 500 }] : [],
    subscribe: { retry: fromTimeout(() => ({ type: "retry_due" })) },
  });
  run(machine, { interpret });

  // after
  const machine = defineMachine({
    types,
    init,
    update,
    subs: [
      {
        type: "timer",
        deps: (s) =>
          s.waiting ? { ms: 500, msg: { type: "retry_due" } } : null,
      },
    ],
  });
  run(machine, { interpret });
  ```

  - `Machine.subs` is `[{ type, deps(state) }]`. `deps` returning `null` or
    `undefined` means off. The id is a hash of `{ type, deps }` (`subIdOf`), so a
    Sub starts when `deps` turns non-null, is left alone while it is unchanged,
    restarts when it changes, and stops on `null` or `stop()`. `deps` must be
    plain data.
  - `Machine` has no `subscriptions` or `subscribe`, and `DepKeyedSub` has no
    `source`. `DepKeyedSub<S, U>` is now the entry type, typed per Sub variant.
  - `Sub<T, D>` is `{ id, type, deps }` — the running Sub a runner receives. A
    runner reads its data off `sub.deps`. Declare a machine's Subs in
    `types.sub` as `Sub<"type", Deps>` variants.
  - Runners arrive at `run(machine, { subscribe })` (and `useMachine`). A
    runner is `(sub, ctx, dispatch) => Dispose`. `subscribe` is required when
    the machine declares a Sub type the engine does not ship, one runner per
    type. A declared type with no runner makes the dispatch reject instead of
    silently never starting.
  - Built-in `timer` on the Promise engine: `{ type: "timer", deps: (s) => ({
ms, msg }) }` dispatches `msg` after `ms` with no runner. A `subscribe.timer`
    entry replaces it, so a test can drive time with its own clock (#270).
  - A runner's `dispatch` never runs a transition on the runner's own stack; the
    Msg is queued behind the current step (spike #260).
  - `replay(...).subs` is the list of running Subs at the final state
    (`{ id, type, deps }`). `replay(...).depSubs` is gone.
  - Removed: `SubIdCollisionError` (the type is part of the id, so two Sub types
    can no longer collide).
  - New in `@demlik/tea`: `subIdOf`, `TimerSub`, `TimerDeps`, `BuiltinSub`,
    `BuiltinSubType`, `SubscribeArg`, and `Wired` (a machine beside its
    `interpret` and `subscribe`).
  - `structuralHash` treats a key holding `undefined` as absent, as JSON does,
    so `{ name: undefined }` and `{}` are one id.

  Every in-tree Sub is ported. By subpath:

  - `.` Sub factories: runners read `sub.deps` (`S extends Sub<string, XData>`),
    and `SubscribeHandler` returns `Dispose`. A changed deps value (url, period,
    channel) is a new id, so the runner restarts; it used to be ignored.
    `defineManagedResource` and `fromTransport` take the Sub type as their first
    type parameter (`name`) and return `{ type, depKeyed(when), subscribe, … }`.
    `ManagedResourceSub` / `TransportSub` are `Sub<N, TKey>`. Removed, each
    with what replaces it: - `.sub(key)` → `.depKeyed(when)`. Put the entry in `subs` and move the
    `if` that picked the key into `when(state)`, returning `null` for off. - `.subIdFor(key)` → `subIdOf(battery.type, key)`. The id is derived from
    the type and the key now. - `defineManagedResource`'s `.gated(when)` and `GatedManagedResource` →
    `.depKeyed(when)`. It takes the same `when` and gives a `subs` entry. - `combineManagedResources` and `CombinedManagedResources` → nothing to
    combine. Each battery's `name` is its own Sub type, so list each
    battery's `.depKeyed(when)` in `subs` and put each `.subscribe` in the
    `subscribe` table under its `type`: `subscribe: { [a.type]: a.subscribe,
[b.type]: b.subscribe }`.
  - `./node`: `NodeWsSub` / `NodeTimerSub` / `NodeSignalSub` carry plain deps
    (`NodeWsDeps { key, url }`, `NodeTimerDeps`, `NodeSignalDeps`). The ws
    callbacks move to `nodeSubscribe({ ws: { onMessage, onOpen?, onClose?,
onError? } })`. The ws registry and `sendToWebSocket(ctx, key, data)` key on
    your `key`, not a `SubId`. Removed: `AssertNodeSubIsSub`, with no
    replacement needed. It was a compile-time check that `NodeSub` fits `Sub`;
    each node Sub is now declared as a `Sub<"type", Deps>`, so the fit holds by
    construction. Delete any reference to it.
  - `./resilience` (battery): `DeadlineSub` is one deadline entry. A machine arms
    a battery's deadlines as ONE `deadline` Sub: `subs: [deadlinesSub((s) =>
rc.subs(s.slice))]` and `run(machine, { subscribe: { deadline:
subscribeDeadline } })`. New: `DeadlinesSub`, `deadlines`, `deadlinesSub`. A
    change to the list re-arms every deadline for its remaining time.
    `mountResilientCall` returns `subs` entries in place of `subscriptions`.
    `withDeadline` / `withResilience` / `withTelemetry` take and return a
    `Wired`. `withDeadline` counts down on the built-in `timer`; removed:
    `DeadlineTimeoutSub`. `ResilienceTimerSub` is `Sub<"$resilience:timer",
readonly DeadlineSub[]>`. `cacheEvictionSub(name, everyMs)` returns a `subs`
    entry; `CacheEvictionSub` is `Sub<"cache", CacheEvictionDeps>`.
  - `./flow`, `./timing`, `./paginate`, `./jev` (battery): the same deadline
    shape; `deadlinesSub` / `DeadlinesSub` are re-exported. `JevSub` is
    `DeadlinesSub`. classify-batch's `subs(state, id?)` returns only the window
    deadlines, and the new `subEntries(select, id?)` gives the machine's `subs`
    entries (window plus cache eviction).
  - `./agent` (experimental): `toMachine()` and `defineAgent(...).machine(input)`
    return a `Wired` that carries `subscribe`; the machine's Sub type is
    `DeadlinesSub`.
  - `./do`: `createAgentHost`'s `buildMachine` returns a `Wired`.

## 0.15.0

### Minor Changes

- `liftSlice` and `readInOrder` on the root door — compose battery slices without
  re-deriving the lens.

  A composition that owns several pure battery slices (a batch window, a fan-out,
  a cache) used to hand-write the lift for every verb (`{ ...s, slice }`) and
  re-derive the precedence of every derived read; the jev `classify-batch`
  composition shipped a stale-read bug from exactly that. `liftSlice(key)` turns a
  `(slice) => [slice, cmds]` verb into a `(s) => [s, cmds]` one, and
  `readInOrder(steps)` states a derived read's precedence as data instead of as
  the order of `if`s. `liftResilience` and `liftJevAsk` keep their names,
  signatures and subpaths and now delegate to `liftSlice`; `classify-batch` reads
  through `readInOrder`. No new dependency.

- f7e4e6d: `mountResilientCall` — mount a resilient-call knob with a spread instead of
  eight hand-spliced wiring points.

  Splicing `createJevAsk` or `createLlmCall` into a machine meant writing `init`,
  the attempt cell, `succeed`, `fail`, `onTimer`, `subs`, `subscribe` and
  `interpret` by hand, and three of those failed only at runtime: folding the
  result before the inherited verb wedged the slice at `running`, a dispatching
  interpret handler settled one invoke and stalled the loop, and an omitted
  `subscribe: { deadline: subscribeDeadline }` meant a backed-off retry never
  fired.

  `mountResilientCall(knob, { slice, attempt, onOk, onErr, onDeadline })` returns
  `{ init, update, subscriptions, subscribe, interpret }` fragments a consumer
  spreads into `defineMachine`. The settle cells run the inherited verb and hand
  the already-settled model to the fold, so the ordering bug is not expressible;
  `subscribe` and `interpret` ride on the fragments, so neither can be forgotten.

  There are three folds rather than two because there are three settle paths. A
  call that exhausts its deadline settles `failed` inside the slice and emits no
  settle Msg, so it reaches no `onErr`; `onDeadline` is that failure class's fold,
  handed the key and the slice's own error. Omit it and only the slice advances,
  exactly as omitting `onOk` / `onErr` does.

  The two settle cells are keyed off the knob's own Msg names, so a knob built
  `createResilientCall<I, R, "jev">({ name: "jev" })` mounts into `jev_ok` /
  `jev_err` and two named knobs spread into four distinct cells. An unnamed knob
  is `resilient`, so the keys read `resilient_ok` / `resilient_err` as before. The
  knob itself now carries that `name` as a readable field.

  Per ADR 0015 it hides assembly and nothing else: the resilience slice stays a
  plain readable Model field, and every verb the mount calls is still exported and
  callable by hand.

  New on `@demlik/tea/resilience` (and re-exported from `@demlik/tea/jev`):
  `mountResilientCall`, plus the types `DeadlineSettled`, `MountableKnob`,
  `MountConfig`, `MountedCell`, `MountedResilientCall`, `Settle` and
  `SettleFold`.

- 38cf090: `createResilientCall` accepts an optional `name`, so a knob owns its settle Msgs

  A resilient-call knob built with `{ name: "jev" }` emits `jev_run` and settles
  through `jev_ok` / `jev_err`, and the settle Msg types are generic in that name.
  A machine mounting two knobs of the family under distinct names therefore gets
  one `update` cell per knob, each already narrowed to that knob's payload —
  replacing the hand-written `key` switch that a single shared cell forced, which
  the type checker could not grade. The name leads the retry and deadline Sub ids
  as well (`jev:retry:<key>`), so two knobs cannot share one timer on one key.

  The deadline Msg follows the name too: a knob built with `{ name: "jev" }`
  receives `jev_deadline`, not `deadline_exceeded`, and `mountResilientCall` keys
  its deadline cell off the knob's name, so two mounted knobs no longer collide on
  one cell. An unnamed knob still receives `deadline_exceeded`, byte for byte.

  **`resilient_ok` / `resilient_err` — and `resilient_run`, and the
  `resilient:retry:<key>` / `resilient:deadline:<key>` Sub ids — remain the
  default for every knob that passes no name.** Nothing changes for an existing
  machine, example or doc unless it opts in.

  `N` is not inferable from the knob's input and result types, so an opted-in knob
  spells all three type arguments:
  `createResilientCall<In, Out, "jev">({ name: "jev", ... })`. The `name` field is
  typed at `N`, so the value and the type cannot drift apart.

- f5cea99: `@demlik/tea/testing` publishes `drive` — the runtime's Cmd→handler→settle-Msg
  loop as one call, for a test.

  `bindMachine` returns the Cmds a fold emitted and stops; performing them was
  the caller's, so every consumer test exercising a Cmd-emitting machine
  hand-wrote the same guarded loop (including the one the jev how-to shipped as
  a thing to copy).

  ```ts
  import { drive } from "@demlik/tea/testing";

  const { state, trace } = await drive(
    machine,
    initial,
    { type: "classify", key, memo, at: 0 },
    ask.handlers()
  );
  ```

  `drive` composes `bindMachine`'s synchronous `step` and adds no second reducer
  path — no `Runtime`, no observation, no clock. It returns the **history** as
  well as the endpoint: `trace` is every Cmd dispatched and every Msg folded, in
  order, so a test asserts on the sequence too, and replaying the trace's Msgs
  through `replay` from the same initial state reproduces the returned `state`.

  Exceeding `maxRounds` (default 100) throws `DriveRoundsExceededError` carrying
  the round count and the partial trace, rather than returning a half-driven
  state a test would assert green on. A rejecting handler's own error propagates
  unchanged, with the partial trace recoverable via `driveTraceOf`.

  Also exported: `DriveResult`, `DriveTraceEntry`, `DriveOptions`,
  `DriveCtxArg`, `DriveNoHandlerError`, `DEFAULT_MAX_ROUNDS`.

### Patch Changes

- `parseAnswers` in `@demlik/tea/jev` validates through a zod schema derived from
  the questions map instead of hand-written guards followed by a cast; the accept
  set is unchanged. One observable difference: a body with several faults at once
  now reports the arm zod's strict object shape reaches first (membership and
  totality are one check), where the old walk reported whichever guard ran first.
  Single-fault bodies map to the same `JevErr` arm as before; the multi-fault
  precedence is pinned by tests and stated in the module docblock.

## 0.14.0

### Minor Changes

- af74406: A run can be stopped from outside. `agent.run(input, { signal })` and
  `driveToDone(handle, start, isTerminal, { signal, cancel })` take an
  `AbortSignal`, and an abort is a TRANSITION rather than a throw: the run settles
  on a new `cancelled` terminal outcome and the call RESOLVES with it. Nothing
  rejects, and a cancellation is never a `DriveFailedError` — a stop button is not
  a failure.

  The outcome is in the Model, which is the point. A process killed after an abort
  resumes reading a run that ENDED, instead of restarting the run its user
  stopped. `status(state)` answers `{ kind: "cancelled", at }`, a member of the
  status union in its own right — a consumer handling `done` and `failed` has not
  covered every way a run can end, and now the compiler says so.

  A signal already aborted when `run` is called ends the run before the first
  model call is made.

  What cancellation does NOT do is recall work already in flight: a promise cannot
  be cancelled, so a tool handler mid-call runs to its own end. Its result reaches
  no `onEvent` listener and never folds into the Model, and it does not hold the
  runtime's teardown. Propagating the signal INTO handlers is a separate seam this
  does not open.

  Omit the signal and every existing run path behaves exactly as before.

  `DriveToDoneOptions` is now a type alias rather than an interface, because
  `signal` and `cancel` are a PAIR — the kernel has no built-in cancel Msg, so a
  signal with nothing to dispatch is a stop button wired to nothing, and the union
  makes that unrepresentable. Every existing use as a type is unaffected; a
  consumer that `extends` it must switch to an intersection.

- a18b660: The bare flow knobs move inside the package (ADR 0015, ADR 0016). Eight battery subpaths
  leave `exports`; every primitive they published still exists, under
  `src/internal/flow/`, and is no longer importable from outside the package. `saga` and
  `workflow` stay two separate modules (ADR 0010: the boundary is compensation); only their
  doors close.

  | Removed door                 | Internal home                      |
  | ---------------------------- | ---------------------------------- |
  | `@demlik/tea/fan-out`        | `src/internal/flow/fan-out`        |
  | `@demlik/tea/monitored-run`  | `src/internal/flow/monitored-run`  |
  | `@demlik/tea/poller`         | `src/internal/flow/poller`         |
  | `@demlik/tea/reconciler`     | `src/internal/flow/reconciler`     |
  | `@demlik/tea/saga`           | `src/internal/flow/saga`           |
  | `@demlik/tea/workflow`       | `src/internal/flow/workflow`       |
  | `@demlik/tea/await-terminal` | `src/internal/flow/await-terminal` |
  | `@demlik/tea/batch-window`   | `src/internal/flow/batch-window`   |

  `workflow`'s two Cmds — `workflow_activity`, `workflow_compensation` — are now built by
  `Cmd.define` constructors (`workflowActivityDef<A>()`, `workflowCompensationDef<A>()`), so
  each carries its input shape as a type. The emitted records are unchanged; a ledger written
  before this release folds identically. The other moved modules emit no Cmds of their own.

  `docs/reference/saga.md` and `docs/reference/workflow.md` go with their doors.

- 897a0de: The grouped battery doors are open. Seven new subpaths, all `battery` tier:

  | Door                      | What is behind it                                                                                                                                                                |
  | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `@demlik/tea/idempotency` | `idempotency`, `idempotent-intake`                                                                                                                                               |
  | `@demlik/tea/flow`        | `await-terminal`, `batch-window`, `fan-out`, `monitored-run`, `poller`, `reconciler`, `saga`, `workflow`                                                                         |
  | `@demlik/tea/resilience`  | `authed-call`, `cache`, `circuit-breaker`, `deadline`, `rate-limit`, `resilient-call`, `retry-to-success`, `token-refresh`, `with-deadline`, `with-resilience`, `with-telemetry` |
  | `@demlik/tea/timing`      | `debounce`, `throttle`, `throttled-input`                                                                                                                                        |
  | `@demlik/tea/persistence` | `recorder`, `snapshot`, `trace-replay`                                                                                                                                           |
  | `@demlik/tea/paginate`    | `paginator`, `paginated-walk`                                                                                                                                                    |
  | `@demlik/tea/work-queue`  | `work-queue`, its pure `ops`, and the `adapter` verb seam                                                                                                                        |

  A consumer who needed exactly-once payouts or a compensating workflow had to
  copy the source: the modules were finished and tested and simply unreachable.
  Each door is a re-export file over `src/internal/`, so nothing moved, nothing
  was renamed, and no module's own file path changed.

  `battery` means these may break in a minor, before and after 1.0, provided the
  changelog for that minor says so — a weaker promise than `stable`, and the
  reason a battery break never forces a major on someone who never imported one.
  The doors are grouped rather than one-per-module because a door is a permanent
  promise and a maintenance cost; `MAINTAINING.md` carries the tier row for each.

  One name needed a decision. `resilient-call` and `with-deadline` each declare a
  different `DeadlineConfig` — a per-call in-process budget, and an inactivity
  window with a progress predicate. On `@demlik/tea/resilience`, `DeadlineConfig`
  is `with-deadline`'s, the consumer-facing wrapper's knob; `resilient-call`'s is
  carried through as `ResilientCallDeadlineConfig`. Both are reachable.

  `@demlik/tea/idempotency` and `@demlik/tea/work-queue` were published before and
  closed by the v0.13.0 sweep. They are open again at `battery`, re-exporting the
  same modules from their in-tree home.

  Reference pages are generated for all seven. The generator now follows a
  re-export to the declaration it names, so a symbol one door carries from another
  module's declaration renders its real kind and summary instead of an empty
  `Reference` row.

- 5ca5dbe: The composed-flow families move inside the package (ADR 0015, ADR 0016). Eleven battery
  subpaths leave `exports`; every primitive they published still exists, under
  `src/internal/{timing,paginate,idempotency,work-queue}/`, and is no longer importable from
  outside the package. `debounce`, `throttle` and `throttled-input` stay three separate
  modules (ADR 0010's no-collapse verdict); only their doors close.

  | Removed door                      | Internal home                                  |
  | --------------------------------- | ---------------------------------------------- |
  | `@demlik/tea/debounce`            | `src/internal/timing/debounce`                 |
  | `@demlik/tea/throttle`            | `src/internal/timing/throttle`                 |
  | `@demlik/tea/throttled-input`     | `src/internal/timing/throttled-input`          |
  | `@demlik/tea/paginator`           | `src/internal/paginate/paginator`              |
  | `@demlik/tea/paginated-walk`      | `src/internal/paginate/paginated-walk`         |
  | `@demlik/tea/idempotency`         | `src/internal/idempotency/idempotency`         |
  | `@demlik/tea/idempotency/adapter` | `src/internal/idempotency/idempotency/adapter` |
  | `@demlik/tea/idempotent-intake`   | `src/internal/idempotency/idempotent-intake`   |
  | `@demlik/tea/work-queue`          | `src/internal/work-queue`                      |
  | `@demlik/tea/work-queue/ops`      | `src/internal/work-queue/ops`                  |
  | `@demlik/tea/work-queue/adapter`  | `src/internal/work-queue/adapter`              |

  `idempotent-intake`'s two Cmds — `intake:process`, `intake:replay` — are now built by
  `Cmd.define` constructors (`intakeProcessDef<P>()`, `intakeReplayDef<R>()`), so each carries
  its input shape as a type. The emitted records are unchanged; a replay log written before
  this release folds identically. The other moved modules emit no Cmds of their own.

  `docs/reference/work-queue.md` goes with its door.

- 447c3f9: `defineAgent(cfg)` grows `.with({ interpret })`, so one unusual requirement costs one
  interpret cell instead of a rebuild under `createAgent`.

  The gap it closes is the ramp: three intents on one side, fourteen fields on the other, and
  nothing in between. `.with` wraps a NAMED cell of the machine the lid already built and
  returns another defined agent — `run`, `machine`, `with` again — so the agent it was called
  on is unchanged and every cell the overlay does not name is carried over by reference.

  ```ts
  const queued = defineAgent({ model, tools: [fetchRate], instructions }).with({
    interpret: {
      fetch_rate: (next) => async (cmd, ctx, dispatch) =>
        inTurn(() => next(cmd, ctx, dispatch)),
    },
  });
  ```

  The wrapped cell settles through the SAME typed Cmd→Msg edge as the cell it wraps: `next`
  resolves the `Cmd.define`d `<tool>_ok` / `<tool>_err` Msg carrying the call's own `callId`,
  and returning it unchanged is what keeps the fold — and a replay of the wrapped run —
  identical to the unwrapped run's. That is the door's whole contract: it is one over the
  effect boundary, never over the fold. A cell that must settle differently is a different
  machine, and `createAgent` is still where you build one.

  `with` composes, later call outermost (`a.with(x).with(y)` enters `y` first). Naming a cell
  the machine has none of throws at `machine(input)` — where the table to check the name
  against exists — listing the cells it does have.

  Additive: an agent that never calls `with` builds the same machine, from the same cells, as
  before. New types beside it: `DefinedAgentMsg`, `DefinedAgentCmd`, `DefinedAgentInterpret`,
  `InterpretOverlay`, `DefinedAgentOverlay`.

- 45f5d5d: `defineAgent({ model, tools, instructions })` on `@demlik/tea/agent` (experimental tier) —
  the lid over `createAgent`. Three intents in, `{ run(input), machine(input) }` out: the
  single-stage wiring (`stages`, `turnOf`, `schemas`) is defaulted, the tool cells derive from
  `toolRouter`, the prompt renders off the Model, and the drive loop is `driveToDone`. It hides
  wiring, never state (ADR 0015): the Model has the same slice keys as a hand-wired
  `createAgent` machine, and `machine(input)` feeds the raw `run`.

  `instructions` is durable. `AgentState` gains an `instructions: string | null` slot on both
  paths, set at `init` from the new `createAgent` config field of the same name and never
  touched by a compaction fold, so a replay reproduces the exact prompt that ran and a
  rehydrated run keeps the prompt it started with (ADR 0004). `payloadOf` receives it as a
  third argument. A Model persisted before the slot existed rehydrates with `null`.

- f91388e: `defineMachine` names Model and Msg once, as values, under a new `types` option — no type
  arguments, no hand-spelled `Settled<typeof cmd>` union, no separate `Reducer<…>` annotation.

  ```ts
  const machine = defineMachine({
    types: { model: {} as Model, msg: {} as Msg },
    cmds: [lookup, audit],
    init: (loaded) => [loaded ?? initial, []],
    update: {
      go: (m, msg) => …,
      lookup_ok: (m, msg) => …, // settled cells inferred from `cmds`
      …
    },
    interpret: { lookup: settle(lookup, async (cmd, ctx) => …) },
  });
  ```

  `S` and `M` come from `types`; `C` and the settled half of `M` from `cmds`; each interpret
  handler's `ctx` from its own Cmd's `requirements`. `run(machine, { ctx })` demands exactly what
  it demanded before.

  **Migration.** The five-slot explicit-generic form still compiles and is not deprecated in this
  release, so nothing breaks. To move a call site:

  ```diff
  -defineMachine<Model, Msg, typeof lookup, never, NoCtx>({
  +defineMachine({
  +  types: { model: {} as Model, msg: {} as Msg, ctx: {} as NoCtx },
     cmds: [lookup],
  ```

  `cmd` and `sub` under `types` carry a hand-written Cmd / Sub union — the slots `cmds` and
  `subscriptions` cannot imply. Drop the slot entirely where the old call passed `never`.

  One shape needs a nudge: a **zero-parameter** function returning a fresh discriminated literal
  (`init: () => [{ type: "idle" }, []]`, `interpret: { x: async () => ({ type: "done" }) }`) is
  checked before the type parameters are fixed, so `"idle"` widens to `string`. Name the parameter
  you are ignoring — `init: (_loaded) => …` — and it narrows again.

  `Settled`, `Reducer`, `Transitions` and `NoCtx` stay exported for a reducer split into its own
  file.

- 32a296b: `driveToDone(handle, start, isTerminal, { failed? })` runs a machine from its
  start Msg to its terminal State in one call and stops the runtime on every exit.

  It replaces the six-step loop every "run this machine to done" caller
  hand-wired — `await ready`, `observe`, park a promise, `dispatch(start)`,
  `getState()`, `stop()` — whose two quiet failure modes were an observer left
  attached and a `stop` never awaited. The observer is detached and `stop()`
  awaited whether the drive resolves or rejects.

  Rejections are typed. A final State the caller's `failed` predicate marks
  rejects with the new `DriveFailedError<S>`, the State riding on `error.state`.
  A machine that never settles rejects with the existing `QuiescenceTimeoutError`
  from the cap `dispatch` already enforces — no second clock.

- f2fceb0: **Breaking:** two dead `@deprecated` aliases are removed outright (ADR 0016).

  - `diff` under `./parity` — use `parityEqual`. Same function, the
    non-inverted name: it returns `true` when the two values are equal.
  - `ContextFree` under `./pure` and the root — use `NoCtx`. Same type, the
    one name for the context-free-ctx marker.

  Neither had an in-tree use; both existed only to wait out a minor.

- e9e4111: A `Store` can now refuse a second live writer. Two runtimes pointed at one
  `agent.json` both drove the same run to done — `save` was unconditional, so the
  last writer won and neither could learn it had raced.

  New on the root subpath: `FencedStore<S>`, an optional widening of `Store<S>`
  that adds `fenced: true`, `loadFenced()` (bytes plus the version they were
  written at) and `saveFenced(state, expectedVersion)` (compare-and-swap);
  `isFencedStore`; and `StoreConflictError` (`_tag: "store_conflict"`), thrown when
  a swap finds a version other than the one it expected. `run` and
  `defineAgent().run` fence automatically when handed a fenced store: they read the
  version at boot and swap on every save. A run started after another has moved the
  version reads the current one, so the newer starter takes the fence and the older
  live writer is refused at its next save — having already fired the effects it
  reached by then. Only the boot race, where both processes read one version before
  either wrote, is refused before a single effect fires. Fencing buys at most one
  live writer from here on, not a guarantee that the loser never ran.

  `Store<S>` itself is unchanged and no implementor breaks. Fencing is opt-in per
  store for all of 0.x — `fileStore(path, parse, { fenced: true })` (version stamp
  guarded by a `wx` lock), `doStore(storage, parse, { fenced: true })` (inside
  `storage.transaction`), `memoryStore(initial, parse, { fenced: true })`. The
  unfenced call is byte-for-byte the old behaviour. `chromeStorageStore` stays
  unfenced deliberately: `chrome.storage` has no atomic compare-and-swap.

  See [ADR 0017](../../.decisions/0017-fencing-is-an-optional-store-widening.md).

- 7159a87: A resource can have a lifetime that spans a run. `provide({ … })` builds the
  `ctx` object `run` already takes, from a graph of providers with `acquire` and
  `release`, and `run` accepts it in place of the object:

  ```ts
  const scoped = provide({
    config: value({ url: process.env.DATABASE_URL ?? "" }),
    db: layer(
      ["config"],
      ({ config }: { config: { url: string } }) => connect(config.url),
      (db) => db.close()
    ),
  });

  await driveToDone(run(machine, { ctx: scoped, store }), start, isDone);
  ```

  The contract is Effect's `Layer` + `Scope`, copied point for point rather than
  invented: acquired once per run in dependency order and memoized, so a provider
  two others depend on is acquired exactly once; released in reverse acquisition
  order, exactly once, on every terminal — done, failed and cancelled all funnel
  through `stop()`. A `release` that throws does not stop its siblings and is
  reported to `onError` under `phase: "provide"` with the provider's key on
  `context.provider`.

  An `acquire` that fails releases what it had already acquired, in reverse, and
  surfaces as a typed `ProvideFailedError` naming the provider — it rejects
  `ready`, never escaping `run` as an uncaught throw.

  This is what a Cmd's `R` channel always meant. A `Cmd` is journaled data and a
  provider is a closure, so the Cmd can only ever carry the requirement — the
  graph that satisfies it lives in the host. The journal is unchanged: a run on a
  `provide` graph writes byte-identical bytes to the same run on a hand-built
  `ctx`, and replay, being a fold over Msgs, never calls an `acquire`.

  Works the same under `/node`, `/do` and `/mem` — those are `Store` adapters and
  this is the `ctx` seam all three share. `defineAgent`'s run options take the
  same widening, so an agent's tools get scoped resources too.

- 8609e71: `@demlik/tea/jev` is open — one new subpath at `battery` tier, over three
  modules:

  | Module           | What it is                                                                                                                           |
  | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
  | `protocol`       | TypeSafe Jev's wire contract as types plus two pure functions, `parseAnswers` and `classifyStatus`. No I/O.                          |
  | `ask`            | One Cmd over `resilient-call` that issues the call, with the HTTP caller injected as a `JevPort` and a pure `JevFallback` behind it. |
  | `classify-batch` | A stream of items turned into Jev calls by wiring `batch-window`, `fan-out` and the TTL `cache` around `ask`.                        |

  A Jev call is a map of questions you name, and an answer comes back under each
  name. The point of typing it is that a `choice` question's `criteria` keys ARE
  its answer's `choice` domain — write the rubric once and the narrowing is free
  at the call site:

  ```ts
  import { createJevAsk, jevQuestions } from "@demlik/tea/jev";

  const questions = jevQuestions({
    category: {
      type: "choice",
      instructions: "Which budget line is this?",
      criteria: { groceries: "Supermarkets", dining: "Restaurants" },
    },
  });
  // answers.category.choice : "groceries" | "dining"
  ```

  The door owns no API key: whoever builds the `JevPort` adapter owns the
  `Authorization` header, and a scripted test fake satisfies the same type — which
  is what makes a Jev-backed machine replayable.

  `battery` means this may break in a minor, before and after 1.0, provided the
  changelog for that minor says so. It is the honest tier here for a second
  reason: the door speaks a third-party wire contract, and a break upstream is a
  break here.

  The door is a re-export file over `src/internal/jev/`; nothing moved and nothing
  was renamed to open it. `docs/reference/jev.md` is generated with the rest, and
  [Ask Jev a typed question](https://github.com/kamp-us/demlik/blob/main/docs/how-to/ask-jev-a-typed-question.md)
  wires a small machine end to end.

- e1d1d1a: Refusals name the accepted set, and `acceptedTypes(machine, state)` lets a caller ask first.

  A refusal used to carry `msgType` and `stateName` — what was refused and where — but not what the
  state would have taken, so learning that a state accepts nothing at all cost one dispatch per Msg
  type. `NoCellError` now also carries `acceptedTypes: readonly string[]`, read at the moment
  `lookupCell` makes the selection and the row is in hand, and the message states it: the accepted
  types when there are any, and "this state accepts no Msg at all" when there are none. The empty
  case is the one a caller acting on a possibly-final state most needs, so it is words rather than an
  empty pair of brackets.

  `acceptedTypes(machine, state)` answers the same question before anything is dispatched — the
  transitions form from the state's own row, the reducer form from the flat table's keys, an empty
  array for a state with no cells. `lookupCell`'s miss arm calls that same function, so asking first
  and dispatching-and-catching cannot be told different things about one `(machine, state)` pair; a
  property test asserts it over ragged tables in both forms. It sits beside `acceptsOf`, which
  answers about a `state.type` a tool already named rather than the state value a caller is holding.

  **Breaking for direct constructors only:** `new NoCellError(msgType, stateName)` now takes a third
  argument, `acceptedTypes`. Every in-package construction site passes it; a caller that only catches
  and reads the error is unaffected.

- c596afd: A transitions cell is optional: a missing cell declares that the state does not accept that message.

  `Transitions<S, M, C>` required every (state.type × msg.type) cell, so a machine could not say "in
  this state, only these messages are valid". A 6-state, 9-message machine was 54 cells, most of them
  `(s) => [s, []]`, and `acceptedTypes(machine, state)` had to report every message type for every
  state — truthfully, and uselessly for a panel deciding which buttons to light, a test asserting a
  phase's surface, or an agent driver deciding what to dispatch. The phase check moved into the cell
  as an `if (m.phase !== "paying") return [m, []]`, where a considered refusal and an unfinished case
  read identically.

  Cells are now optional, the way a statechart's `on` block lists the events a state handles and
  XState treats an unlisted event as no transition. What tea does differently is stay loud
  (ADR 0011): the runtime half already existed, so dispatching a message with no cell raises
  `NoCellError` naming the accepted set, and `tryApplyCell` returns that refusal as data. Nothing is
  silently ignored.

  The **row** stays required. Adding a member to your State union is still a compile-time obligation
  to say what that phase does; a phase that accepts nothing writes the empty row `{}` and means it.

  `ExhaustiveTransitions<S, M, C>` is the old floor, opt-in per machine — the same table with every
  cell required. Annotate your table with it and hand it to `defineMachine` unchanged; it is an
  annotation, not a third update form.

  The new explanation page [Which update form, and what a missing cell
  means](https://github.com/kamp-us/demlik/blob/main/docs/explanation/pick-an-update-form.md) covers
  the choice and what the absence promises.

  **Migration: none.** An existing full table typechecks unchanged — optional cells only widen what
  is accepted. The reducer form is untouched; it remains the form for machines with no state
  discriminant.

- e3a8aa8: `tool()` grows `timeoutMs` and `retry`, so a `defineAgent` user can bound or retry one
  flaky tool without reaching down to `createAgent`.

  Both run in the reducer, through the same `resilient-call` family the brain call already
  uses, so the ladder is DATA on the durable Model rather than control flow inside the
  handler: a waiting retry is a `waiting_retry` phase with its timer armed as a
  subscription, and a process killed between two attempts resumes on the attempt it was on
  instead of refilling the budget. That is the property the only previously reachable
  recourse — a `Promise.race` or a `for` loop inside the handler — cannot have, because it
  lives inside the effect boundary.

  ```ts
  const fetchRate = tool(
    "fetch_rate",
    {
      description: "Fetch today's exchange rate",
      input: z.object({ pair: z.string() }),
      ok: z.object({ rate: z.number() }),
      err: ["upstream"],
      timeoutMs: 5_000,
      retry: {
        baseMs: 100,
        factor: 2,
        capMs: 5_000,
        jitter: "full",
        maxAttempts: 3,
      },
    },
    handler
  );
  ```

  A spent budget settles as `{ kind: "error", reason: 'retry_exhausted {"attempts":3,"last":"upstream"}' }`
  and an elapsed one as `{ kind: "error", reason: "timeout" }` — the same `ToolOutcome`
  shape every other tool failure already has, so an adapter that renders one renders these.
  Absorbed attempts never reach the conversation.

  Additive on every surface. A tool that declares neither field mints no slice entry, arms
  no timer, and behaves exactly as before. Two things are new beside the spec fields: the
  `AgentState.toolResilience` slice (`{}` for an agent that uses no knob) and the
  `AgentConfigCore.toolResilienceOf` seam a hand-wired `createAgent` fills, which
  `toolRouter` now serves as `resilienceOf`.

  `timeoutMs` is the whole call's budget, not one attempt's — measured from the first
  attempt, and a retry does not restart it. It does not cancel the handler either: a promise
  cannot be cancelled in JavaScript, so the call is over at the budget and the loop moves on
  while the attempt runs to its own end, folding nothing when it settles late.

- 78bf096: The persistence / observability modules and the agent-side leaves move inside the package
  (ADR 0015, ADR 0016). Six subpaths leave `exports`; every primitive they published still
  exists under `src/internal/`, and none of them is importable from outside the package.

  | Removed door               | New home                                |
  | -------------------------- | --------------------------------------- |
  | `@demlik/tea/recorder`     | `src/internal/persistence/recorder`     |
  | `@demlik/tea/snapshot`     | `src/internal/persistence/snapshot`     |
  | `@demlik/tea/trace-replay` | `src/internal/persistence/trace-replay` |
  | `@demlik/tea/journal`      | `src/internal/journal`                  |
  | `@demlik/tea/prediction`   | `src/internal/prediction`               |
  | `@demlik/tea/llm-call`     | `src/internal/llm-call`                 |

  **`@demlik/tea/machine-viz` stays where it is.** It is a `stable` subpath with real external
  callsites, and ADR 0016 (as amended by #83) keeps such a part on its own bare door rather than
  folding it into a grouped one — the same shape `@demlik/tea/retry-backoff` takes. `toMermaid`,
  `MachineVizOptions`, `safeId` and `safeLabel` are unchanged, and nothing about that door moves.

  `fileJournal` stays on `@demlik/tea/node` and the prediction ack primitive (`ack`, `initAck`,
  `NO_ACK`, `nextSeq`, `partitionByAck`, `reconcile`, `tagSeq`, and their types) stays on
  `@demlik/tea/pure`; those were always the public route, and only the mechanism-named doors
  behind them close. `@demlik/tea/agent` keeps re-exporting the `llm-call` types it did.

  `snapshot`'s two Cmds — `snapshot_write`, `snapshot_load` — are now built by `Cmd.define`
  constructors (`snapshotWriteDef<V>()`, `snapshotLoad`), so each carries its input shape as a
  type. The emitted records are unchanged; a checkpoint log written before this release folds
  identically. The other moved modules emit no Cmds of their own.

  `docs/reference/llm-call.md` goes with its door.

- 2353649: `createAgent` and `createLlmCall` take a plain function as the model.

  `model: async (messages) => turn` is now the common path where the
  `(modelId) => Llm` factory was required. The returned turn is validated
  through the purpose's schema (`agentTurnSchema` for the plain agent case),
  so a malformed answer surfaces as the run's `llm` failure exactly as a
  structured-output mismatch does — data on the settle Msg, never a throw
  out of the handler. The factory, and `withStructuredOutput(schema)` on it,
  stays the advanced form for a model that binds the schema itself.

  A bare `async` function is read as the plain port by its `AsyncFunction`
  tag; a sync function that returns a promise (`(m) => client.chat(m)`) goes
  through the exported `plainModel(fn)` to lift it into the factory shape.
  Passed bare, such a function is refused on its first call with an `LlmErr`
  whose `reason` is `PLAIN_MODEL_MISROUTE_REASON` — it names `plainModel(fn)`
  as the fix, and never reaches `withStructuredOutput`. `ModelPort` names the
  union, `PlainModel` the plain member. All under `./agent` and `./llm-call`,
  experimental tier.

- 311f8d7: **Thirteen doors.** The export map is the contract, and it had grown to sixty-odd subpaths — most
  of them a convenience for one caller that became a permanent semver promise the moment it
  published. It now carries exactly the public doors: `@demlik/tea`, `/do`, `/node`, `/mem`,
  `/react`, `/extension`, `/testing`, `/pbt`, `/agent`, `/retry-backoff`, `/devtools`,
  `/machine-viz` and `/parity`, plus `/package.json` and `/devtools/styles.css` (the asset stays
  with its door). A test pins the list, so a fourteenth door is now a decision made in the diff
  that adds it rather than a thing that happens.

  Nothing was dropped — the sub-doors folded into their parents as named exports, and every symbol
  they published is still exported, from one specifier up:

  - `@demlik/tea/pure` → `@demlik/tea`. The runtime-free surface (`Machine`, `Cmd`, `foldMsgs`,
    `applyCellChecked`, the prediction/ack helpers, …) is on the root door. The runtime-free
    _guarantee_ is unchanged and still enforced in-tree: nothing under `src/pure/` may import the
    runtime.
  - `@demlik/tea/subs` → `@demlik/tea`. `fromInterval`, `fromTimeout`, `fromEventTarget`,
    `fromEventSource`, `fromBroadcastChannel`, `fromPort`, `fromWebSocket`,
    `fromReconnectingWebSocket`, `defineListener`, `managedResource` and the transport types.
  - `@demlik/tea/extension/react` → `@demlik/tea/extension`. `useBackgroundRuntime`,
    `createBackgroundRuntimeContext` and their option/result types. The background service worker
    stays React-free: the re-export is side-effect-free, so a bundle that names no hook shakes React
    out.
  - `@demlik/tea/extension/subs` → `@demlik/tea/extension`. `fromChromeAlarm` and the other
    chrome-event Sub factories.
  - `@demlik/tea/extension/test-utils` → `@demlik/tea/extension`. `fakeChrome` / `FakeChrome`.
  - `@demlik/tea/pbt/arbitraries` → `@demlik/tea/pbt`. `arbMsg`, `arbMsgSequence`,
    `arbConstantMsg`, `arbGuidedSequence`, `arbRecordMsg`, `stubCtxThrowingProxy`,
    `MsgArbitraryTable`.
  - `@demlik/tea/pbt/runners` → `@demlik/tea/pbt`. `propertyInvariant`, `propertyTerminates`,
    `propertyTrace`, `foldEvents`, `Step`.

  Migration is one edit per import: drop the sub-path, keep the names.

- dd24db6: **BREAKING (experimental tier): the `chart` family is removed.** Nine subpaths are gone from the
  export map:

  - `@demlik/tea/chart`
  - `@demlik/tea/chart/inspect`
  - `@demlik/tea/chart/inspect/react`
  - `@demlik/tea/chart/inspect/styles.css`
  - `@demlik/tea/chart/report`
  - `@demlik/tea/chart/lane`
  - `@demlik/tea/chart/lane/react`
  - `@demlik/tea/chart/lane/styles.css`
  - `@demlik/tea/chart/lane/server`

  All nine carried the `experimental` tier in `MAINTAINING.md`, which is why this is a `minor` and
  not a `major`.

  **There is no replacement and no migration path.** Chart authored a machine as config and drew a
  fabrika lane; neither belongs in a state-machine substrate. The kernel (`defineMachine`, `run`,
  `replay`) and `@demlik/tea/machine-viz` are unaffected — nothing outside `src/chart/` imported it.

  **Last version that ships it: `0.13.0`.** The last commit carrying `src/chart/` is
  `78bf0966` (`git show 78bf0966` restores any of it). Git history is the archive; the code was not
  extracted to another package.

  **Known affected consumer:** `kamp-us/phoenix` imports `@demlik/tea/chart/lane/server` and will
  break on the next release. Pin `@demlik/tea@0.13.0` or vendor the module from the commit above.
  Migrating phoenix is tracked separately.

- 933f624: `Cmd.define`'s `R` channel is declared with `requirements`, not `needs` — one word per concept,
  and it is Effect's ("Requirements"). `deps` keeps its own meaning on `layer`: the edges between
  providers in the host-side graph. No alias — the field never shipped (ADR 0014 amendment #189).

  Migration: rename `needs` → `requirements`, `Cmd.needs<R>()` → `Cmd.requirements<R>()`, and
  `NeedsOf<C>` → `RequirementsOf<C>`. `RequiredCtx<C>` is unchanged.

- c289944: The resilience family moves inside the package (ADR 0015, ADR 0016). Eleven battery
  subpaths leave `exports`; every primitive they published still exists, under
  `src/internal/resilience/`, and is no longer importable from outside the package. Only
  `@demlik/tea/retry-backoff` remains public in this family — Binclusive imports it — and it is
  unchanged.

  | Removed door                   | Internal home                              |
  | ------------------------------ | ------------------------------------------ |
  | `@demlik/tea/resilient-call`   | `src/internal/resilience/resilient-call`   |
  | `@demlik/tea/with-resilience`  | `src/internal/resilience/with-resilience`  |
  | `@demlik/tea/authed-call`      | `src/internal/resilience/authed-call`      |
  | `@demlik/tea/cache`            | `src/internal/resilience/cache`            |
  | `@demlik/tea/circuit-breaker`  | `src/internal/resilience/circuit-breaker`  |
  | `@demlik/tea/deadline`         | `src/internal/resilience/deadline`         |
  | `@demlik/tea/rate-limit`       | `src/internal/resilience/rate-limit`       |
  | `@demlik/tea/retry-to-success` | `src/internal/resilience/retry-to-success` |
  | `@demlik/tea/token-refresh`    | `src/internal/resilience/token-refresh`    |
  | `@demlik/tea/with-deadline`    | `src/internal/resilience/with-deadline`    |
  | `@demlik/tea/with-telemetry`   | `src/internal/resilience/with-telemetry`   |

  The `@deprecated` stamp on `resilient-call` goes with its door: the module is
  `with-resilience`'s implementation and stays, internal.

  Every Cmd these modules emit is now built by a `Cmd.define` constructor — `resilient_run`,
  `$resilience:run`, `$deadline:decision`, `$telemetry:emit`, `refresh_token` — so each carries
  its input schema, result schema and failure tags as types. The emitted records are unchanged;
  a replay log written before this release folds identically.

- 0271b0d: `AgentStatus` on `@demlik/tea/agent` (experimental tier) gains an `idle` member, and `status(s)`
  returns `{ kind: "idle" }` for a Model whose `run.phase === "idle"` — the slice straight out of
  `init`, before any `agent_start`. Previously such a Model fell through to `running`, so a caller
  deciding "start or resume" off `status` booted a run that had not begun, and a DO host reading a
  hydrated-but-unstarted Model reported it live. A `stale` run still reads `running`; `failed`,
  `done` and `suspended` are unchanged. An exhaustive `switch` over `status(s).kind` now needs an
  `idle` arm.
- 8f36bcc: A second, optional model port shape on `@demlik/tea/agent` —
  `async (messages, { onChunk }) => turn`. `defineAgent` takes one `model` field for
  both shapes and tells them apart by arity (`isStreamingModel`), so a plain
  `async (messages) => turn` brain is still invoked with exactly one argument and
  nothing about an existing agent moves. New vocabulary: `TurnChunk`,
  `ModelStream`, `StreamingModel`, `DefinedAgentModel`, `isStreamingModel`.

  The deltas leave through a new `onChunk` run option, contained the way `onEvent`
  is — a throwing listener is warned about, never allowed to reject the model call
  it fired from.

  Streaming is a side channel, never state. A chunk is not journaled, not written
  to the `Store` and never folded into the Model, so the turn a streamed run
  settles is identical to the one a plain model would have settled, a replay
  reproduces that Model with no chunk in the journal, and a resume re-emits no
  delta of a turn that already settled.

- 5aa1c6a: A tool failure on `@demlik/tea/agent` (experimental tier) keeps its tag. `ToolOutcome`'s error
  arm now carries the `{ _tag, …payload }` the tool failed with, spread beside the `reason` string
  it always carried, so the failure the model reads as prose is the same failure host code can
  branch on. `toolErrorReason` and the `reason` it renders are unchanged — this is additive (#115).

  - `ToolFailure` — the stored error arm, `{ kind: "error", reason, _tag? }`. `_tag` is optional
    for one reason: a run persisted by 0.12.x was written before the tag was kept, so a `Store` can
    hand back a failure that has none. Every failure this version mints carries one.
  - `ToolError<T>` / `ToolFailureOf<T>` / `TaggedFailure<E>` — the failure union a router over `T`
    can settle with, and that union distributed over `{ kind, reason }`. Declared tags, `thrown`,
    the kernel's `malformed_result`, the router's `unknown_tool` / `malformed_args`, and the
    ladder's `timeout` / `retry_exhausted` (`ToolResilienceError`, new here: `ToolTimedOut` and
    `ToolRetryExhausted`).
  - `DefineAgentConfig.onToolError(outcome, ctx)` — optional, with `outcome` typed against this
    agent's own tools: a `switch` on `_tag` narrows the payload and an unhandled failure mode is a
    compile error. It fires once per failed CALL, and the two seams it fires from split on whether
    the tool declared `timeoutMs` / `retry`: a tool that declared neither is announced at the
    interpret boundary, before the fold and awaited there; a tool that declared either is announced
    off the fold, because its ending is minted by the reducer rather than by a handler and its
    absorbed attempts are failures the run did not produce. It is not re-fired on resume for an
    outcome already folded, and a throw is contained and warned like `onEvent`'s. `ToolErrorContext`
    is its second argument — the `callId` and the tool `name` the model asked for.

  `AgentVerbs.toolErr` now takes `string | ToolFailure`: a bare `reason` still settles an untagged
  failure exactly as it did, and a whole `ToolFailure` keeps the tag through the fold.

  Router-minted and ladder-minted failures carry their tag the same way, and `kind` / `reason` are
  written last, so a payload field of either name can never shadow the discriminant or the model's
  channel. Code that
  reads `outcome.reason` or discriminates on `outcome.kind` is unaffected.

- e04944e: `tool()` takes a required `description` — the model-facing sentence a provider adapter declares
  to the model beside the schema (Anthropic `description`, OpenAI `function.description`) — and
  surfaces it as `description: string` on `ToolDef` / `AnyToolDef` (experimental tier, #91). An
  adapter reads `t.description`, never a `.describe()` off the `input` schema: that one describes
  the arguments object and lands inside the emitted JSON schema, a different field on every wire
  format.
- d76da43: `tool()` on `@demlik/tea/agent` (experimental tier) hands its handler both settle constructors.
  The third argument is now `{ ok, fail }` instead of the bare `fail`, so a handler writes
  `ok(value)` for the success arm and never imports `better-result` itself — under pnpm's strict
  `node_modules` that transitive import did not resolve, and the tutorial's install line had grown a
  fourth package (#94).

  - `ToolOk<Ok, E>` — `ok(value)`, with `Ok` fixed to what the `ok` schema parses.
  - `ToolConstructors<Ok, E>` — the `{ ok, fail }` pair, the handler's third parameter.
  - `ToolHandler` is `(args, ctx, { ok, fail }) => Promise<Result<Ok, E>>`. A handler written
    against the positional `fail` reads `fail` as the pair now and does not compile; destructure
    it: `async (args, ctx, { ok, fail }) => …`.

- 0b14c96: `tool()` + `toolRouter()` on `@demlik/tea/agent` (experimental tier). Declare a tool once and
  derive what a consumer used to hand-write twice — the `toolOf` mapping and the interpret cell.

  - `tool(name, { input, ok, err, requirements }, handler)` — one colocated value built on `Cmd.define`
    (#44). The Cmd's input is the model's call `{ callId, args }` with `args` parsed against
    `input`; the handler returns `Result<Ok, E>` over the declared `_tag` union (an undeclared tag
    is a compile error) and reads the `requirements` slice off its ctx, demanded at `run`. The cell
    settles through the minted `<name>_ok` / `<name>_err`: a thrown handler becomes `_err`
    (`{ _tag: "thrown", message }`, or the thrown `_tag` when it is a declared one), never a
    rejection; an `_ok` value the `ok` schema rejects becomes the kernel's `malformed_result`.
  - `toolRouter([...tools])` — `toolOf` (total: an unknown name or args failing the schema ride a
    `tool_rejected` Cmd that settles as an error the model sees), the `interpret` table, the `defs`
    for `Machine.cmds`, and `outcomeOf` for reading a settled tool off its Msg.
  - `createAgent(...).toMachine({ tools })` — merges the router's cells, folds its `<name>_ok` /
    `<name>_err` into the conversation, and takes the tool Cmds off the `toolInterpret`
    obligation. `agentEvents({ tools })` projects those settles to `ToolSettled`. Both are
    additive: with no router every existing config and `toolInterpret` compiles unchanged.

- 989e607: Typed effect channels on Cmd constructors (ADR 0014). Additive kernel types — every existing
  `Cmd<A>`, battery Cmd union and machine compiles unchanged.

  - `Cmd<T, E, R>` — `E` (the `_tag` union a Cmd can settle with) and `R` (the `Ctx` slice its
    handler needs) ride as phantom type parameters; the runtime value stays `{ type }`.
  - `Cmd.define(name, { input, ok, err, requirements })` — the typed constructor. Returns the Cmd builder
    (`fetch({ url })` → `{ type: "fetch", url }`) carrying `ok(cmd, value)` / `err(cmd, error)`
    Msg builders and the declaration; `Settled<typeof fetch>` is its `fetch_ok` / `fetch_err`
    Msg union. `Cmd.requirements<R>()` names the `R` slice. `input` / `ok` are zod schemas — `zod` is
    now a runtime dependency.
  - `defineMachine({ cmds: [fetch], … })` derives the machine's Cmd union and the settled half of
    its `M` from the constructors; the reducer must carry the `_ok` / `_err` cells without the
    user naming them in `Msg`.
  - `run` types `ctx` as `Ctx & RequiredCtx<C>` — a ctx missing a key any Cmd's `R` names is a
    compile error. `useMachine` and `agentHost` thread the same demand. An
    `Interpret` cell's `ctx` carries its own Cmd's `R`.
  - Boundary enforcement: a handler's `_ok` value is parsed against the `ok` schema at the
    interpret edge; a value that fails becomes the minted `_err` carrying
    `{ _tag: "malformed_result", issues }` and never reaches Model. The parsed (stripped) value
    is what lands. `run({ clock })` stamps `at` on every settled Msg (default `Date.now`).
  - `settle(def, work)` — `tryInterpret`'s successor for a typed Cmd: `work` returns
    `Result<Ok, E>` with both channels inferred from the def; the helper maps the arms onto the
    minted Msgs. `Interpret` keeps returning `Promise<M | void>`.

- 131a416: `provide`: a misspelled dependency is now a compile error, not a boot-time throw.

  `Provider` gains a third type parameter — the dependency NAME set — and `provide` binds it to
  `keyof M`. Following Effect's `Layer<ROut, E, RIn>`, where requirements are a type parameter and a
  graph that does not satisfy them is refused by the compiler:

  ```ts
  provide({
    config: value({ url: "postgres://x" }),
    // Was: compiled, then threw `UnknownProviderError` at `open()`.
    // Now:  does not compile — "confg" is not a key of this map.
    db: layer(["confg"], (deps: { config: Config }) =>
      connect(deps.config.url)
    ),
  });
  ```

  `UnknownProviderError` stays, for the untyped path only — a cast map, one assembled at runtime,
  one read back through an erased `Provider<unknown, …>` — where there is no key set to check
  against.

  Minor rather than patch because the tightening rejects code that used to compile. `layer`, `value`
  and the acquisition order they produce are unchanged, and a graph built through them needs no edit.

  **What breaks: an explicit `Provider` ANNOTATION.** `K` defaults to `string`, so `readonly
string[]` no longer fits the `readonly (keyof M)[]` the map wants — including a leaf provider whose
  `deps` is `[]`, because the annotation's default is what is compared, not the value:

  ```ts
  // Was: compiled. Now: TS2322 — `string` is not assignable to `"config" | "db"`.
  const config: Provider<Config> = { deps: [], acquire: () => ({ url: "postgres://x" }) };
  const db: Provider<string, { config: Config }> = { deps: ["config"], acquire: (d) => connect(d.config.url) };

  // Fix, either: name the key set…
  const db: Provider<string, { config: Config }, "config" | "db"> = { … };
  // …or drop the annotation and let the constructors infer it (preferred).
  const db = layer(["config"], (d: { config: Config }) => connect(d.config.url));
  ```

### Patch Changes

- 0991b24: `acceptedTypes` keeps its "never throws" promise, and reports only cells a dispatch would accept.

  Two ways the helper disagreed with the refusal path it is supposed to be one reading with. Under
  the transitions form it dereferenced `state.type` unguarded, so a caller trusting the documented
  "never throws" and asking about a pre-boot `undefined` or `null` state crashed. And it returned
  every key of the state's row, while `lookupCell` admits a cell only on
  `typeof cell === "function"` — so a non-function row value, reachable through a cast or from wire
  data, was reported as accepted and then refused on dispatch.

  A nullish state now answers `[]` in both forms: untagged is a state carrying no discriminant,
  nullish is no state at all, and nothing is dispatchable against it. The accept-set reading now
  applies `lookupCell`'s own function admission, so the set a caller is handed and the set a
  `NoCellError` reports name the same cells. The existing agreement property test is extended with
  ragged tables carrying cast-in non-function row values.

- e4add87: ADR 0014 gains an amendment recording the #115 ruling: a tool's declared failure tags now
  reach user code as `{ _tag, …payload }` on `ToolOutcome` and through `defineAgent`'s
  `onToolError`, not only the model as a rendered `reason`.
- 92afb6b: `applyCell` refuses a nullish state with `NoCellError`, in both update forms.

  The refusal side of the asymmetry `acceptedTypes` had fixed. Under the transitions form
  `lookupCell` dereferenced `state.type` before checking the state existed, so
  `applyCell(machine, null, msg)` threw a bare `TypeError` where every other refusal on that path
  raises the typed error callers already handle. Under the reducer form it was worse than a crash:
  dispatch never consults the state, so a cell RAN against a machine that had not booted, while
  `acceptedTypes` answered `[]` for the same pair.

  A nullish state now refuses before the form branch, with `acceptedTypes: []` and the state name
  `(no state)` — untagged is a state carrying no discriminant, nullish is the absence of one. The
  agreement property is extended over the nullish state, so "the helper omits it" and "dispatch
  refuses it" stay one reading there too.

- 7128b06: `driveToDone` no longer hangs when a caller-supplied `cancel` throws
  synchronously on a mid-run abort.

  The abort listener already routed a rejected cancel dispatch — a reducer or
  `interpret` that throws after the Msg is produced — into the drive's rejection.
  A `cancel` function that threw before returning a Msg escaped the listener
  instead: nothing was dispatched, so the terminal promise had nothing to resolve
  it and the drive parked forever. Both throws now take the one route out, so the
  returned promise rejects with the thrown error and the runtime is stopped.

  Unreachable through `defineAgent`, which supplies its own `cancel`; this bites a
  direct kernel consumer passing `{ signal, cancel }` to `driveToDone`.

- 8323465: The hand-authored Diátaxis quadrants catch up with the doors the internalization epic closed
  (ADR 0015, ADR 0016). No behaviour changes; every page under `docs/tutorial/`, `docs/how-to/`
  and `docs/explanation/` now names only a subpath `package.json` `exports` still carries.

  Six how-tos are retired, each because its _subject_ module is now `src/internal/` and the guide
  cannot be followed at all:

  | Retired page                               | Subject door, now internal     | Where the capability is                    |
  | ------------------------------------------ | ------------------------------ | ------------------------------------------ |
  | `docs/how-to/call-an-authenticated-api.md` | `@demlik/tea/authed-call`      | `src/internal/resilience/authed-call`      |
  | `docs/how-to/retry-until-it-succeeds.md`   | `@demlik/tea/retry-to-success` | `src/internal/resilience/retry-to-success` |
  | `docs/how-to/await-a-terminal-state.md`    | `@demlik/tea/await-terminal`   | `src/internal/flow/await-terminal`         |
  | `docs/how-to/batch-work-into-windows.md`   | `@demlik/tea/batch-window`     | `src/internal/flow/batch-window`           |
  | `docs/how-to/debounce-input-durably.md`    | `@demlik/tea/throttled-input`  | `src/internal/timing/throttled-input`      |
  | `docs/how-to/reconcile-desired-state.md`   | `@demlik/tea/reconciler`       | `src/internal/flow/reconciler`             |

  Their `docs/how-to/index.md` rows go with them. For a retry ladder from outside the package the
  public route is `@demlik/tea/retry-backoff` — [Add retry and backoff to a
  call](./docs/how-to/add-resilience.md) — and the L2 intent layer is where these jobs come back.

  Pages that only mentioned a closed door keep their subject and lose the specifier:
  `gate-a-refactor-on-parity.md` now keeps its golden as plain JSON through `@demlik/tea/parity`
  rather than re-hydrating JSONL with the internal `parseJSONL`; `replay-in-a-test.md` points at
  `parity` for the record-then-replay loop; `add-resilience.md` drops the wrapper section, whose
  `createPoller` / `withResilience` are both internal now; and the deadline Sub is named as a
  behaviour where no public specifier exists for it.

  `src/docs/doc-specifiers.test.ts` is the guard so it does not recur: it fails when any
  hand-authored `.md` under `docs/` names a `@demlik/tea/*` specifier the export map does not
  carry.

- 7ce98fb: `driveToDone` no longer hangs when `start`'s follow-up chain quiesces on a
  State that is neither terminal nor `failed`. When the runtime has no live Sub
  (manual or dep-keyed) and no Cmd in flight at that point, nothing inside it can
  deliver another transition, so the drive now rejects with the new
  `DriveStalledError<S>` — the stalled State riding on `error.state`, sibling to
  `DriveFailedError` — and `stop()` is awaited before it settles, as the docstring
  already promised for every exit.

  A Sub-driven machine is unchanged: a Sub that delivers the terminal Msg after
  the dispatch quiesces keeps the drive waiting, and it resolves on that State.

- 6cee530: `@demlik/tea/node` now imports with no `ws` installed. The built door carried a static top-level
  `import WebSocket from "ws"` while `ws` is declared an OPTIONAL peer, so a consumer who installed
  only the tutorial's three packages hit `ERR_MODULE_NOT_FOUND` on their first import of `fileStore`.
  `ws` is loaded on first use inside the `node_ws` Sub instead — `fileStore` and `fileJournal` no
  longer pay for a dependency they never touch, and a `node_ws` Sub opened without `ws` installed
  throws a message naming the package to install.
- fffab4d: `subscribe` and `observe` now say what a dispatch from inside a listener does.
  It is scheduled, never applied: the message is enqueued onto the serial tail
  behind the fold that fired the listener, so it is never folded re-entrantly and
  never discarded, and two listeners issuing in order fold in that order.
  `getState()` inside a `subscribe` listener reads the State the fold just
  committed — the same State `observe` receives for that fold.

  That is the rule the runtime already ran by, and the rule nobody could read. A
  caller who could not tell scheduled from dropped reached for a
  `setTimeout(fn, 0)` deferral to make the dispatch land; none is needed, and the
  guarantee is now pinned by tests as well as written down.

- ec87946: The `/agent` surface now names `Cmd<T, E, R>`, so a reader told the kernel has typed effect
  channels (ADR 0014) can find them where they are actually spelled. No behaviour changes.

  `tool()`'s docblock says it returns a `Cmd<T, E, R>` definition whose `T` is what `ok` parses and
  whose `E` is the `err` tag union — in its first sentence, which is the part `docs/reference` is
  generated from, so the reference row carries it too. The tutorial's "Declare a tool" section makes
  the same read on the tool it just declared, including what the empty `err: []` means, and
  `docs/explanation/errors-as-data.md` links back to it while naming the effect type once.

- da24ca7: `@demlik/tea/parity` now re-exports `Trace` and `RecorderOptions` as types.

  Both already appeared in the door's published signatures — `Recording.trace()` returns a
  `Trace<S, M>`, `goldenReplay` accepts one bare, `recordRun` takes `RecorderOptions` — but
  neither had a name a consumer could import once `@demlik/tea/recorder` went internal. So
  annotating a fixture, typing an options constant, or giving a wrapper an explicit return type
  meant `ReturnType<typeof rec.trace>`.

  ```ts
  import {
    goldenReplay,
    type RecorderOptions,
    type Trace,
  } from "@demlik/tea/parity";

  const opts: RecorderOptions = { captureSteps: true };
  const golden: Trace<AuditState, AuditMsg> = JSON.parse(fixture);
  ```

  No runtime change and no `exports` change: this widens the type surface inside an existing
  door. `docs/how-to/gate-a-refactor-on-parity.md` names `Trace` directly now.

- e3407bd: A boot failure after the provider graph opened now releases it. `run` acquires a
  `provide({ … })` graph as boot's first step; if a later boot step threw —
  `store.load()`, `store.migrate()`, the boot save, or the initial interpret —
  `ready` rejected with every provider still acquired, and only a `stop()` the
  host had no reason to call would close them. The remaining boot steps now run
  inside the graph's lifetime, so a throw releases every acquired provider in
  reverse before the rejection surfaces, symmetric with the unwind `open()`
  already does for a failed `acquire`.

  `Scope.release` is idempotent, so the `stop()` a careful host still calls after
  such a rejection stays a no-op and never double-releases.

- 268163d: `tool()` on `@demlik/tea/agent` (experimental tier) refuses a reserved name. A tool's name is the
  prefix of its `<name>_ok` / `<name>_err` settle Msgs and its own interpret key, so a tool named
  `agent_tool`, `resilient`, `compact`, `compact_run`, `tool_rejected` or `snapshot_write` used to
  overwrite the agent's own reducer or interpret cell through `toMachine`'s last-wins spread — with
  no error at construction, `run` or dispatch (#72).

  - `ReservedToolName` — every protocol discriminant in `MsgType` and every prefix a `_ok` / `_err`
    / `_run` entry was minted from, plus the router's `tool_rejected` and the checkpoint cell
    `snapshot_write`. Derived from `MsgType`, so a new entry there reserves its name and its prefix
    with no second edit.
  - `tool("compact", …)` is a compile error; a reserved name that reaches `tool()` as a widened
    `string` throws `tool: "compact" is reserved — it is an agent-owned Msg prefix`, the same
    declaration-bug refusal `toolRouter` gives a name declared twice.
  - `isReservedToolName(name)` — the runtime guard, exported beside the type.

- fe07a88: `agent.run(...)` now resolves at the type it always produced. Its promise
  resolves only on an ENDED run — `done`, or `cancelled` — and rejects on a
  failure, but it was typed as the whole durable Model, which includes the
  never-started `idle` arm. `idle` deliberately carries no `runId` (identity is
  minted at `start`), so `(await agent.run(input)).run.runId` — a field every
  resolved run has at runtime — did not typecheck, and the reader's only moves
  were a cast or a `phase` guard that can never fail.

  `run` now resolves `DefinedAgentResolvedState<T>`: the same Model with its `run`
  slice narrowed to `EndedRun`, the `done` / `cancelled` subset. `final.run.runId`
  reads bare. Its type is `string | null`, not `string`, because a run cancelled
  through an already-aborted signal ends before `start` mints an identity — that
  is a real outcome of this call and stays a distinguishable value.

  Nothing widens: the `idle` arm is untouched and still carries no `runId`, and
  `DefinedAgentState` — the DURABLE Model, which a `Store` must be able to hold at
  `init` — is unchanged. `@demlik/tea/agent` is an experimental door, and this is
  a narrowing of what a promise resolves: code reading a field off the resolved
  value keeps compiling, while code assigning it to a variable annotated with the
  whole `MonitoredRunState` union does not.

- 19eef4e: `withDeadline`, `withTelemetry` and `withResilience` no longer drop `machine.cmds`, so `run`'s
  interpret edge parses a `Cmd.define`d handler's `_ok` value and stamps `at` on the wrapped machine
  exactly as on the bare one (#66). A malformed result behind a wrap now becomes the minted `_err`
  carrying `malformed_result` instead of reaching the reducer raw. `withResilience`'s
  `$resilience:run` carrier settles the target's result through the same edge `run` uses, handed
  over on ctx, so the parsed and stamped Msg is what lands as the call's `result`.

## 0.13.0

Published on 2026-09-06 by the per-merge publish job, whose version-bump commit was then
rejected by branch rules and never landed on main. The tag on npm carries none of the work
merged after it. Its changesets were never consumed; they roll into the next version, the
first release from the version-PR model.

## 0.12.0

### Minor Changes

- 7c9a962: The lane viewer is an operator console rather than a document.

  The page was two screens — a fleet list, and a lane you reached by leaving the
  list — capped at a column in the middle of the window. Opening a lane hid the
  fleet, which defeats the point: the reason to look up from one lane is another
  lane going amber.

  It is now one full-width screen. A strip carries the verdict as a sentence
  (`1 lane tripped`) with the counts and a live indicator; a rail holds every
  lane permanently, sorted by which needs a person; the stage takes the rest.
  The page itself no longer scrolls — rail and stage scroll independently, so
  reading a twelve-task epic cannot push an amber lane off screen. It opens on
  the rail's first row, which is already the answer to "what should I look at".

  A lane whose `workflow.json` will not parse no longer takes the screen with
  it. Charts were compiled inside render, so one malformed file threw during
  commit and blanked every healthy lane beside it. The parse now happens once
  per lane and its failure is a value: the lane keeps its row, carrying the
  parser's own complaint, and its page says which file broke and how to look at
  it. A render error boundary catches whatever the parse does not.

  Diagrams are bounded and hold their place while they redraw, so stepping
  through an event log no longer collapses the page under the reader.

## 0.11.0

### Minor Changes

- 1bffd8a: **Point at a folder.** `serveLaneViewer({ root, transition })` is now the whole integration — a lane is a directory holding `workflow.json` and `events.jsonl`, that convention is ours, so reading it is ours too. Three hosts had written the same loop before it moved here, each with its own idea of the edges: whether a directory with no `workflow.json` is a lane (it is not — a scratch dir under the root is not something to draw) and whether one with no `events.jsonl` is broken (it is not — it was emitted and never run, and every task sits where it booted).

  `lanesFromDisk(root, { origins })` is exported for callers who want the reader without the server. `lanes: () => …` still takes precedence, for lanes that do not live in a folder. `origins` moves to the top level, so the cast is stated once rather than copied onto every lane.

  A lane that cannot be read is skipped rather than thrown — one bad directory should not take down a fleet view — while a root that cannot be listed still throws, because a short list presented as "your lanes" is worse than an error.

## 0.10.0

### Minor Changes

- 2b6aede: **`serveLaneViewer` — start the lane dashboard, rather than assemble it.** `laneViewer` returns a `(Request) => Response` for a host that already has a server. But everything _between_ that handler and a running page — creating the server, turning node's request into a `Request`, reading a POST body, streaming the response back so the event stream stays open — is identical in every host, and asking each one to write it is asking each one to get it subtly wrong. The streaming especially: buffer the response and `/api/stream` never delivers a frame, which presents as "the page does not update" and is nobody's obvious bug.

  So the three callbacks are now the whole integration. `serveLaneViewer(opts)` listens and hands back `{ url, close }`; `port: 0` takes a free one and reports it. It binds `127.0.0.1` by default, because this reads a machine's own disk and should stay on it. `laneViewer` is unchanged for anyone mounting it themselves.

## 0.9.0

### Minor Changes

- 8f21ad1: **`chart/lane/server` — the lane dashboard as something a host can serve.** `chart/lane/react` gives you the components and assumes you have a bundler. A CLI does not, and the consumer this was written for is one: it already knows where its lanes are, how to fold one and how to record an event, and what it lacks is a page. So this ships the page **prebuilt** and asks the host for the three facts only the host can know — where the lanes are, how an event is recorded, and (optionally) who holds a lane. `laneViewer(opts)` returns a `(Request) => Promise<Response>`, so it mounts under Node's `http`, Bun.serve, Hono or a Worker with no per-framework adapter.

  The contract the page speaks is four endpoints: `GET /api/lanes`, `GET /api/stream` (SSE, liveness is the library's problem — it re-asks `lanes()` and pushes on change, so no host writes a watcher), `GET /api/drivers` and `POST /api/transition`.

  **The host stays the only writer.** `transition` is the host's own verb; the page proposes and the host disposes, and a refusal is an answer displayed in the host's own words rather than an error the page invents. Omit `transition` entirely and the dashboard is read-only, which is a real mode and not a degraded one. `drivers` is optional because ownership is not in the lane files at all — absent means UNKNOWN and renders nothing, never "free", because a lane shown free while someone holds it is what starts a second driver on one piece of work.

  `examples/lane-dashboard/serve.ts` is a complete host in ~120 lines, most of it reading two files.

## 0.8.0

### Minor Changes

- 3066c6e: Add `./chart/inspect` and `./chart/inspect/react` (**experimental**): a live debugger for any machine authored with `./chart`, that builds itself out of the chart.

  A hand-built debugger page for a machine types four things out by hand — the list of messages, the state names, which control is disabled when, and what each payload looks like. A chart already carries all four as data, so `<ChartInspector chart={lane} parts={{ assign, guards }} boot={…} samples={…} />` is the whole page: a control per message, a live state panel, a state diagram with the current node lit, and a time-travel scrubber over every transition. There is no prop that restates something the chart already says.

  **Refusals are first-class**, which is the capability the totality property buys and no other inspector can offer. A chart is total over (state × event): a pair is declared, or refused — by the event's `scope`, by the state's `ignore`, or by `end: true` — and there is no third case. So a refused event renders as _visibly refused with the mechanism that refused it_ (`"PASS" is not addressed to phase "working" (scope: edges)`), not as a missing button. The refusal reasons are derived by the same predicate `compile` uses to choose between a self-loop and a `NoCellError`, so the picture and the machine cannot disagree about what is refused.

  **Guard preview.** Given a live state and a sample message the named guard is executed — it is pure, the same thing `replay` may call — and the branch it takes is reported with that arm's target and cmds. Edit a payload and watch the branch flip. Where it cannot be evaluated (no sample, no bag, a throwing body) it degrades to `unknown` carrying the reason, never to a guess. Cell edges show their whole declared `to` fan-out, plus the target the cell actually picks when it can be run purely with samples, clamped to that edge's `to`.

  **What would fire, and what did.** The control row shows the cmds an edge _declares_ — the before question, which a `{ to, cell }` edge answers with an empty list _by declaration_, because the cell builds its cmds inside its body. `captureCmds(machine, { msgs, ctx })` answers the after question: what a recorded run actually emitted, per step, tagged with the message that caused it, cell-built cmds included. It installs no observer — `replay` already returns the cmds a fold emitted, so a step's emissions are the tail past the previous prefix, read off the same pure fold the scrubber uses. A fold that throws truncates the capture and says so (`stoppedAt`) rather than reporting a short list as complete. The React page renders both, as separate panels, with the fired row highlighted at the scrubber's cursor.

  **Reducer-form charts are inspectable, as the thinner thing they are.** `describeReducerChart` + `inspectReducerState` + `<ReducerChartInspector>` describe a `defineReducerChart` chart with the facts it actually has: the flat state list, the entry state, the event alphabet with `foreign`/`from`/payload-ness, per-event routing including a cell edge's whole declared fan-out, and totality over events — which this form enforces _more_ strictly than the grid form, since `on` is a required mapped type rather than a `scope` convention. What it cannot say it refuses to say: `phases`, `refusals` and `scope` each hold an `Unanswerable` carrying the reason ("this chart form has no state dimension — a refusal is a `(state, event)` fact"), never an empty list that would read as _nothing is refused_. The component names all three on screen instead of leaving unexplained gaps, and each describer accepts only its own chart form (a compile error otherwise, probes `e56`/`e57`).

  **Time travel is pure.** The runtime is recorded with `./recorder` and scrubbing re-folds a prefix of the recorded messages through `replay` — `init` + `update` only, never `interpret`, never a Store, never a live subscription — so dragging backwards re-derives history instead of re-performing it.

  `./chart/inspect` is the headless half: `describeChart(C)` returns the phases, states, entry, end/parking flags, the event alphabet with `scope`/`foreign`/`hasPayload`, the cmd/guard/cell alphabets, every edge and every refusal; `inspectState(desc, state, opts)` returns one verdict per event against a live state. It is framework-free and pure, so a script, a test or an Ink TUI gets the useful half. `./chart/inspect/react` is the thin binding, styled the way `./devtools` is (one prefixed stylesheet, consumer design tokens, no new dependency).

  The one thing the author still supplies is `Samples<C>`: `ty<T>()` is `{}` at runtime, so a payload's shape is erased before any runtime code could read it. The bag is typed by the chart all the same — keyed by exactly the events that declare a payload, each value that event's declared type, an event with no payload has no key to write, and a typo'd name is an excess property.

  Additively, `chartMermaid` now takes an optional options bag — `highlight` (light the active node), `phases` (draw phases as Mermaid composite states, which the flat drawing threw away), `polarity` (draw an `end: true` final and an `end: "error"` one apart), `walked` (mark the edges a run actually took, keyed by the exported `edgeKey`), `direction` and `title`. Every default reproduces the drawing it emitted before options existed, so no existing caller and no committed diagram moves. `safeId` / `safeLabel` are now exported from `./machine-viz` and shared by both drawings, so a chart whose state name is not identifier-safe (`human:cp-approval`) draws correctly instead of emitting broken Mermaid.

  It is also the package's ONE chart renderer. `./chart/report`'s `drawTask` was a second implementation of the same drawing, written in parallel against the same Mermaid grammar while this options bag was being added, and the two had diverged before they were folded together: a guarded edge's then-arm was drawn bare here (reading as unconditional beside its `[!guard]` sibling) and labelled there, the highlight had two spellings, and only one side sanitized its ids. `drawTask` is now a translation of `{ current, walked }` onto these options and nothing else, so a report's diagram and a chart's diagram cannot drift again. A guarded then-arm now carries its guard in **both** drawings, and the report's classes are the renderer's own — `teaActive` / `teaTripped` / `teaShipped`.

- 3066c6e: **`from` on an event — where its Msg comes from.** A chart says `WIP: "build"`, an edge from an event to a target; it never said where the event comes from. In TEA a Msg has exactly three origins — a Cmd's result, a Sub firing, the outside world — so `from: "cmd" | "sub" | { world: <role> }` declares which, once, on the event that owns the fact. The taxonomy is closed and the **cast is open**: the world origin carries a role name you choose, so an operator, a shopper, an on-call rota and a webhook are all expressible and none is enumerated by the library. `OriginAt`, `CmdEvent`, `SubEvent`, `WorldEvent` and `WorldRole` derive off it; `describeChart` returns it per event and `EventPreview` carries it to the button row (a refused event has a sender too). Optional throughout — a chart that declares no `from` derives `never` everywhere and behaves exactly as it did — and it composes with `scope`, `data` and `foreign` without touching any of them. A second field inside `{ world }` is a compile error naming the offender (probe 50).
- 3066c6e: **`@demlik/tea/chart/lane` + `/chart/report`** — the nets under a typed lane, and
  the one thing a run and a report of that run must never do.

  The module's stated contract is that a run and a report of that run cannot
  drift. Three ways they could are closed here, plus the type-layer gate the lane
  had been missing and the diagnostics that named the wrong thing.

  **A run and a fold now refuse the same pairs.** tea's runtime has always had
  three answers to `(state, event)` — routed, refused, unreplayable — and the
  lowered chart could carry two. So an event a state accepts and drops (its
  `ignore` names it, or it is broadcast to another phase) made `runLane` self-loop
  and `foldLane` throw `UnreplayableLogError`: a report calling a run unreplayable
  when the run had replayed it, on the shape of our own shipped lane fixture. The
  refusal set is now computed once at lowering and carried as
  `ImportedChart.refusals` — on the chart rather than on the node, because
  `ImportedNode` is a mirror of what fabrika's own compiler emits and the golden
  test compares the two. **It is a no-op at the imported door by construction**: a
  `workflow.json`'s events are `scope: "edges"` and its states carry no `ignore`,
  so nothing there can produce a refusal, lowering an imported chart is still the
  identity, and an imported log naming an unrouted event is refused exactly as
  before.

  **A guarded edge a lane cannot fold is refused at the door.** The fold walks
  every guarded edge with one inline predicate, `retries < maxRetries`, because
  that is the only guard a `workflow.json` can mean — the two-arm array IS the
  retry guard. Applied unstated to a `defineChart` literal it invents an answer: a
  chart guarded on `amount < 100`, driven with `amount: 5000`, RAN to `declined`
  and FOLDED to `captured`, so the report called a tripped run complete and
  printed a `retries: 1/2` on a chart with no retry concept. Carrying the real
  predicate is not available — a guard's BODY lives in `Parts`, which `defineLane`
  never sees — so a region whose `ctx` does not carry the budget the fold reads is
  now refused by `__laneRegionGuardsOnSomethingOtherThanTheRetryBudget`.

  **A numeric task id is a task id.** fabrika's task ids are GitHub issue numbers,
  so `defineLane({ phases: [{ tasks: { 5729: coder } }] })` is the obvious
  spelling, and `Extract<keyof …, string>` annihilated it: `LaneTaskId`, `LaneMsg`
  and `LaneHands` all read back `never`, zero hands were demanded and the CORRECT
  hand was rejected. Every alphabet now normalises a key the way the log, the
  `${task}.${event}` wire key and `Object.entries` already spell one.

  **The lane has its own literal-alphabet gate**, mirroring `graph.ts`'s. A
  computed phase or task key, or a `terminals` object hoisted without `as const`,
  degraded the lane's alphabets to `string` — no hand required, any invented task
  id accepted, `__laneHandNamesAnUnknownTask` dead — and with two phases it
  accused the author of `__taskDeclaredInTwoPhases` for a task declared exactly
  once. The gate is ordered ahead of the duplicate check so the accusation is
  true, and its markers name the fix (`…MustBeLiteralsAddAsConst`).

  **Also refused at the `defineLane` door**, each with a probe: a region marking
  two states `initial: true` (zero was caught and two was not — and two SPLIT, the
  shape reading the last and the fold the first); a region that never went through
  `defineChart`, so `Strict`/`Total` never ran and a typo'd target parked the task
  in a state that does not exist; and a dot in a task id or an event name, which
  re-partitions the `${task}.${event}` key space so one task's event becomes
  unreachable and a message addressed to `a` moves `a.b`.

  **Diagnostics.** The no-cell defect names the task (useless on a twelve-task
  lane otherwise). Every unknown task in a log is collected, not just the first,
  as `parseEventsJsonl` already did. `laneShape` reads the FIRST `initial: true`,
  which is the one `initialOf` and the fold take.

  **Export surface.** `chart/lane`'s `PhaseStanding` is renamed **`PhaseAtRest`**
  and is now `Exclude<PhaseStanding, "active">` over `chart/report`'s — the two
  entry points exported different types under one name, so which one a reader got
  depended on which module they imported. `ImportedChart` gains optional
  `refusals`; `WorkflowImportOptions` gains optional `strictFrom`, which refuses a
  `from` key naming no event the document routes (opt-in, because a consumer's
  cast legitimately spans several templates) — the cross-check `eventAlphabet` was
  written for and nothing was calling.

- 3066c6e: **`@demlik/tea/chart/lane` (experimental)** — a lane, as a describable
  structure: N chart instances running in parallel, grouped into phases that
  sequence.

  `./chart` describes one machine. A lane is not one machine — it has phases that
  run in order, each holding N task regions running concurrently, a phase
  completes when every region in it reaches a final, and the whole thing ends
  `complete` or `tripped` (tripped when any region landed on an `end: "error"`
  final). Its state is compound: `{ phase1: { issue_5729: "build" }, phase2:
"waiting" }`.

  - `defineLane` — the authoring door. The nesting is the structure; the phase
    order, each phase's task set, and which finals are success vs error are all
    derived. Four authoring mistakes are compile errors that name the offender.
  - `laneShape` — read the same facts off any lane, authored or imported.
  - `inspectLane` — the headless view a UI needs: the active phase, each task's
    state, what it is waiting on, what is stuck, and — per task — the existing
    per-chart legal-events / refusals inspection.

  **`@demlik/tea/chart/report`** grows the multi-phase half: `phaseStandings` and
  `trippedTasks` are exported, and `laneReport` draws a multi-phase lane honestly
  — diagrams for the active phase, one line each for phases already finished and
  phases not yet started, with tripped regions marked distinctly from complete
  ones.

  **`@demlik/tea/chart/inspect`** — bug fix. `describeChart` read `node.end ===
true`, so a state declared `end: "error"` was described as a non-final: it
  re-acquired the totality obligation, and a live event over it came back
  `undeclared` rather than refused. Both polarities now read as final, and
  `ChartStateInfo` carries `endPolarity` (`false | true | "error"`) beside `end`.

- 3066c6e: **`@demlik/tea/chart/lane` — `runLane`'s doors are checked, and its cmd tag
  moved.** The runtime drove one lane correctly; what it did with the inputs a
  host actually hands it — a persisted state from an older build, a boot that
  disagrees with the lane, a task id with a dot in it — was undefined.

  **Breaking, one shape.** A region's cmd leaves the lane tagged
  `{ lane: { task } }` instead of a flat `task`, so a chart whose cmd payload
  declares its own `task` field keeps its value:

  ```diff
  - interpret: { "issue_5729.spawn_shell": async (cmd) => spawn(cmd.task) }
  + interpret: { "issue_5729.spawn_shell": async (cmd) => spawn(cmd.lane.task) }
  ```

  The flat tag was spread OVER the payload, and `task` is an entirely ordinary
  field for a cmd in a work lane to carry: the author's value was replaced by the
  lane's task id, and the tag narrowed the author's field to that literal, so
  there was no type error either. `lane` is now the one key a region's cmd may not
  declare, and a chart that declares it is a compile error naming the task
  (`__laneRegionCmdDeclaresTheReservedLaneField`). `cmd.type` is unchanged.

  - **One retry budget, not two.** `defineLane({ retries })` lands in
    `lane.context[task].maxRetries` and that is the number `foldLane` replays
    with. `runLane`'s budget used to come only from `boot()`, and nothing
    cross-checked them: booting `maxRetries: 0` under a lane that declares the
    default 2 froze the run where the report of that same log said it retried.
    A `boot()` — or a rehydrated leaf — carrying a budget the lane does not
    declare is now refused, naming the task and both numbers.
  - **Rehydration is validated.** `init(loaded)` is the branch every production
    restart walks; it used to return its argument unread. A persisted state is now
    checked against the lane on the way in — every task present, no task the lane
    does not run, each leaf's `type` a state of that task's chart, and its `was` a
    state too — instead of failing later as a reducer throw inside the host's
    dispatch loop. The leaves are still returned verbatim; the lane's own standing
    is re-derived, since it is a fact derived from those leaves.
  - **`was` is checked at boot, and no longer rewritten on a resume.** The typed
    door refuses a bad `was` in `StateOf`; the imported door had no net at all.
    And a resume now carries `was` through unchanged, which is `stepTask`'s rule —
    the compiled cell re-injects `was` for any landing in a parking state, so with
    two mutually reachable parking states the run and the fold walked the next
    resume to two different STATES. fabrika has one parking state; `runLane` is a
    library.
  - **Dots are refused.** Task `a` + event `b.GO` and task `a.b` + event `GO` both
    register the dispatch key `a.b.GO` — last writer wins and one task's event is
    unreachable for the life of the process — and a dotted task id writes a log
    the replayer re-partitions into a task that does not exist. `runLane` throws,
    naming both. (`Total<C>` already banned the dot in a state name and in a
    foreign event name, for the same reason.)
  - **A task in `phases` with no chart is a defect, not a skip.** It used to get
    no dispatch keys and no boot check — the one input where `runLane`'s closing
    cast asserted something untrue.

  `phases` do not gate dispatch and the module header now says so: a message
  addressed to a phase-2 task moves that region while phase 1 is active, exactly
  as `foldLane` folds the whole log. Phases sequence the lane's STANDING; they are
  not admission control.

- 3066c6e: Add `./chart/lane/react` and `./chart/lane/styles.css` (**experimental**): a real fabrika lane, looked at in a browser rather than only as markdown.

  `<ChartInspector>` takes a live machine — a chart plus the code bodies — and runs it. A fabrika lane is the opposite shape: already-run history, no code bodies anywhere, imported at runtime from a `workflow.json`. So the one thing a real consumer most wants to look at could reach only one of this module's surfaces. Now it reaches both.

  **Two sources, one presentation.** `<LaneView lane log>` is the replay case — the two files a fabrika lane IS, and its scrubber folds a prefix of the real log, which is not an approximation of the state at step k but the definition of it. `<LiveLaneView lane hands>` is a lane running under `runLane`, whose leaves come off the runtime rather than off a fold (a lane boots each region where its sub-issue actually is, so a fold from every chart's `initial: true` would draw a different lane than the one running). Same component underneath, same panels, and neither branches on which source it has.

  **What the source decides is what is OFFERED, and an unavailable control is visibly unavailable with the reason** — never silently absent, which is the rule the refusal rendering has always followed. In replay every control carries an `Unanswerable<"dispatch">` reading _the code bodies that would run an edge do not exist here_; live, they dispatch `${task}.${event}`, the addressed form `compile(chart, parts, taskId)` already keys the table by. The same discipline covers the questions one source cannot answer at all: a recorded tape carries the ORDER of its msgs and no wall-clock, so the timeline's `at` column is an `Unanswerable<"clock">` with the reason rather than a column of invented times, and a region whose state keeps no `retries` gets an `Unanswerable<"retries">` rather than a confident `0/2`.

  **The lane's own structure is the page.** Phases in order with their standings, N task chips per phase, the lane terminal — and _which of twelve things is stuck_ FIRST, because for a real epic that is the first question and a page that answers it fourth answers it too late. Three kinds of stuck, and the third is the one worth having: a task whose retry budget is spent can still move, and the next `FAIL` is the error final rather than a retry.

  **`report.ts`'s editorial rules are applied, not relearned.** A real emitted phase holds eight tasks and six sit untouched at their entry state; a wall of near-identical diagrams is exactly as useless in a browser as in a PR comment. So the active phase expands only the tasks that MOVED (a tripped phase expands the tasks that tripped it), and the rest collapse. The one concession the medium earns is that a collapsed task keeps its whole panel — waiting-on, controls, picture — behind a disclosure instead of losing it, so on a live lane a collapsed region is still dispatchable one click away.

  **The headless half ships too**, on the existing `./chart/lane` subpath: `replayFeed` / `liveFeed` build a `LaneFeed`, and `laneView(feed, cursor)` is the whole lane at one moment as a value a script or a TUI can read with no DOM. `inspectLaneStates` is `inspectLane` from the leaves rather than from a log — the door a running lane comes through — and `walkedEdgeKey` is now one declaration site for "which edge did this step draw", so a folded timeline and a live tape thicken the same edges.

  Tested against the real fabrika artifacts (`workflow.json`, `events.jsonl`, and `lane status`/`lane history` stdout for three lanes driven by the actual binary, including a four-phase epic), with a real `react-dom/client` root under happy-dom. The strongest assertion folds the epic's log and compares all eight of its phase-2 leaves against `fabrika lane status`'s own stdout, which the page never saw.

  No new dependency: the diagram is emitted as `<pre class="mermaid">` for a host renderer, exactly as the chart inspector does, and the stylesheet is standalone (this page renders no devtools component) with the same prefixed-class, consumer-token contract.

- 3066c6e: Add `./chart/report` (**experimental**): import a `kamp-us/phoenix` fabrika
  `workflow.json` into charts, and render a running lane as one markdown block.

  `chartFromWorkflow(document)` mirrors fabrika's own lane compiler structurally
  rather than by name — an `on` string becomes `{ target }`, a two-arm array
  becomes `{ target, when, otherwise }`, a transition targeting a `type: "history"`
  node becomes `{ resume: { fallback } }`, the `hist` node itself is dropped
  (history is an edge property in a chart, not a state), a `type: "final"` becomes
  `end: true`, and a final reached as a guarded array's fallthrough becomes
  `end: "error"`. It refuses a document that does not fit with every defect named,
  never a half-import. The imported charts are runtime-typed (`string` states and
  events); the compile-time guarantees still come from a chart written as a
  literal, and the two are held together by a golden test that asserts the
  importer's edge set against what fabrika's own compiler produces for the two
  committed templates.

  `laneReport({ workflow, entries, status })` returns markdown that works
  unchanged in a terminal, a PR comment and an issue comment: one mermaid block
  per task **in the active phase only** with the current node lit and the walked
  edges marked, one line per future phase, a "where it is" line off `stateValue`,
  a "waiting on" line in fabrika's own vocabulary (the operator's `WIP`, the
  spawned shell, a human's `UNBLOCKED` — and no guess at all for a state nothing
  routes), a retry line when the budget has been spent, and a timeline table whose
  `from → to` is recomputed by prefix-folding, because `lane history` deliberately
  does not store it.

  Two input paths, both supported and asserted to produce identical output:
  `laneFromFiles(workflowJson, eventsJsonl)` off disk, and
  `laneFromCli(workflowJson, statusStdout, historyStdout)` off `fabrika lane
status` / `fabrika lane history`. The second means a standalone inspector can
  shell out to `fabrika` and needs **zero** phoenix changes.

  **`./chart`: `end` widens from `true` to `true | "error"`.** `true` still means
  a success final, so every existing chart is unchanged and this is additive.
  `"error"` declares the failure terminal — the state a guarded edge falls through
  to when its guard is spent — which is the distinction a driver trips a whole run
  off and which a chart previously could not express. Finality itself is blind to
  the polarity: an error final owes no pairs and may declare no edges, exactly as
  a success final does. Three new derivations read it: `EndPolarity<C, S>`,
  `SuccessFinal<C>` and `ErrorFinal<C>`.

  **"Waiting on" is derived, and the importer takes provenance at the boundary.** `waitingOn` used to decide what a lane was waiting on by matching hard-coded state names — `queued`, `build`, `review`, `ship`, `blocked`, `human:*` — copied out of fabrika's `wire/lane-brief.ts`. Those names are fabrika's, so an upstream rename turned the report into a confident liar with nothing failing anywhere. The answer is now the events the state routes, grouped by the `from` each declares, and `./chart/report` holds no state name, no event name and no job title.

  `workflow.json` records topology and has never recorded who sends what, so `chartFromWorkflow(document, { from })` — mirrored on `chartFromWorkflowText`, `laneFromFiles` and `laneFromCli` — takes that map **once, at the import boundary**, and everything downstream derives from it. Omit it and every reader degrades honestly: it names the events a state accepts and refuses to say who sends them, the same refusal an unrouted state used to get. A partial map is not rounded up to a whole one.

  **Breaking:** `SHELL_STATES` and `ShellState` are gone. They were a copy of another repo's vocabulary and there is nothing to replace them with — the fact they encoded now lives on the event. New: `WorkflowImportOptions` and `originOf`.

  **The importer is driven by the document's grammar, not its vocabulary.** `chartFromWorkflow` used to enumerate one consumer's six event names (`WIP`, `DONE`, `BLOCKED`, `PASS`, `FAIL`, `UNBLOCKED`) and refuse any document that used a seventh — so a consumer adding an event took the importer offline for every document, not just theirs. An event name a document declares is now, by definition, an event of that document. Every genuinely structural refusal is unchanged: a guarded arm that is not a two-arm array, a transition targeting an unknown state, a machine-level state that is neither a `parallel` phase nor a `final`, a final no `onDone` pair targets, a non-string `trigger`, text that is not JSON — all still refused, still with **every** defect named. Two grammatical rules about names replace the vocabulary check: a spelling that strips to nothing once its namespace is removed (`"ISSUE."`), and one state spelling one event twice (`"ISSUE.WIP"` and `"WIP"` in the same `on`), which used to be a silent overwrite.

  **Breaking:** `OPERATOR_EVENTS`, `OperatorEvent` and `isOperatorEvent` are gone — one more copy of another repo's vocabulary. New: `eventAlphabet(lane)`, which answers the same question by deriving it from the document.

  A guarded arm the document leaves unlabelled now carries `when: "retries remain"` — a description of what the two-arm array already means — rather than defaulting to one consumer's guard name (`retriesRemaining`). A labelled arm still carries the author's own word, verbatim and undereferenced.

- 3066c6e: **`@demlik/tea/chart/lane`** — a lane can now be **run**. `runLane(lane, hands)`
  returns the `init` and `update` a `Machine` is made of, and `defineMachine`
  takes them with no cast.

  ```ts
  const machine = defineMachine<
    LaneRunState<typeof epic>,
    LaneRunMsg<typeof epic>,
    LaneCmd<typeof epic>,
    Sub<never>,
    Record<never, never>
  >({
    ...runLane(epic, {
      issue_5729: {
        parts,
        boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }),
      },
      // already merged on GitHub — this instance boots where it IS.
      issue_5730: {
        parts,
        boot: () => ({ type: "shipped", retries: 0, maxRetries: 2 }),
      },
    }),
    interpret: {
      "issue_5729.spawn_shell": async (cmd) => spawn(cmd.task) /* … */,
    },
  });
  ```

  - **Routing** reuses the namespacing that was already there. `compile(chart,
parts, ns)` keys a table `${ns}.${event}`; the lane's `ns` is the task id, so
    `{ task, event }` is `${task}.${event}` on the wire and a message reaches that
    task's region and no other. The event stays narrowed to the events **that
    task's** chart declares.
  - **Per-instance boot.** `boot()` says where THIS instance starts, typed to that
    task's own `StateOf<chart>` — an emitted epic boots each child `queued`,
    `landed` or `frozen` depending on its sub-issue, and `initial: true` becomes
    the default rather than the law. The lane's own standing is derived at boot
    too, so a lane whose children all landed before the run started boots straight
    into `complete` or `tripped`.
  - **Phase advancement is the fold's, not a copy of it.** The runtime calls
    `phaseStandings` and the newly-named `laneTerminalReached` — `foldLane`'s own
    functions — so a run and a report of that run cannot drift. `equiv-lane-run
.test.ts` drives one lane through the runtime and through the fold over the
    equivalent event log and diffs every region's state plus the whole derived
    `deriveLaneStatus` output at every step, over two walks that between them
    cover every declared arm of the region chart.
  - **Cmds** leave the lane tagged with the task that emitted them, under the same
    namespace the replies come back in: `issue_5729.spawn_shell`, carrying
    `task: "issue_5729"`.

  New exports: `runLane`, `LaneRuntime`, `LaneRunState`, `LaneRegions`,
  `LaneRunMsg`, `LaneCmd`, `LaneHand`, `LaneHands`, `LaneHandsOf`,
  `LaneRunChecks`; and from `@demlik/tea/chart/report`, `laneTerminalReached` plus
  the `LeafStates` the phase walk now takes (`TaskState` still satisfies it — the
  widening is what lets the runtime call the same function over its own region
  states).

  Three more authoring mistakes are compile errors naming the offender: a hand for
  a task the lane does not declare, an instance booted into a state its own chart
  never declares, and a region whose chart declares a **foreign** event —
  `keyOf` leaves a foreign name bare under a namespace on purpose, and a bare
  event addresses no single region.

- 3066c6e: **`@demlik/tea/chart/lane`** — `defineLane` is now generic over its region
  charts, so a lane built from `defineChart` literals keeps their types.

  `phases` took an `ImportedChart` — `Chart<unknown>` by construction, because the
  imported door reads a `workflow.json` this repo has never compiled — so a lane
  assembled from typed charts erased every literal type the chart module exists to
  preserve, and authoring a typed lane needed a cast. It no longer does:

  ```ts
  const lane = defineLane({
    phases: { phase1: { issue_5729: coderChart, issue_5730: coderChart } },
    terminals: { complete: "complete", tripped: "tripped" },
  });

  const state: LaneState<typeof lane> = {
    phases: {
      phase1: { issue_5729: { type: "build", retries: 0, maxRetries: 2 } },
    },
    lane: "running",
  };
  const msg: LaneMsg<typeof lane> = { task: "issue_5729", event: "PASS" };
  ```

  - `LaneState<L>` — the compound state, per phase, per task, each leaf that
    task's **own** `StateOf<chart>`, narrowed; plus the phase standing and the
    lane's terminal.
  - `LaneMsg<L>` — `{ task, event }` with both narrowed, and the event narrowed to
    the events **that task's** chart declares, not to a union across the lane's
    charts.
  - `LanePhaseName`, `LaneTaskId`, `LaneTasksIn`, `LaneTaskChart`, `LanePhaseOf`,
    `LaneSiblings`, `LaneInitial`, `LaneSuccessFinals`, `LaneErrorFinals`,
    `LaneTerminal`, `PhaseStanding`, `LaneRegion`, `Lane` are exported alongside.

  Three new authoring mistakes are compile errors naming the offending task: a
  region that marks no `initial: true`, a region that declares no final in either
  polarity, and a region that hands a transition to a `{ to, cell }` (nothing in
  this subpath runs a cell). All three stand down at the imported door, where an
  imported chart's states are `string` and the question cannot be asked —
  `defineLane` still refuses those at runtime with `LaneShapeError`.

  **Two doors, one representation** is unchanged and now literal: `defineLane`
  lowers whichever chart it was handed to the single `ImportedChart`
  representation, so `foldLane`, `laneReport` and `inspectLane` take an authored
  lane and an imported one through the same code path. `chartFromWorkflow` is
  untouched and still reads back as `Chart<unknown>` — the same derivations, at a
  weaker instantiation.

### Patch Changes

- 3066c6e: **`@demlik/tea/chart/lane/react` (experimental)** — the lane page, read again by a person and fixed where it lied.

  Every item below was found by rendering a real lane in a browser and reading it, not by an assertion. Each now has one that fails without its fix.

  **A live lane no longer dispatches into the present while you are looking at the past.** The scrubber moves the view; the runtime stays where it is. So while the cursor was behind the tape, every control was still enabled, computed its outcome (`→ build`) from the state ON SCREEN, and dispatched into the state that was actually there — a click both mis-stated what it would do and gave no sign it had done it (the only feedback anywhere was `step 3 of 6` becoming `step 3 of 7`). Scrubbing now turns the controls off and says why, through the same "unavailable, with the reason" machinery a replay source has always used.

  **A lane that finished successfully draws its diagrams again.** Only an `active` or `tripped` phase expanded anything, so a lane that ended the way lanes are meant to end rendered zero diagrams — under its own paragraph promising one under every task. The phase a lane ENDED in now expands, by the same rule the active one uses.

  **Why nothing can be dispatched is a fact of the source, and is stated as one.** The sentence used to be scraped back off the first non-refused control; on a finished lane the chart refuses every control, so the page dropped its one explanation exactly where six dead buttons needed it. `LaneViewModel` now carries `noDispatch` and the feed declares it.

  **A refused message is drawn as a step, not as a walk.** A total chart answers everything, so a message nothing routes still lands and still gets a row — rendered `issue_1 DONE review → review` it was indistinguishable from a self-loop the chart declares. `LaneStepView.refused` marks it and the row says "refused, nothing moved".

  **The picture carries polarity.** An error final and a success final were both lit the same blue at the moment one of them was where a task died, while every other surface (chip, badge, stuck panel) said so in red. `stateDiagram-v2` has no per-edge styling, so the lit node wears a class of its own.

  **`"DONE" is not addressed to phase "working" (scope: edges)` is gone.** `scope: "edges"` means the event is live exactly where an edge declares it — it is not a phase name, so the phase test could never pass and the refusal named a phase that had nothing to do with it. `RefusalReason` gains a `no-edge` kind and the sentence is now `"queued" declares no "DONE" edge`. Since `edges` is the default scope, this was most refusals on most charts, and it was the densest jargon on a page that otherwise works hard to teach.

  **Sentences that were wrong when they were said.** A tripped lane is no longer badged `DONE` (that was `deriveLaneStatus`'s internal `done | active` printed raw, one span from the word `tripped`); "N tasks running together" is now the standing's own count, and never says "1 task running together"; a single-phase lane no longer opens "A lane is 1 phase that run in order"; a collapsed task reads "still at `review`" rather than "not started" beside a chip saying `= review`; and a task on an error final speaks of the trip in the tense it happened in.

  **The page reads with no stylesheet at all.** Separators between adjacent inline spans are in the markup, so a bare host gets `5674 · replay · tripped · stopped here` rather than `5674replaytrippeddone`. The stylesheet only makes them quiet.

  **A collapsed diagram is not rendered until it is opened.** All twelve `<pre class="mermaid">` of a twelve-task lane were in the DOM and every mermaid host rendered all twelve; keyed by their own text, one step of the scrubber remounted and re-rendered the lot. The fold now costs what it looks like it costs.

  **`chart/lane/styles.css` is one stylesheet again.** It had been written in two passes, the second re-declaring `.tea-lv`, `.tea-lv-head`, `.tea-lv-panel`, `.tea-lv-stuck`, `.tea-lv-mermaid` and `.tea-lv-steps` wholesale with `.tea-lv-btn` appearing five times — half the first pass was dead by cascade. One authoritative declaration per selector, theme-token fallbacks intact. The cascade had also inverted the page's affordances: the two clickable events rendered as plain text while the four disabled ones kept a dotted box. A button now looks like a button while it can be pressed.

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
