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
  RequiredCtx,
  Sub,
} from "./pure/core";
import {
  applyCellChecked,
  type Cmd,
  cmdEdge,
  cmdEdgeOver,
  depsInactive,
  structuralHash,
} from "./pure/core";
import type {
  BootingRuntime,
  CtxArg,
  DispatchSettle,
  FencedStore,
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
  DriveFailedError,
  DriveStalledError,
  IdentityDropNotice,
  isFencedStore,
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

// === liveWork: "can anything still transition me without a dispatch?" ===
//
// The one read `driveToDone` needs that the public `Runtime` does not carry:
// after `start`'s chain quiesces on a non-terminal State, only a live Sub or an
// in-flight Cmd can still enqueue a transition; with neither, waiting is a leak
// (#68). Module-private and symbol-keyed so it reaches no export (the export map
// is the contract — MAINTAINING.md), yet enumerable so it survives the spread a
// wrapper does over the handle.
const liveWork: unique symbol = Symbol("demlik-tea.liveWork");

/** The runtime's own sources of a caller-less transition, counted. */
interface LiveWork {
  /** Live Subs — manual (`subscriptions`) plus dep-keyed (`subs`). */
  readonly subs: number;
  /** Interpret handlers currently awaiting. */
  readonly cmds: number;
}

interface LiveWorkProbe {
  readonly [liveWork]: () => LiveWork;
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
  // `Ctx & RequiredCtx<C>`: the machine's own ctx PLUS every typed Cmd's `R`
  // (ADR 0014 §3). A machine whose Cmds need `{ http }` cannot be run without
  // it — the missing dependency is a compile error here, not `undefined` in a
  // handler at 3 a.m.
  opts: CtxArg<Ctx & RequiredCtx<C>> & {
    store?: Store<S>;
    onError?: OnError;
    /**
     * The clock that stamps `at` on a `Cmd.define`d effect's settled Msg at
     * the interpret edge. Defaults to `Date.now`. Inject a fixed one for a
     * deterministic run; a `replay` log carries its own `at`s and never reads
     * this.
     */
    clock?: () => number;
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
  // Fencing is a property of the store the caller handed us, never a flag on
  // `run` (#143): a store that can refuse a second writer says so, and this is
  // the one place that decides to use it. `fencedVersion` is the version this
  // run last observed — read at boot, advanced by every accepted save. A save
  // that finds a different version throws `StoreConflictError` out of the store,
  // which is exactly the refusal the loser deserves.
  const fenced = store !== undefined && isFencedStore(store) ? store : null;
  let fencedVersion = 0;

  // The read half: take the bytes and remember the version they came at, so the
  // first save can swap against it.
  async function readFenced(from: FencedStore<S>): Promise<unknown> {
    const read = await from.loadFenced();
    fencedVersion = read.version;
    return read.raw;
  }

  // The one write path. Every `store.save` in this runtime goes through here so
  // the fenced and unfenced stores cannot drift apart at a call site.
  async function persist(next: S): Promise<void> {
    if (fenced) {
      fencedVersion = await fenced.saveFenced(next, fencedVersion);
      return;
    }
    if (store) await store.save(next);
  }
  // `ctx` is conditionally optional (see `CtxArg`); default the nullish case to
  // `{}` so the augmented-ctx spread and `init(loaded, ctx)` get a value.
  const ctx = (opts.ctx ?? {}) as Ctx & RequiredCtx<C>;
  const clock = opts.clock ?? Date.now;
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

  // The interpret edge over the typed constructors (`Cmd.define`) this machine
  // declared: parses a handler's `_ok` value and stamps `at`; a pass-through
  // for a machine of hand-written Cmds. Applied to every handler's return in
  // `runInterpret`, and handed to the handlers on ctx so a wrapper that
  // composes a base handler inside its own settles through the same edge.
  const settleAtEdge = cmdEdgeOver(machine.cmds ?? [], clock);

  // Copied into a fresh object so handlers get a Ctx & PortEmitter without
  // mutating the caller's ctx (which may be shared across runtimes / tests).
  // `Object.assign`, not a spread: `RequiredCtx<C>` is an intersection tsc
  // cannot prove is an object type while `C` is generic, and a spread refuses it.
  const augmentedCtx: Ctx & RequiredCtx<C> & PortEmitter = Object.assign(
    {},
    ctx,
    { emit: portEmit, [cmdEdge]: settleAtEdge },
  );

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
      const returned = await trackInFlight(
        handler(
          cmd as Extract<C, { type: C["type"] }>,
          // The handler's cell demands `Ctx & NeedsOf<its Cmd>`; the runtime
          // holds `Ctx & RequiredCtx<C>` — the intersection over EVERY Cmd, so
          // a superset of any one cell's slice. The widening is sound by
          // construction; `tsc` cannot see through the generic `C` to prove it.
          augmentedCtx as Parameters<typeof handler>[1],
          dispatchUnawaited,
        ),
      );
      const follow = settleAtEdge(cmd, returned);
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
    await persist(next);
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
      // A fenced store reads its version in the same breath as its bytes, and
      // the boot save below is a compare-and-swap like every other. Note which
      // run loses: reading here means a LATER starter reads the current version
      // and swaps cleanly, so it takes the fence and the older live writer is
      // refused at ITS next save. Only a true race — both booting off the same
      // version before either wrote — is refused HERE, before any effect fires.
      const raw = fenced ? await readFenced(fenced) : await store.load();
      const parsed = store.migrate(raw);
      const [initialState, initCmds] = machine.init(parsed, ctx);
      state = initialState;
      pendingInitCmds = initCmds;
      await persist(state);
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

  const runtime: Runtime<S, M, E> & LiveWorkProbe = {
    [liveWork]: () => ({
      subs: subRegistry.size + depSubRegistry.size,
      cmds: inFlightCmds,
    }),
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
          await persist(state);
        } catch (error) {
          reportError(error, { phase: "stop-save" });
        }
      }
    },
  };

  return runtime;
}

