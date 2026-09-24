# Migrate from 0.15 to the two-engine release

To move a 0.15 codebase onto the release that splits `@demlik/tea` into a
core and two engines, work through the sections below in order. Each one names
what was removed or reshaped and shows it before and after. The machine ends up
as plain data, and everything that runs it moves to `run`.

The short version:

- `run` lives in `@demlik/tea/promise` now.
- A machine has no `interpret`, no `subscribe` and no `subscriptions`. Handlers
  and Sub runners go to `run`.
- Subs are `{ type, deps }` data. `timer` is built in.
- A `Cmd.define`d handler returns an outcome, and the engine mints the Msg.
- There is no DI (`provide`, `layer`, `R`) and no battery layer (`mount*`,
  `with*`, `handlers(ports)`).

The release notes list every renamed type. This page covers the moves that
change how you write code.

## 1. Import `run` from `@demlik/tea/promise`

`run`, `driveToDone` and `DriveToDoneOptions` left the root. The root is the
neutral core and imports no engine.

```ts
// before
import { defineMachine, run } from "@demlik/tea";

// after
import { defineMachine } from "@demlik/tea";
import { run } from "@demlik/tea/promise";
```

To run on Effect instead, import `run` from `@demlik/tea/effect`. See
[Run a machine on the Effect engine](./run-on-the-effect-engine.md).

## 2. Move `interpret` from the machine to `run`

`Machine` has no `interpret` field. Passing one to `defineMachine` is a type
error.

```ts
// before
const machine = defineMachine({ types, init, update, interpret });
run(machine, { ctx });

// after
const machine = defineMachine({ types, init, update });
run(machine, { ctx, interpret });
```

`interpret` is required once the machine emits a Cmd. Code that carried a
machine and its handlers together (`createAgentHost`'s `buildMachine`,
`toMachine()`, `defineAgent(...).machine(input)`) now returns
`{ machine, interpret }`, and the `Wired` type names that pair.

## 3. Declare Subs as `{ type, deps }` data

Both 0.15 Sub forms are gone: `subscriptions(state)` plus a `subscribe` table
on the machine, and `subs: [{ deps, source }]`. A Sub is now a `type` and a
`deps(state)` function. `null` means off. The runner moves to `run`.

```ts
// before: the manual form
const machine = defineMachine({
  types, init, update,
  subscriptions: (s) => (s.live ? [{ id: subId("feed"), type: "feed", url: s.url }] : []),
  subscribe: { feed: openFeed },
});

// before: the dep-keyed form
const machine = defineMachine({
  types, init, update,
  subs: [{ deps: (s) => (s.live ? s.url : null), source: (s, dispatch) => openFeed(s.url, dispatch) }],
});

// after
type FeedSub = Sub<"feed", { readonly url: string }>;

const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, sub: {} as FeedSub },
  init, update,
  subs: [{ type: "feed", deps: (s) => (s.live ? { url: s.url } : null) }],
});
run(machine, {
  subscribe: { feed: (sub, ctx, dispatch) => openFeed(sub.deps.url, dispatch) },
});
```

A runner is `(sub, ctx, dispatch) => Dispose` and reads its data off
`sub.deps`. The Sub's id is a hash of `{ type, deps }`, so it starts when `deps`
turns non-null, restarts when `deps` changes, and stops on `null`. `deps` must
be plain data.

For a timeout, use the built-in `timer`. It needs no runner:

```ts
// before
subscriptions: (s) => (s.waiting ? [{ id: subId("retry"), type: "retry", delayMs: 500 }] : []),
subscribe: { retry: fromTimeout(() => ({ type: "retry_due" })) },

// after
subs: [
  { type: "timer", deps: (s) => (s.waiting ? { ms: 500, msg: { type: "retry_due" } } : null) },
],
```

A `subscribe.timer` entry replaces the built-in, which is how a test drives
time. Other moves in this area:

- `defineManagedResource(...).sub(key)` and `.gated(when)` become
  `.depKeyed(when)`: put the entry in `subs`, and return `null` from `when` for
  off. `.subIdFor(key)` becomes `subIdOf(battery.type, key)`.
  `combineManagedResources` is gone; list each resource's `.depKeyed(when)`
  and its `.subscribe` under its own `type`.
- `replay(...).depSubs` is gone. Read `replay(...).subs`.
- `SubIdCollisionError` is gone. Two Sub types can no longer share an id.

## 4. Return an outcome from a `Cmd.define`d handler

