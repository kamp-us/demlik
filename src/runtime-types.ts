/**
 * @demlik/tea runtime interface surface + pure helpers — the public types,
 * interfaces, and construction/composition helpers the runtime (`./run`)
 * implements against: `Store`, the error-sink and supervision contracts, the
 * `RuntimeRef` / `BootingRuntime` / `Runtime` handle hierarchy, `definePort`, the
 * identity-typed constructors `defineMachine` / `asReducer`, and the pure tools
 * `replay` (compose without running) and `tryInterpret` (Railway).
 */

import { Result } from "better-result";
import type { Machine, Port, Reducer, Sub, Transitions } from "./pure/core";
import { type Cmd, detectUpdateForm, foldUpdates } from "./pure/core";

// The nominal brand minted ONLY through the validated construction path
// (`asReducer` / `defineMachine`). A raw record of handlers is a structural
// `Reducer<S, M, C>`; a branded one has passed through the single minting
// boundary. The brand is an *optional* phantom so the structural annotation form
// (`const update: Reducer<...> = { ... }`) keeps accepting plain object literals
// — the guard that rejects an async reducer is `SyncReturn`'s non-thenable
// return, enforced on every cell.
declare const ReducerBrand: unique symbol;

// A `Reducer` (or `Transitions`) minted through `asReducer` / `defineMachine`.
// Carries the phantom brand; otherwise identical to its structural counterpart.
export type Branded<T> = T & { readonly [ReducerBrand]: true };

/**
 * Compile-time exhaustiveness assertion for default branches of switches over
 * discriminated unions narrowed by hand (Sub handlers, message-bridge
 * dispatchers, port fanouts) — TS narrows the operand to `never` only if every
 * variant is covered, so adding one produces a compile error at the `absurd(x)`
 * site. Strengthens invariant 7 (identity is explicit).
 *
 * @example
 *   switch (msg.type) {
 *     case "a": return ...;
 *     case "b": return ...;
 *     default: return absurd(msg);  // compile error if a "c" is added
 *   }
 */
export function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

// The explicit "this cell ignores this msg" helper. Naming the no-op forces the
// author to *decide* "this cell does nothing" (a real decision), distinct from
// "I forgot to write this cell" (which the mapped type rejects); an implicit
// wildcard would silently swallow a future Msg variant that should be handled.
// Assignable to any Transitions cell regardless of S/M/C concrete types.
export const noop = <S, M, C extends Cmd>(
  state: S,
  _msg: M,
): readonly [S, readonly C[]] => [state, []];

// Module-level registry — process-scope, identity-by-name. The runtime witness
// that every port name in this process is unique. Cleared only by the test-only
// `__resetPortRegistry()` helper.
const definedPortNames = new Set<string>();

/**
 * Thrown by `definePort` when a name has already been registered in the current
 * process. Symmetric with `SubIdCollisionError` (thrown by `reconcileSubs`) —
 * both mechanize invariant 7 (identity is explicit) at the runtime layer the
 * type system cannot reach (string names compared at runtime).
 */
export class PortNameCollisionError extends Error {
  override readonly name = "PortNameCollisionError";
  readonly _tag = "PortNameCollisionError" as const;
  constructor(portName: string) {
    super(
      `definePort: a port named "${portName}" was already defined. ` +
        `Each definePort call must use a unique name. ` +
        `If two modules need the same port, export it from one module and import it.`,
    );
  }
}

/**
 * Thrown by `reconcileSubs` when, within ONE desired subscription set, two subs
 * share an `id` but declare different `type`s — a silent bug class the type
 * system cannot reach (ids are strings compared at runtime). The symmetric twin
 * of `PortNameCollisionError`: both mechanize invariant 7 (identity is explicit)
 * at the runtime layer. Same id across transitions is the no-churn case and does
 * NOT throw; only a within-set type conflict does.
 */