/**
 * Is the runtime provably out of ways to transition on its own? True only when
 * the handle carries the `liveWork` read and it counts zero live Subs and zero
 * in-flight Cmds. A handle without the read (a wrapper that rebuilt the object
 * without spreading it) cannot be proven stalled, so the drive keeps waiting —
 * the pre-#68 contract, never a false stall.
 */
function isStalled(runtime: object): boolean {
  const probe = (runtime as Partial<LiveWorkProbe>)[liveWork];
  if (probe === undefined) return false;
  const live = probe();
  return live.subs === 0 && live.cmds === 0;
}

/**
 * The outside-in stop, as a PAIR. A signal is only cancellation if something can
 * turn "aborted" into a transition this machine understands, and the kernel has
 * no built-in cancel Msg any more than it has a built-in terminal set — so the
 * `signal` and the `cancel` that reads it are one option, present together or
 * absent together. A discriminated union rather than two optional fields, on the
 * same reasoning as `AgentCompactionConfig`: a signal with no `cancel` is a stop
 * button wired to nothing, and that is a state worth making unrepresentable
 * rather than checking for.
 */
type DriveCancellation<S, M> =
  | {
      readonly signal?: undefined;
      readonly cancel?: undefined;
    }
  | {
      /**
       * Abort the run through this signal. On abort the drive dispatches
       * `cancel`'s Msg and resolves on the State that lands — it does NOT reject,
       * and a cancellation is never a `DriveFailedError`. Already aborted when
       * the drive is called → the cancel Msg goes in place of `start`, so the
       * run ends without the start's effects ever firing.
       */
      readonly signal: AbortSignal;
      /**
       * The Msg that settles this machine as cancelled, chosen off the current
       * State exactly as `start` is. PURE. It must land a State `isTerminal`
       * holds for — the drive resolves on the terminal predicate, not on the
       * abort — and that State should be DURABLE, or a reload resumes the run
       * its caller stopped.
       */
      readonly cancel: (state: S) => M;
    };

