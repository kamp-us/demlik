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
import {
  applyCellChecked,
  type Cmd,
  depsInactive,
  structuralHash,
} from "./pure/core";
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
import {
  DispatchDiscardedError,
  DisposeTimeoutNotice,
  IdentityDropNotice,
  QuiescenceTimeoutError,
  RuntimeDiscardedError,
  RuntimeDiscardNotice,
  SubIdCollisionError,
} from "./runtime-types";

// Default `onError` sink: re-throw on a fresh macrotask so the failure reaches
// the host's global error handler instead of vanishing — surface, not swallow
// (invariant 6).
//
// A `RuntimeDiscardNotice` is NOT a failure of the runtime's own contract — a
// host tearing a runtime down with Cmds in flight (a React ctx-identity change,
// a navigation) is legal, merely lossy. Rethrowing it would make every
// unmount-during-fetch an uncaught error for consumers who never configured a
// sink, so the default WARNS: loud enough that the silent discard #365 describes
// cannot happen again, never fatal. A configured `onError` sees `"discard"` like
// any other phase and can route or ignore it.
//
// The branch keys on the ERROR CLASS, never on `context.phase`: the phase is
// attached by the report site, and `reportError` hands a THROWING consumer sink's
// own error back here with the phase it was handling — so a phase-keyed branch
// would warn away a broken sink and re-create the very silent failure this
// mechanism exists to remove. The class is the one thing a sink's own defect
// cannot forge.
function defaultOnError(error: unknown, _context: RuntimeErrorContext): void {
  if (error instanceof RuntimeDiscardNotice) {
    console.warn(error);
    return;
  }
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
     * How long `stop()` waits for teardown work that returned a Promise (an
     * async `release` in `defineManagedResource`, an async Sub cleanup) before
     * giving up on it. Defaults to 5_000ms.
     *
     * `stop()` awaits those disposals so a host doing
     * `await runtime.stop(); env.evict()` cannot drop the isolate mid-release —
     * the leak the managed-resource battery exists to prevent, relocated to
     * shutdown. The bound is what keeps a release that never settles from
     * hanging the host: on expiry `stop()` reports a `DisposeTimeoutNotice`
     * (warn-only, like every `RuntimeDiscardNotice`) and resolves anyway,
     * because `stop()` resolving is a contract.
     */
    disposeTimeoutMs?: number;
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
  const disposeTimeoutMs = opts.disposeTimeoutMs ?? 5_000;
  // No projector → `E = never` and `on` is uncallable.
  const projectEvents: (msg: M, state: S) => readonly E[] =
    opts.events ?? (() => []);
  // No predicate → never terminal (`result()` always `undefined`).
  const isTerminal: (state: S) => boolean = opts.terminal ?? (() => false);
  // Absent sink → `defaultOnError` (invariant 6).
  const onError: OnError = opts.onError ?? defaultOnError;
  // A throwing sink routes THAT throw through `defaultOnError` so it can't
  // re-create a silent failure. It arrives with the context the sink was
  // handling, so `defaultOnError` must not decide fatality from the phase — the
  // sink's own error is not the runtime's teardown notice, whatever phase it
  // inherits.
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
  // The dispatch gate. It only ever ADVANCES — `"open"` → `"draining"` →
  // `"closed"` — so the discard window can never re-open under a second `stop()`.
  //
  //   "open"     — normal operation; `enqueueDispatch` accepts.
  //   "draining" — inside `stop()`, before the tail has settled. New work is
  //                still refused (the stop barrier is absolute, and refusing is
  //                what makes the drain terminate), but a Msg refused HERE was
  //                discarded BY the teardown: it is an in-flight Cmd's follow-up,
  //                a detached handler's terminal Msg, or a Sub that is still live
  //                because subs are torn down only after the drain. So the
  //                rejection is a `DispatchDiscardedError` and it reports under
  //                `phase: "discard"` — lossy, legal, warn-only.
  //   "closed"   — halted: a `stop` supervision halt, or `stop()` has returned.
  //                A dispatch refused here is a consumer using a runtime it
  //                already retired — a real error, and it stays loud.
  let gate: "open" | "draining" | "closed" = "open";
  // Interpret handlers currently awaiting — "how many Cmds are in flight?".
  // Maintained in `runInterpret` (its only writer) and read by `stop()` to make
  // a mid-flight teardown LOUD instead of silent (issue #365). Not a second
  // representation of the serial `tail`: the tail is a promise chain, which
  // cannot be asked synchronously whether it has outstanding work.
  let inFlightCmds = 0;

  const subRegistry = new Map<string, Dispose>();
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
        trackDisposal(cleanup());
      } catch (err) {
        reportError(err, { phase: "sub-cleanup" });
      }
      subRegistry.delete(id);
    }
  }

  // Teardown work that returned a Promise and has not settled. A cleanup /
  // `Dispose` may be async (`defineManagedResource`'s `release` is typed
  // `void | Promise<void>` precisely so a flush can be awaited), and the
  // reconcile pass CANNOT await it — reconcile runs inside the synchronous
  // transition path (invariant 2). So every async disposal is remembered here
  // the moment it starts, wherever it started, and `stop()` drains the set
  // before resolving: `await runtime.stop()` then means "teardown is done", which
  // is the only reading a host evicting an isolate can act on.
  //
  // The rejection is attached HERE, once, so a failing teardown reaches the sink
  // under `"sub-cleanup"` (the same phase a synchronous cleanup throw uses)
  // instead of a `console.warn` at each battery, and can never become an
  // unhandled rejection.
  const pendingDisposals = new Set<Promise<void>>();

  function trackDisposal(result: void | Promise<void>): void {
    if (!(result instanceof Promise)) return;
    const settling: Promise<void> = result
      .catch((err) => {
        reportError(err, { phase: "sub-cleanup" });
      })
      .finally(() => {
        pendingDisposals.delete(settling);
      });
    pendingDisposals.add(settling);
  }

  /**
   * Wait for the disposals started so far, bounded by `disposeTimeoutMs`. On
   * expiry report a `DisposeTimeoutNotice` and return anyway — `stop()` resolves
   * regardless (contract), and a release that never settles must not become a
   * host that never shuts down. Warn-only, like every `RuntimeDiscardNotice`:
   * the host asked for this teardown, the loss is legal, and it is now visible.
   */
  async function drainDisposals(): Promise<void> {
    if (pendingDisposals.size === 0) return;
    const outstanding = [...pendingDisposals];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        Promise.all(outstanding).then(() => "settled" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), disposeTimeoutMs);
        }),
      ]);
      if (outcome === "timeout") {
        reportError(
          new DisposeTimeoutNotice(outstanding.length, disposeTimeoutMs),
          { phase: "discard" },
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
        trackDisposal(running.dispose());
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
   *   - `deps(state)` is nullish (`depsInactive`) → the Sub is inactive in this
   *     state; dispose it if it was running.
   *   - otherwise → `id = structuralHash(deps)`; if no source is running for
   *     this entry, or the running id differs (re-arm), dispose the old source
   *     and run `source(state, dispatch, ctx)` to open a fresh one (the entry
   *     re-derives its own typed slice from `state`).
   *   - Unchanged id → leave the source running (the no-churn case).
   *
   * Throws are collected and returned rather than thrown here (same contract as
   * the manual path) so one bad entry doesn't strand the others. That covers
   * `deps` and the hash, not just `source`: `deps` is user code on exactly the
   * same footing, and an unguarded throw there stranded every LATER entry AND
   * the manual `subscriptions` aggregate, which is only reached after this loop.
   * A machine that declares no `subs` returns immediately — the pass is inert.
   */
  function reconcileDepSubs(): unknown {
    let firstError: unknown = null;
    const subs = machine.subs;
    if (!subs) return firstError;
    for (const [i, entry] of subs.entries()) {
      // `deps` + `structuralHash` in ONE guarded step: both are pure user-data
      // reads whose failure means "this entry's slice is unknowable", and the
      // recovery is identical — remember the error, leave the slot untouched,
      // keep reconciling the siblings.
      let deps: unknown;
      let id: string;
      try {
        deps = entry.deps(state as S);
        if (depsInactive(deps)) {
          // Inactive in this state — tear down if running.
          disposeDepSubs([i]);
          continue;
        }
        id = structuralHash(deps);
      } catch (err) {
        if (firstError === null) firstError = err;
        continue;
      }

      const running = depSubRegistry.get(i);
      if (running !== undefined && running.runningId === id) {
        // No-churn case: same deps → leave the source running.
        continue;
      }
      // Re-arm (id changed) or first arm — dispose the stale source first.
      disposeDepSubs([i]);
      try {
        // `dispatchUnawaited`, never the raw `enqueueDispatch`: a source's
        // dispatch has no caller to reject at, and the gate rejects during
        // teardown — handing it the raw promise-returning form turned every
        // Sub that fired while `stop()` drained into an unhandled rejection
        // that bypassed `onError` entirely.
        const dispose = entry.source(state as S, dispatchUnawaited, ctx);
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
        // Same reasoning as the dep-keyed source above: a subscribe handler's
        // dispatch is unawaited by construction, so it gets the wrapped form.
        const cleanup = handler(
          sub as Extract<U, { type: U["type"] }>,
          ctx,
          dispatchUnawaited,
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

  // The ONE `(msg) => void` handed to every producer that cannot await its own
  // dispatch: a detached interpret handler's `ctx.waitUntil(...)` tail, a
  // dep-keyed Sub's `source`, a `subscribe[type]` handler. Same serial-tail
  // enqueue every other dispatch uses (`enqueueDispatch` chains on `tail`),
  // wrapped so the rejection — which has no caller, the original dispatcher
  // having already resolved — routes to the sink with the phase DERIVED from
  // the error class (`reportUndelivered`).
  //
  // Handing any of those sites the raw `enqueueDispatch` is the defect this
  // shape exists to prevent: its promise REJECTS whenever the gate is shut, so
  // a Sub that fires during `stop()`'s drain produced an unhandled rejection
  // that reached the host's global handler while `onError` saw nothing. A
  // handler authored via `wrapDetached` receives a NARROWED view of this fn
  // (only its declared result-Msg set); a plain leaf handler ignores it.
  const dispatchUnawaited = (msg: M): void => {
    enqueueDispatch(msg).catch(reportUndelivered);
  };

  /**
   * Report a re-dispatch that nobody can await. The phase is DERIVED from the
   * rejection the gate produced, so the two call sites cannot drift: a
   * `DispatchDiscardedError` means the teardown refused the Msg (`"discard"` —
   * warn-only), anything else is a genuine failure of the follow-up itself
   * (`"follow-up"` — the default sink rethrows it).
   */
  function reportUndelivered(error: unknown): void {
    reportError(error, {
      phase: error instanceof DispatchDiscardedError ? "discard" : "follow-up",
    });
  }

  /**
   * Count an interpret handler's work as in flight for exactly the lifetime of
   * its promise. The ONE writer of `inFlightCmds`, so "how many Cmds are
   * outstanding?" has a single definition; `finally`-balanced, so a rejecting
   * handler can never strand the count above zero. A handler that throws
   * SYNCHRONOUSLY never reaches here, which is correct — it was never in
   * flight.
   */
  function trackInFlight<T>(work: T | Promise<T>): Promise<T> {
    inFlightCmds++;
    return Promise.resolve(work).finally(() => {
      inFlightCmds--;
    });
  }

  /**
   * Run `interpret` for each emitted cmd. A returned follow-up Msg is enqueued
   * onto the tail (NOT dispatched re-entrantly). The first error stops further
   * handlers in this transition.
   */
  async function runInterpret(cmds: readonly C[]): Promise<void> {
    for (const cmd of cmds) {
      const handler = interpretMap[cmd.type as C["type"]];
      if (!handler) continue;
      const follow = await trackInFlight(
        handler(
          cmd as Extract<C, { type: C["type"] }>,
          augmentedCtx,
          dispatchUnawaited,
        ),
      );
      if (follow !== undefined && follow !== null) {
        // The follow-up's rejection has no caller (the original dispatcher
        // resolved), so route it to the sink (invariant 6); name a failure Msg
        // via `tryInterpret` to fold it back into state.
        enqueueDispatch(follow as M).catch(reportUndelivered);
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
   * Instance-identity filter: is this message addressed to a DIFFERENT instance
   * than the one this state owns? When the machine declares an `identity`, a
   * `true` here drops the message before `update` runs, so the reducer never
   * sees a foreign-instance message and no cell needs a
   * `msg.runId !== state.runId` guard.
   *
   * A message with no identity (`ofMsg` → undefined) is identity-agnostic and
   * always proceeds. `ofState` → undefined means this instance has no identity
   * to defend yet (an `idle` state before any run is established), so an
   * addressed message there is identity-ESTABLISHING, not foreign. Drop only
   * when both identities are present and differ.
   *
   * Pure and synchronous; a throw is the caller's to supervise (see
   * `stepDispatch`).
   */
  function isMisaddressed(msg: M, current: S): boolean {
    if (machine.identity === undefined) return false;
    const addressed = machine.identity.ofMsg(msg);
    if (addressed === undefined) return false;
    const own = machine.identity.ofState(current);
    if (own === undefined) return false;
    return structuralHash(addressed) !== structuralHash(own);
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
    // The identity filter and the reducer are ONE synchronous user-code step,
    // and they are protected as one. The projections used to run above this
    // `try`, so a throwing `ofMsg` / `ofState` was neither reported nor
    // supervised while an identical throw one line later was both — and since
    // `structuralHash` throws on a bigint or a non-plain value, a snowflake-style
    // run id put EVERY dispatch on that unprotected path.
    //
    // The reentrancy brand guarantees this whole step cannot suspend, so a throw
    // here is clean with `state` still pre-transition; it routes to the declared
    // supervision strategy under `phase: "reduce"` — the transition's own
    // synchronous code failed, whichever half of it that was. Folding goes
    // through `applyCellChecked` — the single dev-checked
    // reducer-vs-transitions primitive `foldUpdates` also folds through (see
    // `pure/core.ts`).
    let next: S;
    let cmds: readonly C[];
    try {
      if (isMisaddressed(msg, state)) {
        // The drop advances nothing: no save, no reconcile, no interpret, no
        // listener/observer/event fire, no done-waiter settle — and it RESOLVES
        // the dispatch, because a mis-addressed message is not the caller's
        // error. That is exactly why it must be reported: without this the
        // caller cannot tell "applied" from "silently discarded", and a reusable
        // Durable Object serving run A then run B lost run B while reporting
        // success. `IdentityDropNotice` is a `RuntimeDiscardNotice` — warn by
        // default, never fatal (invariant 6: the enforcement point is
        // observable, which is what makes it ONE point).
        reportError(new IdentityDropNotice(msg.type), {
          phase: "identity-drop",
        });
        return;
      }
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
          gate = "closed";
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
   * subscribe calls also go through. Rejects when the gate is not open (with a
   * `DispatchDiscardedError` while `stop()` drains, a plain stopped Error once it
   * has), boot failed, or the reducer / save / sub start / interpret throws.
   */
  function enqueueDispatch(msg: M): Promise<void> {
    if (gate !== "open") {
      // The gate's state at refusal time IS the classification — the report
      // sites read the error class, never the message.
      return Promise.reject(
        gate === "draining"
          ? new DispatchDiscardedError(msg.type)
          : new Error("@demlik/tea: runtime stopped"),
      );
    }
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
      // Open the discard window unless the gate is already `"closed"` (a
      // supervision halt, or a redundant second `stop()`): the gate only
      // advances, so a Msg refused after a halt or after `stop()` returned stays
      // a loud error rather than being re-labelled a teardown discard.
      if (gate === "open") gate = "draining";
      // Report BEFORE the drain: after `await tail` the count is zero by
      // construction, and the fact worth surfacing is what was outstanding at
      // the moment the host let go. `stop()` drains, but every consumer of the
      // resulting transitions (listeners, observers, event handlers) is being
      // torn down with it, so those Cmds' results reach nobody (issue #365).
      if (inFlightCmds > 0) {
        reportError(new RuntimeDiscardedError(inFlightCmds), {
          phase: "discard",
        });
      }
      // Drain in-flight work. Tail rejections were swallowed at enqueue time, so
      // this await always resolves. The drain TERMINATES because the gate refuses
      // the follow-ups those handlers return — allowing them in instead would let
      // a handler chain extend the tail without end.
      await tail;
      // The barrier is now absolute: everything that was in flight has settled,
      // so a dispatch from here on is a consumer using a retired runtime.
      gate = "closed";
      // Run every active sub cleanup; throws isolated and routed to the sink.
      stopSubs([...subRegistry.keys()]);
      // Dispose every live dep-keyed source too (same throw-isolation).
      disposeDepSubs([...depSubRegistry.keys()]);
      // …then WAIT for the teardown work that is still settling — the ones
      // above, plus any async cleanup a mid-run reconcile started. `stop()`
      // resolving has to mean "teardown is done", or a host doing
      // `await stop(); env.evict()` drops the isolate mid-release and re-creates
      // the exact leak the managed-resource battery exists to prevent. Bounded
      // by `disposeTimeoutMs` so a release that never settles cannot hold the
      // host open (see `drainDisposals`).
      await drainDisposals();
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