export class SubIdCollisionError extends Error {
  override readonly name = "SubIdCollisionError";
  readonly _tag = "SubIdCollisionError" as const;
  constructor(id: string, declaredType: string, conflictingType: string) {
    super(
      `@demlik/tea: Sub.id collision: id="${id}" declared as ` +
        `type="${declaredType}" and type="${conflictingType}"`,
    );
  }
}

/**
 * Test-only escape hatch — clears the module-level port-name registry so the
 * collision assert in `definePort` doesn't false-positive across vitest's
 * non-isolated runs. Production code MUST NOT call this.
 *
 * @internal test-only
 */
export function __resetPortRegistry(): void {
  definedPortNames.clear();
}

/**
 * Which otherwise-unattributable runtime path produced an error. Every fanout is
 * throw-isolated so one bad consumer never strands its siblings, and the
 * isolated throw routes to the `OnError` sink rather than a bare `console.error`.
 *
 * - `"follow-up"` — a follow-up Msg an interpret handler returned rejected when
 *   re-dispatched (the original dispatcher already resolved, so no caller).
 * - `"stop-save"` — the final `store.save(state)` inside `stop()` threw
 *   (`stop()` resolves regardless, so without the sink this was silent loss).
 * - `"reduce"` — the pure `update` (reducer) threw synchronously; the configured
 *   `Supervision` strategy decides what happens next, but the throw is surfaced
 *   here as data first.
 * - `"listener"` — a `runtime.subscribe(...)` listener threw during fanout.
 * - `"observer"` — a `runtime.observe(...)` observer threw during fanout.
 * - `"event"` — the `events` projector or an `on(type, ...)` handler threw.
 * - `"boot"` — an `onBoot` handler threw (boot fanout, or a late registration).
 * - `"port-emit"` — a `subscribePort` listener threw during a port emission.
 * - `"sub-cleanup"` — a subscription's cleanup threw (reconcile-removal or
 *   `stop()` teardown).
 */
export type RuntimeErrorPhase =
  | "follow-up"
  | "stop-save"
  | "reduce"
  | "listener"
  | "observer"
  | "event"
  | "boot"
  | "port-emit"
  | "sub-cleanup";

/** Context handed to an `OnError` sink alongside the error itself. */
export interface RuntimeErrorContext {
  readonly phase: RuntimeErrorPhase;
}

/**
 * Sink for runtime failures that have no caller to reject at. Configured via
 * `run(machine, { onError })`. Should be total — a throw inside the sink is
 * itself surfaced via the default sink, so it can never re-introduce a silent
 * failure.
 */
export type OnError = (error: unknown, context: RuntimeErrorContext) => void;

// === Supervision: declared policy for a reducer throw ===
//
// A throw inside the pure `update` is a synchronous throw (the reentrancy brand
// makes a reducer provably synchronous), catchable in the dispatch loop — the
// seam Akka supervisor strategies / Erlang-OTP supervision trees occupy: "let it
// crash" becomes CONFIG. Every strategy routes the failure to `onError` with
// `phase: "reduce"` FIRST (invariant 6), then differs in what happens next:
//
//   - `stop`    — halt (SAFE DEFAULT). State is NOT advanced; the dispatch
//                 promise rejects; every subsequent dispatch rejects. Never a
//                 silent resume.
//   - `escalate`— surface + propagate: the dispatch promise rejects so the
//                 failure bubbles to a parent supervisor. The runtime stays live.
//   - `restart` — re-init from a host-provided last-known-good state and keep
//                 folding. The core owns no snapshot logic — the host supplies
//                 `rehydrate()`, the core installs its result and continues.

/** The three declared reducer-throw supervision strategies. */
export type SupervisionStrategy = "stop" | "escalate" | "restart";

