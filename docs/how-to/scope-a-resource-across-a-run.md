# Scope a resource across a run

To give a run a resource with a real lifetime — a database handle, a connection
pool, a temp directory — hand `run` a `provide({ … })` graph instead of a `ctx`
object. The graph is acquired at boot and released when the run ends, on every
ending: done, failed, or cancelled.

The resource never touches the journal. A `Cmd` is data and a provider is a
closure, so a Cmd could never carry one; what a Cmd declares is the `R`
(Requirements) channel — a *type*. `provide` is the host-side graph that
satisfies it.

## 1. Declare each dependency as a provider

`layer(acquire, release?)` is a provider with no dependencies. `value(v)` lifts
something already built — a config object, a clock — into the graph.

```ts
import { layer, provide, value } from "@demlik/tea";

const scoped = provide({
  config: value({ url: process.env.DATABASE_URL ?? "" }),
  db: layer(
    ["config"],
    ({ config }: { config: { url: string } }) => connect(config.url),
    (db) => db.close(),
  ),
});
```

The three-argument form is the one with dependencies: `["config"]` names the
siblings, and the annotation on `acquire`'s parameter is what types them. Both
`acquire` and `release` may be async — the graph awaits each.

## 2. Hand the graph to `run` in place of `ctx`

```ts
import { driveToDone, run } from "@demlik/tea";

const outcome = await driveToDone(
  run(machine, { ctx: scoped, store }),
  { type: "start" },
  (s) => s.phase === "done",
);
```

`ctx` accepts either shape, so this is the only line that changes when a
hand-built `ctx` grows a lifetime. Inside an interpret handler nothing changes at
all: `ctx.db` is the handle, typed exactly as before.

The order is fixed and worth knowing:

- **Acquire** runs at boot, in dependency order — `config` before `db` — and each
  provider is acquired **exactly once**, however many others depend on it.
- **Release** runs in **reverse** acquisition order, exactly once, when the run
  ends. `driveToDone` stops the runtime in a `finally`, so a done run, a `failed`
  run and a cancelled run all release. Driving the runtime yourself, `stop()` is
  the release point.
- A `release` that throws does not stop its siblings from running; it is reported
  to `run`'s `onError` sink under `phase: "provide"`, with the provider's key on
  `context.provider`.

## 3. Handle an acquire that fails

A database that will not connect is not a bug in your code, so it does not throw
out of `run`. It rejects `ready` with a typed `ProvideFailedError` naming the
provider — and by the time it does, every provider acquired before it has already
been released, in reverse.

```ts
import { ProvideFailedError, run } from "@demlik/tea";

const handle = run(machine, { ctx: scoped, store });
try {
  await handle.ready;
} catch (error) {
  if (error instanceof ProvideFailedError) {
    console.error(`could not stand up ${error.provider}`, error.cause);
  }
  throw error;
}
```

## 4. Replay is untouched

Replay is a fold over Msgs: it calls no interpret handler, so it calls no
`acquire`. A recorded run re-folds through `replay` with no database anywhere
near it, and the journal a `provide` run writes is byte-identical to the one the
same machine writes on a hand-built `ctx`.

```ts
import { replay } from "@demlik/tea";

const { state } = replay(machine, { ctx: fakeCtx, msgs: recorded });
```

## When to open the scope yourself

A host that assembles its own `ctx` — a Durable Object wiring storage into the
object it hands `run` — can open the graph directly instead:

```ts
const scope = await scoped.open();
try {
  await driveToDone(run(machine, { ctx: scope.ctx }), start, isDone);
} finally {
  await scope.release();
}
```

`scope.release()` is idempotent, so this is safe beside a `run` that already
released.