/** Options for `driveToDone`. */
export type DriveToDoneOptions<
  S,
  M extends { type: string } = never,
> = DriveCancellation<S, M> & {
  /**
   * Marks a terminal State as a FAILURE. A State this holds for ends the drive
   * like any terminal one — the runtime is stopped — but the drive REJECTS with
   * `DriveFailedError` carrying it instead of resolving. A failed State is
   * terminal by definition; it need not also satisfy `isTerminal`. Omit → the
   * drive never rejects on State, only on a runtime error.
   */
  readonly failed?: (state: S) => boolean;
};

/**
 * Drive a machine from `start` to its terminal State in one call, then tear the
 * runtime down. The one-shot shape every "run this machine to done" test and
 * caller boundary otherwise hand-wires as six steps — `await ready`, `observe`,
 * park a promise, `dispatch(start)`, `getState()`, `stop()` — with the observer
 * leak and the forgotten `stop` those six steps invite.
 *
 * Takes the handle `run()` returns (a `Runtime` extends it, so a booted one is
 * accepted too), awaits `ready`, dispatches `start`, and resolves with the first
 * State for which `isTerminal` holds. A machine that boots already terminal (a
 * rehydrated finished run) resolves on its boot State and `start` is never
 * dispatched — a finished run has nothing to set in motion. `start` may be a
 * function of the boot State instead of a Msg: a machine rehydrated MID-run
 * needs its resume Msg, not its start Msg, and only the boot State says which
 * (the agent's `agent_boot` vs `agent_start` is the case in point). The
 * observer is detached and `stop()` awaited on EVERY exit: resolve, `failed`,
 * a stall, a boot or dispatch throw, the quiescence cap.
 *
 * Rejections are typed, never silent:
 *   - `DriveFailedError<S>` when `opts.failed` marks the final State — the State
 *     rides on `error.state`.
 *   - `DriveStalledError<S>` when `start`'s follow-up chain quiesces on a State
 *     that is neither terminal nor `failed` and the runtime has no live Sub and
 *     no Cmd in flight — nothing inside it can deliver another transition, so
 *     waiting would be a hang with the runtime leaked. The stalled State rides
 *     on `error.state`. A machine that CAN still move is not stalled: a live Sub
 *     (manual or dep-keyed) that delivers the terminal Msg after the dispatch
 *     quiesces keeps the drive waiting, and it resolves on that State. What the
 *     runtime cannot see — a dispatch from outside it after quiescence — does
 *     not count as live; a machine that depends on one declares it as a Sub.
 *   - `QuiescenceTimeoutError` when `start`'s follow-up chain never settles —
 *     the SAME cap `dispatch` and `idle()` already reject on (invariant 6), not a
 *     second clock. A livelocking machine surfaces as its own failure class.
 *   - the boot error, or whatever `dispatch(start)` rejects with, otherwise.
 *
 * `isTerminal` is caller-supplied, exactly as `run()`'s `terminal` option is —
 * the kernel has no built-in terminal-set concept and this does not add one.
 *
 * Cancellation is the same story: `{ signal, cancel }` stops the drive from
 * outside, and it settles the run rather than escaping it. On abort the drive
 * dispatches `cancel`'s Msg and RESOLVES on the terminal State that transition
 * lands — no rejection, no `DriveFailedError`, no `AbortError`. That is the whole
 * point of routing a stop through the Model: the outcome is durable, so a killed
 * process resumes reading a run that ended instead of restarting one someone
 * stopped. In-flight effects are not recalled — a promise cannot be cancelled —
 * so they settle to their own end and `stop()` drains them as it always did;
 * keeping their results off the public channels is the machine's own business.
 * Omit the pair and every path here behaves exactly as it did before.
 *
 * @param handle     the handle `run(machine, opts)` returned.
 * @param start      the Msg that sets the run in motion, or a function choosing
 *                   it off the boot State. PURE.
 * @param isTerminal the terminal predicate over the machine's State. PURE.
 * @param opts       an optional `failed` predicate and an optional
 *                   `{ signal, cancel }` pair (see {@link DriveToDoneOptions}).
 */
