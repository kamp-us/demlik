// ---------------------------------------------------------------------------
// SubscribeHandler<S, M, Ctx> — the structural shape of one sub runner: one
// entry of the `subscribe` table handed to `run`. Pulled out as a named type
// so factory return types in this subpath can match the engine's `Subscribe`
// entry without re-deriving it from the mapped type.
//
// The machine declares a Sub as data in `subs`; a factory in this subpath
// returns the runner for that Sub's type, which the caller hands to `run`:
//
//   subs: [{ type: "audit-idle", deps: (s) => (s.watching ? {} : null) }],
//   // …
//   run(machine, {
//     subscribe: {
//       "audit-idle": fromPort(
//         (ctx) => ctx.auditRuntime,
//         auditIdlePort,
//         (idle) => ({ type: "audit:idle", idle }),
//       ),
//     },
//   });
//
// The factory absorbs the lifecycle (subscribe + cleanup); the caller keeps
// the intent (which port, which msg). A runner reads its data off `sub.deps`.
// Strengthens invariant 9 (the surface for cross-cutting Sub topologies is
// named, small, and exported from one subpath instead of redrawn at every
// call site).
// ---------------------------------------------------------------------------

import type { Dispose, Sub } from "../index";

export type SubscribeHandler<S extends Sub, M, Ctx> = (
  sub: S,
  ctx: Ctx,
  dispatch: (msg: M) => void,
) => Dispose;

// ---------------------------------------------------------------------------
// dispatchIfPresent — the null-drop dispatch idiom every Sub factory in this
// subpath (and the chrome/node factories) shares. A factory's callback maps a
// platform event to `M | null`; `null` is the explicit "drop this emission"
// signal — the event fired but the caller decided it isn't interesting given
// current state, so no dispatch is made and the listener stays armed. Hoisted
// here so the one drop-on-null rule lives once instead of re-inlined as
// `const msg = fn(...); if (msg !== null) dispatch(msg);` at every listener.
// ---------------------------------------------------------------------------

export function dispatchIfPresent<M>(
  dispatch: (msg: M) => void,
  msg: M | null,
): void {
  if (msg !== null) dispatch(msg);
}
