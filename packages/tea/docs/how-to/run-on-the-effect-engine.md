# Run a machine on the Effect engine

To run a `@demlik/tea` machine with Effect handlers, Layers and interruption,
import `run` from `@demlik/tea/effect`. The machine file is the one the Promise
engine runs, unchanged: see
[Run a machine on the Promise engine](./run-on-the-promise-engine.md).

`@demlik/tea/effect` is `experimental` and targets Effect v4 (still a release
candidate). `effect` is an optional peer dependency, so install it yourself:

```sh
pnpm add effect
```

## 1. Write the machine once

This is the same file the Promise how-to uses. It imports only `@demlik/tea`.

```ts
import { Cmd, defineMachine } from "@demlik/tea";
import { z } from "zod";

/** Look a user up by id. The handler returns an outcome; the engine mints the Msg. */
export const fetchUser = Cmd.define("fetch_user", {
  input: z.object({ id: z.string() }),
  ok: z.object({ name: z.string() }),
  err: ["not_found"],
});

export interface ProfileState {
  readonly status: "idle" | "loading" | "loaded" | "missing";
  readonly name: string | null;
}

export type ProfileMsg =
  | { readonly type: "look_up"; readonly id: string }
  | { readonly type: "clear" };

export const profile = defineMachine({
  types: { model: {} as ProfileState, msg: {} as ProfileMsg },
  cmds: [fetchUser],
  init: (loaded) => [loaded ?? { status: "idle", name: null }, []],
  update: {
    look_up: (s, m) => [
      { ...s, status: "loading", name: null },
      [fetchUser({ id: m.id })],
    ],
    fetch_user_ok: (s, m) => [
      { ...s, status: "loaded", name: m.value.name },
      [],
    ],
    fetch_user_err: (s) => [{ ...s, status: "missing", name: null }, []],
    clear: (s) => [{ ...s, status: "idle", name: null }, []],
  },
  // A miss clears itself after two seconds. Both engines ship `timer`.
  subs: [
    {
      type: "timer",
      deps: (s) =>
        s.status === "missing" ? { ms: 2_000, msg: { type: "clear" } } : null,
    },
  ],
});
```

`Cmd.define` takes any Standard Schema. To use Effect Schema instead of zod,
pass each schema through `Schema.toStandardSchemaV1`.

## 2. Hand `run` Effect handlers

```ts
import { run } from "@demlik/tea/effect";
import { Context, Effect } from "effect";
import { profile } from "./profile-lookup";

/** Where names come from, as an Effect service. Provide it with a Layer. */
export class Directory extends Context.Service<
  Directory,
  { readonly nameOf: (id: string) => Effect.Effect<string | undefined> }
>()("Directory") {}

/** Boot the profile machine on the Effect engine. Needs a Scope and a Directory. */
export const runProfile = run(profile, {
  interpret: {
    fetch_user: (cmd) =>
      Effect.gen(function* () {
        const directory = yield* Directory;
        const name = yield* directory.nameOf(cmd.id);
        if (name === undefined) {
          return yield* Effect.fail({ _tag: "not_found" as const });
        }
        return { name };
      }),
  },
});

/** Look one user up and read the state it settles in. Closing the scope stops the run. */
export const lookUp = (id: string) =>
  Effect.gen(function* () {
    const handle = yield* runProfile;
    const runtime = yield* Effect.promise(() => handle.ready);
    yield* Effect.promise(() => runtime.dispatch({ type: "look_up", id }));
    return runtime.getState();
  }).pipe(Effect.scoped);
```

Then provide the service and run it:

```ts
const DirectoryLive = Layer.succeed(Directory, {
  nameOf: (id) => Effect.succeed(id === "u1" ? "Ada" : undefined),
});

const state = await Effect.runPromise(
  lookUp("u1").pipe(Effect.provide(DirectoryLive)),
);
// { status: "loaded", name: "Ada" }
```

What changes from the Promise engine:

- **A handler returns an `Effect`.** Its success becomes `fetch_user_ok` and a
  failure with a declared tag becomes `fetch_user_err`. A defect, or a failure
  with a tag the Cmd does not declare, goes to `onError` and dispatches no Msg.
  A hand-written Cmd's handler succeeds with one Msg, a list of Msgs, or
  nothing, as on the Promise engine; a list is dispatched in order.
- **Services come from your Layers.** `runProfile` needs `Directory` because
  its handler reads it, and the type says so. It does not compile as runnable
  until you provide it.
- **`run` needs a `Scope`.** Closing the scope stops the run. Every handler
  still in flight is interrupted, its finalizers run, and no Msg is dispatched
  after stop. Calling `stop()` on the handle does the same.
- **The handle is the Promise engine's handle.** `ready`, `dispatch`,
  `getState`, `subscribe` and `stop` read the same. Anything typed on
  `RunHandle` or `BootedRunHandle`, like `useRuntime` from `@demlik/tea/react`,
  takes it as it is.

The other options (`store`, `onError`, `clock`, `events`, `supervision`,
`terminal`, `telemetry`, `disposeTimeoutMs`) mean what they mean on the Promise
engine. A fenced store stays fenced.

## 3. Swap a runner in a test

A Sub runner returns a `Stream` of Msgs. A `subscribe` entry with a built-in's
name replaces it, so a test can fire the `timer` Msg at once:

```ts
run(profile, {
  interpret,
  subscribe: { timer: (sub) => Stream.make(sub.deps.msg) },
});
```

The built-in `timer` is `Effect.sleep` for `deps.ms`, then `deps.msg`.