/**
 * Declared supervision policy for a reducer (`update`) throw, at
 * `run(machine, { supervision })`. The bare-string shorthands (`"stop"` /
 * `"escalate"`) are accepted for the two strategies that need no host data;
 * `restart` MUST be the object form because it carries the `rehydrate` callback,
 * which MUST return a valid `S` synchronously (the reducer is synchronous, so
 * recovery is too — no suspension across the single-writer slot).
 */
export type Supervision<S, M extends { type: string }> =
  | "stop"
  | "escalate"
  | { readonly strategy: "stop" }
  | { readonly strategy: "escalate" }
  | {
      readonly strategy: "restart";
      /**
       * Host-provided rehydration to last-known-good state. Invoked when the
       * reducer throws; its return value becomes the new state and the transition
       * continues from there. Receives the pre-throw `state`, the `msg` that
       * triggered the throw, and the thrown `error` so the host can route by
       * cause.
       */
      readonly rehydrate: (state: S, msg: M, error: unknown) => S;
    };

/**
 * Raised by `idle()` when the quiescence wait hits its iteration cap without the
 * dispatch tail stabilizing — `idle()` REJECTS rather than silently resolving,
 * so a livelocking machine surfaces instead of masquerading as quiescent.
 * Mechanizes invariant 6 at the runtime layer, the role `PortNameCollisionError`
 * plays for invariant 7.
 */
export class QuiescenceTimeoutError extends Error {
  override readonly name = "QuiescenceTimeoutError";
  readonly _tag = "QuiescenceTimeoutError" as const;
  constructor(public readonly iterations: number) {
    super(
      `@demlik/tea: idle() did not reach quiescence after ${iterations} ` +
        `iterations — the dispatch tail kept advancing. The machine is ` +
        `likely livelocking (an interpret handler enqueues a follow-up Msg ` +
        `that enqueues another, without end). Bound the follow-up chain in ` +
        `the reducer, or stop the runtime.`,
    );
  }
}

/**
 * Define a typed port. `name` is metadata (devtools / debug logs); port identity
 * is by reference. Each definePort call must use a unique `name` — a second call
 * with the same name throws `PortNameCollisionError`. Use ports for "data leaving
 * the runtime selectively" (cursor announcements, DOM-mutation broadcasts,
 * telemetry) that should NOT be folded into State. Strengthens invariant 7.
 */
export function definePort<T>(name: string): Port<T> {
  // HMR skip — Vite / dev servers re-import the module on hot reload, which
  // would otherwise false-positive on every definePort across reloads. The
  // try/catch is load-bearing for service-worker bundles: Vite polyfills
  // `import.meta.url` via `document.baseURI`, which throws ReferenceError in
  // an MV3 service worker. A throw here would abort SW install (Chrome
  // surfaces it as "registration failed status 15"). Catching it = "no HMR
  // detected" = the collision check applies, which is the correct SW
  // behavior (SWs reload via chrome.runtime.reload, not module HMR).
  let isHmr = false;
  try {
    const meta = import.meta as { hot?: unknown };
    isHmr = meta?.hot !== undefined && meta?.hot !== null;
  } catch {
    isHmr = false;
  }
  if (!isHmr && definedPortNames.has(name)) {
    throw new PortNameCollisionError(name);
  }
  definedPortNames.add(name);
  return { __brand: "port", name } as Port<T>;
}

// === Store: pluggable persistence adapter ===
//
// `load()` returns `unknown` because storage genuinely doesn't know `S` —
// chrome.storage returns whatever JSON lives at the key, DurableObjectStorage
// returns whatever bytes were serialized. Casting raw storage to `S` at the
// adapter boundary is the exact `as S` move forbidden by invariant 8
// everywhere else in the substrate. `load()` returning `unknown` makes the
// substrate stop pretending.
//
// `migrate(raw)` is the boundary parse. Returns `S` on a recognized shape —
// the substrate passes it to `init` as `loaded`. Returns `null` on any
// unrecognized shape — the substrate passes `null` to `init`, fresh-boot
// path. Must NOT throw: if a future shape is unrecognizable, returning
// `null` boots clean from a known-good path. Throwing here would
// indistinguishably collapse "storage corruption" and "schema migration not
// yet written" — both are runtime decisions, not panics.
//
// Strengthens invariant 8 (the boundary parses; the core trusts) — the
// substrate now enforces the parse instead of relying on every adapter
// remembering to.
export interface Store<S> {
  load(): Promise<unknown>;
  save(state: S): Promise<void>;
  migrate(raw: unknown): S | null;
}

