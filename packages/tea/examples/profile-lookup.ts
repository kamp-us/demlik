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
