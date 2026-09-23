---
"@demlik/tea": minor
---

The Effect engine lands at `@demlik/tea/effect` (#283, `experimental` tier,
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