// === DispatchSettle: how far a dispatch awaits ===
//
// The default is the SAFE one, `"quiescent"` — `dispatch` resolves only once the
// entire transitive follow-up chain has drained (the same drain `idle()`
// performs). Were the default one transition, an `interpret` follow-up Msg would
// enqueue a fresh transition fire-and-forget relative to the original
// `dispatch`, resolving "early". The rare single-step case opts in with `"once"`
// (or the `dispatchOnce` convenience).
export type DispatchSettle = "quiescent" | "once";

// === RuntimeRef<M>: typed sibling-runtime handle ===
//
// Exposes only the inbox of a Runtime — `dispatch` / `dispatchOnce`. Use it as
// the field type when one runtime holds a *sibling* (composition by reduction
// across orthogonal lifecycles — invariant 5): the holder learns the Msg shape
// it can send, nothing about the referenced runtime's State/Cmd/Sub/Ctx/
// observers/Port fanout. `Runtime<S, M>` extends `RuntimeRef<M>` structurally.
export interface RuntimeRef<M extends { type: string }> {
  /**
   * Put a Msg in the runtime's inbox and resolve once processed. Runs to
   * QUIESCENCE by default: settles only after the dispatched Msg AND every
   * transitive interpret follow-up has drained. Pass `{ settle: "once" }` (or
   * call `dispatchOnce`) for the single-step case.
   *
   * Rejection ordering: the ONE dispatched transition's own failure surfaces
   * first, here. If it succeeds but the follow-up chain never stabilizes, the
   * quiescent drain rejects with `QuiescenceTimeoutError`. Follow-up Msg
   * rejections themselves route to the `onError` sink, never here.
   */
  dispatch(msg: M, opts?: { readonly settle?: DispatchSettle }): Promise<void>;
  /**
   * Dispatch `msg` and resolve after exactly ONE transition's effects settle,
   * WITHOUT draining the follow-up chain — equivalent to
   * `dispatch(msg, { settle: "once" })`. Prefer plain `dispatch` unless you will
   * `await runtime.idle()` yourself; the un-awaited follow-up chain is the
   * footgun the quiescent default removed.
   */
  dispatchOnce(msg: M): Promise<void>;
}

// === BootingRuntime: handle returned SYNCHRONOUSLY from run() ===
//
// `run()` returns a `BootingRuntime<S, M>` the instant it is called, while boot
// is still in flight. It exposes exactly the surface TOTAL before boot: queue a
// dispatch, subscribe, observe, wire a Port, stop. What you may NOT do is read
// State (`getState`) or wait for quiescence (`idle`) — those need the initial
// State to exist, and are the difference between a BootingRuntime and a
// `Runtime`, enforced at the type level so "read State before boot" is a COMPILE
// error, not a runtime throw.
//
// `subscribe` is the React-shaped change notifier (zero-arg, paired with
// `getState()`). `observe` is the devtools-shaped trace hook — `(msg, state)`
// for every APPLIED transition; boot is delivered via `onBoot` instead, so
// `observe`'s `msg` is total (never `null`). `on(type, handler)` is the SEMANTIC
// event channel: only the public, `type`-narrowed events a machine projects,
// never its PRIVATE Msg vocabulary. `E` defaults to `never` (no projector → `on`
// uncallable).
export interface BootingRuntime<
  S,
  M extends { type: string },
  E extends { type: string } = never,
