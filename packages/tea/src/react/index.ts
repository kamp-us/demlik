/**
 * @packageDocumentation
 * @demlik/tea/react — React host adapter for `@demlik/tea`.
 *
 * The thinnest possible adapter that makes a tea machine consumable from a
 * React component. Three rules (PRD §"React adapter"):
 *
 *   1. The runtime is the source of truth, NOT React state. We subscribe via
 *      `useSyncExternalStore`, reading a snapshot of the run's state. React
 *      renders are driven by runtime state changes; React never owns the state.
 *   2. The runtime is kept per component-mount, not per render. It is keyed on
 *      `[machine, opts.run, opts.ctx, opts.store]` — IDENTITY, not value. See
 *      `docs/how-to/drive-from-react.md` for the ctx-identity footgun + fix.
 *   3. Concurrent React is the design target. `useSyncExternalStore` is the
 *      React-blessed primitive for tearing-free external state.
 *
 * Client-only in v1 — components that call `useMachine` MUST be `"use client"`.
 * Server Components consume data via Relay/RSC as today; tea machines own
 * client-side stateful flows. No RSC streaming, no server-side state
 * hydration. Crossing this boundary is a v2 concern.
 */

"use client";

import * as React from "react";
import {
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  BootedRunHandle,
  Cmd,
  Dispose,
  EngineRun,
  Interpret,
  Machine,
  RunHandlers,
  RunOptions,
  Store,
  Sub,
  Subscribe,
} from "../index";
import { builtinRunners } from "../internal/engine/builtin-runners";
import { MountedRun } from "./mounted-run";
import type { SubGate } from "./sub-gate";

// A stable `<Activity>` arrived in React 19.2. That is the first React where a
// passive cleanup can be a hide, and the first to run an insertion cleanup in a
// deleted hidden tree. `MountedRun` says why it needs to know.
const cleanupMayBeAHide = "Activity" in React;

/**
 * Options passed to `useMachine`. `run` is the engine's `run` — `run` from
 * `@demlik/tea/promise`, or any engine's; the hook imports no engine. `ctx`
 * is required (every machine has one), `store` is optional (omit it for
 * volatile-state machines), and the handlers are the ones `run` takes beside
 * the machine: `interpret` (required once the machine emits a Cmd) and the
 * `subscribe` runners (required once the machine declares a Sub type other
 * than the built-in `timer`) — see {@link RunHandlers}. Same requiredness as
 * `run`, because it is the same type.
 *
 * **The handlers are read fresh, never memoized on.** A handler table written
 * inline in the component is a new object every render; keying the runtime on
 * it would reboot the machine on every render. So `useMachine` hands `run` a
 * table that looks each cell up on the latest render's `interpret` /
 * `subscribe` at the moment a Cmd runs or a Sub starts — a handler may close
 * over props and state freely.
 *
 * **Identity matters.** The runtime is keyed on `[machine, opts.run,
 * opts.ctx, opts.store]`. A new `ctx` reference rebuilds the runtime, and so
 * does a new `run` — pass the engine's own function, not an inline wrapper. Always `useMemo`
 * (or otherwise stabilize) the ctx at the call site. See README.
 *
 * Forgetting to is no longer silent: the replaced runtime's `stop()` reports
 * `RuntimeDiscardedError` under `phase: "discard"` when Cmds were still in
 * flight, which the substrate's default sink warns about (issue #365).
 */
export type UseMachineOpts<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
> = {
  run: EngineRun<S, M, C, U, Ctx>;
  ctx: Ctx;
  store?: Store<S>;
} & RunHandlers<M, C, U, Ctx>;