`settle` is gone, and so is building a `_ok` / `_err` Msg by hand. A handler
gets `ok` and `err` beside its ctx and returns what they build. The engine turns
that into `<cmd>_ok` or `<cmd>_err`.

```ts
// before
const machine = defineMachine({
  types, cmds: [fetchDoc], init, update,
  interpret: {
    fetch_doc: settle(fetchDoc, async (cmd, ctx) => {
      const res = await ctx.http.get(cmd.url);
      return res.status === 404 ? Result.err({ _tag: "not_found" }) : Result.ok(res.body);
    }),
  },
});

// after
run(machine, {
  ctx: { http },
  interpret: {
    fetch_doc: async (cmd, { http, ok, err }) => {
      const res = await http.get(cmd.url);
      return res.status === 404 ? err({ _tag: "not_found" }) : ok(res.body);
    },
  },
});
```

- **Return a failure, don't throw it.** A throw, an `err` with a tag the Cmd
  does not declare, or a handler returning any Msg reaches `onError` under the
  `"interpret"` phase. No `_err` Msg is dispatched.
- **A `Cmd.define`d handler returns no follow-up Msg.** Before, it could answer
  with another Msg of the machine. Now it returns an outcome or nothing, on
  both engines. Put the follow-up in the reducer's `<cmd>_ok` / `<cmd>_err`
  cell instead.
- **Plain Cmds don't change.** A hand-written Cmd's handler still returns a
  Msg or nothing.
- **`Cmd.define` takes any Standard Schema.** zod works as it is. Effect Schema
  goes through `Schema.toStandardSchemaV1`. The schema's `validate` must be
  synchronous.
- **zod and `better-result` are no longer dependencies.** Install zod yourself
  if you use it.

`tryApplyCell` and `tryFoldMsgs` return an `Outcome` instead of a
`better-result` `Result`:

```ts
// before
const r = tryApplyCell(machine, state, msg);
if (Result.isOk(r)) use(r.value);

// after
const r = tryApplyCell(machine, state, msg);
if (r._tag === "Ok") use(r.value);
```

## 5. Replace `provide` / `layer` and the `R` channel with a plain `ctx`

tea no longer does dependency injection (ADR 0020). `provide`, `layer`,
`value`, `dep` and the provider types are gone, and so are
`Cmd.requirements`, `RequirementsOf` and `RequiredCtx`. A Cmd type is
`Cmd<Type, Ok, E>`, with no `R`.

```ts
// before
const fetchDoc = Cmd.define("fetch_doc", {
  input, ok, err: ["not_found"],
  requirements: Cmd.requirements<{ http: Http }>(),
});
defineMachine({ types: { model, msg }, cmds: [fetchDoc], … });
run(machine, { ctx: provide({ http: layer(openHttp, closeHttp) }) });

// after
const fetchDoc = Cmd.define("fetch_doc", { input, ok, err: ["not_found"] });
defineMachine({ types: { model, msg, ctx: {} as { http: Http } }, cmds: [fetchDoc], … });
const http = await openHttp();
try {
  const runtime = await run(machine, { ctx: { http } }).ready;
  // …
} finally {
  await closeHttp(http);
}
```

You own the resource's lifetime. On the Effect engine, a handler reads services
from your Layers instead, and `run`'s type names the services it needs.

In `@demlik/tea/agent`, `tool()` no longer takes `requirements`. Annotate the
handler's ctx instead: `async (args, ctx: { kb: Kb }, { ok, fail }) => …`.

## 6. Hand-wire what `mountResilientCall` spread for you

The battery layer is gone (ADR 0022). `mountResilientCall` is removed. Wire the
knob's verbs into your own `update`, and write the run Cmd's handler yourself.

```ts
// before
const mounted = mountResilientCall(rc, {
  slice: "call",
  attempt: { on: "load", run: (call, m) => rc.attempt(call, m.id, m.id, m.at) },
  onOk,
  onErr,
});
const machine = defineMachine({
  types, init,
  update: { ...mounted.update },
  subscriptions: mounted.subscriptions,
  subscribe: mounted.subscribe,
  interpret: rc.handlers({ run: fetchUser }),
});

// after
const machine = defineMachine({
  types, cmds: [rc.run], init,
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

[Hand-wire a resilient call](./hand-wire-a-resilient-call.md) walks the whole
machine, `onSettle` included. The settle Msgs are the engine-minted
`resilient_run_ok` / `resilient_run_err`, so a knob named `jev` settles on
`jev_run_ok`, not `jev_ok`.

## 7. Replace `succeed` / `fail` on a resilient call with `settle`

`createResilientCall(...)` returns one `settle(slice, msg)` in place of
`succeed` and `fail`. It reads the key off the Msg and returns
`{ call, cmds, outcome }`.

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

// after
resilient_run_ok: (s, m) => onSettle(s, rc.settle(s.call, m)),
resilient_run_err: (s, m) => onSettle(s, rc.settle(s.call, m)),
```

