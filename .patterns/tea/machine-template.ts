/**
 * Canonical machine template. Copy this file and fill in the blanks.
 *
 * Read before writing: .patterns/tea/patterns/01-invariants.md
 *
 * Enforcement active:
 * - TypeScript: missing handlers are compile errors
 * - Biome: fetch/Date/crypto banned in reducer files (noRestrictedGlobals)
 * - GritQL: await/mutation/.push banned in reducer files
 * - Runtime (__DEV__): Object.freeze catches mutation, JSON.stringify catches closures
 */

import type { Sub, Subscribe } from "@demlik/tea";
import { Cmd, defineMachine, type Interpret, tryInterpret } from "@demlik/tea";

// ---------------------------------------------------------------------------
// 1. State — discriminated union. Each phase carries only its own data.
//    See: .patterns/tea/patterns/11-impossible-states.md
// ---------------------------------------------------------------------------
type State =
  | { _tag: "idle" }
  | { _tag: "loading" }
  | { _tag: "ready"; data: string }
  | { _tag: "error"; error: string };

// ---------------------------------------------------------------------------
// 2. Msg — one closed union. Every event that can move the machine.
//    Cmd results AND Sub events both land here. One union, one audit surface.
//    See: .patterns/tea/patterns/01-invariants.md (invariant 4)
// ---------------------------------------------------------------------------
type Msg =
  | { _tag: "fetch_requested" }
  | { _tag: "fetch_succeeded"; data: string }
  | { _tag: "fetch_failed"; error: string }
  | { _tag: "tick"; time: number }
  | { _tag: "visibility_changed"; visible: boolean };

// ---------------------------------------------------------------------------
// 3. Cmd — one-shot effects. Tagged data describing intent, never closures.
//    "Do this once, report back with a Msg."
//    See: .patterns/tea/patterns/04-effects-as-data.md
//    See: .patterns/tea/patterns/15-decisions.md (decision 1: Cmd vs Sub)
// ---------------------------------------------------------------------------
type Commands = { _tag: "fetch_data" };

// ---------------------------------------------------------------------------
// 4. Sub — ongoing subscriptions. Continuous sources of Msgs.
//    "Keep watching this, send me Msgs when something happens."
//    `Sub<type, deps>`: `deps` is the plain data its runner reads. The runtime
//    derives each running Sub's id from `{ _tag, deps }` — never hand-written.
//    The built-in `timer` needs no entry here.
//    See: .patterns/tea/patterns/04-effects-as-data.md (Sub section)
//    See: .patterns/tea/patterns/15-decisions.md (decision 4: sub gating)
// ---------------------------------------------------------------------------
type Subs =
  | Sub<"heartbeat", { readonly everyMs: number }>
  | Sub<"visibility", { readonly watch: "document" }>;

// ---------------------------------------------------------------------------
// 5. Ctx — injected dependencies (sibling runtime refs, config, etc.)
// ---------------------------------------------------------------------------
type Ctx = Record<string, never>;

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------
export const machine = defineMachine({
  // 0. Types — the slots no value in this object implies, named once. Model and
  //    Msg always; `cmd` / `sub` / `ctx` only when nothing else says them.
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as Commands,
    sub: {} as Subs,
    ctx: {} as Ctx,
  },

  // 6. Init — returns [state, cmds].
  //    See: .patterns/tea/patterns/15-decisions.md (decision 2: init shape)
  init: (loaded) => [loaded ?? { _tag: "idle" }, Cmd.none],

  // 7. Update — Reducer form: one handler per Msg type.
  //    Each cell is pure: no fetch, no await, no mutation.
  //    Return [nextState, cmds] — the pair is the architecture.
  //    See: .patterns/tea/patterns/03-signature.md
  update: {
    fetch_requested: () => [{ _tag: "loading" }, [{ _tag: "fetch_data" }]],

    fetch_succeeded: (_state, msg) => [{ _tag: "ready", data: msg.data }, Cmd.none],

    fetch_failed: (_state, msg) => [{ _tag: "error", error: msg.error }, Cmd.none],

    tick: (state) => [state, Cmd.none],

    visibility_changed: (state) => [state, Cmd.none],
  },

  // 9. Subs — declared as data: one `{ _tag, deps(state) }` entry per Sub.
  //    `deps` returns the slice of state the Sub depends on, or null for
  //    "off in this state". The runtime keys each running Sub on `{ _tag, deps }`:
  //      Same deps across transitions → keep running (no restart)
  //      Deps changed → stop the old one, start the new one
  //      Deps null → stop
  //
  //    Always-on: input streams that must not miss events (constant deps).
  //    Phase-gated: things that cost resources or are situational.
  //    See: .patterns/tea/patterns/15-decisions.md (decision 4)
  subs: [
    // Always-on: visibility matters in any phase
    { _tag: "visibility", deps: () => ({ watch: "document" }) },
    // Phase-gated: only tick when ready (costs a timer)
    {
      _tag: "heartbeat",
      deps: (state) => (state._tag === "ready" ? { everyMs: 30_000 } : null),
    },
    // Built-in `timer`: dispatch `msg` once, `ms` after it starts. Every
    // engine ships its runner, so there is none to write below.
    {
      _tag: "timer",
      deps: (state) =>
        state._tag === "loading"
          ? { ms: 10_000, msg: { _tag: "fetch_failed", error: "timeout" } }
          : null,
    },
  ],
});

// ---------------------------------------------------------------------------
// Handlers — code, so they sit beside the machine, never on it. `run` takes
// them: `run(machine, { ctx, interpret, subscribe })`.
// ---------------------------------------------------------------------------
// 8. Interpret — one handler per Cmd type. This is where I/O lives.
//    Use tryInterpret for Railway-style error handling.
//    See: .patterns/tea/patterns/13-error-handling.md
export const interpret: Interpret<Msg, Commands, Ctx> = {
  fetch_data: tryInterpret(
    async () => {
      const res = await fetch("https://example.com/data");
      return res.text();
    },
    (data): Msg => ({ _tag: "fetch_succeeded", data }),
    (error): Msg => ({ _tag: "fetch_failed", error: String(error) }),
  ),
};

// 10. Subscribe — one runner per Sub type the machine declares (the built-in
//     `timer` excepted; an entry named `timer` here would replace it). A
//     runner reads its data off `sub.deps` and returns the cleanup the
//     runtime calls when the Sub stops.
//     See: .patterns/tea/patterns/14-ports-interop.md
export const subscribe: Subscribe<Msg, Subs, Ctx> = {
  heartbeat: (sub, _ctx, dispatch) => {
    const id = setInterval(() => dispatch({ _tag: "tick", time: Date.now() }), sub.deps.everyMs);
    return () => clearInterval(id);
  },

  visibility: (_sub, _ctx, dispatch) => {
    const handler = () =>
      dispatch({ _tag: "visibility_changed", visible: document.visibilityState === "visible" });
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
};
