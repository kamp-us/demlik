/**
 * The core loop both engines run (#280, spike #264). It does five things and
 * nothing else: it keeps one serial tail, folds a Msg into a transition, saves
 * before any effect, reconciles the running Subs, and runs the transition's
 * Cmds, dispatching what they return. It has no special case for any built-in.
 *
 * One loop, not one per engine (#283). The loop calls a handler and a runner
 * through erased signatures and awaits a Promise either way, so an engine's
 * own types never pass through it. The Effect engine turns each handler and
 * runner into a fiber at its own edge, run with the services the caller
 * provided, so Effect services (`R`) reach every handler without the loop
 * carrying a type slot for them — the gap spike #260's generic loop left open.
 * Sharing the loop is also what makes the two engines' traces identical: the
 * fold, the save order and the built-ins are the same code.
 *
 * Everything else `run` offers is an {@link Extension} built on five points:
 *
 *   1. `update`    — middleware over the fold. Returning `null` means "no
 *                    transition": no save, no effects, no commit.
 *   2. `interpret` — middleware over one Cmd's handler call; it maps what the
 *                    handler returned to the Msg to dispatch, if any.
 *   3. `store`     — a wrapper over the store the caller handed `run`.
 *   4. `commit`    — called after a transition's effects, with the Msg and the
 *                    committed State. Boot passes `undefined` for the Msg.
 *   5. `ctx`       — keys added to the ctx every Cmd handler receives, so a
 *                    handler that runs another handler inside its own can reach
 *                    the same machinery the loop applies to it.
 *
 * An extension may also add methods to the run handle (`handle`). Array order
 * is nesting order: the first extension's middleware is the outermost, and
 * commit callbacks run first to last. `builtinExtensions` (`./builtins`) fixes
 * that order for every engine; it is not a user-facing plugin API (#268).
 *
 * `stop()` is the core's own lifecycle, because the gate it drives is what every
 * dispatch passes through: open → draining → closed, never backwards.
 */

import type { Dispose, Sub, SubEntry } from "../../pure/core";
import { desiredSub, detachWork } from "../../pure/core";
import type {
  DispatchSettle,
  OnError,
  RuntimeErrorContext,
  RuntimeErrorPhase,
  Store,
} from "../../runtime-types";
import {
  DispatchDiscardedError,
  DisposeTimeoutNotice,
  QuiescenceTimeoutError,
  RuntimeDiscardedError,
  RuntimeDiscardNotice,
} from "../../runtime-types";

// === The extension points ===

/** A fold's result: the next State and the Cmds it emits. */
export type Transition<S, C> = readonly [S, readonly C[]];

/** One fold step. `null` means the Msg produced no transition. */
export type Step<S, M, C> = (state: S, msg: M) => Transition<S, C> | null;

/**
 * One Cmd's handler call; resolves to the Msg to dispatch, or nothing.
 * `dispatch` is what the handler is handed for Msgs it fires itself, so an
 * extension can check them on the way out.
 */
export type InterpretStep<C, M> = (
  cmd: C,
  dispatch: (msg: M) => void,
) => Promise<unknown>;

/** What the loop lends an extension. */
export interface LoopServices<S> {
  /** Route a failure with no caller to the `onError` sink. */
  report(error: unknown, phase: RuntimeErrorPhase): void;
  /** Call `fn` for each item, routing every throw to the sink under `phase`. */
  fanout<T>(
    items: Iterable<T>,
    phase: RuntimeErrorPhase,
    fn: (item: T) => void,
  ): void;
  /** Close the gate for good: every later dispatch is refused. */
  halt(): void;
  /** The committed State, or `undefined` before boot has produced one. */
  state(): S | undefined;
}

/** One built-in, as the loop sees it. Every member is optional. */
export interface Extension<S, M, C> {
  readonly update?: (next: Step<S, M, C>) => Step<S, M, C>;
  readonly interpret?: (next: InterpretStep<C, M>) => InterpretStep<C, M>;
  readonly store?: (store: Store<S>) => Store<S>;
  readonly commit?: (msg: M | undefined, state: S) => void;
  readonly ctx?: object;
  readonly handle?: object;
}

