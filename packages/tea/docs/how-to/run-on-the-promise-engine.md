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
    await runtime.dispatch({ type: "look_up", id });
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
- **A hand-written Cmd's handler returns Msgs.** It returns one Msg, a list of
  Msgs, or nothing. The engine dispatches a list in order, like Elm's
  `Cmd.batch`.
- **The built-in `timer` needs no runner.** `run` only asks for `subscribe`
  when the machine declares a Sub type the engine does not ship.
- **`dispatch` resolves after the step settles.** Here that includes the
  `fetch_user` call, so `getState()` already reads `loaded` or `missing`.
- **`stop()`** drains the queue and stops every running Sub, the pending
  `timer` included.

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