`outcome` is `{ kind: "done", value }`, `{ kind: "failed", error }` or
`{ kind: "retrying" }`. The value is only reachable through it, so a settle cell
can't fold the result in while the call still reads `running`. The knob's
`subs(slice)` is now `deadlines(slice)`, and `timer(slice)` gives the built-in
`timer`'s deps.

## 8. Write the handler that `handlers(ports)` used to build

Every L2 helper drops `handlers(ports)` and ships its run Cmd as a
`Cmd.define`d def. You write that Cmd's handler in your engine's style. Here is
`token-refresh`, whose Cmd is `refresh_token`:

```ts
// before
run(machine, { interpret: { ...tr.handlers({ refresh: () => sdk.mintToken() }) } });

// after
run(machine, {
  interpret: {
    refresh_token: async (_cmd, { ok, err }) => {
      try {
        return ok(await sdk.mintToken());
      } catch (cause) {
        return err({ _tag: "token_refresh_failed", cause });
      }
    },
  },
});
```

The same move applies to `authed-call`, `paginated-walk`, `reconciler`,
`monitored-run`, `snapshot`, `classify-batch` and `jev`. Their settle Msgs are
the minted `<cmd>_ok` / `<cmd>_err`, and their verbs take that Msg. `fan-out`'s
`handlers(ports)` is renamed `completion(ports)`. The release notes list each
helper's new names.

## 9. Replace `withResilience`, `withDeadline` and `withTelemetry`

The three wrappers are gone. None of them wraps your Model any more.

`withResilience` becomes a hand-wired resilient call (section 6):

```ts
// before
const resilient = withResilience(machine, {
  target: "fetch_user",
  retry: { baseMs: 200, factor: 2, capMs: 5_000, maxAttempts: 3, jitter: "full" },
});
run(resilient, { ctx });

// after
const rc = createResilientCall<string, User>({
  retry: { baseMs: 200, factor: 2, capMs: 5_000, maxAttempts: 3, jitter: "full" },
});
// …wire `rc` into your update as in section 6.
```

`withDeadline` becomes a `timer` Sub in your own machine. Put a counter in
`deps` so every bit of progress re-arms it:

```ts
// before
const guarded = withDeadline(machine, { ms: 30_000, progress: (m) => m.type === "chunk" });

// after
subs: [
  {
    type: "timer",
    deps: (s) =>
      s.phase === "running" ? { ms: 30_000, msg: { type: "stalled", seq: s.seq } } : null,
  },
],
update: {
  chunk: (s, m) => [{ ...s, seq: s.seq + 1 /* …fold the chunk */ }, []],
  stalled: (s) => [{ ...s, phase: "timed_out" }, []],
},
```

`withTelemetry` becomes the `telemetry` option of `run`:

```ts
// before
const observed = withTelemetry(machine);
run(observed, { ctx: { telemetrySink: (e) => log(e) } });

// after
run(machine, { interpret, telemetry: (e) => log(e) });
```

The sink gets `{ seq, msgType, at }` after every applied transition, and `at`
comes from `run`'s `clock`.

## 10. Pass the engine's `run` to `useMachine` and `createAgentHost`

`@demlik/tea/react` and `@demlik/tea/do` import no engine. You hand them
`run`.

```ts
// before
useMachine(machine, { ctx });
createAgentHost({ buildMachine, store, ctx, toSseFrame });

// after
import { run } from "@demlik/tea/promise";

useMachine(machine, { run, ctx, interpret });
createAgentHost({ run, buildMachine, store, ctx, toSseFrame });
```

- `useMachine` rebuilds the runtime when `run`'s identity changes. Pass the
  engine's own function, not an inline wrapper.
- `buildMachine` returns `{ machine, interpret }` (section 2).
- `AgentHost.runtime()` resolves to a `BootedRunHandle`, so it has no
  `result()` / `done()` / `idle()`. Read the terminal State from
  `host.result()`.
- `useRuntime` takes any `BootedRunHandle`, and `bootResume` / `autoBoot` take
  any `RunHandle`.
