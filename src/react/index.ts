/**
 * @packageDocumentation
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

import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  BootedRunHandle,
  Cmd,
  EngineRun,
  Interpret,
  Machine,
  RunHandle,
  RunHandlers,
  RunOptions,
  Store,
  Sub,
  Subscribe,
} from "../index";

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
 * **Identity matters.** The runtime is memoized on `[machine, opts.run,
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
 * - Builds via `useMemo(() => opts.run(machine, opts), [machine, opts.run,
 *   opts.ctx, opts.store])` — the run is recreated when ANY of those
 *   identities change.
 * - Subscribes via `useSyncExternalStore(runtime.subscribe, runtime.getState,
 *   runtime.getState)` — tearing-free under React 18 concurrent rendering.
 * - On unmount (or any dep change), `useEffect` cleanup calls
 *   `runtime.stop()` — drains the queue, runs every active sub cleanup,
 *   flushes state, and — if Cmds were still in flight — reports
 *   `RuntimeDiscardedError` (`phase: "discard"`) rather than dropping them
 *   silently.
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
  const handlers = useMemo(
    () => ({
      interpret: latestTable(
        () => (handlersRef.current as { interpret?: object }).interpret,
      ) as Interpret<M, C, Ctx>,
      subscribe: latestTable(() => handlersRef.current.subscribe) as Partial<
        Subscribe<M, U, Ctx>
      >,
    }),
    [],
  );
  // `run()` returns a `RunHandle<S, M>` SYNCHRONOUSLY (issue #45) — exactly
  // what `useMemo` needs. We never `await` here: awaiting would force an async
  // memo, a null first-commit state, and a resolved-flag dance. Instead we hold
  // the booting handle and capture the booted one (the only thing with a total
  // `getState`) once `ready` resolves.
  const booting = useMemo<RunHandle<S, M>>(
    () =>
      run(machine, {
        ctx,
        store,
        ...handlers,
      } as RunOptions<S, M, C, U, Ctx>),
    [machine, run, ctx, store, handlers],
  );

  // Captures the booted handle once `ready` resolves. Until then it is
  // `null` and `getSnapshot` serves `preliminaryState`. Reset whenever the
  // booting handle identity changes (a new machine/ctx/store mount).
  //
  // The boot race the paired `bootedTick` bump exists for: the substrate's
  // boot fanout fires BEFORE `ready` resolves (fireListeners runs inside the
  // boot step; `ready` chains off the boot promise), so at notification time
  // this ref is still null and `getSnapshot` returns the same
  // `preliminaryState` reference — React sees an unchanged snapshot and
  // skips the re-render. Nothing re-notifies after the ref is set, so a
  // store-backed mount would stay stuck on the preliminary state until the
  // next unrelated transition. Bumping a reducer when we capture the booted
  // runtime forces the render that swaps preliminary → real state.
  const readyRef = useRef<BootedRunHandle<S, M> | null>(null);
  const [, markBooted] = useReducer((tick: number) => tick + 1, 0);

  // Preliminary state computed sync from `machine.init(null, ctx)`. This is
  // the snapshot React sees BEFORE the runtime finishes booting (matters
  // only when `opts.store` is present — without a store, the substrate
  // already sets state synchronously inside `run()`, so the boot fanout that
  // captures `readyRef` lands on the same microtask as the first commit).
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

  // `getSnapshot` reads the booted runtime if `ready` has resolved (the ref is
  // populated), else falls back to the preliminary state. No try/catch dance
  // anymore — pre-boot there is simply no booted handle to read from, so
  // the fallback is structural, not exception-driven.
  const getSnapshot = (): S =>
    readyRef.current !== null ? readyRef.current.getState() : preliminaryState;

  const state = useSyncExternalStore(
    booting.subscribe,
    getSnapshot,
    getSnapshot,
  );

  useEffect(() => {
    let live = true;
    // Capture the booted runtime when `ready` resolves, then force the
    // render that swaps preliminary → real state (see the boot-race note on
    // `readyRef` — the boot fanout fires too early to do it for us). Boot
    // rejections are swallowed: a failed boot surfaces on every `dispatch`,
    // which is where the consumer handles it.
    booting.ready.then(
      (r) => {
        if (live) {
          readyRef.current = r;
          markBooted();
        }
      },
      () => {},
    );
    return () => {
      live = false;
      readyRef.current = null;
      // Fire-and-forget — `stop()` is async but `useEffect` cleanup is sync.
      // The runtime swallows in-flight rejections internally, so this never
      // rejects in practice; we still attach `.catch` for safety.
      booting.stop().catch(() => {});
    };
  }, [booting]);

  return [state, booting.dispatch];
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
