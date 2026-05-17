/**
 * @b8e/tea — TEA-faithful state machine substrate.
 *
 * This module exposes the full Locked API Surface from the PRD as types and
 * implements `defineMachine` (identity, task 1), `run` (task 2), and
 * `replay` + `tryInterpret` (task 3).
 *
 * `replay` is the pure unit-test tool: it composes `init` + `update` only,
 * never touches `Store`, never calls `interpret`, never starts subscriptions.
 *
 * `tryInterpret` is Railway sugar — wraps a fallible async function and routes
 * Ok/Err to two Msg constructors via better-result.
 */

import { Result } from "better-result";

// === Cmd: tagged-union, one-shot effect ===
export type Cmd<T extends string = string> = { type: T };

// === Sub: tagged-union, continuous source of msgs; stable id used for diff/reconcile ===
export type Sub<T extends string = string> = { id: string; type: T };

// === Machine: pure data, host-agnostic ===
export interface Machine<S, M, C extends Cmd, U extends Sub, Ctx> {
  init: (loaded: S | null, ctx: Ctx) => readonly [S, readonly C[]];
  update: (state: S, msg: M) => readonly [S, readonly C[]];
  interpret: {
    [K in C["type"]]: (cmd: Extract<C, { type: K }>, ctx: Ctx) => Promise<M | void>;
  };
  subscriptions?: (state: S) => readonly U[];
  subscribe?: {
    [K in U["type"]]: (
      sub: Extract<U, { type: K }>,
      ctx: Ctx,
      dispatch: (msg: M) => void,
    ) => () => void;
  };
}

// === Store: pluggable persistence adapter ===
export interface Store<S> {
  load(): Promise<S | null>;
  save(state: S): Promise<void>;
}

// === Runtime: handle returned from run() ===
export interface Runtime<S, M> {
  dispatch(msg: M): Promise<void>;
  getState(): S;
  subscribe(listener: () => void): () => void;
  stop(): Promise<void>;
}

// === defineMachine: identity-typed pass-through ===
export function defineMachine<S, M, C extends Cmd, U extends Sub, Ctx>(
  m: Machine<S, M, C, U, Ctx>,
): Machine<S, M, C, U, Ctx> {
  return m;
}

