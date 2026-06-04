/**
 * @demlik/tea/react — React host adapter for `@demlik/tea`.
 *
 * The thinnest possible adapter that makes a tea machine consumable from a
 * React component. Three rules (PRD §"React adapter"):
 *
 *   1. The runtime is the source of truth, NOT React state. We subscribe via
 *      `useSyncExternalStore(runtime.subscribe, runtime.getState,
 *      runtime.getState)`. React renders are driven by runtime state changes;
 *      React never owns the state.
 *   2. The runtime is memoized per component-mount, not per render. The deps
 *      array is `[machine, opts.ctx, opts.store]` — IDENTITY, not value. See
 *      `README.md` for the ctx-identity footgun + fix.
 *   3. Concurrent React is the design target. `useSyncExternalStore` is the
 *      React-blessed primitive for tearing-free external state.
 *
 * Client-only in v1 — components that call `useMachine` MUST be `"use client"`.
 * Server Components consume data via Relay/RSC as today; tea machines own
 * client-side stateful flows. No RSC streaming, no server-side state
 * hydration. Crossing this boundary is a v2 concern.
 */

"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  type Cmd,
  type Machine,
  type Runtime,
  run,
  type Store,
  type Sub,
} from "../index";

/**
 * Options passed to `useMachine`. The shape is intentionally minimal — `ctx`
 * is required (every machine has one), `store` is optional (omit it for
 * volatile-state machines).
 *
 * **Identity matters.** The runtime is memoized on `[machine, opts.ctx,
 * opts.store]`. A new `ctx` reference rebuilds the runtime. Always `useMemo`
 * (or otherwise stabilize) the ctx at the call site. See README.
 */
export interface UseMachineOpts<S, Ctx> {
  ctx: Ctx;
  store?: Store<S>;
}

/**
 * Build and own a `Runtime<S, M>` for the lifetime of the component mount.
 *
 * - Builds via `useMemo(() => run(machine, opts), [machine, opts.ctx,
 *   opts.store])` — runtime is recreated when ANY of the three identities
 *   change.
 * - Subscribes via `useSyncExternalStore(runtime.subscribe, runtime.getState,
 *   runtime.getState)` — tearing-free under React 18 concurrent rendering.
 * - On unmount (or any dep change), `useEffect` cleanup calls
 *   `runtime.stop()` — drains the queue, runs every active sub cleanup,
 *   flushes state.
 *
 * Returns `[state, dispatch]` shaped like `useReducer`.
 */
export function useMachine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: UseMachineOpts<S, Ctx>,
): [S, (msg: M) => Promise<void>] {
  // Deps are literal: machine identity, ctx identity, store identity. NOT
  // `[opts]` (would rebuild every render — callers pass fresh objects).
  // We pass explicit fields to `run()` so the closure captures only the
  // deps in the array — keeps biome's `useExhaustiveDependencies` happy
  // without lying about what the memo actually depends on.
  const ctx = opts.ctx;
  const store = opts.store;
  const runtime = useMemo<Runtime<S, M>>(
    () => run(machine, { ctx, store }),
    [machine, ctx, store],
  );

  // Preliminary state computed sync from `machine.init(null, ctx)`. This is
  // the snapshot React sees BEFORE the runtime finishes booting (matters
  // only when `opts.store` is present — without a store, the substrate
  // already sets state synchronously inside `run()`). Once the runtime
  // boots, `runtime.getState()` returns the real (possibly loaded) state.
  //
  // We deliberately recompute on each render but cache by `[machine,
  // opts.ctx]` — `init` is pure by convention, so cost is negligible. The
  // cached snapshot is also identity-stable across rerenders when the deps
  // don't change, which `useSyncExternalStore` rewards (no spurious
  // re-renders).
  const preliminaryState = useMemo<S>(
    () => machine.init(null, ctx)[0],
    [machine, ctx],
  );

  // `getSnapshot` reads the runtime if it has booted, else falls back to
  // the preliminary state. The runtime's `getState` throws pre-boot when a
  // store is configured — we catch that and substitute the preliminary
  // value.
  const getSnapshot = (): S => {
    try {
      return runtime.getState();
    } catch {
      return preliminaryState;
    }
  };

  const state = useSyncExternalStore(
    runtime.subscribe,
    getSnapshot,
    getSnapshot,
  );
  useEffect(
    () => () => {
      // Fire-and-forget — `stop()` is async but `useEffect` cleanup is sync.
      // The runtime swallows in-flight rejections internally, so this never
      // rejects in practice; we still attach `.catch` for safety.
      runtime.stop().catch(() => {});
    },
    [runtime],
  );
  return [state, runtime.dispatch];
}

/**
 * Lower-level escape hatch: consume an externally-built `Runtime<S, M>`.
 *
 * Use this when the runtime is owned by something OTHER than the component —
 * a parent component, a test harness, a singleton. **The component does NOT
 * call `runtime.stop()` on unmount** — the caller owns the lifecycle.
 *
 * Primary use case in this repo: component tests. Build a runtime with
 * `@demlik/tea/mem` and pre-seed it via `replay`, then mount the component with
 * `useRuntime(testRuntime)` to render in any phase.
 *
 * Returns `[state, dispatch]` — same shape as `useMachine`.
 */
export function useRuntime<S, M extends { type: string }>(
  runtime: Runtime<S, M>,
): [S, (msg: M) => Promise<void>] {
  const state = useSyncExternalStore(
    runtime.subscribe,
    runtime.getState,
    runtime.getState,
  );
  return [state, runtime.dispatch];
}
