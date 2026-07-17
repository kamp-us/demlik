/**
 * @demlik/tea — TEA-faithful state machine substrate.
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
import type {
  Machine,
  Port,
  PortEmitter,
  Reducer,
  Sub,
  Transitions,
} from "./pure/core";
import {
  __DEV__,
  applyCell,
  assertPureResult,
  type Cmd,
  deepFreeze,
  detectUpdateForm,
  foldUpdates,
} from "./pure/core";

export type {
  ContextFree,
  Interpret,
  Machine,
  NoCtx,
  Port,
  PortEmitter,
  Reducer,
  Sub,
  SubId,
  Subscribe,
  SyncReturn,
  Transitions,
  UpdateForm,
} from "./pure/core";
// Re-export the pure-core surface so the root `@demlik/tea` entry is unchanged
// (additive; the runtime-free guarantee lives on `@demlik/tea/pure`).
export {
  applyCell,
  Cmd,
  detectUpdateForm,
  foldMsgs,
  formOf,
  msgKeysOf,
  NoCellError,
  subId,
} from "./pure/core";

// The nominal brand minted ONLY through the validated construction path
// (`asReducer` / `defineMachine`). Mirrors `retry-backoff`'s `RngBrand`: a raw
// record of handlers is a structural `Reducer<S, M, C>`, but a `Reducer` that
// also carries this phantom brand is one that has passed through the single
// minting boundary. The brand is an *optional* phantom so the structural
// `Reducer<S, M, C>` annotation form (`const update: Reducer<...> = { ... }`)
// keeps accepting plain object literals — the guard that actually rejects an
// async reducer is `SyncReturn`'s non-thenable return, enforced on every cell.
declare const ReducerBrand: unique symbol;

// A `Reducer` (or `Transitions`) that has been minted through `asReducer` /
// `defineMachine`. Carries the phantom brand; otherwise identical to its
// structural counterpart.
export type Branded<T> = T & { readonly [ReducerBrand]: true };

// === absurd: compile-time exhaustiveness assertion ===
//
// Use in default branches of switches over discriminated unions where every
// case should be handled explicitly. TS narrows the operand to `never` only
// if every variant has been covered upstream; adding a new variant produces
// a compile error at the `absurd(x)` site.
//
// The substrate's `Reducer<S, M, C>` and `Transitions<S, M, C>` forms cover
// the reducer-side exhaustiveness with mapped types — no `absurd` needed
// there. This helper exists for the OTHER boundaries where a discriminated
// union is narrowed by hand: Sub handlers mapping a wire-protocol
// discriminant to flat Msg variants, message-bridge dispatchers, port
// fanouts, etc. Without it, consumers redeclare the same 3-line helper
// across files; with it, the substrate owns the one canonical version.
//
// Strengthens invariant 7 (identity is explicit).
/**
 * Compile-time exhaustiveness assertion. Use in default branches of
 * switches over discriminated unions where every case should be handled
 * explicitly — TS narrows the type to `never` only if every variant has
 * been covered. Strengthens invariant 7 (identity is explicit).
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

// === noop: the explicit "this cell ignores this msg" helper ===
//
// Elm's fallback for unhandled (state × msg) pairs is implicit:
// `_ -> (model, Cmd.none)` in a case expression. We make it explicit because
// implicit no-ops are silent regressions waiting to happen — a future Msg
// variant that *should* be handled gets swallowed by the wildcard.
//
// Naming the no-op forces the author to *decide*: "this cell does nothing"
// is a real decision, distinct from "I forgot to write this cell." The
// mapped type rejects the second case; `noop` names the first.
//
// Assignable to any Transitions cell regardless of S/M/C concrete types
// (the type parameters are free) — drop it into any cell without per-type
// casts.
export const noop = <S, M, C extends Cmd>(
  state: S,
  _msg: M,
): readonly [S, readonly C[]] => [state, []];

// Module-level registry — process-scope, identity-by-name. The set is the
// runtime witness that every port name in this process is unique. Cleared
// only by the test-only `__resetPortRegistry()` helper.
const definedPortNames = new Set<string>();

/**
 * Thrown by `definePort` when a name has already been registered in the
 * current process. Symmetric with the `Sub.id` collision assert in
 * `reconcileSubs` — both mechanize invariant 7 (identity is explicit) at the
 * runtime layer the type system cannot reach (string names compared at
 * runtime, not at compile time).
 */
export class PortNameCollisionError extends Error {
  override readonly name = "PortNameCollisionError";
  constructor(portName: string) {
    super(
      `definePort: a port named "${portName}" was already defined. ` +
        `Each definePort call must use a unique name. ` +
        `If two modules need the same port, export it from one module and import it.`,
    );
  }
}

/**
 * Test-only escape hatch — clears the module-level port-name registry so the
 * collision assert in `definePort` doesn't false-positive across vitest's
 * non-isolated runs. Production code MUST NOT call this; the registry is the
 * invariant-7 witness for the process lifetime.
 *
 * @internal test-only
 */
export function __resetPortRegistry(): void {
  definedPortNames.clear();
}

// === Runtime error sink (invariant 6 — no silent failures) ===
//
// The runtime has points where a failure has no natural caller to reject at:
// a follow-up Msg an interpret handler enqueued (the original dispatcher
// already resolved), and the final `store.save` during `stop()` (whose
// contract is a resolved Promise). Historically both were swallowed —
// `.catch(() => {})` and a bare `console.error` — which violates invariant 6:
// the runtime must be inspectable; no silent failures.
//
// `RuntimeErrorContext` tags WHICH swallowed path produced the error so a sink
// can route by phase. `OnError` is the sink itself, configured at `run(...)`.
// When no sink is provided the runtime uses `defaultOnError`, which RE-THROWS
// on a fresh macrotask — surfacing to the host's unhandled-rejection / global
// error handler rather than vanishing. The default surfaces; it never swallows.

/**
 * Which otherwise-unattributable runtime path produced an error.
 *
 * - `"follow-up"` — a follow-up Msg an interpret handler returned rejected
 *   when re-dispatched. The original dispatcher already resolved, so this
 *   rejection has no caller; without the sink it was swallowed.
 * - `"stop-save"` — the final `store.save(state)` inside `stop()` threw.
 *   `stop()` resolves regardless (its contract), so without the sink this was
 *   silent loss of the last write.
 * - `"reduce"` — the pure `update` (reducer) threw synchronously while folding
 *   a Msg. #71's reentrancy brand makes a reducer provably synchronous, so this
 *   throw is catchable in the dispatch loop; the configured `Supervision`
 *   strategy decides what the runtime does next (`stop` / `escalate` /
 *   `restart`), but the failure is ALWAYS surfaced here as data first.
 */
export type RuntimeErrorPhase = "follow-up" | "stop-save" | "reduce";

/** Context handed to an `OnError` sink alongside the error itself. */
export interface RuntimeErrorContext {
  readonly phase: RuntimeErrorPhase;
}

/**
 * Sink for runtime failures that have no caller to reject at. Configured via
 * `run(machine, { onError })`. Should be total — a throw inside the sink is
 * itself surfaced via `defaultOnError`, so the sink can never re-introduce a
 * silent failure.
 */
export type OnError = (error: unknown, context: RuntimeErrorContext) => void;

/**
 * Default `onError` sink: re-throw on a fresh macrotask so the failure reaches
 * the host's global error / unhandledRejection handler instead of vanishing.
 * Used whenever `run(...)` is called without an explicit `onError`. The least
 * surprising default — it surfaces rather than swallows (invariant 6) without
 * forcing every caller to wire a sink.
 */
function defaultOnError(error: unknown, _context: RuntimeErrorContext): void {
  setTimeout(() => {
    throw error;
  }, 0);
}

