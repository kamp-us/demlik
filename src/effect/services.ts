/**
 * @packageDocumentation
 * The two Context service keys tea injects into an Effect-authored interpret
 * cell: the `ctx` tea passes as argument 2, and the kernel-injected `dispatch`
 * it passes as argument 3.
 *
 * The keys are per-call VALUES rather than module-level singletons because
 * their Shape binds the application's own generics (`Ctx`, `Msg`). A module
 * singleton would have to pick one app's types and force every other app
 * through a cast.
 */

import { Context } from "effect";
import type { PortEmitter } from "../pure/core";

/**
 * Identity brand for the `TeaCtx` service. One brand across every
 * `teaServices()` call — the Shape varies per app, the slot does not.
 */
export interface TeaCtxId {
  readonly _: unique symbol;
}

/** Identity brand for the `TeaDispatch` service. */
export interface TeaDispatchId {
  readonly _: unique symbol;
}

/** The kernel-injected detached dispatch, as a service shape. */
export interface TeaDispatchShape<M> {
  readonly dispatch: (msg: M) => void;
}

/**
 * The environment every Effect-authored interpret cell may read: the tea `ctx`
 * and the kernel-injected `dispatch`. `toInterpret` is what discharges it.
 */
export type TeaEnv = TeaCtxId | TeaDispatchId;

/** The pair of keys `teaServices<M, Ctx>()` hands back. */
export interface TeaServices<M, Ctx> {
  readonly TeaCtx: Context.Key<TeaCtxId, Ctx & PortEmitter>;
  readonly TeaDispatch: Context.Key<TeaDispatchId, TeaDispatchShape<M>>;
}

/**
 * Build the `TeaCtx` / `TeaDispatch` keys bound to this app's `Msg` and `Ctx`.
 *
 * Call it ONCE per app and share the result — the string ids are the runtime
 * identity, so two calls produce interchangeable keys at runtime even though
 * their Shapes differ at the type level.
 *
 * @param namespace - runtime id prefix. Defaults to `"@demlik/tea"`.
 */
export function teaServices<M, Ctx>(
  namespace = "@demlik/tea",
): TeaServices<M, Ctx> {
  return {
    TeaCtx: Context.Service<TeaCtxId, Ctx & PortEmitter>(`${namespace}/TeaCtx`),
    TeaDispatch: Context.Service<TeaDispatchId, TeaDispatchShape<M>>(
      `${namespace}/TeaDispatch`,
    ),
  };
}
