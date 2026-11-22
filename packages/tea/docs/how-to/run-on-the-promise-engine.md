# Run a machine on the Promise engine

To run a `@demlik/tea` machine with handlers that return Promises, import `run`
from `@demlik/tea/promise`. The machine file imports only `@demlik/tea`, so the
same file also runs on the Effect engine. See
[Run a machine on the Effect engine](./run-on-the-effect-engine.md) for that
side; it uses this exact machine.

## 1. Write the machine once

The machine is plain data: `init`, `update`, the Cmds it emits and the Subs it
wants. It names no engine and holds no handler.

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
  | { readonly _tag: "look_up"; readonly id: string }
  | { readonly _tag: "clear" };

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
      _tag: "timer",
      deps: (s) =>
        s.status === "missing" ? { ms: 2_000, msg: { _tag: "clear" } } : null,
    },
  ],
});
```

Listing `fetchUser` in `cmds` is what gives `update` its `fetch_user_ok` and
`fetch_user_err` cells. You don't add them to `ProfileMsg`.

## 2. Hand `run` the handlers

```ts
import { run } from "@demlik/tea/promise";
import { profile } from "./profile-lookup";

/** Where names come from. Swap in your real client. */
export interface Directory {
  readonly nameOf: (id: string) => Promise<string | undefined>;
}

/** Boot the profile machine on the Promise engine. */
export function runProfile(directory: Directory) {
  return run(profile, {
    interpret: {
      fetch_user: async (cmd, { ok, err }) => {
        const name = await directory.nameOf(cmd.id);
        return name === undefined ? err({ _tag: "not_found" }) : ok({ name });
      },
    },
  });
}

/** Look one user up and read the state it settles in. */
export async function lookUp(directory: Directory, id: string) {
  const runtime = await runProfile(directory).ready;
  try {
    await runtime.dispatch({ _tag: "look_up", id });
    return runtime.getState();
  } finally {
    await runtime.stop();
  }
}
```

What each piece does:

- **`interpret`** has one handler per Cmd. A `Cmd.define`d handler gets `ok`
  and `err` on its second argument and returns what they build. The engine
  turns `ok(...)` into `fetch_user_ok` and `err(...)` into `fetch_user_err`.
- **Return a failure, don't throw it.** `err` only takes a tag the Cmd
  declares. A throw, or an `err` with a tag the Cmd does not declare, goes to
  `onError` and dispatches no Msg.
- **`driveToDone` rejects with the throw that stalled it.** To run a machine
  to its terminal State in one call, hand `run`'s handle to `driveToDone` from
  this same import. A handler's throw on a later hop, or any throw of a
  `Cmd.define`d handler, has no caller to reject at, so it would go to
  `onError` and leave the drive with nothing to wait for. While the drive waits
  it holds that throw instead. If the drive then stalls, it rejects with the
  first held throw, the same object, in place of `DriveStalledError`, and every
  other held throw goes to `onError`. If the drive resolves anyway, because a
  Sub delivers the terminal Msg or an abort lands the cancelled State, every
  held throw goes to `onError` and the drive resolves as before. A throw that
  comes after the drive ended goes to `onError` too. A hand-written Cmd's throw
  on the first hop still rejects the drive at once. A failure that is not a
  handler's, such as a store that refuses a later save, still reaches `onError`
  and the drive stalls. A run you dispatch to yourself is unchanged.
- **A hand-written Cmd's handler returns Msgs.** It returns one Msg, a list of
  Msgs, or nothing. The engine dispatches a list in order, like Elm's
  `Cmd.batch`.
- **The built-in `timer` needs no runner.** `run` only asks for `subscribe`
  when the machine declares a Sub type the engine does not ship.
- **`dispatch` resolves after the step settles.** Here that includes the
  `fetch_user` call, so `getState()` already reads `loaded` or `missing`.
- **`stop()`** drains the queue, up to `disposeTimeoutMs` (5 seconds unless
  you set it), and stops every running Sub, the pending `timer` included. When
  a handler never returns, `stop()` gives up on it at that limit, reports a
  `DrainTimeoutNotice` to `onError`, then stops the Subs, runs the final save
  and returns. The handler is still running. What it returns later is dropped,
  and so are the Msgs queued behind it; the notice's `droppedMsgs` counts those
  per Msg type. No store call starts after `stop()`
  has returned, but a save or load already under way is not cancelled and can
  finish later. A [fenced store](./make-durable.md#4-refuse-a-second-writer-if-two-processes-can-reach-the-storage)
  refuses that late save, and so does `doEventSourcedStore` once a newer run has
  loaded its log. A custom plain store that waits before it writes takes it over
  what a newer run saved. Use one of the first two if you start a new run on the
  same store after a `stop()` that gave up.
- **`onError` hears what has no caller to reject at.** That is a failing Sub
  (`"sub"`), a failed final save (`"stop-save"`), or a Msg sent with `tell`, by a
  Sub, or by a Cmd that failed (`"follow-up"`). A reducer's thrown object reaches
  `onError` once, under `"reduce"`, and a Sub runner that throws as it starts
  once, under `"sub"`, on both engines. Primitive reducer throws
  still reach both `"reduce"` and `"follow-up"` for Msgs with no caller.
  With no `onError` the default sink warns about a discard and rethrows the rest,
  which ends the process along with every other
  run in it. A host running several machines in one process passes a sink. A
  fenced store must be given one, or it does not compile. A fenced store typed
  plain `Store<S>` with no sink compiles, and `run` throws at once.

## 3. Swap a runner in a test

A `subscribe` entry with a built-in's name replaces it. To skip the two-second
wait in a test, fire the `timer` Msg at once:

```ts
run(profile, {
  interpret,
  subscribe: {
    timer: (sub, _ctx, dispatch) => {
      dispatch(sub.deps.msg);
      return () => {};
    },
  },
});
```

The machine does not change. Only the runner does.
