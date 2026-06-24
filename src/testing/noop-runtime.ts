// ---------------------------------------------------------------------------
// noopRuntime — a Runtime<S, M>-shaped value whose every method is inert.
//
// The motivating callsite: a machine's `ctx` requires a sibling Runtime<S,
// M> reference (e.g. the queue runtime in extension/lib/queue-machine
// reaches into an `auditRuntime: Runtime<...>` slot on its ctx so its
// interpret handlers can dispatch into the audit machine). When the test
// replays such a machine, `replay` never actually invokes `interpret`, so
// the runtime reference is never dereferenced — but the type system
// still requires a value of `Runtime<S, M>` shape at the ctx slot. Tests
// today work around this with a hand-rolled 12-line NOOP_AUDIT_RUNTIME
// const cast through `as unknown as Runtime<...>`.
//
// `noopRuntime<S, M>()` is that hand-roll, named once. It returns a real
// Runtime<S, M> value whose every method is a structurally-correct no-op:
//
//   - `dispatch`: resolves immediately, never advances state.
//   - `getState`: returns the optional `initialState` argument (or a
//     deliberate `undefined` cast as S — the function lies about its
//     return type when no initial state is provided; this is the trade-off
//     we accept for an ergonomic test substrate).
//   - `subscribe` / `observe` / `subscribePort`: register the listener,
//     return a no-op unsubscribe. The listener is never fired because the
//     state never changes.
//   - `emitPort`: no-op.
//   - `ready`: a Promise that resolves to the no-op runtime itself (the #45
//     `ready: Promise<Runtime<S, M>>` shape — already booted, nothing to wait
//     for).
//   - `stop`: resolved Promise<void>.
//
// Strengthens invariant 9 (the testing surface is named and small).
// ---------------------------------------------------------------------------

import type { Port, Runtime } from "../index";

/**
 * Construct an inert `Runtime<S, M>` value. Use at ctx sites that require
 * a Runtime reference but where the test never invokes `interpret` (so
 * the runtime is never dereferenced in practice).
 *
 * @param opts.initialState  Optional value returned by `getState()`. Omit
 *   when the test never calls `getState()` on the no-op runtime — most
 *   tests only need the type-level slot filled.
 */
export function noopRuntime<S, M extends { type: string }>(opts?: {
  initialState?: S;
}): Runtime<S, M> {
  const initialState = opts?.initialState;
  // Single source of truth for the "do-nothing" unsubscribe so multiple
  // subscribe call sites share the same function instance — purely cosmetic
  // (the function would be a no-op either way).
  const noopUnsubscribe = (): void => {};
  const runtime: Runtime<S, M> = {
    async dispatch(_msg: M): Promise<void> {
      // Resolves immediately. State never advances; listeners never fire.
      // Quiescent by default (#50), but the no-op has no follow-up chain to
      // drain, so single-step and run-to-quiescence collapse to the same no-op.
    },
    async dispatchOnce(_msg: M): Promise<void> {
      // Single-step sibling of `dispatch` (#50). Same no-op for the no-op
      // runtime — there is no tail to leave in flight.
    },
    async idle(): Promise<void> {
      // No tail to drain — the no-op runtime never enqueues a follow-up.
    },
    result(): S | undefined {
      // The no-op runtime never advances, so it is never terminal (#46).
      return undefined;
    },
    done(): Promise<S> {
      // Never terminal → the awaitable never settles, matching `run()` with no
      // `terminal` predicate. Returned as a never-resolving promise.
      return new Promise<S>(() => {});
    },
    getState(): S {
      // Lie if no initial state was provided. The caller's contract is
      // "you accept the lie because you know replay never invokes
      // interpret and therefore never reads this." When the caller DOES
      // pass an initialState the lie collapses to truth.
      return initialState as S;
    },
    subscribe(_listener: () => void): () => void {
      return noopUnsubscribe;
    },
    observe(_observer: (msg: M | null, state: S) => void): () => void {
      return noopUnsubscribe;
    },
    subscribePort<T>(
      _port: Port<T>,
      _listener: (value: T) => void,
    ): () => void {
      return noopUnsubscribe;
    },
    emitPort<T>(_port: Port<T>, _value: T): void {
      // No-op. No subscribers to fan out to; nothing to do.
    },
    // Assigned just below — `ready` must resolve to `runtime` itself, which
    // can't be referenced inside its own object literal.
    ready: undefined as unknown as Promise<Runtime<S, M>>,
    async stop(): Promise<void> {
      // Resolves immediately. No in-flight tail to drain, no subs to clean.
    },
  };
  // Already "booted" — `ready` hands back the same runtime synchronously.
  runtime.ready = Promise.resolve(runtime);
  return runtime;
}