> extends RuntimeRef<M> {
  dispatch(msg: M, opts?: { readonly settle?: DispatchSettle }): Promise<void>;
  dispatchOnce(msg: M): Promise<void>;
  subscribe(listener: () => void): () => void;
  observe(observer: (msg: M, state: S) => void): () => void;
  /**
   * Subscribe to the INITIAL State — the boot transition. Fires exactly once:
   * immediately if boot already completed (so a late subscriber never misses
   * it), otherwise on the boot fanout. Returns a cleanup (a no-op once fired).
   */
  onBoot(handler: (state: S) => void): () => void;
  /**
   * Subscribe to a SEMANTIC event of `type`. The handler receives exactly the
   * `E` member whose `type` matches `K`, so a consumer never touches another
   * event's shape and never references the machine's PRIVATE Msg names. Multiple
   * handlers per type; fanout is synchronous and throw-isolated. Fires only when
   * the machine's `events` projector (wired on `run`) emits that type.
   */
  on<K extends E["type"]>(
    type: K,
    handler: (event: Extract<E, { type: K }>) => void,
  ): () => void;
  /**
   * Subscribe to a typed Port. Multiple listeners per port; fanout is synchronous
   * and isolated. Ports are for "data leaving the runtime selectively" (see
   * `definePort`) — distinct from `observe` (every transition) and State.
   */
  subscribePort<T>(port: Port<T>, listener: (value: T) => void): () => void;
  /**
   * Emit a value on a Port from OUTSIDE an interpret handler — same synchronous
   * fanout as `ctx.emit`. The canonical use is `observe`-driven emission (one
   * runtime publishing a state-derived signal another subscribes to via
   * `subscribePort`) without spawning a "tell the outside world" Cmd per
   * transition.
   */
  emitPort<T>(port: Port<T>, value: T): void;
  /**
   * Resolves to the booted `Runtime<S, M>` after boot completes (or rejects with
   * the boot error). This is the ONLY way to obtain a `Runtime` — and a
   * `Runtime` is the only handle whose `getState()` is total. Awaiting `ready` is
   * the single gate between "boot in flight" and "State exists":
   *
   * ```ts
   * const runtime = await run(machine, opts).ready;
   * runtime.getState(); // total — never throws-before-boot
   * ```
   *
   * Idempotent — the same settled promise, resolving to the same `Runtime`, comes
   * back on every read. Expresses canon §2.3 (boot is a named, awaitable moment).
   */
  ready: Promise<Runtime<S, M, E>>;
  stop(): Promise<void>;
}

// === Runtime: the BOOTED handle `ready` resolves to ===
//
// A `BootingRuntime<S, M>` whose boot has completed. It adds the two members
// only meaningful once the initial State exists — `getState()` (total) and
// `idle()` (quiescence) — and narrows `ready` to resolve to itself. You never
// construct one directly; you obtain it via `await bootingRuntime.ready`, which
// makes "read State before boot" unrepresentable rather than merely discouraged.
export interface Runtime<
  S,
  M extends { type: string },
  E extends { type: string } = never,
