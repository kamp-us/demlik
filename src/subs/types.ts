// ---------------------------------------------------------------------------
// SubscribeHandler<S, M, Ctx> — the structural shape of a single entry in
// `Machine.subscribe`. Pulled out as a named type so factory return types
// in this subpath can match the substrate's expected `subscribe` cell shape
// without re-deriving it from `Machine`'s mapped type.
//
// A Sub factory in this subpath returns a `SubscribeHandler<S, M, Ctx>` —
// the same `(sub, ctx, dispatch) => cleanup` shape the substrate expects in
// `machine.subscribe[type]`. Callers assign the factory's return value
// directly to a subscribe cell:
//
//   subscribe: {
//     "audit-idle": fromPort(
//       (ctx) => ctx.auditRuntime,
//       auditIdlePort,
//       (idle) => ({ type: "audit:idle", idle }),
//     ),
//   }
//
// The factory absorbs the lifecycle (subscribe + cleanup); the caller keeps
// the intent (which port, which msg). Strengthens invariant 9 (the surface
// for cross-cutting Sub topologies is named, small, and exported from one
// subpath instead of redrawn at every call site).
// ---------------------------------------------------------------------------

import type { Sub } from "../index";

export type SubscribeHandler<S extends Sub, M, Ctx> = (
  sub: S,
  ctx: Ctx,
  dispatch: (msg: M) => void,
) => () => void;

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