// === run: implemented in task 2 ===
//
// Returns a `Runtime<S, M>` synchronously. Boot (`store?.load()` + `init`) runs
// asynchronously as the FIRST entry on the serial dispatch tail; every public
// runtime method (`dispatch`, `stop`, `getState`) awaits the boot phase
// implicitly through the queue. Failures inside `store.load` propagate via the
// boot promise — subsequent calls reject/throw with that error. There is no
// "synchronous load" branch because `Store#load` is async by contract.
//
// Save-then-effects ordering is structural: every transition mutates state,
// awaits `store.save(newState)`, then reconciles subscriptions, then runs
// `interpret` for emitted cmds, then fires external listeners. A throw in any
// effect phase leaves the persisted state ahead of the host's belief about
// what executed — the Railway discipline (`tryInterpret` in handlers) makes
// that safe in practice.
export function run<S, M, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: { ctx: Ctx; store?: Store<S> },
): Runtime<S, M> {
  const { ctx, store } = opts;

  // Holders are intentionally late-initialized: `state` is set inside the boot
  // step, which runs as the head of the tail. `getState()` before boot throws.
  let state: S | undefined;
  let bootError: unknown = null;
  let stopped = false;

  const subRegistry = new Map<string, () => void>();
  const listeners = new Set<() => void>();

  // The serial dispatch queue: every step is chained onto `tail`. New dispatch
  // calls (and re-entrant ones from interpret follow-ups) wait for the
  // previous step to fully resolve before running their reducer. This is the
  // single concurrency gate.
  let tail: Promise<void> = Promise.resolve();

  /**
   * Reconcile subscriptions against `state`. Called after every save.
   *
   * - Same id present in old + new → leave running.
   * - Removed id → call cleanup. Swallow cleanup throws + `console.error`.
   * - New id → call subscribe[type]; on success store cleanup. On throw, the
   *   sub is NOT registered; throw is remembered and re-thrown after the loop
   *   so all other new subs still register.
   */
  function reconcileSubs(): void {
    if (!machine.subscriptions) return;
    const desired = machine.subscriptions(state as S);
    const desiredIds = new Set<string>();

    // Removals first — anything in the registry not in `desired` should stop.
    for (const sub of desired) desiredIds.add(sub.id);
    for (const [id, cleanup] of subRegistry) {
      if (!desiredIds.has(id)) {
        try {
          cleanup();
        } catch (err) {
          console.error(err);
        }
        subRegistry.delete(id);
      }
    }

    // Additions — anything in `desired` not in the registry should start.
    let firstStartError: unknown = null;
    for (const sub of desired) {
      if (subRegistry.has(sub.id)) continue;
      const handler = machine.subscribe?.[sub.type as U["type"]];
      if (!handler) {
        // No handler for this sub type — programmer error; skip. (TS would
        // normally forbid this at compile time when `subscribe` is provided
        // and U has variants, but a runtime guard is cheap.)
        continue;
      }
      try {
        const cleanup = handler(sub as Extract<U, { type: U["type"] }>, ctx, enqueueDispatch);
        subRegistry.set(sub.id, cleanup);
      } catch (err) {
        if (firstStartError === null) firstStartError = err;
        // Do NOT register; continue to next sub so other starts still run.
      }
    }
    if (firstStartError !== null) throw firstStartError;
  }

  /**
   * Run `interpret` for each emitted cmd. Each handler may return a follow-up
   * Msg — that Msg is enqueued onto the tail (NOT dispatched re-entrantly
   * inside the current transition).
   *
   * Throws propagate to the caller of `step`. The first error stops further
   * handlers in this transition.
   */
  async function runInterpret(cmds: readonly C[]): Promise<void> {
    for (const cmd of cmds) {
      const handler = machine.interpret[cmd.type as C["type"]];
      if (!handler) continue;
      const follow = await handler(cmd as Extract<C, { type: C["type"] }>, ctx);
      if (follow !== undefined && follow !== null) {
        // Schedule follow-up Msg on the tail. The current step resolves
        // first; the follow-up runs after, as a fresh transition. Swallow the
        // returned rejection — fire-and-forget at this site; the runtime
        // never re-throws follow-up errors at the dispatcher of the original
        // cmd. If you need observable error handling, name a failure Msg via
        // `tryInterpret` (Railway).
        enqueueDispatch(follow as M).catch(() => {});
      }
    }
  }

  /**
   * Fire every external listener. Listener throws are isolated — one bad
   * listener does not strand the others. This is the dual of cleanup
   * semantics: the runtime guarantees forward progress for unrelated
   * observers.
   */
  function fireListeners(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch (err) {
        console.error(err);
      }
    }
  }

  /**
   * One full transition: update → save → reconcile subs → interpret → fire
   * listeners. Save-before-effects is the hard ordering; tests pin it.
   *
   * Throws from `update` propagate immediately (state unchanged). Throws from
   * `save` propagate after the in-memory `state` is advanced (PRD row: "state
   * advanced; persisted state did not"). Throws from reconcile or interpret
   * propagate after `save` has succeeded (PRD row: "state already saved").
   */
  async function stepDispatch(msg: M): Promise<void> {
    if (state === undefined) {
      // This should never happen — boot always runs before any dispatch.
      throw new Error("@b8e/tea: runtime not booted");
    }
    const [next, cmds] = machine.update(state, msg);
    state = next;
    if (store) await store.save(state);
    // Subscriptions reconcile against the new state; throws propagate AFTER
    // the entire diff pass completes (so other subs still register / clean
    // up correctly). Cleanup throws are swallowed inside reconcileSubs.
    reconcileSubs();
    await runInterpret(cmds);
    fireListeners();
  }

  /**
   * Boot is split into two phases.
   *
   * - **Synchronous (`run()` call):** when `store` is absent, we know `loaded
   *   = null` without an await — run `init(null, ctx)` IMMEDIATELY so that
   *   `getState()` is observable synchronously. This is what
   *   `useSyncExternalStore` consumers (e.g. `@b8e/tea-react`) need to render
   *   on the first commit without an undefined-state flicker.
   * - **Asynchronous (`stepBootEffects` on the tail):** save + sub reconcile
   *   + interpret-of-init-cmds + listener fire. These run as the first tail
   *   entry; subsequent dispatches queue behind them.
   *
   * When `store` IS present we cannot do `init` synchronously (we'd be
   *  inventing a loaded value), so we keep the full async path. Components
   * that want synchronous initial state in that case should omit the store
   * for the React mount and persist via a different mechanism (or accept the
   * default-snapshot story in a future v2).
   *
   * `store.load` throws propagate via the boot promise; subsequent calls
   * reject with the load error. (The PRD row "run() throws synchronously" is
   * imprecise relative to Store#load being async — we honor the intent: no
   * usable runtime is ever observable on load failure.)
   */
  // Synchronous init when there is NO store: `getState()` is observable
  // synchronously by `useSyncExternalStore` consumers. When a store IS
  // present, `init` must run AFTER `store.load()` (the contract: `init`
  // receives the loaded snapshot), and callers must await boot before
  // calling `getState()` — they do so implicitly via the first `dispatch()`
  // (which queues behind the boot step).
  //
  // The asymmetry is the substrate being honest about a real constraint: a
  // store is, by definition, an async boundary. Components that need
  // synchronous initial state under a store should await the runtime's boot
  // before mounting — `await runtime.ready` (not provided in v1; use `await
  // runtime.dispatch(noopMsg)` if needed, or a parent-level loading state).
  let pendingInitCmds: readonly C[] = [];
  if (!store) {
    const [initialState, initCmds] = machine.init(null, ctx);
    state = initialState;
    pendingInitCmds = initCmds;
  }

  async function stepBootEffects(): Promise<void> {
    if (store) {
      const loaded = await store.load();
      const [initialState, initCmds] = machine.init(loaded, ctx);
      state = initialState;
      pendingInitCmds = initCmds;
      await store.save(state);
    }
    reconcileSubs();
    await runInterpret(pendingInitCmds);
    fireListeners();
  }

  /**
   * Enqueue a dispatch on the tail. Re-entrant calls from interpret or
   * subscribe handlers go through this same gate — guaranteeing serial
   * execution across the entire system.
   *
   * `dispatch` rejects when:
   * - the runtime is stopped (next dispatch always rejects after stop);
   * - boot failed (every dispatch surfaces the boot error);
   * - the reducer, save, sub start, or interpret throws.
   */
  function enqueueDispatch(msg: M): Promise<void> {
    if (stopped) return Promise.reject(new Error("@b8e/tea: runtime stopped"));
    const next = tail.then(() => {
      if (bootError !== null) throw bootError;
      return stepDispatch(msg);
    });
    // Swallow the rejection on the tail so a single failing dispatch does NOT
    // poison every subsequent one. The original `next` promise still rejects
    // for the dispatch caller.
    tail = next.catch(() => {});
    return next;
  }

  // Kick off boot-effects immediately. Boot rejections are remembered on
  // `bootError`; they surface on every subsequent dispatch call. Note: when
  // `store` is absent the synchronous-init step above already set `state` —
  // `stepBootEffects` only runs save/sub/interpret/listener-fire. When
  // `store` is present, the full async path runs here.
  tail = stepBootEffects().catch((err) => {
    bootError = err;
  });

  const runtime: Runtime<S, M> = {
    dispatch: enqueueDispatch,
    getState(): S {
      if (bootError !== null) throw bootError;
      // Synchronous-init path (no store): `state` is set inside `run()`
      // before this getter can ever be called → returns immediately. Resumed
      // path (store present): `state` becomes defined after
      // `stepBootEffects` awaits `store.load()`; calls before that throw.
      // The `booted` flag is no longer a precondition — `state !==
      // undefined` is the single source of truth that init information is
      // available.
      if (state === undefined) {
        throw new Error("@b8e/tea: getState() called before runtime booted");
      }
      return state;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async stop(): Promise<void> {
      stopped = true;
      // Drain whatever is in flight before tearing down. Any rejections in
      // the tail were already swallowed at enqueue time, so this await
      // always resolves.
      await tail;
      // Run every active sub cleanup. Throws are swallowed + logged so one
      // bad cleanup does not strand the others.
      for (const [id, cleanup] of subRegistry) {
        try {
          cleanup();
        } catch (err) {
          console.error(err);
        }
        subRegistry.delete(id);
      }
      // Flush final state. A save throw here is logged but does not reject
      // `stop()` — the contract is "returns a resolved Promise".
      if (store && state !== undefined && bootError === null) {
        try {
          await store.save(state);
        } catch (err) {
          console.error(err);
        }
      }
    },
  };

  return runtime;
}

