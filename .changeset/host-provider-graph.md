---
"@demlik/tea": minor
---

A resource can have a lifetime that spans a run. `provide({ … })` builds the
`ctx` object `run` already takes, from a graph of providers with `acquire` and
`release`, and `run` accepts it in place of the object:

```ts
const scoped = provide({
  config: value({ url: process.env.DATABASE_URL ?? "" }),
  db: layer(
    ["config"],
    ({ config }: { config: { url: string } }) => connect(config.url),
    (db) => db.close(),
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