/** An extension is built once per run, from the loop's services. */
export type ExtensionFactory<S, M, C> = (
  loop: LoopServices<S>,
) => Extension<S, M, C>;

/** A Cmd handler as the loop calls it. */
export type LoopHandler<M> = (
  cmd: never,
  ctx: unknown,
  dispatch: (msg: M) => void,
) => unknown;

/** A Sub runner as the loop calls it. */
export type LoopRunner<Ctx, M> = (
  sub: Sub,
  ctx: Ctx,
  dispatch: (msg: M) => void,
) => Dispose;

/** Everything the loop needs from `run`. */
export interface LoopConfig<S, M extends { type: string }, C, Ctx> {
  readonly init: (loaded: S | null, ctx: Ctx) => Transition<S, C>;
  /** The innermost fold: the machine's own `update`. */
  readonly reduce: (state: S, msg: M) => Transition<S, C>;
  readonly subs: readonly SubEntry<S>[];
  readonly runnerFor: (type: string) => LoopRunner<Ctx, M> | undefined;
  readonly handlerFor: (type: string) => LoopHandler<M> | undefined;
  readonly store: Store<S> | undefined;
  readonly ctx: Ctx;
  readonly onError: OnError | undefined;
  readonly disposeTimeoutMs: number;
  readonly idleCap: number;
  readonly extensions: readonly ExtensionFactory<S, M, C>[];
}

// === liveWork: "can anything still transition me without a dispatch?" ===
//
// The one read `driveToDone` needs that the public `Runtime` does not carry:
// after `start`'s chain quiesces, only a live Sub or an in-flight Cmd can still
// enqueue a transition; with neither, waiting is a leak (#68). Module-private
// and symbol-keyed so it reaches no export (the export map is the contract —
// MAINTAINING.md), yet enumerable so it survives the spread a wrapper does over
// the handle.
export const liveWork: unique symbol = Symbol("demlik-tea.liveWork");

/** The runtime's own sources of a caller-less transition, counted. */
export interface LiveWork {
  /** Live Subs — the running `machine.subs` entries. */
  readonly subs: number;
  /** Interpret handlers currently awaiting. */
  readonly cmds: number;
}

export interface LiveWorkProbe {
  readonly [liveWork]: () => LiveWork;
}

/** The members the core itself puts on the run handle. */
export interface LoopHandle<S, M> extends LiveWorkProbe {
  dispatch(msg: M, opts?: { readonly settle?: DispatchSettle }): Promise<void>;
  dispatchOnce(msg: M): Promise<void>;
  getState(): S;
  ready: Promise<unknown>;
  idle(): Promise<void>;
  stop(): Promise<void>;
}

// Default `onError` sink: re-throw on a fresh macrotask so the failure reaches
// the host's global error handler instead of vanishing — surface, not swallow
// (invariant 6).
//
// A `RuntimeDiscardNotice` is NOT a failure of the runtime's own contract — a
// host tearing a runtime down with Cmds in flight (a React ctx change, a
// navigation) is legal, merely lossy. Rethrowing it would make every
// unmount-during-fetch an uncaught error for consumers who never configured a
// sink, so the default WARNS: loud enough that the silent discard #365
// describes cannot happen again, never fatal. A configured `onError` sees
// `"discard"` like any other phase and can route or ignore it.
//
// The branch keys on the ERROR CLASS, never on `context.phase`: `report`
// hands a THROWING consumer sink's own error back here with the phase it was
// handling, so a phase-keyed branch would warn away a broken sink and re-create
// the very silent failure this exists to remove.
function defaultOnError(error: unknown, _context: RuntimeErrorContext): void {
  if (error instanceof RuntimeDiscardNotice) {
    console.warn(error);
    return;
  }
  setTimeout(() => {
    throw error;
  }, 0);
}

/**
 * Start the loop. Returns the handle synchronously; boot runs as the FIRST entry
 * on the serial tail. Save-then-effects ordering is structural: every
 * transition installs State, awaits the save, reconciles Subs, runs the Cmds,
 * then calls the commit callbacks.
 */
