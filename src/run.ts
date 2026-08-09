/**
 * @demlik/tea runtime — `run`: boot + the serial dispatch loop. The pure helpers
 * that compose against a machine without running it (`replay`, `tryInterpret`)
 * live in `./runtime-types`.
 */

import type {
  Dispose,
  Interpret,
  Machine,
  Port,
  PortEmitter,
  Sub,
} from "./pure/core";
import { applyCellChecked, type Cmd, structuralHash } from "./pure/core";
import type {
  BootingRuntime,
  CtxArg,
  DispatchSettle,
  OnError,
  Runtime,
  RuntimeErrorContext,
  RuntimeErrorPhase,
  Store,
  Supervision,
} from "./runtime-types";
import { QuiescenceTimeoutError, SubIdCollisionError } from "./runtime-types";

// Default `onError` sink: re-throw on a fresh macrotask so the failure reaches
// the host's global error handler instead of vanishing — surface, not swallow
// (invariant 6).
function defaultOnError(error: unknown, _context: RuntimeErrorContext): void {
  setTimeout(() => {
    throw error;
  }, 0);
}

// Normalize `Supervision` (bare string or object) so the dispatch loop branches
// on `.strategy` once. Default `stop`. Derived from `Supervision` — the object
// arms are exactly its non-string members, so the restart `rehydrate` payload
// has a single source of truth.
type NormalizedSupervision<S, M extends { type: string }> = Extract<
  Supervision<S, M>,
  object
>;

function normalizeSupervision<S, M extends { type: string }>(
  supervision: Supervision<S, M> | undefined,
): NormalizedSupervision<S, M> {
  if (supervision === undefined) return { strategy: "stop" };
  if (typeof supervision === "string") return { strategy: supervision };
  return supervision;
}