// === Supervision: declared policy for a reducer throw (ADR 0003 #4) ===
//
// The resilience kit (retry, circuit-breaker, …) covers *effect* failures —
// throws inside `interpret`. A throw inside the pure `update` (the reducer) had
// no declared policy: it simply rejected the dispatch promise and left the
// runtime in an ambiguous "did we halt or not?" state. #71's reentrancy brand
// makes a reducer provably synchronous, so a reducer throw is now a synchronous
// throw catchable in the dispatch loop. This is the seam Akka supervisor
// strategies / Erlang-OTP supervision trees occupy: "let it crash" becomes
// CONFIG, not hope.
//
// Every strategy routes the failure to the `onError` sink with `phase:
// "reduce"` FIRST (invariant 6 — errors are data, never silently swallowed),
// then differs in what the runtime does next:
//
//   - `stop`    — halt the runtime. State is NOT advanced; the dispatch promise
//                 rejects with the reducer error; every subsequent dispatch
//                 rejects ("runtime stopped"). The SAFE DEFAULT: a reducer that
//                 violated its own invariants does not get to keep folding.
//                 Never a silent resume.
//   - `escalate`— surface via `onError` AND propagate: the dispatch promise
//                 rejects with the reducer error so the failure bubbles to the
//                 caller/parent supervisor. The runtime is NOT halted (a parent
//                 may choose to keep dispatching) — escalation is "tell someone
//                 above me", not "die".
//   - `restart` — re-initialize from a host-provided last-known-good state and
//                 keep folding. The core does NOT own snapshot logic; the host
//                 supplies `rehydrate()`, the core invokes it, installs its
//                 result as the new state, and continues the transition
//                 (save → reconcile → interpret → fire) from there. The
//                 original failure is still surfaced as data via `onError`.
//
// The restart rehydrate is a host callback by design: the core has no opinion
// on where last-known-good state lives (a snapshot Store, an in-memory cache, a
// recomputed default). Mirrors how `Store` keeps persistence out of core.

/** The three declared reducer-throw supervision strategies. */
export type SupervisionStrategy = "stop" | "escalate" | "restart";

/**
 * Declared supervision policy for a reducer (`update`) throw, configured at
 * `run(machine, { supervision })`.
 *
 * - `{ strategy: "stop" }` — halt + surface (the safe default; also the bare
 *   shorthand `"stop"`).
 * - `{ strategy: "escalate" }` — surface + propagate, runtime stays live (also
 *   the bare shorthand `"escalate"`).
 * - `{ strategy: "restart", rehydrate }` — surface, then re-init from the
 *   host-supplied last-known-good `S` and keep folding. `rehydrate` receives
 *   the failing `(state, msg, error)` so the host can log / pick a snapshot;
 *   it MUST return a valid `S` synchronously (the reducer is synchronous, so
 *   recovery is too — no suspension across the single-writer slot).
 *
 * The bare-string shorthands (`"stop"` / `"escalate"`) are accepted for the two
 * strategies that need no host data; `restart` MUST be the object form because
 * it carries the `rehydrate` callback.
 */
export type Supervision<S, M extends { type: string }> =
  | "stop"
  | "escalate"
  | { readonly strategy: "stop" }
  | { readonly strategy: "escalate" }
  | {
      readonly strategy: "restart";
      /**
       * Host-provided rehydration to last-known-good state. Invoked by the core
       * when the reducer throws; its return value becomes the new state and the
       * transition continues from there. Receives the pre-throw `state`, the
       * `msg` that triggered the throw, and the thrown `error` so the host can
       * route by cause.
       */
      readonly rehydrate: (state: S, msg: M, error: unknown) => S;
    };

/**
 * Normalize the `Supervision` config (bare string or object) into a single
 * object shape so the dispatch loop branches on `.strategy` once. The default
 * — applied when `run(...)` is called without `supervision` — is `stop`: the
 * explicit, safe choice. It surfaces via `onError` and halts; it never silently
 * resumes a machine whose reducer just violated an invariant (invariant 6).
 */
type NormalizedSupervision<S, M extends { type: string }> =
  | { readonly strategy: "stop" }
  | { readonly strategy: "escalate" }
  | {
      readonly strategy: "restart";
      readonly rehydrate: (state: S, msg: M, error: unknown) => S;
    };

function normalizeSupervision<S, M extends { type: string }>(
  supervision: Supervision<S, M> | undefined,
): NormalizedSupervision<S, M> {
  if (supervision === undefined) return { strategy: "stop" };
  if (typeof supervision === "string") return { strategy: supervision };
  return supervision;
}

/**
 * Raised by `idle()` when the quiescence wait hits its iteration cap without
 * the dispatch tail stabilizing. Replaces the old silent fall-through-resolve
 * (which made "the loop quiesced" indistinguishable from "we gave up"):
 * `idle()` now REJECTS with this so a livelocking machine surfaces instead of
 * masquerading as quiescent.
 *
 * Mechanizes invariant 6 (no silent failures) at the runtime layer — the same
 * role `PortNameCollisionError` plays for invariant 7.
 */