// === replay: pure unit-test helper ===
//
// Composes `init(loaded ?? null, ctx)` then `update(state, msg)` for each msg.
// Returns the final state plus the cmds that *would* have been emitted and the
// subs that *would* have been desired at the final state.
//
// Crucially:
// - does NOT call any `interpret[type]` handler
// - does NOT touch `Store`
// - does NOT start any subscription via `machine.subscribe?.[type]`
//
// `subscriptions` (the description function) IS called to derive the returned
// `subs` array. That's intentional — it lets tests assert what would be wired
// up without actually wiring it.
export function replay<S, M, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: { msgs: readonly M[]; ctx: Ctx; loaded?: S | null },
): { state: S; cmds: C[]; subs: U[] } {
  // `init` is `(loaded: S | null, ctx) => ...`; coerce undefined → null so the
  // AC "`replay` with `loaded: undefined` calls `init(null, ctx)`" holds.
  const loaded = opts.loaded ?? null;
  const [initialState, initCmds] = machine.init(loaded, opts.ctx);

  let state: S = initialState;
  const cmds: C[] = [...initCmds];

  for (const msg of opts.msgs) {
    const [next, emitted] = machine.update(state, msg);
    state = next;
    cmds.push(...emitted);
  }

  const subs: U[] = machine.subscriptions ? [...machine.subscriptions(state)] : [];

  return { state, cmds, subs };
}

