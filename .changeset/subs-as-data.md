---
"@demlik/tea": minor
---

**Breaking:** a machine's Subs are data. The two Sub forms merge into one
(#251 R1.4, spike #252), and the code that opens a resource moves to `run`.

```ts
// before
const machine = defineMachine({
  types, init, update,
  subscriptions: (s) => (s.waiting ? [{ id: subId("retry"), type: "retry", delayMs: 500 }] : []),
  subscribe: { retry: fromTimeout(() => ({ type: "retry_due" })) },
});
run(machine, { interpret });

// after
const machine = defineMachine({
  types, init, update,
  subs: [
    { type: "timer", deps: (s) => (s.waiting ? { ms: 500, msg: { type: "retry_due" } } : null) },
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
  with what replaces it:
  - `.sub(key)` → `.depKeyed(when)`. Put the entry in `subs` and move the
    `if` that picked the key into `when(state)`, returning `null` for off.
  - `.subIdFor(key)` → `subIdOf(battery.type, key)`. The id is derived from
    the type and the key now.
  - `defineManagedResource`'s `.gated(when)` and `GatedManagedResource` →
    `.depKeyed(when)`. It takes the same `when` and gives a `subs` entry.
  - `combineManagedResources` and `CombinedManagedResources` → nothing to
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