// === run ===
//
// Returns a `BootingRuntime<S, M>` synchronously; boot runs as the FIRST entry
// on the serial dispatch tail, awaited implicitly by every public method.
//
// Save-then-effects ordering is structural: every transition mutates state,
// awaits `store.save(newState)`, then reconciles subscriptions, then runs
// `interpret` for emitted cmds, then fires external listeners. A throw in any
// effect phase leaves the persisted state ahead of the host's belief about
// what executed — the Railway discipline (`tryInterpret` in handlers) makes
// that safe in practice.
export function run<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string } = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: CtxArg<Ctx> & {
    store?: Store<S>;
    onError?: OnError;
    /**
     * The SEMANTIC event projector. Maps one APPLIED transition `(msg, state)`
     * to zero-or-more public events of `E`; `[]` skips the transition. Maps the
     * machine's PRIVATE Msg vocabulary to NAMED events — the private names never
     * reach `on`'s `E` surface. Omit → `E = never` and `on` is uncallable. PURE.
     */
    events?: (msg: M, state: S) => readonly E[];
    /**
     * Declared policy for a reducer (`update`) throw. Always surfaced via
     * `onError` (`phase: "reduce"`); the strategy decides what the runtime does
     * next. Defaults to `"stop"`. See `Supervision`.
     */
    supervision?: Supervision<S, M>;
    /**
     * The run-terminality predicate — makes the run's outcome first-class. Fed to
     * `Runtime.result()` and `Runtime.done()`. PURE. Omit → never terminal.
     */
    terminal?: (state: S) => boolean;
    /**
     * Iteration cap for `idle()`'s quiescence wait. Defaults to 100_000. Test
     * seam only. Production code must not set it.
     *
     * @internal test-only
     */
    __idleCap?: number;
  },
): BootingRuntime<S, M, E> {
  const { store } = opts;
  // `ctx` is conditionally optional (see `CtxArg`); default the nullish case to
  // `{}` so the augmented-ctx spread and `init(loaded, ctx)` get a value.
  const ctx = (opts.ctx ?? {}) as Ctx;
  const idleCap = opts.__idleCap ?? 100_000;
  // No projector → `E = never` and `on` is uncallable.
  const projectEvents: (msg: M, state: S) => readonly E[] =
    opts.events ?? (() => []);
  // No predicate → never terminal (`result()` always `undefined`).
  const isTerminal: (state: S) => boolean = opts.terminal ?? (() => false);
  // Absent sink → `defaultOnError` (invariant 6).
  const onError: OnError = opts.onError ?? defaultOnError;
  // A throwing sink routes THAT throw through `defaultOnError` so it can't
  // re-create a silent failure.
  const reportError = (error: unknown, context: RuntimeErrorContext): void => {
    try {
      onError(error, context);
    } catch (sinkError) {
      defaultOnError(sinkError, context);
    }
  };

  // Throw-isolated fanout: run `fn` for every item, routing any throw to the
  // sink under `phase` so one bad consumer never strands its siblings
  // (invariant 6). The single home for that isolation discipline — every
  // synchronous listener/observer/handler fanout goes through here.
  function fanout<T>(
    items: Iterable<T>,
    phase: RuntimeErrorPhase,
    fn: (item: T) => void,
  ): void {
    for (const item of items) {
      try {
        fn(item);
      } catch (err) {
        reportError(err, { phase });
      }
    }
  }
  const supervision = normalizeSupervision<S, M>(opts.supervision);

  // `state` is late-initialized inside the boot step (the head of the tail).
  let state: S | undefined;
  let bootError: unknown = null;
  let stopped = false;

  const subRegistry = new Map<string, () => void>();
  // Dep-keyed Sub registry. One slot per `machine.subs[i]`, keyed by the entry's
  // array index (its stable identity across reconciles — a dep-keyed Sub has no
  // author-supplied id). `runningId` is the `structuralHash(deps)` of the live
  // source; an absent slot means the entry is currently inactive (its `deps`
  // returned null). The same dispose-on-change / dispose-on-null machinery the
  // manual Sub path uses, with the id DERIVED instead of author-supplied.
  const depSubRegistry = new Map<
    number,
    { runningId: string; dispose: Dispose }
  >();
  const listeners = new Set<() => void>();
  // Observers get (msg, state) for every APPLIED transition (boot goes via `onBoot`).
  const observers = new Set<(msg: M, state: S) => void>();
  // `booted` lets an `onBoot` handler registered AFTER boot fire immediately.
  const bootHandlers = new Set<(state: S) => void>();
  let booted = false;
  // Keyed by event `type`, stored monomorphically (per-type safety at `on`).
  const eventHandlers = new Map<string, Set<(event: E) => void>>();
  // `done()` waiters — the first terminal transition drains them.
  const doneWaiters = new Set<(state: S) => void>();

  // Keyed by Port reference (identity is by-reference per Elm); per-port type
  // safety is enforced at the call sites.
  const portRegistry = new Map<Port<unknown>, Set<(value: unknown) => void>>();

  // `emit` injected onto ctx: synchronous fanout, no-op on no subscribers,
  // listener throws isolated + routed to the sink (invariant 6).
  function portEmit<T>(port: Port<T>, value: T): void {
    const subscribers = portRegistry.get(port as Port<unknown>);
    if (!subscribers || subscribers.size === 0) return;
    fanout(subscribers, "port-emit", (listener) => listener(value));
  }

  // Spread into a fresh object so handlers get a Ctx & PortEmitter without
  // mutating the caller's ctx (which may be shared across runtimes / tests).
  const augmentedCtx: Ctx & PortEmitter = { ...ctx, emit: portEmit };

  // Every step chains onto `tail` — the single concurrency gate.
  let tail: Promise<void> = Promise.resolve();

  // Tear down each named sub: run its cleanup (throws isolated + routed to the
  // sink under `"sub-cleanup"`), then drop it from the registry regardless of a
  // cleanup throw. The single home for the cleanup-and-delete discipline shared
  // by `reconcileSubs`'s removal pass and `stop()`.
  function stopSubs(ids: Iterable<string>): void {
    for (const id of ids) {
      const cleanup = subRegistry.get(id);
      if (cleanup === undefined) continue;
      try {
        cleanup();
      } catch (err) {
        reportError(err, { phase: "sub-cleanup" });
      }
      subRegistry.delete(id);
    }
  }

  // Dispose each named dep-keyed slot: run its `Dispose` (throws isolated +
  // routed to the sink under `"sub-cleanup"`, exactly as `stopSubs` does for the
  // manual path), then drop the slot regardless of a throw. The single home for
  // the dispose-and-delete discipline shared by `reconcileDepSubs`'s teardown /
  // re-arm passes and `stop()`.
  function disposeDepSubs(indices: Iterable<number>): void {
    for (const index of indices) {
      const running = depSubRegistry.get(index);
      if (running === undefined) continue;
      try {
        running.dispose();
      } catch (err) {
        reportError(err, { phase: "sub-cleanup" });
      }
      depSubRegistry.delete(index);
    }
  }

  /**
   * Reconcile the dep-keyed Subs (`machine.subs`) against `state`. Runs as the
   * first pass of `reconcileSubs`, sharing the dispose-on-change /
   * dispose-on-null machinery with the manual Sub path. For each entry:
   *
   *   - `deps(state)` is null → the Sub is inactive in this state; dispose it
   *     if it was running.
   *   - `deps(state)` is non-null → `id = structuralHash(deps)`; if no source
   *     is running for this entry, or the running id differs (re-arm), dispose
   *     the old source and run `source(state, dispatch, ctx)` to open a fresh
   *     one (the entry re-derives its own typed slice from `state`).
   *   - Unchanged id → leave the source running (the no-churn case).
   *
   * Start throws are collected and returned rather than thrown here (same
   * contract as the manual path) so one bad source doesn't strand the others.
   * A machine that declares no `subs` returns immediately — the pass is inert.
   */
  function reconcileDepSubs(): unknown {
    let firstError: unknown = null;
    const subs = machine.subs;
    if (!subs) return firstError;
    for (const [i, entry] of subs.entries()) {
      const deps = entry.deps(state as S);

      if (deps === null) {
        // Inactive in this state — tear down if running.
        disposeDepSubs([i]);
        continue;
      }

      const id = structuralHash(deps);
      const running = depSubRegistry.get(i);
      if (running !== undefined && running.runningId === id) {
        // No-churn case: same deps → leave the source running.
        continue;
      }
      // Re-arm (id changed) or first arm — dispose the stale source first.
      disposeDepSubs([i]);
      try {
        const dispose = entry.source(state as S, enqueueDispatch, ctx);
        depSubRegistry.set(i, { runningId: id, dispose });
      } catch (err) {
        if (firstError === null) firstError = err;
        // Do NOT register; continue so other dep-keyed sources still arm.
      }
    }
    return firstError;
  }

  /**
   * Reconcile subscriptions against `state`, after every save. Same id old+new →
   * leave running; removed id → cleanup (throws isolated, routed to the sink);
   * new id → start (throw remembered and re-thrown after the loop so all other
   * new subs still register).
   */
  function reconcileSubs(): void {
    // Dep-keyed pass FIRST, then the manual aggregate — ONE reconcile pass over
    // both paths. Its start error is remembered (it happened first) and thrown
    // after the manual pass so a bad dep-keyed source never strands the manual
    // subs, and vice versa.
    const depError = reconcileDepSubs();
    if (!machine.subscriptions) {
      if (depError !== null) throw depError;
      return;
    }
    const desired = machine.subscriptions(state as S);
    const desiredIds = new Set<string>();

    // Collision assert: within one desired set, two subs sharing an id but
    // declaring different types is a silent bug class. (Same id across
    // transitions is the no-churn case and MUST NOT throw.)
    const desiredTypeById = new Map<string, string>();
    for (const sub of desired) {
      const existing = desiredTypeById.get(sub.id);
      if (existing !== undefined && existing !== sub.type) {
        throw new SubIdCollisionError(sub.id, existing, sub.type);
      }
      desiredTypeById.set(sub.id, sub.type);
    }

    // Removals first — anything in the registry not in `desired` should stop.
    for (const sub of desired) desiredIds.add(sub.id);
    stopSubs([...subRegistry.keys()].filter((id) => !desiredIds.has(id)));

    // Additions — anything in `desired` not in the registry should start.
    let firstStartError: unknown = depError;
    for (const sub of desired) {
      if (subRegistry.has(sub.id)) continue;
      const handler = machine.subscribe?.[sub.type as U["type"]];
      if (!handler) {
        // No handler for this sub type — programmer error; skip.
        continue;
      }
      try {
        const cleanup = handler(
          sub as Extract<U, { type: U["type"] }>,
          ctx,
          enqueueDispatch,
        );
        subRegistry.set(sub.id, cleanup);
      } catch (err) {
        if (firstStartError === null) firstStartError = err;
        // Do NOT register; continue to next sub so other starts still run.
      }
    }
    if (firstStartError !== null) throw firstStartError;
  }

  // `interpret` is optional when `C extends Cmd<never>`; default a missing map to
  // `{}` — the per-cmd `if (!handler) continue` preserves invariant-6 forward
  // progress for a miswired consumer.
  const interpretMap: Interpret<M, C, Ctx> =
    (machine as { interpret?: Interpret<M, C, Ctx> }).interpret ??
    ({} as Interpret<M, C, Ctx>);

  // The injected dispatch for DETACHED handlers. Same serial-tail enqueue every
  // other dispatch uses (`enqueueDispatch` chains on `tail`), wrapped to a sync
  // `(msg) => void` so a detached handler's `ctx.waitUntil(...)` tail can fire
  // its terminal Msg without awaiting the runtime. The rejection has no caller
  // (the original dispatcher already resolved), so it routes to the sink under
  // `"follow-up"` — the same phase the returned-follow-up path uses. A handler
  // authored via `wrapDetached` receives a NARROWED view of this fn (only its
  // declared result-Msg set); a plain leaf handler ignores it entirely.
  const interpretDispatch = (msg: M): void => {
    enqueueDispatch(msg).catch((error: unknown) => {
      reportError(error, { phase: "follow-up" });
    });
  };

  /**
   * Run `interpret` for each emitted cmd. A returned follow-up Msg is enqueued
   * onto the tail (NOT dispatched re-entrantly). The first error stops further
   * handlers in this transition.
   */
  async function runInterpret(cmds: readonly C[]): Promise<void> {
    for (const cmd of cmds) {
      const handler = interpretMap[cmd.type as C["type"]];
      if (!handler) continue;
      const follow = await handler(
        cmd as Extract<C, { type: C["type"] }>,
        augmentedCtx,
        interpretDispatch,
      );
      if (follow !== undefined && follow !== null) {
        // The follow-up's rejection has no caller (the original dispatcher
        // resolved), so route it to the sink (invariant 6); name a failure Msg
        // via `tryInterpret` to fold it back into state.
        enqueueDispatch(follow as M).catch((error: unknown) => {
          reportError(error, { phase: "follow-up" });
        });
      }
    }
  }

  // Throws isolated so one bad listener does not strand the others.
  function fireListeners(): void {
    fanout(listeners, "listener", (listener) => listener());
  }

  // After `fireListeners` so observers see what subscribers see. APPLIED
  // transitions only — `msg` is total (boot routes to `fireBoot`).
  function fireObservers(msg: M): void {
    if (observers.size === 0 || state === undefined) return;
    const snapshot = state;
    fanout(observers, "observer", (observer) => observer(msg, snapshot));
  }

  // Project the transition to semantic events and fan each to its `on(...)`
  // handlers; a throw in the projector OR a handler is isolated.
  function fireEvents(msg: M): void {
    if (eventHandlers.size === 0 || state === undefined) return;
    let events: readonly E[];
    try {
      events = projectEvents(msg, state);
    } catch (err) {
      reportError(err, { phase: "event" });
      return;
    }
    for (const event of events) {
      const bucket = eventHandlers.get(event.type);
      if (bucket === undefined) continue;
      fanout(bucket, "event", (handler) => handler(event));
    }
  }

  // Fire every `onBoot` handler with the initial State ONCE and flip `booted`.
  function fireBoot(): void {
    booted = true;
    if (bootHandlers.size === 0 || state === undefined) return;
    const snapshot = state;
    fanout(bootHandlers, "boot", (handler) => handler(snapshot));
  }

  // Resolve every parked `done()` waiter iff the just-folded State is terminal —
  // so `done()` settles on the same transition `result()` first returns it.
  function settleDoneWaiters(): void {
    if (doneWaiters.size === 0 || state === undefined) return;
    if (!isTerminal(state)) return;
    const snapshot = state;
    const parked = [...doneWaiters];
    doneWaiters.clear();
    for (const resolve of parked) resolve(snapshot);
  }

  // The post-transition commit tail: install state, then save → reconcile subs →
  // interpret → fire fanout → settle done-waiters. Save-before-effects is the
  // hard ordering; tests pin it. The normal transition and the `restart`
  // supervision branch both end here.
  async function commit(next: S, msg: M, cmds: readonly C[]): Promise<void> {
    state = next;
    if (store) await store.save(next);
    reconcileSubs();
    await runInterpret(cmds);
    fireListeners();
    fireObservers(msg);
    fireEvents(msg);
    settleDoneWaiters();
  }

  /**
   * One full transition: update → save → reconcile subs → interpret → fire.
   * Save-before-effects is the hard ordering; tests pin it. A `save` throw
   * propagates after the in-memory `state` is advanced; reconcile/interpret
   * throws after `save` has succeeded.
   */
  async function stepDispatch(msg: M): Promise<void> {
    if (state === undefined) {
      throw new Error("@demlik/tea: runtime not booted");
    }
    // Instance-identity filter. When the machine declares an `identity`, a
    // message addressed to a DIFFERENT identity is dropped here — before
    // `update` runs, so the reducer never sees a foreign-instance message and
    // no cell needs a `msg.runId !== state.runId` guard. A message with no
    // identity (`ofMsg` undefined) is identity-agnostic and always proceeds.
    // The drop resolves the dispatch (no throw) and advances nothing: no save,
    // no reconcile, no interpret, no listener/observer/event fire, no
    // done-waiter settle. Identity is explicit (invariant 7) and the drop is
    // the one observable enforcement point (invariant 6).
    if (machine.identity !== undefined) {
      const addressed = machine.identity.ofMsg(msg);
      if (addressed !== undefined) {
        const own = machine.identity.ofState(state);
        // `own === undefined` ⇒ this instance has no identity to defend yet
        // (e.g. an `idle` state before any run is established). An addressed
        // message in that state is identity-establishing, not foreign — never
        // dropped. Drop only when BOTH identities are present and differ.
        if (
          own !== undefined &&
          structuralHash(addressed) !== structuralHash(own)
        ) {
          return;
        }
      }
    }
    // The reducer is the only synchronous user code; the reentrancy brand
    // guarantees it cannot suspend, so a throw here is clean with `state` still
    // pre-transition. Route it to the supervision strategy. Dispatch goes
    // through `applyCellChecked` — the single dev-checked reducer-vs-transitions
    // primitive `foldUpdates` also folds through (see `pure/core.ts`).
    let next: S;
    let cmds: readonly C[];
    try {
      [next, cmds] = applyCellChecked<S, M, C>(machine, state, msg);
    } catch (reduceError) {
      // Invariant 6 — surface the failure as data FIRST, for every strategy.
      reportError(reduceError, { phase: "reduce" });
      switch (supervision.strategy) {
        case "restart": {
          // Host supplies last-known-good state; core installs it and KEEPS
          // FOLDING from there with no cmds (the throwing reduce produced none).
          // A throw inside `rehydrate` is NOT caught — it surfaces to the caller.
          await commit(supervision.rehydrate(state, msg, reduceError), msg, []);
          return;
        }
        case "escalate":
          // Surface + propagate; the runtime stays live for a parent supervisor.
          throw reduceError;
        default:
          // `stop` (safe default): halt. State is NOT advanced; propagate so THIS
          // dispatch also rejects — the halt is observable, never a silent resume.
          stopped = true;
          throw reduceError;
      }
    }
    await commit(next, msg, cmds);
  }

  // Boot has two phases. With NO store, `loaded = null` without an await — run
  // `init(null, ctx)` IMMEDIATELY so `getState()` is observable synchronously
  // (what `useSyncExternalStore` consumers need to render the first commit
  // without a flicker). The async remainder runs in `stepBootEffects` as the
  // first tail entry. With a store we cannot `init` synchronously (we'd invent a
  // loaded value), so the full path runs there; `store.load` throws propagate
  // via the boot promise.
  let pendingInitCmds: readonly C[] = [];
  if (!store) {
    const [initialState, initCmds] = machine.init(null, ctx);
    state = initialState;
    pendingInitCmds = initCmds;
  }

  async function stepBootEffects(): Promise<void> {
    if (store) {
      // Boundary parse (invariant 8): `store.load()` returns `unknown`;
      // `store.migrate(raw)` is the required parse — `S` on recognized shape,
      // `null` on unrecognized (boots fresh). `migrate` MUST NOT throw; if it
      // does we surface via the boot promise (same as a `load` throw).
      const raw = await store.load();
      const parsed = store.migrate(raw);
      const [initialState, initCmds] = machine.init(parsed, ctx);
      state = initialState;
      pendingInitCmds = initCmds;
      await store.save(state);
    }
    reconcileSubs();
    await runInterpret(pendingInitCmds);
    fireListeners();
    // Boot has no applied Msg — deliver the initial State via `onBoot`, not
    // `observe`, and project no semantic event.
    fireBoot();
    // A rehydrated boot can land terminal — settle any pre-boot `done()` waiter.
    settleDoneWaiters();
  }

  /**
   * Enqueue a dispatch on the tail — the single gate re-entrant interpret /
   * subscribe calls also go through. Rejects when the runtime is stopped, boot
   * failed, or the reducer / save / sub start / interpret throws.
   */
  function enqueueDispatch(msg: M): Promise<void> {
    if (stopped)
      return Promise.reject(new Error("@demlik/tea: runtime stopped"));
    const next = tail.then(() => {
      if (bootError !== null) throw bootError;
      return stepDispatch(msg);
    });
    // Swallow the rejection on the tail so one failing dispatch does NOT poison
    // every subsequent one. The original `next` still rejects for the caller.
    tail = next.catch(() => {});
    return next;
  }

  /**
   * Drain the serial tail to quiescence. Every interpret follow-up calls
   * `enqueueDispatch`, which reassigns `tail` SYNCHRONOUSLY before the parent
   * step resolves, so awaiting the current `tail` and re-reading it catches every
   * transitively enqueued follow-up; loop until the reference is stable. Bounded
   * by `idleCap` — on cap REJECT with `QuiescenceTimeoutError` (never a silent
   * resolve), keeping a livelock distinguishable from quiescence (invariant 6).
   */
  async function drainToQuiescence(): Promise<void> {
    for (let i = 0; i < idleCap; i++) {
      const observed = tail;
      await observed;
      if (tail === observed) return;
    }
    throw new QuiescenceTimeoutError(idleCap);
  }

  /**
   * The public `dispatch`: run-to-quiescence by default. Await the Msg's OWN
   * transition first (so a reducer / save / interpret throw on THIS Msg surfaces
   * before any drain), then — unless `{ settle: "once" }` — drain the transitive
   * follow-up chain.
   */
  async function dispatchToQuiescence(
    msg: M,
    opts?: { readonly settle?: DispatchSettle },
  ): Promise<void> {
    await enqueueDispatch(msg);
    if (opts?.settle === "once") return;
    await drainToQuiescence();
  }

  // `bootPromise` is the un-swallowed promise `runtime.ready` chains off (so
  // callers see the boot error directly); `tail` gets the swallowed branch so a
  // boot failure does NOT poison every subsequent dispatch's chain (each surfaces
  // `bootError` in `enqueueDispatch`).
  const bootPromise = stepBootEffects();
  tail = bootPromise.catch((err) => {
    bootError = err;
  });

  // `ready` chains off `bootPromise` so a failed boot never hands out a `Runtime`
  // (keeping `getState()` total). The `runtime` forward reference resolves at
  // `.then` time, after the literal below initializes. Idempotent.
  const readyPromise: Promise<Runtime<S, M, E>> = bootPromise.then(
    () => runtime,
  );

  const runtime: Runtime<S, M, E> = {
    dispatch: dispatchToQuiescence,
    dispatchOnce: enqueueDispatch,
    getState(): S {
      // TOTAL. A `Runtime` is only obtainable by awaiting `ready`, which resolves
      // AFTER boot set `state`; a failed boot rejects `ready`, so no `Runtime` is
      // handed out then. The cast encodes that invariant.
      return state as S;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observe(observer: (msg: M, state: S) => void): () => void {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    onBoot(handler: (state: S) => void): () => void {
      // Already booted → fire immediately (cleanup is a no-op) so a late
      // subscriber never misses the one-shot boot.
      if (booted && state !== undefined) {
        const snapshot = state;
        fanout([handler], "boot", (h) => h(snapshot));
        return () => {};
      }
      bootHandlers.add(handler);
      return () => {
        bootHandlers.delete(handler);
      };
    },
    on<K extends E["type"]>(
      type: K,
      handler: (event: Extract<E, { type: K }>) => void,
    ): () => void {
      // Monomorphic registry; per-type narrowing lives at THIS call site, and
      // `fireEvents` only routes an event to its own bucket, so the erased call
      // is sound.
      let bucket = eventHandlers.get(type);
      if (bucket === undefined) {
        bucket = new Set<(event: E) => void>();
        eventHandlers.set(type, bucket);
      }
      const erased = handler as (event: E) => void;
      bucket.add(erased);
      return () => {
        const set = eventHandlers.get(type);
        if (set === undefined) return;
        set.delete(erased);
        if (set.size === 0) eventHandlers.delete(type);
      };
    },
    subscribePort<T>(port: Port<T>, listener: (value: T) => void): () => void {
      const key = port as Port<unknown>;
      let bucket = portRegistry.get(key);
      if (!bucket) {
        bucket = new Set<(value: unknown) => void>();
        portRegistry.set(key, bucket);
      }
      // Bucket stores `(value: unknown) => void`; per-port type safety at this site.
      const erased = listener as (value: unknown) => void;
      bucket.add(erased);
      return () => {
        const set = portRegistry.get(key);
        if (!set) return;
        set.delete(erased);
        if (set.size === 0) portRegistry.delete(key);
      };
    },
    emitPort<T>(port: Port<T>, value: T): void {
      // Lets `observe`-driven Port emission work without a per-transition Cmd.
      portEmit(port, value);
    },
    ready: readyPromise,
    idle(): Promise<void> {
      return drainToQuiescence();
    },
    result(): S | undefined {
      // TOTAL. No predicate → `isTerminal` is `() => false`, so a non-terminating
      // machine reads `undefined` forever.
      const current = state as S;
      return isTerminal(current) ? current : undefined;
    },
    done(): Promise<S> {
      // Already terminal → resolve at once (never parks, so it can't miss the
      // terminal transition). Otherwise park a resolver for `settleDoneWaiters`.
      const current = state as S;
      if (isTerminal(current)) return Promise.resolve(current);
      return new Promise<S>((resolve) => {
        doneWaiters.add(resolve);
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      // Drain in-flight work. Tail rejections were swallowed at enqueue time, so
      // this await always resolves.
      await tail;
      // Run every active sub cleanup; throws isolated and routed to the sink.
      stopSubs([...subRegistry.keys()]);
      // Dispose every live dep-keyed source too (same throw-isolation).
      disposeDepSubs([...depSubRegistry.keys()]);
      // Flush final state. A save throw here does not reject `stop()` (contract:
      // resolves regardless) but IS loss of the last write, so route it to the
      // sink rather than swallowing it (invariant 6).
      if (store && state !== undefined && bootError === null) {
        try {
          await store.save(state);
        } catch (error) {
          reportError(error, { phase: "stop-save" });
        }
      }
    },
  };

  return runtime;
}