> extends BootingRuntime<S, M, E> {
  /**
   * The current State. TOTAL — never throws. Obtaining a `Runtime` requires
   * awaiting `ready`, which only resolves AFTER boot has run `init` and set the
   * initial State.
   */
  getState(): S;
  /** Resolves to this same `Runtime` once boot completes. Idempotent. */
  ready: Promise<Runtime<S, M, E>>;
  /**
   * Resolves once the runtime has reached QUIESCENCE — every dispatched Msg AND
   * every transitive interpret follow-up has been processed, with no further step
   * pending on the tail. Since plain `dispatch` already runs to quiescence, this
   * is mainly for follow-ups left by a `dispatchOnce` single step, or a chain
   * kicked off by a Sub / boot `init` cmds with no `dispatch` to await.
   *
   * Idempotent and re-entrant-safe. Tail rejections are NOT surfaced here (a
   * failing dispatch surfaces on its OWN promise; follow-up rejections route to
   * `onError`). The one rejection `idle()` produces is `QuiescenceTimeoutError`
   * on hitting the iteration cap — so a livelock stays distinguishable from a
   * genuine quiesce (invariant 6). A poll is still correct when waiting on an
   * EXTERNAL event the runtime cannot enqueue itself.
   */
  idle(): Promise<void>;
  /**
   * The terminal State of the run, or `undefined` while in flight — "terminal"
   * per the `terminal` predicate passed to `run()` (no predicate → never
   * terminal → always `undefined`). The first-class result read: the run's
   * product off the State the machine already owns, NOT scraped off the `observe`
   * firehose by matching an internal Msg name. Total — never throws.
   */
  result(): S | undefined;
  /**
   * Resolves with the terminal State the first time the run reaches one (per the
   * `terminal` predicate). If ALREADY terminal, resolves immediately; otherwise
   * on the transition that first makes `terminal` hold. The awaitable companion
   * to `result()`. With no predicate this never resolves. Idempotent and
   * multi-caller safe.
   */
  done(): Promise<S>;
}

// === defineMachine: identity-typed pass-through ===
//
// Overloads enforce exactly one `update` shape per call so consumers see a
// concrete type, not the internal union. Runtime is identity — `run` branches on
// the structural shape of `update` (Reducer = record of functions; Transitions =
// record of records) when dispatching, so overload resolution picks the right
// branch by value shape. Strengthens invariant 2 (record forms have no
// fall-through default) and invariant 7 (the variant set is load-bearing).