// === tryInterpret: Railway sugar over `Result.tryPromise` ===
//
// Wraps a fallible `(cmd, ctx) => Promise<Ok>` and returns a handler suitable
// for `interpret[type]`. On success the returned function resolves with
// `onOk(value, cmd)`; on rejection it resolves with `onErr(error, cmd)`. It
// NEVER rejects (assuming `onOk`/`onErr` are total — that's the caller's
// contract).
//
// Implementation note: we use the `{try, catch: (e) => e}` form of
// `Result.tryPromise` rather than the one-arg `(thunk)` form so the original
// error passes through untouched. The one-arg form wraps errors in
// `UnhandledException`, which would prevent callers from `instanceof`-checking
// their own error types inside `onErr`.
//
// M is a Msg type (not a Cmd) — the helper routes Ok/Err to two Msg constructors.
export function tryInterpret<C extends Cmd, Ok, M, Ctx>(
  work: (cmd: C, ctx: Ctx) => Promise<Ok>,
  onOk: (value: Ok, cmd: C) => M,
  onErr: (error: unknown, cmd: C) => M,
): (cmd: C, ctx: Ctx) => Promise<M> {
  return async (cmd, ctx) => {
    const result = await Result.tryPromise({
      try: () => work(cmd, ctx),
      catch: (error: unknown): unknown => error,
    });
    return result.match({
      ok: (value) => onOk(value, cmd),
      err: (error) => onErr(error, cmd),
    });
  };
}
