// ---------------------------------------------------------------------------
// fromPort — universal `Runtime.subscribePort`-shaped Sub factory.
//
// The canonical cross-runtime coordination pattern in @demlik/tea: one
// runtime emits to a typed Port; another runtime's machine declares an
// `audit-idle`-shaped Sub whose subscribe handler attaches to the
// publisher's Port. The recurring 4-line shape at every such cell:
//
//   "audit-idle": (_sub, ctx, dispatch) =>
//     ctx.auditRuntime.subscribePort(auditIdlePort, (value) => {
//       dispatch(buildMsg(value));
//     });
//
// The factory absorbs the cleanup-returning subscribePort call AND the
// dispatch-on-emit wiring. The caller keeps the three pieces of intent:
//
//   1. `selectRuntime(ctx)` — which sibling Runtime publishes the Port.
//      This is a selector (not a direct ctx.auditRuntime reference) so
//      the factory does NOT pin the ctx shape — any machine whose ctx
//      exposes some Runtime<...> reference is compatible by selecting it.
//      A direct `Runtime` parameter would have made the factory shape
//      depend on having that Runtime in scope at machine-definition
//      time, which is a worse match for the "ctx is the boundary"
//      contract this substrate already commits to.
//
//   2. `port: Port<T>` — the typed channel itself. Identity is by
//      reference (the substrate enforces unique names at definePort
//      time); pass the same `Port<T>` value the publisher emits to.
//
//   3. `msgFn(value, sub) => M | null` — the value-to-Msg mapping, with
//      drop-on-null semantics matching every other factory in this
//      subpath. The published value's type `T` flows through to `msgFn`'s
//      first param so the caller never re-asserts the payload shape.
//
// Strengthens invariant 9 (the cross-runtime Port topology is named at
// one factory site instead of redrawn at every subscribe cell).
// ---------------------------------------------------------------------------

import type { Port, Runtime, Sub } from "../index";
import type { SubscribeHandler } from "./types";

export function fromPort<S extends Sub, M, Ctx, T>(
  selectRuntime: (ctx: Ctx) => Runtime<unknown, { type: string }>,
  port: Port<T>,
  msgFn: (value: T, sub: S) => M | null,
): SubscribeHandler<S, M, Ctx> {
  return (sub, ctx, dispatch) => {
    const runtime = selectRuntime(ctx);
    return runtime.subscribePort(port, (value) => {
      const msg = msgFn(value, sub);
      if (msg !== null) dispatch(msg);
    });
  };
}