export class QuiescenceTimeoutError extends Error {
  override readonly name = "QuiescenceTimeoutError";
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
 * Define a typed port. `name` is metadata (shown in devtools / debug logs);
 * port identity is by reference. Each definePort call must use a unique
 * `name` — a second call with the same name throws
 * `PortNameCollisionError`. If two modules need the same port, export it
 * from one module and import it from the other.
 *
 * Use ports for "data leaving the runtime selectively" — e.g. cursor
 * announcements, DOM-mutation broadcasts, telemetry events that should NOT be
 * folded into State and should NOT be observed by every transition listener.
 *
 * Strengthens invariant 7 (identity is explicit) — the runtime assert is the
 * Port-side counterpart of `SubId`'s id collision check in `reconcileSubs`.
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
// `dispatch(msg)` settles ONE transition by default would be the dangerous
// choice (issue #50): an `interpret` handler that returns a follow-up Msg
// enqueues a FRESH transition on the tail, and that follow-up is fire-and-
// forget relative to the original `dispatch`. Callers that forgot to also
// `await idle()` saw their dispatch resolve "early", before the consequences
// of the Msg had run — which is why the codebase grew a dispatch+`idle()`
// wrapper and tests fell back to `for (i<200) sleep(5)` polls.
//
// So the default is the SAFE one: `"quiescent"` — `dispatch` resolves only
// once the entire transitive follow-up chain has drained (the same drain
// `idle()` performs). The rare single-step case (a caller that genuinely wants
// one transition and will await the tail itself) opts in with `"once"`, or
// uses the `dispatchOnce` convenience.
export type DispatchSettle = "quiescent" | "once";

// === RuntimeRef<M>: typed sibling-runtime handle ===
//
// A `RuntimeRef<M>` exposes only the inbox of a Runtime — `dispatch(msg)` (and
// its single-step sibling `dispatchOnce(msg)`).
// Use it as the field type when one runtime holds a reference to a *sibling*
// runtime (composition by reduction across orthogonal lifecycles — invariant
// 5). The holder learns the Msg shape it can send, nothing about the
// referenced runtime's State, Cmd, Sub, Ctx, observers, listeners, or Port
// fanout. That asymmetry is the point: cross-runtime coupling collapses to
// "I can put a Msg in your inbox", which is the smallest coordination
// surface that preserves typed cross-runtime calls.
//
// `Runtime<S, M>` extends `RuntimeRef<M>` structurally — every Runtime is
// trivially a RuntimeRef. The narrowing happens at the *consumer's* Ctx
// type, not via a runtime cast.
//
// Strengthens invariant 5 (composition by reduction — sibling runtimes
// coordinate through the narrowest typed surface) and invariant 6 (runtime
// is small and inspectable — what a holder *can* do to a sibling runtime is
// exactly one method, not the full surface).
export interface RuntimeRef<M extends { type: string }> {
  /**
   * Put a Msg in the runtime's inbox and resolve once it has been processed.
   *
   * Runs to QUIESCENCE by default (issue #50): the returned promise settles
   * only after the dispatched Msg AND every follow-up Msg its `interpret`
   * handlers (transitively) returned have drained off the serial tail. This is
   * the safe default — `await dispatch(msg)` means "the consequences have run",
   * not "one transition fired and the rest are racing". Pass
   * `{ settle: "once" }` (or call `dispatchOnce`) for the rare single-step
   * case where the caller will await the tail itself.
   *
   * Rejection ordering: the ONE dispatched transition's own failure (a reducer
   * / save / sub-start / interpret throw) surfaces first, on this promise. If
   * that transition succeeds but the follow-up chain never stabilizes, the
   * quiescent drain rejects with `QuiescenceTimeoutError` (same cap and same
   * no-silent-give-up contract as `idle()` — issue #51). Follow-up Msg
   * rejections themselves route to the `onError` sink, never here.
   */
  dispatch(msg: M, opts?: { readonly settle?: DispatchSettle }): Promise<void>;
  /**
   * Dispatch `msg` and resolve after exactly ONE transition's effects settle,
   * WITHOUT draining the follow-up chain. Equivalent to
   * `dispatch(msg, { settle: "once" })`.
   *
   * This is the old (pre-#50) `dispatch` behavior, kept as an explicit escape
   * hatch: a caller that wants to interleave its own work between the first
   * transition and its follow-ups, then `await runtime.idle()` itself. Prefer
   * plain `dispatch` (run-to-quiescence) unless you specifically need the
   * single step — the un-awaited follow-up chain is exactly the footgun #50
   * removed from the default.
   */
  dispatchOnce(msg: M): Promise<void>;
}

// === BootingRuntime: handle returned SYNCHRONOUSLY from run() ===
//
// `run()` returns a `BootingRuntime<S, M>` the instant it is called — boot
// (store.load → init → save → reconcile → interpret-of-init-cmds → first
// fanout) is still in flight. A BootingRuntime exposes exactly the surface
// that is TOTAL before boot completes: you may queue a dispatch, subscribe a
// listener, attach an observer, wire a Port, or stop the runtime — none of
// those need the initial State to exist yet. What you may NOT do is read the
// State (`getState`) or wait for quiescence (`idle`): there is no State to
// read until boot has run `init`, and a half-booted runtime has no meaningful
// "quiescence" to await. Those two are the difference between a BootingRuntime
// and a `Runtime` — and that difference is enforced at the type level.
//
// `ready` resolves to the FULL `Runtime<S, M>` once boot completes (or rejects
// with the boot error). It is the ONLY way to obtain a `Runtime`:
//
//   const runtime = await run(machine, opts).ready;
//   runtime.getState(); // total — boot has run, State exists
//
// This closes issue #45: `getState(): S` used to be declared on the handle
// `run()` returned synchronously, yet it THREW before boot under a store. The
// type claimed total; the value was partial, and only JSDoc told you to await.
// Splitting the booting handle from the ready runtime makes "read State before
// boot" a COMPILE error rather than a runtime throw — the type no longer lies.
//
// `subscribe(listener)` is the React-shaped change notifier (zero-arg, paired
// with `getState()` via `useSyncExternalStore` on the ready Runtime).
// `observe(observer)` is the devtools-shaped trace hook: it receives `(msg,
// state)` for every COMPLETED, APPLIED transition. The boot transition is NOT
// an applied Msg — there is no event there, only the initial State — so it does
// NOT flow through `observe`. It is delivered once via `onBoot(handler)`
// instead, so `observe`'s `msg` is total (`M`, never `null`): a consumer no
// longer carries a `| null` boot arm it then ignores (#47). Both `observe` and
// `onBoot` fire from the same point in the dispatch loop (after save →
// reconcile → interpret), so what they see is consistent with what a subscriber
// sees via the ready Runtime's `getState()`.
//
// Observe is separate from subscribe because the contracts differ: React
// consumers want "something changed, re-read state"; devtools consumers want
// "here is the exact (msg, state) pair, append it to a log". Folding them
// would force every React subscriber to type-check a `msg` arg they will never
// use, and would couple `useSyncExternalStore` to a particular Msg type at the
// substrate.
//
// `on(type, handler)` is the SEMANTIC event channel (#47): a typed subscription
// to the machine-level `AgentEvent`-style union `E` a machine projects off its
// transitions (via `run`'s `events` projector). Where `observe` hands every
// consumer the raw `(M, S)` firehose to hand-filter — coupling a UI to the
// machine's PRIVATE Msg vocabulary (e.g. a retry plumbing's `resilient_ok`) —
// `on` delivers only the public, named events, narrowed to the requested
// `type`. `E` defaults to `never`: a machine that wires no `events` projector
// has an empty event surface and `on` is uncallable (no `E["type"]` to pass).
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
   * Subscribe to the INITIAL State — the boot transition the old `observe`
   * `msg === null` arm carried (#47). Fires exactly once: immediately if boot
   * has already completed when `onBoot` is called (so a late subscriber never
   * misses it), otherwise on the boot fanout. Returns a cleanup that detaches
   * the handler (a no-op once it has fired).
   *
   * This is where the boot case the `observe` firehose used to fold in went
   * once `observe`'s `msg` became total: a consumer that needs to seed a view
   * from the initial State wires `onBoot`; a consumer that only folds events
   * (the common case) wires `observe` (or `on`) and is no longer handed a boot
   * arm to skip.
   */
  onBoot(handler: (state: S) => void): () => void;
  /**
   * Subscribe to a SEMANTIC event of `type` (#47). Typed narrowing: the handler
   * receives exactly the `E` member whose `type` matches `K`, so a consumer
   * built on `on("TurnSettled", …)` never touches another event's shape and —
   * critically — never references the machine's PRIVATE Msg names. Returns a
   * cleanup that detaches the handler. Multiple handlers per type are
   * supported; fanout is synchronous and throw-isolated (same discipline as
   * `observe`). Fires only when the machine's `events` projector (wired on
   * `run`) emits an event of that type for a transition.
   */
  on<K extends E["type"]>(
    type: K,
    handler: (event: Extract<E, { type: K }>) => void,
  ): () => void;
  /**
   * Subscribe to a typed Port. Returns a cleanup function that removes the
   * listener. Multiple listeners per port are supported; fanout is synchronous
   * (same shape as `observe`) and isolated — one listener throw does not strand
   * the others.
   *
   * Ports are for "data leaving the runtime selectively" — see `definePort`.
   * Distinct from `observe` (every transition) and from State (the world).
   */
  subscribePort<T>(port: Port<T>, listener: (value: T) => void): () => void;
  /**
   * Emit a value on a Port from OUTSIDE an interpret handler. Same synchronous
   * fanout discipline as `ctx.emit` inside interpret — every subscriber
   * receives the value immediately; emitting to a port with no subscribers is
   * a no-op; listener throws are isolated.
   *
   * Use this for `observe`-driven Port emission: the canonical case is one
   * runtime publishing a state-derived signal (e.g. "am I idle?") that
   * another runtime subscribes to via `subscribePort`. Without
   * `runtime.emitPort`, the only way to emit a Port is from inside an
   * `interpret` handler — which forces the reducer to spawn a "tell the
   * outside world" Cmd on every transition that should signal. With it,
   * `runtime.observe((msg, state) => runtime.emitPort(port, derive(state)))`
   * keeps the reducer free of Port-plumbing Cmds and matches the "every
   * transition is observable" contract this invariant set already commits to.
   *
   * Strengthens invariant 6 (runtime is small and inspectable — Port emission
   * is no longer privileged to interpret handlers; `observe`-driven emission
   * is structurally supported).
   */
  emitPort<T>(port: Port<T>, value: T): void;
  /**
   * Resolves to the booted `Runtime<S, M>` after boot completes — i.e. after
   * `store.load()` (if any), `init`, `store.save()` of the initial state,
   * `reconcileSubs`, `interpret` of any init-emitted cmds, and the initial
   * listener / observer fanout. Rejects with the boot error if boot fails (the
   * same error every subsequent `dispatch` call rejects with).
   *
   * This is the ONLY way to obtain a `Runtime<S, M>` — and a `Runtime` is the
   * only handle whose `getState()` is total. Awaiting `ready` is therefore the
   * single gate between "boot in flight" and "State exists":
   *
   * ```ts
   * const runtime = await run(machine, opts).ready;
   * runtime.getState(); // total — never throws-before-boot
   * ```
   *
   * Idempotent — subsequent reads return the same settled promise. The runtime
   * holds exactly one `ready` promise per `run()` call; it resolves to the same
   * `Runtime` object every time.
   *
   * Closes issue #45 (the `getState()` lie) and the v1 boot-await gap once
   * documented in `stepBootEffects`: components that need synchronous initial
   * state under a store (e.g. `useSyncExternalStore` consumers) await `ready`
   * for the booted runtime instead of dispatching a no-op Msg.
   *
   * Expresses canon §2.3 (the `init` contract — boot is a named, awaitable
   * moment). Strengthens invariant 6 (runtime is small and inspectable).
   */
  ready: Promise<Runtime<S, M, E>>;
  stop(): Promise<void>;
}

// === Runtime: the BOOTED handle `ready` resolves to ===
//
// A `Runtime<S, M>` is a `BootingRuntime<S, M>` whose boot has completed. It
// adds the two members that are only meaningful once the initial State exists:
// `getState()` (total — boot ran `init`, so State is always present) and
// `idle()` (quiescence is only definable on a runtime that has booted). It
// also narrows `ready` to `Promise<Runtime<S, M>>` resolving to itself — a
// booted runtime awaited again hands back the same booted runtime, so consumer
// code that re-awaits (e.g. a cached `getRuntime()` accessor) keeps a total
// `getState`.
//
// You never construct a `Runtime` directly from `run()`; you obtain it via
// `await bootingRuntime.ready`. That asymmetry is the whole fix for #45 —
// "read State before boot" is now unrepresentable, not merely discouraged.
export interface Runtime<
  S,
  M extends { type: string },
  E extends { type: string } = never,
> extends BootingRuntime<S, M, E> {
  /**
   * The current State. TOTAL — never throws. Obtaining a `Runtime` requires
   * awaiting `ready`, which only resolves AFTER boot has run `init` and set the
   * initial State; a `Runtime` therefore always has a State to return. (Before
   * #45 this was declared on the synchronously-returned handle and threw under
   * a store until boot finished — the type lied. It no longer does.)
   */
  getState(): S;
  /**
   * Resolves to this same `Runtime` once boot completes. Idempotent.
   */
  ready: Promise<Runtime<S, M, E>>;
  /**
   * Resolves once the runtime has reached QUIESCENCE — every dispatched Msg AND
   * every follow-up Msg an interpret handler returned has been processed, with
   * no further step pending on the serial tail.
   *
   * Since #50, plain `dispatch(msg)` already runs to quiescence (it awaits this
   * same drain after its own transition), so a caller rarely needs `idle()`
   * directly. `idle()` is still the right tool to (a) settle follow-ups left in
   * flight by a `dispatchOnce` / `dispatch(msg, { settle: "once" })` single
   * step, or (b) wait out a follow-up chain kicked off by a Sub or by boot
   * `init` cmds where there was no `dispatch` call to await. It chains onto the
   * current tail and re-checks until the tail stops advancing, draining the
   * entire transitive follow-up chain.
   *
   * Idempotent and re-entrant-safe: each call reads the live tail; a tail that
   * advanced during the await (a follow-up landed) is awaited again until
   * stable. Tail rejections are NOT surfaced here — a failing dispatch
   * surfaces on its OWN returned promise (and follow-up rejections route to
   * the `onError` sink). The ONE rejection `idle()` itself produces is a
   * `QuiescenceTimeoutError` when the wait hits its iteration cap without the
   * tail stabilizing: that replaces the old silent fall-through-resolve so a
   * livelocking machine is distinguishable from a genuinely quiesced one
   * (invariant 6 — no silent failures).
   *
   * Use `idle()` for runtime-internal follow-ups; a poll is still correct when
   * waiting on an EXTERNAL event (a WS reply) the runtime cannot enqueue itself.
   *
   * Strengthens invariant 6 (runtime is small and inspectable — quiescence is a
   * first-class awaitable moment, not a poll the consumer re-derives).
   */
  idle(): Promise<void>;
  /**
   * The terminal State of the run, or `undefined` while it is still in flight.
   * A run is "terminal" exactly when the `terminal` predicate passed to `run()`
   * returns `true` for the current State; with no predicate supplied a run is
   * never terminal and this always returns `undefined`.
   *
   * This is the FIRST-CLASS result read (issue #46): the outcome of running the
   * thing, off the State the machine already owns — NOT scraped off the
   * `observe` firehose by matching an internal Msg name (`resilient_ok`) and
   * racing a state-clear. The consumer reads the run's product (e.g. an agent's
   * `state.output`) off the returned `S`, with no coupling to the machine's
   * private retry / loop vocabulary.
   *
   * Total — never throws (a `Runtime` always has a State; see `getState`).
   */
  result(): S | undefined;
  /**
   * Resolves with the terminal State the first time the run reaches a terminal
   * State (per the `terminal` predicate passed to `run()`). If the run is
   * ALREADY terminal when `done()` is called, resolves immediately with the
   * current State; otherwise resolves on the transition that first makes
   * `terminal` hold.
   *
   * The awaitable companion to `result()` — "wait for the run to finish, then
   * hand me what it produced" in one call, instead of polling `result()` or
   * hand-rolling an `observe` loop that watches for a private terminal Msg.
   * With no `terminal` predicate supplied the run is never terminal, so this
   * promise never resolves (a non-terminating machine has no result to await).
   *
   * Idempotent and multi-caller safe: every call observes the live State, so a
   * call made after the run already terminated resolves at once, and concurrent
   * callers all settle on the same terminal transition.
   */
  done(): Promise<S>;
}

// === defineMachine: identity-typed pass-through ===
//
// Overloads enforce exactly one `update` shape per call so consumers see a
// concrete type for `update`, not the substrate-internal union. Implementation
// is identity at runtime — the runtime (`run`) branches on the structural
// shape of `update` (Reducer vs Transitions) when dispatching.
//
// - Reducer-form overload: `update: Reducer<S, M, C>` — flat record keyed by
//   Msg.type. Exhaustiveness is enforced by the mapped type; adding a Msg
//   variant without a matching key is a compile error.
// - Transitions-form overload: `update: Transitions<S, M, C>` — 2D table
//   keyed by State.type then Msg.type. Only available when `S extends {
//   type: string }`.
//
// Distinguishing the two: TS overload resolution checks the literal shape of
// the argument. Reducer values are functions; Transitions values are records
// (of functions). Structurally distinct, so overload resolution picks the
// right branch.
//
// Strengthens invariant 2 (record forms have no fall-through default) and
// invariant 7 (the Msg variant set — and, for Transitions, the State variant
// set — is load-bearing at the type level).

// Transitions-form overload — `update` is a 2D table keyed by State.type
// then Msg.type. Declared FIRST (most specific): the value shape (record of
// records of functions) is structurally distinct from Reducer (record of
// functions), so TS overload resolution picks this branch only when the
// literal matches the table shape.
//
// The S constraint is expressed via a conditional `S extends { type: string
// } ? Transitions<S, M, C> : never` instead of a generic-parameter
// constraint. The conditional approach keeps `S` unconstrained at the
// overload signature, so `Parameters<typeof defineMachine<NonDiscriminatedS,
// ...>>` (the public `satisfies` pattern) doesn't fail at the first
// overload — it just skips to the next one because `update` becomes
// `never`.
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
// Reducer-form overload — `update` is a flat record keyed by Msg.type.
// Object literals where every property is a function match this shape.
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
  // downstream reader (`run`, `replay`, the `withX` wrappers) re-derives it
  // structurally. Non-enumerable: it must not serialize, must not show up in
  // `Object.keys(machine)`, and must not collide with any Msg.type key on a
  // flattened surface. Idempotent under re-wrap (`defineMachine(defineMachine(m))`).
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

// === asReducer: the validated minting path for a reducer (ADR 0003 #5) ===
//
// The single entry point that turns a raw record of handlers into a branded
// `Reducer<S, M, C>` — the exact role `asRng` plays for `Rng` in
// `retry-backoff`. The parameter type is `Reducer<S, M, C>`, whose every cell
// returns the non-thenable `SyncReturn<S, C>`, so the reentrancy guard fires
// HERE, at construction: an `async` cell (or one that inline-`await`s) returns
// `Promise<...>`, which is not assignable to `SyncReturn`, and `tsc` rejects the
// call at the offending cell. A pure synchronous reducer passes through
// untouched and gains the phantom `ReducerBrand`.
//
// PURE: identity at runtime (the brand is phantom). `defineMachine` brands its
// `update` internally the same way, so callers that pass an object literal
// straight to `defineMachine` never need to call `asReducer` — it exists for
// the standalone `const update = asReducer<...>({ ... })` form, mirroring how a
// caller can mint an `Rng` with `asRng` before wiring it.
export function asReducer<S, M extends { type: string }, C extends Cmd>(
  reducer: Reducer<S, M, C>,
): Branded<Reducer<S, M, C>> {
  return reducer as Branded<Reducer<S, M, C>>;
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

// === CtxArg<Ctx>: the `ctx` field of `run`'s opts, conditionally optional ===
//
// A PURE machine reads nothing from `ctx` — its `Ctx` is `NoCtx`
// (`Record<never, never>`), `Record<string, never>` (the vortex arena grain,
// #182), or `unknown`. Forcing such a machine to write `ctx: {}` is ceremony
// for a value the type already pins as empty — the same friction the
// `Machine.interpret` field removed for cmdless machines. So `ctx` is
// CONDITIONALLY optional: when the empty object satisfies `Ctx` it may be
// OMITTED (the runtime defaults it to `{}`), so a pure reducer runs as
// `run(machine)`; when `Ctx` carries a field a handler reads, `ctx` stays
// REQUIRED so a context-bearing machine can't silently forget it.
//
// `[Record<never, never>] extends [Ctx]` reads as "is `{}` assignable to
// `Ctx`" — true for the context-free shapes above, false for `{ db: … }`. The
// tuple-wrap disables distributive conditional behavior, the same trick the
// `Machine.interpret`/`update` fields use. Existing callers that pass `ctx`
// are unaffected — an optional field still accepts a present value.
export type CtxArg<Ctx> = [Record<never, never>] extends [Ctx]
  ? { ctx?: Ctx }
  : { ctx: Ctx };

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
     * The SEMANTIC event projector (#47). Maps one APPLIED transition `(msg,
     * state)` to zero-or-more public events of the machine-level union `E`.
     * Returning `[]` skips the transition (it produced no event the consumer's
     * `on(type, …)` cares about). This is where a machine maps its PRIVATE Msg
     * vocabulary (a retry plumbing's `resilient_ok`, a tool loop's
     * `agent_tool_ok`) to NAMED events — the private names live only inside this
     * closure and never reach `on`'s `E` surface. Omit → the run has no event
     * surface (`E = never`) and `on` is uncallable.
     *
     * PURE — called inside the dispatch loop on the freshly-folded `(msg,
     * state)`; it must not read the clock, mutate, or throw (a throw is
     * isolated like an observer throw, never stranding the transition).
     */
    events?: (msg: M, state: S) => readonly E[];
    /**
     * Declared policy for when the pure `update` (reducer) throws. The reducer
     * throw is always surfaced via `onError` (`phase: "reduce"`); the strategy
     * decides what the runtime does next. Defaults to `"stop"` — the explicit,
     * safe choice (surface + halt, never a silent resume). See `Supervision`.
     */
    supervision?: Supervision<S, M>;
    /**
     * The run-terminality predicate — what makes the run's outcome first-class
     * (issue #46). Returns `true` for a State the run has finished in (e.g. an
     * agent's `state.run.phase === "done"`). The runtime feeds it to
     * `Runtime.result()` (the terminal State, or `undefined` in flight) and
     * `Runtime.done()` (resolves with the terminal State when it first holds).
     *
     * PURE — the runtime calls it inside the dispatch loop on the freshly-folded
     * State; it must not read the clock, mutate, or throw. Omit → the run is
     * never terminal: `result()` always returns `undefined` and `done()` never
     * resolves (the right behavior for a machine with no natural completion).
     */
    terminal?: (state: S) => boolean;
    /**
     * Iteration cap for `idle()`'s quiescence wait. Defaults to 100_000. Test
     * seam only — lets a livelock test trip the `QuiescenceTimeoutError` reject
     * path in a handful of iterations instead of 100k. Production code must not
     * set it.
     *
     * @internal test-only
     */
    __idleCap?: number;
  },
): BootingRuntime<S, M, E> {
  const { store } = opts;
  // `ctx` is conditionally optional (see `CtxArg`): a pure machine omits it.
  // Default the absent/nullish case to an empty object so the augmented-ctx
  // spread and `init(loaded, ctx)` get a value, never `undefined`. Callers that
  // pass a real `ctx` (or `ctx: undefined` for a `Ctx = undefined` machine that
  // ignores it) are unchanged.
  const ctx = (opts.ctx ?? {}) as Ctx;
  const idleCap = opts.__idleCap ?? 100_000;
  // The semantic-event projector (#47). Defaults to "no events" — a machine
  // that wires none has an empty event surface (`E = never`), so `on` is
  // uncallable and this projector never runs.
  const projectEvents: (msg: M, state: S) => readonly E[] =
    opts.events ?? (() => []);
  // The run-terminality predicate (#46). Defaults to "never terminal" so a
  // machine with no natural completion has a sound `result()`/`done()` (always
  // undefined / never resolves) rather than a missing one.
  const isTerminal: (state: S) => boolean = opts.terminal ?? (() => false);
  // The error sink for paths with no caller to reject at (follow-up dispatch
  // rejections, the final stop-save). Optional on `run`; when absent we fall
  // back to `defaultOnError`, which re-throws on a macrotask so the failure
  // still surfaces. Invariant 6: no silent failures.
  const onError: OnError = opts.onError ?? defaultOnError;
  // The sink must itself be total. If a consumer's sink throws, route THAT
  // throw through `defaultOnError` so a buggy sink can't re-create a silent
  // failure (or strand a teardown loop).
  const reportError = (error: unknown, context: RuntimeErrorContext): void => {
    try {
      onError(error, context);
    } catch (sinkError) {
      defaultOnError(sinkError, context);
    }
  };
  // The declared policy for a reducer throw (ADR 0003 #4). Default `stop`:
  // surface via `onError` + halt, never a silent resume. Normalized once here
  // so `stepDispatch` branches on `.strategy` without re-parsing the shorthand.
  const supervision = normalizeSupervision<S, M>(opts.supervision);

  // Holders are intentionally late-initialized: `state` is set inside the boot
  // step, which runs as the head of the tail. `getState()` before boot throws.
  let state: S | undefined;
  let bootError: unknown = null;
  let stopped = false;

  const subRegistry = new Map<string, () => void>();
  const listeners = new Set<() => void>();
  // Observers receive (msg, state) for every completed, APPLIED transition. The
  // boot transition has no applied Msg — it is delivered via `onBoot`, not here
  // — so `msg` is total (`M`, never `null`) (#47). Same throw-isolation
  // contract as listeners.
  const observers = new Set<(msg: M, state: S) => void>();
  // `onBoot` handlers receive the initial State once (#47). The boot case the
  // old `observe(msg === null)` arm carried lives here now. `booted` flips on
  // the boot fanout so a handler registered AFTER boot fires immediately with
  // the captured initial State (never misses it).
  const bootHandlers = new Set<(state: S) => void>();
  let booted = false;
  // Semantic-event handlers, keyed by event `type` (#47). Each `on(type, fn)`
  // adds `fn` to its type's bucket; the dispatch loop projects each transition
  // to `E[]` via `projectEvents` and fans each event to its type's handlers.
  // Stored as `(event: { type: string }) => void` to keep the registry
  // monomorphic; per-type safety lives at the `on` call site (the handler's `K`
  // narrows the event via `Extract<E, { type: K }>`).
  const eventHandlers = new Map<string, Set<(event: E) => void>>();
  // `done()` waiters (#46): each open `done()` call parks its resolver here.
  // The first transition that makes `isTerminal(state)` hold drains the set,
  // resolving every parked promise with the terminal State. A `done()` call
  // made AFTER the run is already terminal resolves immediately and never
  // parks (so it can never miss the terminal transition).
  const doneWaiters = new Set<(state: S) => void>();

  // Port subscriber registry. Keyed by Port reference (NOT name) — port
  // identity is nominal/by-reference per Elm semantics. Each port can have
  // many listeners; emissions fan out synchronously to all of them.
  // `Set<(value: unknown) => void>` is the storage shape; per-port type
  // safety is enforced at the `subscribePort` / `emit` call sites via the
  // phantom `__t` field on `Port<T>`.
  const portRegistry = new Map<Port<unknown>, Set<(value: unknown) => void>>();

  // The `emit` function injected onto ctx. Synchronous fanout — same shape as
  // `observe`. No-op when the port has no subscribers. Listener throws are
  // isolated + logged so one bad subscriber does not strand the others.
  function portEmit<T>(port: Port<T>, value: T): void {
    const subscribers = portRegistry.get(port as Port<unknown>);
    if (!subscribers || subscribers.size === 0) return;
    for (const listener of subscribers) {
      try {
        listener(value);
      } catch (err) {
        console.error(err);
      }
    }
  }

  // Augmented ctx passed to every Cmd handler. `ctx` is intentionally spread
  // into a fresh object so handlers receive a Ctx & PortEmitter without
  // mutating the caller's ctx (which may be shared across runtimes / tests).
  const augmentedCtx: Ctx & PortEmitter = { ...ctx, emit: portEmit };

  // === update dispatch ===
  //
  // The substrate accepts two `update` shapes (see `defineMachine` overloads);
  // dispatch goes through `applyCell`, the single reducer-vs-transitions
  // primitive keyed on `formOf` (see `pure/core.ts`, #275).
  function applyUpdate(state: S, msg: M): readonly [S, readonly C[]] {
    if (__DEV__) deepFreeze(state);
    const result = applyCell<S, M, C>(machine, state, msg);
    if (__DEV__) assertPureResult(result, msg.type);
    return result;
  }

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

    // Collision assert: within a single desired set, two subs sharing an id
    // but declaring different types is the silent class of bug that Elm's
    // sub diffing relies on the user to avoid — we catch it explicitly here.
    // (Same id + same type within the desired set is a redundant declaration
    // — harmless, and the `subRegistry.has` check below dedupes it on the
    // start path. Same id across transitions is the no-churn case the
    // reconcile pass is designed for and MUST NOT throw.)
    const desiredTypeById = new Map<string, string>();
    for (const sub of desired) {
      const existing = desiredTypeById.get(sub.id);
      if (existing !== undefined && existing !== sub.type) {
        throw new Error(
          `@demlik/tea: Sub.id collision: id="${sub.id}" declared as type="${existing}" and type="${sub.type}"`,
        );
      }
      desiredTypeById.set(sub.id, sub.type);
    }

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

  // `interpret` is optional at the type level when `C extends Cmd<never>`
  // (see `Machine<...>`). The runtime safely defaults a missing map to `{}`
  // because such a machine never emits cmds — the cmd loop below never
  // dereferences a handler. The defensive default also guards against a
  // miswired non-Cmd<never> consumer reaching this code path; the per-cmd
  // `if (!handler) continue` then preserves invariant-6 forward progress
  // instead of throwing on `undefined.foo`.
  type InterpretMap = {
    [K in C["type"]]: (
      cmd: Extract<C, { type: K }>,
      ctx: Ctx & PortEmitter,
      // biome-ignore lint/suspicious/noConfusingVoidType: an interpret handler returns a follow-up Msg or nothing; `void` permits no-return bodies that `M | undefined` would reject
    ) => Promise<M | void>;
  };
  const interpretMap: InterpretMap =
    (machine as { interpret?: InterpretMap }).interpret ?? ({} as InterpretMap);

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
      const handler = interpretMap[cmd.type as C["type"]];
      if (!handler) continue;
      const follow = await handler(
        cmd as Extract<C, { type: C["type"] }>,
        augmentedCtx,
      );
      if (follow !== undefined && follow !== null) {
        // Schedule follow-up Msg on the tail. The current step resolves
        // first; the follow-up runs after, as a fresh transition. The
        // returned rejection has no caller (the original dispatcher already
        // resolved), so route it to the error sink instead of swallowing it —
        // invariant 6: no silent failures. If you want this failure folded
        // back into state, name a failure Msg via `tryInterpret` (Railway);
        // the sink is the last-resort observability hook for the rest.
        enqueueDispatch(follow as M).catch((error: unknown) => {
          reportError(error, { phase: "follow-up" });
        });
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
   * Fire every observer with the just-applied msg + post-transition state.
   * Same throw-isolation contract as `fireListeners`. Called immediately
   * after `fireListeners` so observers see exactly what subscribers see. Only
   * called for APPLIED transitions — `msg` is total (the boot case routes to
   * `fireBoot`, not here) (#47).
   */
  function fireObservers(msg: M): void {
    if (observers.size === 0 || state === undefined) return;
    const snapshot = state;
    for (const observer of observers) {
      try {
        observer(msg, snapshot);
      } catch (err) {
        console.error(err);
      }
    }
  }

  /**
   * Project the just-applied transition to semantic events and fan each to its
   * type's `on(...)` handlers (#47). The projector maps the machine's private
   * Msg vocabulary to public events; a throw in the projector OR a handler is
   * isolated (errors-are-data) so it never strands the transition. Called right
   * after `fireObservers` so an `on` handler sees the same post-transition State
   * an observer would.
   */
  function fireEvents(msg: M): void {
    if (eventHandlers.size === 0 || state === undefined) return;
    let events: readonly E[];
    try {
      events = projectEvents(msg, state);
    } catch (err) {
      console.error(err);
      return;
    }
    for (const event of events) {
      const bucket = eventHandlers.get(event.type);
      if (bucket === undefined) continue;
      for (const handler of bucket) {
        try {
          handler(event);
        } catch (err) {
          console.error(err);
        }
      }
    }
  }

  /**
   * Fire every `onBoot` handler with the initial State, ONCE, and flip `booted`
   * (#47). This carries the case the old `observe(msg === null)` arm did. Same
   * throw-isolation contract. A handler registered after this runs fires
   * immediately at its `onBoot` call site instead (it reads `booted`).
   */
  function fireBoot(): void {
    booted = true;
    if (bootHandlers.size === 0 || state === undefined) return;
    const snapshot = state;
    for (const handler of bootHandlers) {
      try {
        handler(snapshot);
      } catch (err) {
        console.error(err);
      }
    }
  }

  /**
   * Resolve every parked `done()` waiter iff the just-folded State is terminal
   * (#46). Called once per completed transition (including boot), right after
   * the observer fanout, so a `done()` promise settles on the SAME transition a
   * synchronous `result()` would first return non-`undefined`. Drains the set
   * before resolving (a resolver enqueued anew during the drain belongs to the
   * next call, not this one — but a terminal State stays terminal, so the new
   * waiter's own `done()` call already resolved it immediately).
   */
  function settleDoneWaiters(): void {
    if (doneWaiters.size === 0 || state === undefined) return;
    if (!isTerminal(state)) return;
    const snapshot = state;
    const parked = [...doneWaiters];
    doneWaiters.clear();
    for (const resolve of parked) resolve(snapshot);
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
      throw new Error("@demlik/tea: runtime not booted");
    }
    // The reducer is the only synchronous user code in the step, and #71's
    // brand guarantees it cannot suspend — so a throw here is a clean,
    // catchable synchronous throw with `state` still at its pre-transition
    // value. Route it to the declared supervision strategy (ADR 0003 #4).
    let next: S;
    let cmds: readonly C[];
    try {
      [next, cmds] = applyUpdate(state, msg);
    } catch (reduceError) {
      // Invariant 6 — surface the failure as data FIRST, for every strategy.
      reportError(reduceError, { phase: "reduce" });
      switch (supervision.strategy) {
        case "restart": {
          // Host supplies last-known-good state; core installs it and KEEPS
          // FOLDING from there. State did not advance to the (never-produced)
          // reducer result — it is replaced by the rehydrated value. The
          // transition continues below with no cmds, since the throwing reduce
          // produced none. A throw inside `rehydrate` itself is NOT caught here
          // — it propagates as a genuine recovery failure (the host's
          // last-good source is broken), surfacing to the dispatch caller.
          state = supervision.rehydrate(state, msg, reduceError);
          if (store) await store.save(state);
          reconcileSubs();
          // No cmds to interpret — the reducer never returned a result.
          fireListeners();
          fireObservers(msg);
          fireEvents(msg);
          settleDoneWaiters();
          return;
        }
        case "escalate":
          // Surface + propagate. The runtime stays live (a parent supervisor
          // may keep dispatching); the failure bubbles out the dispatch
          // promise so the caller above sees it.
          throw reduceError;
        default:
          // `stop` (the safe default): halt the runtime. State is NOT advanced;
          // every subsequent dispatch rejects ("runtime stopped"). Propagate so
          // THIS dispatch promise also rejects — the halt is observable, never
          // a silent resume.
          stopped = true;
          throw reduceError;
      }
    }
    state = next;
    if (store) await store.save(state);
    // Subscriptions reconcile against the new state; throws propagate AFTER
    // the entire diff pass completes (so other subs still register / clean
    // up correctly). Cleanup throws are swallowed inside reconcileSubs.
    reconcileSubs();
    await runInterpret(cmds);
    fireListeners();
    fireObservers(msg);
    fireEvents(msg);
    settleDoneWaiters();
  }

  /**
   * Boot is split into two phases.
   *
   * - **Synchronous (`run()` call):** when `store` is absent, we know `loaded
   *   = null` without an await — run `init(null, ctx)` IMMEDIATELY so that
   *   `getState()` is observable synchronously. This is what
   *   `useSyncExternalStore` consumers (e.g. `@demlik/tea/react`) need to render
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
      // Boundary parse (invariant 8). `store.load()` returns `unknown`
      // because storage doesn't know `S`; `store.migrate(raw)` is the
      // substrate's required parse — `S` on recognized shape, `null` on
      // unrecognized (which boots fresh, a known-good path). `migrate` MUST
      // NOT throw per its contract; if it does we surface the error via the
      // boot promise (same as a `load` throw — `runtime.ready` rejects and
      // every subsequent `dispatch` surfaces `bootError`).
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
    // The boot transition has no applied Msg — deliver the initial State via
    // `onBoot`, not `observe` (#47). No `fireEvents` either: boot is not an
    // applied event, so it projects no semantic event.
    fireBoot();
    // A rehydrated boot can land in a terminal State (the run finished before
    // the last eviction) — settle any `done()` waiter parked before boot.
    settleDoneWaiters();
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
    if (stopped)
      return Promise.reject(new Error("@demlik/tea: runtime stopped"));
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

  /**
   * Drain the serial tail to quiescence. Quiescence = the tail stopped
   * advancing: every interpret follow-up calls `enqueueDispatch`, which
   * reassigns `tail` SYNCHRONOUSLY (before the parent step resolves), so
   * awaiting the current `tail` and re-reading it catches every transitively
   * enqueued follow-up. We loop until the reference is stable across an await.
   *
   * Bounded by `idleCap` — on cap we REJECT with `QuiescenceTimeoutError`
   * (never a silent fall-through-resolve), so a livelocking machine stays
   * distinguishable from a genuinely quiesced one (invariant 6 — issue #51).
   *
   * Shared by `runtime.idle()` and the quiescent `dispatch` default (#50): one
   * drain definition, one cap, one reject contract.
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
   * The public `dispatch`: run-to-quiescence by default (#50). Enqueue the Msg
   * on the tail, await its OWN transition first (so a reducer / save / interpret
   * throw on THIS Msg surfaces here, before any drain), then — unless the caller
   * asked for a single step — drain the transitive follow-up chain.
   *
   * `{ settle: "once" }` (and the `dispatchOnce` alias) skip the drain: resolve
   * after the one transition and leave the follow-up chain racing on the tail
   * for a caller that will `await runtime.idle()` itself.
   */
  async function dispatchToQuiescence(
    msg: M,
    opts?: { readonly settle?: DispatchSettle },
  ): Promise<void> {
    await enqueueDispatch(msg);
    if (opts?.settle === "once") return;
    await drainToQuiescence();
  }

  // Kick off boot-effects immediately. Boot rejections are remembered on
  // `bootError`; they surface on every subsequent dispatch call. Note: when
  // `store` is absent the synchronous-init step above already set `state` —
  // `stepBootEffects` only runs save/sub/interpret/listener-fire. When
  // `store` is present, the full async path runs here.
  //
  // `bootPromise` is the original (un-swallowed) promise — it is what
  // `runtime.ready` chains off so callers see the boot error directly. `tail`
  // gets the swallowed branch so a boot failure does NOT poison every
  // subsequent dispatch's `.then` chain (each dispatch surfaces `bootError`
  // explicitly inside `enqueueDispatch`).
  const bootPromise = stepBootEffects();
  tail = bootPromise.catch((err) => {
    bootError = err;
  });

  // `ready` resolves to the booted `Runtime` (issue #45). It chains off the
  // un-swallowed `bootPromise` so boot failures reject it directly — meaning a
  // failed boot never hands out a `Runtime`, which is what keeps `getState()`
  // total. The `runtime` reference resolves at `.then` time (a later
  // microtask), well after the object literal below finishes initializing, so
  // the forward reference is safe. Built once → idempotent: the same settled
  // promise comes back on every `ready` read.
  const readyPromise: Promise<Runtime<S, M, E>> = bootPromise.then(
    () => runtime,
  );

  const runtime: Runtime<S, M, E> = {
    dispatch: dispatchToQuiescence,
    dispatchOnce: enqueueDispatch,
    getState(): S {
      // TOTAL (issue #45). A `Runtime` is only obtainable by awaiting `ready`,
      // which resolves AFTER boot has run `init` and set `state` — so by the
      // time any holder of this object can call `getState()`, `state` is
      // defined. No `state === undefined` throw branch: that was the old lie
      // (declared total on the synchronously-returned handle, threw under a
      // store pre-boot). Boot failures never reach here either — `ready`
      // rejects, so no `Runtime` is ever handed out on a failed boot.
      //
      // The cast encodes that invariant. The lone way to reach it with `state`
      // still undefined would be to cast the BootingRuntime to Runtime and call
      // `getState()` before `ready` — which the type system now forbids without
      // an explicit, deliberate cast.
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
      // Already booted → fire immediately with the captured initial State so a
      // late subscriber never misses the one-shot boot (#47). It does not park
      // (boot is a single past event), so the returned cleanup is a no-op.
      if (booted && state !== undefined) {
        try {
          handler(state);
        } catch (err) {
          console.error(err);
        }
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
      // The registry is monomorphic (`Set<(event: E) => void>`); the per-type
      // narrowing lives at THIS call site — `handler` accepts the `K`-narrowed
      // event, and `fireEvents` only ever routes an event to its own type's
      // bucket, so the erased call is sound.
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
      // The bucket stores `(value: unknown) => void` to keep the registry
      // monomorphic; per-port type safety lives at this call site (the
      // listener's `T` is bound to the port's phantom `__t`).
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
      // Same closure as `ctx.emit` inside interpret — synchronous fanout,
      // no-op on no subscribers, listener-throw isolation. Exposing it on
      // the Runtime interface lets `observe`-driven Port emission work
      // without spawning a "tell the outside world" Cmd per transition.
      portEmit(port, value);
    },
    // `ready` is assigned just below (it must resolve to `runtime` itself,
    // which can't be referenced inside its own object literal). See the
    // assignment + rationale after this block.
    ready: readyPromise,
    idle(): Promise<void> {
      // Quiescence = the tail stopped advancing (full rationale on
      // `drainToQuiescence`). `idle()` is the direct await of that drain; the
      // quiescent `dispatch` default reuses the SAME helper after its own
      // transition. The cap + `QuiescenceTimeoutError` reject (no silent
      // fall-through-resolve) keeps "quiesced" and "gave up" distinguishable —
      // invariant 6: no silent failures.
      return drainToQuiescence();
    },
    result(): S | undefined {
      // TOTAL — `state` is defined for any holder of a `Runtime` (see
      // `getState`). The terminal predicate is the ONLY thing that decides
      // "finished"; with none supplied `isTerminal` is `() => false`, so a
      // non-terminating machine reads `undefined` forever (#46).
      const current = state as S;
      return isTerminal(current) ? current : undefined;
    },
    done(): Promise<S> {
      // Already terminal → resolve at once with the live State (never parks, so
      // a post-termination call can't miss the terminal transition).
      const current = state as S;
      if (isTerminal(current)) return Promise.resolve(current);
      // Otherwise park a resolver; `settleDoneWaiters` drains it on the
      // transition that first makes `isTerminal` hold. With no predicate this
      // promise never resolves — the documented "no natural completion" case.
      return new Promise<S>((resolve) => {
        doneWaiters.add(resolve);
      });
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
      // Flush final state. A save throw here does not reject `stop()` — the
      // contract is "returns a resolved Promise" — but it IS the loss of the
      // last write, so route it to the error sink rather than swallowing it
      // with a bare console.error. Invariant 6: no silent failures.
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

// === historyTracker: composable observability helper ===
//
// A bounded ring buffer of recent `(msg, state)` transitions, built on the
// Runtime's public `observe` API. The substrate itself stays minimal — it
// has no notion of history, no opt to enable one, no method on the Runtime
// interface to read one. Anything that wants "recent transitions" composes
// via this helper. The substrate provides the primitive (`observe`); this
// is the bookkeeping that builds on it.
//
// Use cases:
//   - Bridge backlog replay for late subscribers (see `@demlik/tea/extension`).
//   - Debug inspectors showing recent traffic on attach.
//   - Sentry breadcrumb collection.
//   - Property/contract tests that want to assert "these N transitions
//     happened in this order."
//
// Discipline:
//   - One-line creation: `const tr = historyTracker(runtime, 100);`
//   - Snapshot at any time: `tr.snapshot()` — shallow copy, oldest first.
//   - Detach when done: `tr.stop()` — unsubscribes the observer; the buffer
//     freezes at its current contents (snapshot() still works, useful for
//     post-hoc inspection in tests).
//
// Why not put this on the Runtime interface as `runtime.history()`?
// Because history is derivable. Putting it on the Runtime privileges one
// use case (debug inspectors) at the substrate level and grows the
// interface for everyone. The composition shape stays out of the dispatch
// loop entirely — the substrate's hot path doesn't pay any cost for a
// feature it doesn't need to provide.
// =============================================================================

export interface HistoryTracker<S, M extends { type: string }> {
  /**
   * Snapshot of recorded transitions, oldest first. Each entry is
   * `{ msg, state }` exactly as the underlying `observe` callback received
   * it — `msg` is `null` for the boot transition, a Msg for every other.
   *
   * Returns a shallow copy: the array is fresh on every call (callers may
   * iterate, slice, or replay without affecting the tracker's buffer).
   * Entry values are references to the originals (TEA states/msgs are
   * conventionally immutable; do not mutate them if your S/M is not).
   */
  snapshot(): readonly { readonly msg: M | null; readonly state: S }[];
  /**
   * Detach the underlying observer. After `stop()`:
   *   - No new transitions are recorded.
   *   - `snapshot()` continues to work and returns the buffer's contents
   *     at the moment of stop (useful for post-hoc inspection in tests).
   *   - The tracker holds no references that would prevent GC of the
   *     `runtime` argument other than the entries already buffered.
   *
   * Idempotent — subsequent calls are no-ops.
   */
  stop(): void;
}

/**
 * Create a bounded history tracker over a Runtime. The tracker subscribes
 * to the runtime via `observe(...)` and retains the last `size` `(msg,
 * state)` transitions in a FIFO ring buffer.
 *
 * @param runtime  Any `BootingRuntime<S, M>` (a full `Runtime` satisfies it).
 *                 The tracker uses only `observe`, which is total before boot —
 *                 attach it to the synchronous `run()` handle to record the
 *                 boot transition.
 * @param size     Buffer cap. `size <= 0` produces an inert no-op tracker:
 *                 no observer is attached to the runtime, `snapshot()` is
 *                 always `[]`, and `stop()` is a no-op. (Prefer skipping the
 *                 tracker entirely in that case — this arm just makes a
 *                 non-positive `size` harmless rather than an error.)
 *
 * Memory cost: O(size × avg(msg + state size)). For audit-extension's
 * inspector use case (size 100, audit state ~5KB), ~500KB max — held
 * in-memory only, no persistence.
 */
export function historyTracker<S, M extends { type: string }>(
  runtime: BootingRuntime<S, M>,
  size: number,
): HistoryTracker<S, M> {
  const buffer: { msg: M | null; state: S }[] = [];
  let stopped = false;

  const push = (entry: { msg: M | null; state: S }): void => {
    buffer.push(entry);
    if (buffer.length > size) buffer.shift();
  };

  // The boot transition (the `{ msg: null, state }` head entry the old
  // `observe(msg === null)` arm recorded) now arrives via `onBoot` (#47);
  // applied transitions arrive via `observe` with a total `msg`. The public
  // snapshot shape (`msg: M | null`) is unchanged — boot is still `msg: null`.
  const unobserve =
    size <= 0
      ? (): void => {}
      : runtime.observe((msg, state) => {
          push({ msg, state });
        });
  const unboot =
    size <= 0
      ? (): void => {}
      : runtime.onBoot((state) => {
          push({ msg: null, state });
        });

  return {
    snapshot() {
      // Shallow copy — callers may freely iterate or mutate the returned
      // array. Entry values are references; see HistoryTracker docs.
      return buffer.slice();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unobserve();
      unboot();
    },
  };
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
  // `init` is `(loaded: S | null, ctx) => ...`; coerce undefined → null so the
  // AC "`replay` with `loaded: undefined` calls `init(null, ctx)`" holds.
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
  // reducer-vs-transitions form by construction. `replay` wraps it with the
  // `init` entry + Cmd/Sub collection; `foldMsgs` calls it from a base state
  // and returns the state only.
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