export function startLoop<S, M extends { type: string }, C, Ctx>(
  config: LoopConfig<S, M, C, Ctx>,
): LoopHandle<S, M> {
  const { idleCap, disposeTimeoutMs } = config;
  const onError: OnError = config.onError ?? defaultOnError;

  // A throwing sink routes THAT throw through `defaultOnError`, with the context
  // the sink was handling, so it cannot re-create a silent failure.
  function report(error: unknown, phase: RuntimeErrorPhase): void {
    const context: RuntimeErrorContext = { phase };
    try {
      onError(error, context);
    } catch (sinkError) {
      defaultOnError(sinkError, context);
    }
  }

  // Throw-isolated fanout: one bad consumer never strands its siblings
  // (invariant 6). The single home for that isolation discipline.
  function fanout<T>(
    items: Iterable<T>,
    phase: RuntimeErrorPhase,
    fn: (item: T) => void,
  ): void {
    for (const item of items) {
      try {
        fn(item);
      } catch (err) {
        report(err, phase);
      }
    }
  }

  // `state` is late-initialized: synchronously when there is no store to read,
  // otherwise inside the boot step (the head of the tail).
  let state: S | undefined;
  let bootError: unknown = null;
  // The dispatch gate. It only ever ADVANCES — `"open"` → `"draining"` →
  // `"closed"` — so the discard window can never re-open under a second `stop()`.
  //
  //   "open"     — normal operation; `enqueueDispatch` accepts.
  //   "draining" — inside `stop()`, before the tail has settled. New work is
  //                still refused (refusing is what makes the drain terminate),
  //                but a Msg refused HERE was discarded BY the teardown: an
  //                in-flight Cmd's follow-up, a detached handler's last Msg, or a
  //                Sub still live because subs are torn down after the drain. So
  //                the rejection is a `DispatchDiscardedError` reported under
  //                `phase: "discard"` — lossy, legal, warn-only.
  //   "closed"   — halted by an extension, or `stop()` has returned. A dispatch
  //                refused here is a consumer using a retired runtime — a real
  //                error, and it stays loud.
  let gate: "open" | "draining" | "closed" = "open";
  // Interpret handlers currently awaiting. Written only by `trackInFlight`, read
  // by `stop()` to make a mid-flight teardown LOUD instead of silent (#365).
  let inFlightCmds = 0;

  const services: LoopServices<S> = {
    report,
    fanout,
    halt() {
      gate = "closed";
    },
    state: () => state,
  };
  const extensions = config.extensions.map((make) => make(services));

  // The fold, the handler call and the store, each wrapped by the extensions
  // that ask for it. `reduceRight` makes the first extension the outermost.
  const update: Step<S, M, C> = extensions.reduceRight<Step<S, M, C>>(
    (next, ext) => (ext.update ? ext.update(next) : next),
    config.reduce,
  );
  const interpret: InterpretStep<C, M> = extensions.reduceRight<
    InterpretStep<C, M>
  >((next, ext) => (ext.interpret ? ext.interpret(next) : next), callHandler);
  const store: Store<S> | undefined =
    config.store === undefined
      ? undefined
      : extensions.reduceRight<Store<S>>(
          (inner, ext) => (ext.store ? ext.store(inner) : inner),
          config.store,
        );
  const commitCallbacks = extensions.flatMap((ext) =>
    ext.commit ? [ext.commit] : [],
  );

  // Copied into a fresh object so handlers get the contributed keys without
  // mutating the caller's ctx (which may be shared across runtimes / tests).
  // `Object.assign`, not a spread: tsc cannot prove a generic `Ctx` is an
  // object type, and a spread refuses it.
  const handlerCtx: unknown = Object.assign(
    {},
    config.ctx,
    ...extensions.map((ext) => ext.ctx ?? {}),
    { [detachWork]: detachInFlight },
  );

  // Every step chains onto `tail` — the single concurrency gate.
  let tail: Promise<void> = Promise.resolve();

  // The running Subs, keyed by their derived id. An id present here is a runner
  // that started and has not been disposed.
  const subRegistry = new Map<string, { type: string; dispose: Dispose }>();

  // Tear down each named sub: run its cleanup (throws routed to the sink under
  // `"sub-cleanup"`), then drop it from the registry regardless.
  function stopSubs(ids: Iterable<string>): void {
    for (const id of ids) {
      const running = subRegistry.get(id);
      if (running === undefined) continue;
      try {
        trackDisposal(running.dispose());
      } catch (err) {
        report(err, "sub-cleanup");
      }
      subRegistry.delete(id);
    }
  }

  // Teardown work that returned a Promise and has not settled. Reconcile runs
  // inside the synchronous transition path (invariant 2) and cannot await a
  // cleanup, so every async disposal is remembered here the moment it starts,
  // and `stop()` drains the set before resolving: `await runtime.stop()` then
  // means "teardown is done", the only reading a host evicting an isolate can
  // act on. The rejection is attached HERE, once, so it can never become an
  // unhandled rejection.
  const pendingDisposals = new Set<Promise<void>>();

  function trackDisposal(result: void | Promise<void>): void {
    if (!(result instanceof Promise)) return;
    const settling: Promise<void> = result
      .catch((err) => {
        report(err, "sub-cleanup");
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
   * host that never shuts down.
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
        report(
          new DisposeTimeoutNotice(outstanding.length, disposeTimeoutMs),
          "discard",
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Reconcile the running Subs against `state`, after every save. An id already
   * running is left alone, a running id no longer wanted is stopped, and a
   * wanted id not yet running is started through its runner.
   *
   * Every failure is collected, never thrown mid-pass, so one bad entry cannot
   * strand its siblings: a throwing `deps` leaves the running Subs of that type
   * untouched, and a throwing runner is not registered. The first error is
   * thrown after the pass. A Sub type with no runner is a failure too — nothing
   * would ever start it.
   */
  function reconcileSubs(): void {
    let firstError: unknown = null;
    const remember = (err: unknown): void => {
      if (firstError === null) firstError = err;
    };
    const desired = new Map<string, Sub>();
    // Types whose entry could not be read this pass: keep what is running.
    const unreadTypes = new Set<string>();
    for (const entry of config.subs) {
      try {
        const sub = desiredSub(entry, state as S);
        if (sub !== null) desired.set(sub.id, sub);
      } catch (err) {
        remember(err);
        unreadTypes.add(entry.type);
      }
    }

    stopSubs(
      [...subRegistry].flatMap(([id, running]) =>
        desired.has(id) || unreadTypes.has(running.type) ? [] : [id],
      ),
    );

    for (const [id, sub] of desired) {
      if (subRegistry.has(id)) continue;
      const runner = config.runnerFor(sub.type);
      if (runner === undefined) {
        remember(
          new Error(
            `@demlik/tea: no subscribe runner for Sub type "${sub.type}". ` +
              "Pass one to run in `subscribe`.",
          ),
        );
        continue;
      }
      try {
        // A runner's dispatch is unawaited by construction, so it gets the
        // wrapped form, which also queues the transition behind this step —
        // never on the runner's own stack (spike #260).
        const dispose = runner(sub, config.ctx, dispatchUnawaited);
        subRegistry.set(id, { type: sub.type, dispose });
      } catch (err) {
        remember(err);
      }
    }
    if (firstError !== null) throw firstError;
  }

  // The ONE `(msg) => void` handed to every producer that cannot await its own
  // dispatch: a Cmd handler's late tail, a Sub runner. Its rejection has no
  // caller, so it routes to the sink with the phase derived from the error
  // class (`reportUndelivered`). Handing those sites the raw `enqueueDispatch`
  // would turn a Sub firing during `stop()`'s drain into an unhandled rejection
  // the sink never sees.
  function dispatchUnawaited(msg: M): void {
    enqueueDispatch(msg).catch(reportUndelivered);
  }

  // A `DispatchDiscardedError` means the teardown refused the Msg (`"discard"`,
  // warn-only); anything else is a genuine failure of the follow-up itself.
  function reportUndelivered(error: unknown): void {
    report(
      error,
      error instanceof DispatchDiscardedError ? "discard" : "follow-up",
    );
  }

  /**
   * Count a handler's work as in flight for exactly the lifetime of its
   * promise. `finally`-balanced, so a rejecting handler can never strand the
   * count above zero. A handler that throws SYNCHRONOUSLY never reaches here,
   * which is correct — it was never in flight.
   */
  function trackInFlight<T>(work: T | Promise<T>): Promise<T> {
    inFlightCmds++;
    return Promise.resolve(work).finally(() => {
      inFlightCmds--;
    });
  }

  /**
   * Enlist work a handler will NOT return — the `detachWork` key on ctx. A
   * handler that fans out inside its own Cmd (ADR 0018) returns before its
   * effect finishes; handing the promise here puts it back on both accountings
   * a returned promise had: `trackInFlight`, so `stop()` still reports it, and
   * the serial `tail`, so `idle()` drains it. The tail extension is
   * SYNCHRONOUS, so a `drainToQuiescence` that already read `tail` sees the
   * reference change and loops again.
   */
  function detachInFlight(work: Promise<unknown>): void {
    const tracked = trackInFlight(work);
    tracked.catch(reportUndelivered);
    tail = tail
      .then(async () => {
        await tracked;
      })
      .catch(() => {});
  }

  // The innermost interpret step: call the Cmd's handler, if one is wired. A
  // missing handler returns nothing, which is invariant 6's forward progress
  // for a miswired consumer.
  function callHandler(cmd: C, dispatch: (msg: M) => void): Promise<unknown> {
    const handler = config.handlerFor((cmd as { type: string }).type);
    if (handler === undefined) return Promise.resolve(undefined);
    return trackInFlight(handler(cmd as never, handlerCtx, dispatch));
  }

  /**
   * Run each emitted Cmd. A returned Msg is enqueued onto the tail, never
   * dispatched re-entrantly. The first error stops further handlers in this
   * transition.
   *
   * THIS LOOP IS SERIAL BY RULING, NOT BY OVERSIGHT (ADR 0018). It runs a
   * transition's Cmds one at a time and never interleaves two handlers, so the
   * Msgs it enqueues fold in Cmd-EMISSION order and a replayed log reproduces
   * the same fold — invariant 2's serializability. Overlap in time belongs
   * INSIDE one Cmd's handler, never across the Cmds of one transition.
   */
  async function runCmds(cmds: readonly C[]): Promise<void> {
    for (const cmd of cmds) {
      const follow = await interpret(cmd, dispatchUnawaited);
      if (follow !== undefined && follow !== null) {
        enqueueDispatch(follow as M).catch(reportUndelivered);
      }
    }
  }

  // Install State, then save → reconcile subs → run Cmds → commit callbacks.
  // Save-before-effects is the hard ordering; tests pin it. Boot and every
  // transition end here; boot passes no Msg.
  async function commit(
    next: S,
    msg: M | undefined,
    cmds: readonly C[],
  ): Promise<void> {
    state = next;
    if (store) await store.save(next);
    reconcileSubs();
    await runCmds(cmds);
    for (const callback of commitCallbacks) callback(msg, next);
  }

  // One full transition. A `null` from the fold is no transition at all, and
  // it RESOLVES the dispatch. A throw from the fold rejects it.
  async function stepDispatch(msg: M): Promise<void> {
    if (state === undefined) {
      throw new Error("@demlik/tea: runtime not booted");
    }
    const transition = update(state, msg);
    if (transition === null) return;
    await commit(transition[0], msg, transition[1]);
  }

  // With NO store there is nothing to read, so `init` runs IMMEDIATELY and
  // `getState()` is observable synchronously (what `useSyncExternalStore`
  // consumers need to render the first commit without a flicker); an `init`
  // throw leaves `run` itself. With a store, the read is the first thing boot
  // awaits; a `load` or `migrate` throw rejects `ready`.
  const storeless: Transition<S, C> | null =
    store === undefined ? config.init(null, config.ctx) : null;
  if (storeless !== null) state = storeless[0];

  async function boot(): Promise<void> {
    // Boundary parse (invariant 8): `store.load()` returns `unknown`;
    // `store.migrate(raw)` is the required parse — `S` on a recognized shape,
    // `null` on an unrecognized one (boots fresh).
    const [initial, cmds] =
      storeless ??
      config.init(
        (store as Store<S>).migrate(await (store as Store<S>).load()),
        config.ctx,
      );
    await commit(initial, undefined, cmds);
  }

  /**
   * Enqueue a dispatch on the tail — the single gate re-entrant handler and
   * runner calls also go through. Rejects when the gate is not open (with a
   * `DispatchDiscardedError` while `stop()` drains, a plain stopped Error once
   * it has), boot failed, or the fold / save / sub start / handler throws.
   */
  function enqueueDispatch(msg: M): Promise<void> {
    if (gate !== "open") {
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
    // every later one. The original `next` still rejects for the caller.
    tail = next.catch(() => {});
    return next;
  }

  /**
   * Drain the serial tail to quiescence. Every follow-up reassigns `tail`
   * SYNCHRONOUSLY before its parent step resolves, so awaiting the current
   * `tail` and re-reading it catches every transitively enqueued follow-up.
   * Bounded by `idleCap` — on cap REJECT with `QuiescenceTimeoutError`, keeping
   * a livelock distinguishable from quiescence (invariant 6).
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
   * The public `dispatch`: await the Msg's OWN transition first (so its own
   * failure surfaces before any drain), then — unless `{ settle: "once" }` —
   * drain the transitive follow-up chain.
   */
  async function dispatchToQuiescence(
    msg: M,
    opts?: { readonly settle?: DispatchSettle },
  ): Promise<void> {
    await enqueueDispatch(msg);
    if (opts?.settle === "once") return;
    await drainToQuiescence();
  }

  // `bootPromise` is the un-swallowed promise `ready` chains off (so callers
  // see the boot error directly); `tail` gets the swallowed branch so a failed
  // boot does not poison every later dispatch's chain (each surfaces
  // `bootError` in `enqueueDispatch`).
  const bootPromise = boot();
  tail = bootPromise.catch((err) => {
    bootError = err;
  });

  const core: LoopHandle<S, M> = {
    [liveWork]: () => ({ subs: subRegistry.size, cmds: inFlightCmds }),
    dispatch: dispatchToQuiescence,
    dispatchOnce: enqueueDispatch,
    getState(): S {
      // TOTAL. A booted handle is only obtainable by awaiting `ready`, which
      // resolves AFTER boot set `state`.
      return state as S;
    },
    // A failed boot never hands out a handle. The forward reference resolves
    // at `.then` time, after `handle` below is built.
    ready: bootPromise.then(() => handle),
    idle: drainToQuiescence,
    async stop(): Promise<void> {
      // Open the discard window unless the gate is already `"closed"` (a halt,
      // or a redundant second `stop()`): the gate only advances.
      if (gate === "open") gate = "draining";
      // Report BEFORE the drain: after `await tail` the count is zero by
      // construction, and the fact worth surfacing is what was outstanding at
      // the moment the host let go (#365).
      if (inFlightCmds > 0) {
        report(new RuntimeDiscardedError(inFlightCmds), "discard");
      }
      // Drain in-flight work. Tail rejections were swallowed at enqueue time, so
      // this always resolves. It TERMINATES because the gate refuses the
      // follow-ups those handlers return.
      await tail;
      gate = "closed";
      stopSubs([...subRegistry.keys()]);
      // …then WAIT for the teardown still settling, bounded by
      // `disposeTimeoutMs` (see `drainDisposals`).
      await drainDisposals();
      // Flush final State. A save throw does not reject `stop()` (contract:
      // resolves regardless) but IS loss of the last write, so it reaches the
      // sink (invariant 6).
      if (store && state !== undefined && bootError === null) {
        try {
          await store.save(state);
        } catch (error) {
          report(error, "stop-save");
        }
      }
    },
  };
  const handle: LoopHandle<S, M> = Object.assign(
    core,
    ...extensions.map((ext) => ext.handle ?? {}),
  );
  return handle;
}