// Transitions-form overload — 2D table keyed by State.type then Msg.type.
// Declared FIRST (most specific). The S constraint is a conditional (`S extends
// { type: string } ? Transitions<...> : never`) not a generic-parameter
// constraint, so `S` stays unconstrained at the signature and the public
// `Parameters<typeof defineMachine<NonDiscriminatedS, ...>>` pattern skips this
// overload (update becomes `never`) instead of failing.
export function defineMachine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  m: Omit<Machine<S, M, C, U, Ctx>, "update"> & {
    // `[S]` tuple-wrap disables distributive conditional behavior — see
    // the comment on `Machine.update` for why distribution is wrong here.
    update: [S] extends [{ type: string }] ? Transitions<S, M, C> : never;
  },
): Machine<S, M, C, U, Ctx>;
// Reducer-form overload — flat record keyed by Msg.type.
export function defineMachine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  m: Omit<Machine<S, M, C, U, Ctx>, "update"> & {
    update: Reducer<S, M, C>;
  },
): Machine<S, M, C, U, Ctx>;
// Implementation signature — accepts both via the union on `Machine.update`.
export function defineMachine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(m: Machine<S, M, C, U, Ctx>): Machine<S, M, C, U, Ctx> {
  // Tag the update form ONCE, here at the typed construction boundary, so no
  // downstream reader re-derives it structurally. Non-enumerable so it does not
  // serialize, show up in `Object.keys`, or collide with a Msg.type key.
  // Idempotent under re-wrap (`defineMachine(defineMachine(m))`).
  if (m.__form === undefined) {
    Object.defineProperty(m, "__form", {
      value: detectUpdateForm(m.update as object),
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  return m;
}

// === asReducer: the validated minting path for a reducer ===
//
// Turns a raw record of handlers into a branded `Reducer<S, M, C>`. The
// parameter type's every cell returns the non-thenable `SyncReturn<S, C>`, so
// the reentrancy guard fires HERE, at construction: an `async` cell returns
// `Promise<...>`, not assignable to `SyncReturn`, and `tsc` rejects it. PURE —
// identity at runtime (the brand is phantom). `defineMachine` brands its
// `update` internally the same way, so this exists for the standalone `const
// update = asReducer<...>({ ... })` form.
export function asReducer<S, M extends { type: string }, C extends Cmd>(
  reducer: Reducer<S, M, C>,
): Branded<Reducer<S, M, C>> {
  return reducer as Branded<Reducer<S, M, C>>;
}

// === CtxArg<Ctx>: the `ctx` field of `run`'s opts, conditionally optional ===
//
// A PURE machine reads nothing from `ctx` (its `Ctx` is `NoCtx` /
// `Record<string, never>` / `unknown`); forcing `ctx: {}` is ceremony for a
// value the type already pins as empty. So `ctx` is CONDITIONALLY optional: when
// `{}` satisfies `Ctx` it may be OMITTED (defaulted to `{}`), so a pure reducer
// runs as `run(machine)`; when `Ctx` carries a field a handler reads, `ctx` stays
// REQUIRED. `[Record<never, never>] extends [Ctx]` reads as "is `{}` assignable
// to `Ctx`" — true for the context-free shapes, false for `{ db: … }`; the
// tuple-wrap disables distributive conditional behavior.
export type CtxArg<Ctx> = [Record<never, never>] extends [Ctx]
  ? { ctx?: Ctx }
  : { ctx: Ctx };

// === replay: pure unit-test helper ===
//
// Composes `init(loaded ?? null, ctx)` then `update(state, msg)` for each msg.
// Returns the final state plus the cmds that *would* have been emitted and the
// subs that *would* have been desired at the final state. It does NOT call any
// `interpret[type]` handler, does NOT touch `Store`, and does NOT start any
// subscription. `subscriptions` IS called to derive `subs` — that lets tests
// assert what would be wired up without actually wiring it.
export function replay<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: { msgs: readonly M[]; ctx: Ctx; loaded?: S | null },
): { state: S; cmds: C[]; subs: U[] } {
  // Coerce undefined → null so `replay` with `loaded: undefined` calls
  // `init(null, ctx)`.
  const loaded = opts.loaded ?? null;
  const [initialState, initCmds] = machine.init(loaded, opts.ctx);

  if (loaded !== null && initCmds.length > 0) {
    throw new Error(
      "TEA contract violation: machine.init must return [state, []] (no Cmds) " +
        "when `loaded` is non-null. Init's rehydrate branch is a pure state " +
        "passthrough — the migration/parse boundary, not the boot-effect hook.\n\n" +
        "Routes for boot effects:\n" +
        "  - Stateless infrastructure (e.g. chrome.alarms ensure) → host module " +
        "top level, outside TEA.\n" +
        "  - State-conditional resume (e.g. re-attach a session) → a `boot` Msg " +
        "dispatched once from the host after `run(...)` returns, handled in update.\n\n" +
        "See .patterns/tea/tea-invariants.md (Invariant 2).",
    );
  }

  // `replay` and `foldMsgs` share ONE internal fold (`foldUpdates`), keyed on
  // `formOf` — the same reader `run` uses — so all three agree on the
  // reducer-vs-transitions form by construction.
  const { state, cmds: foldedCmds } = foldUpdates<S, M, C>(
    machine,
    initialState,
    opts.msgs,
  );
  const cmds: C[] = [...initCmds, ...foldedCmds];

  const subs: U[] = machine.subscriptions
    ? [...machine.subscriptions(state)]
    : [];

  return { state, cmds, subs };
}

// === tryInterpret: Railway sugar over `Result.tryPromise` ===
//
// Wraps a fallible `(cmd, ctx) => Promise<Ok>` into a handler for
// `interpret[type]`: on success resolves `onOk(value, cmd)`, on rejection
// `onErr(error, cmd)`. It NEVER rejects (assuming `onOk`/`onErr` are total).
//
// We use the `{try, catch: (e) => e}` form (not the one-arg thunk) so the
// original error passes through untouched — the one-arg form wraps errors in
// `UnhandledException`, which would break `instanceof` checks inside `onErr`.
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