/**
 * Build and own a run of `machine` for the lifetime of the component mount, on
 * the engine whose `run` the caller hands in.
 *
 * - Starts the run in an effect, never during render, and keys it on `[machine,
 *   opts.run, opts.ctx, opts.store]`: the run is replaced when ANY of those
 *   identities change. Until the run has its first State saved, `state` is
 *   `init(null, ctx)`'s.
 * - Subscribes via `useSyncExternalStore` — tearing-free under React 18
 *   concurrent rendering.
 * - On unmount (or any dep change), calls `stop()` — drains the queue, up to
 *   `disposeTimeoutMs`, runs every active sub cleanup, flushes state, and — if
 *   Cmds were still in flight — reports `RuntimeDiscardedError` (`phase:
 *   "discard"`) rather than dropping them silently. A handler that has not
 *   returned by the limit is given up on and reported as a `DrainTimeoutNotice`.
 *
 * **Strict Mode:** its extra effect run on mount does nothing. One run starts,
 * `run` is called once, and each Sub starts once.
 *
 * **`<Activity>`** (React 19.2 and later): a hide stops the machine's Subs, and nothing else: their
 * cleanups run, and they start again on show. It is the same run across the hide,
 * so `state` keeps its value, `init` is not called again, and a Cmd in flight
 * lands and its answer folds, whether that comes during the hide or after the
 * show. A Msg dispatched while hidden folds at once, and any Cmd it emits runs.
 *
 * `dispatch` stays the same function across a hide and show. A Msg dispatched
 * before the run has started, which on a tree first mounted hidden means before
 * its first show, waits for the run and its promise settles once it is folded.
 * After an unmount, `dispatch` rejects with `@demlik/tea: runtime stopped`.
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
  opts: NoInfer<UseMachineOpts<S, M, C, U, Ctx>>,
): [S, (msg: M) => Promise<void>] {
  // Deps are literal: machine, engine, ctx and store identity. NOT `[opts]`
  // (would rebuild every render — callers pass fresh objects). We pass
  // explicit fields to `run()` so the closure captures only the deps in the
  // array — keeps biome's `useExhaustiveDependencies` happy without lying
  // about what the memo actually depends on.
  const run = opts.run;
  const ctx = opts.ctx;
  const store = opts.store;
  // The latest render's handlers, read per call (see `UseMachineOpts`). Written
  // during render on purpose: a Cmd a transition emits runs after the render
  // that produced it, so the table it reads is never older than that render.
  const handlersRef = useRef<RunHandlers<M, C, U, Ctx>>(opts);
  handlersRef.current = opts;
  const interpret = useMemo(
    () =>
      latestTable(
        () => (handlersRef.current as { interpret?: object }).interpret,
      ) as Interpret<M, C, Ctx>,
    [],
  );
  // Render only builds the holder and reads `init` for the first paint, which
  // is pure. `useMemo` may call this twice under Strict Mode and an abandoned
  // render may drop the result, so no run starts here: that would leak one.
  const mounted = useMemo(
    () =>
      new MountedRun<S, M>(
        (subs) =>
          run(machine, {
            ctx,
            store,
            interpret,
            subscribe: gatedRunners(
              subs,
              () => handlersRef.current.subscribe,
            ) as Partial<Subscribe<M, U, Ctx>>,
          } as RunOptions<S, M, C, U, Ctx>),
        machine.init(null, ctx)[0],
        cleanupMayBeAHide,
      ),
    [machine, run, ctx, store, interpret],
  );

  const state = useSyncExternalStore(
    mounted.subscribe,
    mounted.getSnapshot,
    mounted.getSnapshot,
  );

  // The one cleanup React runs only when the component is really gone: neither
  // Strict Mode's double run nor `<Activity>` touches an insertion effect. It
  // is what tells a hide from an unmount, which the effect below cannot. Reacts
  // before 19.2 can skip it, and `MountedRun` covers them.
  useInsertionEffect(() => () => mounted.retire(), [mounted]);

  useEffect(() => {
    mounted.connect();
    return () => mounted.disconnect();
  }, [mounted]);

  return [state, mounted.dispatch];
}

/** A Sub runner as `run` calls it. */
type GatedRunner = (sub: Sub, ctx: unknown, dispatch: unknown) => Dispose;

/**
 * The Sub runner table `run` is handed: each runner the latest render names goes
 * through `subs`, read again each time the Sub starts. The built-ins are named
 * here so they go through it too. A type with no runner at all stays `undefined`,
 * which is what the engine reports as a missing runner.
 */
function gatedRunners(
  subs: SubGate,
  current: () => object | undefined,
): object {
  const runnerFor = (type: PropertyKey) =>
    ((current() as Record<PropertyKey, unknown> | undefined)?.[type] ??
      (builtinRunners as Record<PropertyKey, unknown>)[type]) as
      | GatedRunner
      | undefined;
  return new Proxy(
    {},
    {
      get: (_target, type) => {
        const first = runnerFor(type);
        if (first === undefined) return undefined;
        const gated: GatedRunner = (sub, ctx, dispatch) =>
          subs.admit(() => (runnerFor(type) ?? first)(sub, ctx, dispatch));
        return gated;
      },
    },
  );
}

/**
 * A handler table whose every cell is looked up on `current()` at the moment it
 * is read, so `run` — which reads a cell per Cmd / per Sub start — always sees
 * the latest render's handler without the runtime being rebuilt.
 */
function latestTable(current: () => object | undefined): object {
  return new Proxy(
    {},
    {
      get: (_target, type) =>
        (current() as Record<PropertyKey, unknown> | undefined)?.[type],
    },
  );
}

/**
 * Lower-level escape hatch: consume an externally-built, booted run — any
 * engine's {@link BootedRunHandle} (the Promise engine's `Runtime` is one).
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
export function useRuntime<
  S,
  M extends { type: string },
  E extends { type: string } = never,
>(runtime: BootedRunHandle<S, M, E>): [S, (msg: M) => Promise<void>] {
  const state = useSyncExternalStore(
    runtime.subscribe,
    runtime.getState,
    runtime.getState,
  );
  return [state, runtime.dispatch];
}
