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

import type { Sub } from "@demlik/tea";
import { Cmd, defineMachine, subId, tryInterpret } from "@demlik/tea";

// ---------------------------------------------------------------------------
// 1. State — discriminated union. Each phase carries only its own data.
//    See: .patterns/tea/patterns/11-impossible-states.md
// ---------------------------------------------------------------------------
type State =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "ready"; data: string }
  | { type: "error"; error: string };

// ---------------------------------------------------------------------------
// 2. Msg — one closed union. Every event that can move the machine.
//    Cmd results AND Sub events both land here. One union, one audit surface.
//    See: .patterns/tea/patterns/01-invariants.md (invariant 4)
// ---------------------------------------------------------------------------
type Msg =
  | { type: "fetch_requested" }
  | { type: "fetch_succeeded"; data: string }
  | { type: "fetch_failed"; error: string }
  | { type: "tick"; time: number }
  | { type: "visibility_changed"; visible: boolean };

// ---------------------------------------------------------------------------
// 3. Cmd — one-shot effects. Tagged data describing intent, never closures.
//    "Do this once, report back with a Msg."
//    See: .patterns/tea/patterns/04-effects-as-data.md
//    See: .patterns/tea/patterns/15-decisions.md (decision 1: Cmd vs Sub)
// ---------------------------------------------------------------------------
type Commands = { type: "fetch_data" };

// ---------------------------------------------------------------------------
// 4. Sub — ongoing subscriptions. Continuous sources of Msgs.
//    "Keep watching this, send me Msgs when something happens."
//    Each Sub needs a deterministic `id` so the runtime can diff lifecycle.
//    See: .patterns/tea/patterns/04-effects-as-data.md (Sub section)
//    See: .patterns/tea/patterns/15-decisions.md (decision 4: sub gating)
// ---------------------------------------------------------------------------
type Subs = { type: "heartbeat"; id: Sub["id"] } | { type: "visibility"; id: Sub["id"] };

// ---------------------------------------------------------------------------
// 5. Ctx — injected dependencies (sibling runtime refs, config, etc.)
// ---------------------------------------------------------------------------
type Ctx = Record<string, never>;

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------
export const machine = defineMachine<State, Msg, Commands, Subs, Ctx>({
  // 6. Init — returns [state, cmds].
  //    See: .patterns/tea/patterns/15-decisions.md (decision 2: init shape)
  init: (loaded) => [loaded ?? { type: "idle" }, Cmd.none],

  // 7. Update — Reducer form: one handler per Msg type.
  //    Each cell is pure: no fetch, no await, no mutation.
  //    Return [nextState, cmds] — the pair is the architecture.
  //    See: .patterns/tea/patterns/03-signature.md
  update: {
    fetch_requested: () => [{ type: "loading" }, [{ type: "fetch_data" }]],

    fetch_succeeded: (_state, msg) => [{ type: "ready", data: msg.data }, Cmd.none],

    fetch_failed: (_state, msg) => [{ type: "error", error: msg.error }, Cmd.none],

    tick: (state) => [state, Cmd.none],

    visibility_changed: (state) => [state, Cmd.none],
  },

  // 8. Interpret — one handler per Cmd type. This is where I/O lives.
  //    Use tryInterpret for Railway-style error handling.
  //    See: .patterns/tea/patterns/13-error-handling.md
  interpret: {
    fetch_data: tryInterpret(
      async () => {
        const res = await fetch("https://example.com/data");
        return res.text();
      },
      (data): Msg => ({ type: "fetch_succeeded", data }),
      (error): Msg => ({ type: "fetch_failed", error: String(error) }),
    ),
  },

  // 9. Subscriptions — declare active subs as a function of state.
  //    The runtime diffs old vs new by `id`:
  //      Same id across transitions → keep running (no restart)
  //      Id removed → cleanup (stop)
  //      New id → subscribe handler (start)
  //
  //    Always-on: input streams that must not miss events.
  //    Phase-gated: things that cost resources or are situational.
  //    See: .patterns/tea/patterns/15-decisions.md (decision 4)
  subscriptions: (state) => {
    const subs: Subs[] = [
      // Always-on: visibility matters in any phase
      { type: "visibility", id: subId("visibility") },
    ];

    // Phase-gated: only tick when ready (costs a timer)
    if (state.type === "ready") {
      subs.push({ type: "heartbeat", id: subId("heartbeat") });
    }

    return subs;
  },

  // 10. Subscribe — one handler per Sub type. Returns a cleanup function.
  //     Cleanup is called when the sub is removed from the active list.
  //     See: .patterns/tea/patterns/14-ports-interop.md
  subscribe: {
    heartbeat: (_sub, _ctx, dispatch) => {
      const id = setInterval(() => dispatch({ type: "tick", time: Date.now() }), 30_000);
      return () => clearInterval(id);
    },

    visibility: (_sub, _ctx, dispatch) => {
      const handler = () =>
        dispatch({ type: "visibility_changed", visible: document.visibilityState === "visible" });
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    },
  },
});