export async function driveToDone<
  S,
  M extends { type: string },
  E extends { type: string } = never,
>(
  handle: BootingRuntime<S, M, E>,
  start: M | ((booted: S) => M),
  isTerminal: (state: S) => boolean,
  opts: DriveToDoneOptions<S, M> = {},
): Promise<S> {
  const failed = opts.failed ?? (() => false);
  const settles = (state: S): boolean => isTerminal(state) || failed(state);
  let detach: (() => void) | undefined;
  let unlisten: (() => void) | undefined;
  try {
    const runtime = await handle.ready;
    // A run that rehydrated already terminal has nothing to start: resolve on
    // the boot State without dispatching, so `start`'s Cmds are never left in
    // flight for `stop()` to discard. Read BEFORE the signal so a run that
    // already ended keeps the outcome it ended on — an abort arriving after the
    // fact does not restate a finished run as cancelled.
    const booted = runtime.getState();
    if (settles(booted)) {
      if (failed(booted)) throw new DriveFailedError(booted);
      return booted;
    }
    // Attach BEFORE dispatching so a terminal transition landing inside the
    // start dispatch is caught.
    const terminal = new Promise<S>((resolve) => {
      detach = runtime.observe((_msg, state) => {
        if (settles(state)) resolve(state);
      });
    });
    // An abort mid-run enqueues the cancel Msg on the SAME serial tail every
    // other dispatch uses, so it lands between transitions rather than inside
    // one. Work already enqueued when the abort arrives still folds; work the
    // machine would have enqueued after it does not, because the cancelled State
    // is terminal and its verbs stop emitting. `dispatchOnce` (not `dispatch`)
    // because the cancel has no follow-up chain to drain, and a rejection —
    // the runtime already tearing down — is nothing this drive can act on: the
    // terminal it is racing settles the outcome either way.
    if (opts.signal !== undefined) {
      const { signal, cancel } = opts;
      const onAbort = () => {
        runtime.dispatchOnce(cancel(runtime.getState())).catch(() => {});
      };
      // Already aborted → cancel INSTEAD of starting, so `start`'s effects (a
      // model call, for the agent) never fire at all.
      if (signal.aborted) {
        onAbort();
        return await terminal;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      unlisten = () => signal.removeEventListener("abort", onAbort);
    }
    // The race lets a dispatch rejection (reducer / interpret throw, the
    // quiescence cap) surface here instead of floating as an unhandled rejection
    // while the terminal await parks forever.
    const msg = typeof start === "function" ? start(booted) : start;
    const started = runtime.dispatch(msg).then(() => {
      // Quiesced. A settling State already went through the observer, so
      // `terminal` is resolved; otherwise the wait is legitimate only while the
      // runtime itself can still transition. With no live Sub and no Cmd in
      // flight nothing is coming, and the wait becomes the hang #68 names.
      const parked = runtime.getState();
      if (!settles(parked) && isStalled(runtime)) {
        throw new DriveStalledError(parked);
      }
      return terminal;
    });
    const state = await Promise.race([terminal, started]);
    if (failed(state)) throw new DriveFailedError(state);
    return state;
  } finally {
    detach?.();
    // The abort listener outlives this call unless it is removed: a signal a
    // caller reuses across runs would otherwise accumulate one dispatch per run
    // it has already finished.
    unlisten?.();
    // `stop()` resolves by contract, so awaiting it here cannot mask the error
    // a rejecting branch above is carrying.
    await handle.stop();
  }
}
