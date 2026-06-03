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

// === Dev-mode invariant enforcement ===
//
// Three runtime guards that catch TEA invariant violations during development.
// Dead-code-eliminated in production by any bundler that replaces
// `import.meta.env.DEV` (Vite) or `process.env.NODE_ENV` (webpack/esbuild).
//
// 1. deepFreeze(state) before passing to update — catches mutation
// 2. Thenable check on return value — catches async update
// 3. Walk cmd fields for function types — catches closures-as-data
//
// These enforce invariants 1 and 2 at runtime where the type system cannot.
const __DEV__: boolean = (() => {
  try {
    const meta = import.meta as unknown as { env?: { DEV?: boolean } };
    if (meta.env?.DEV !== undefined) {
      return meta.env.DEV;
    }
  } catch {
    // import.meta not available (Node CJS, service workers)
  }
  try {
    return typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
  } catch {
    return false;
  }
})();

function deepFreeze<T>(obj: T, seen?: WeakSet<object>): T {
  if (obj === null || typeof obj !== "object") return obj;
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) return obj;
  const visited = seen ?? new WeakSet();
  if (visited.has(obj as object)) return obj;
  visited.add(obj as object);
  Object.freeze(obj);
  for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v, visited);
  return obj;
}

function hasFunctionValues(obj: unknown): string | null {
  if (obj === null || typeof obj !== "object") return null;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === "function") return key;
  }
  return null;
}

function assertPureResult(result: unknown, msgType: string): void {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    throw new Error(
      `@demlik/tea: update cell "${msgType}" returned a Promise. ` +
        `update must be synchronous. Move async work to interpret.`,
    );
  }
  if (!Array.isArray(result) || result.length < 2 || !Array.isArray(result[1])) {
    throw new Error(
      `@demlik/tea: update cell "${msgType}" returned a non-tuple. ` +
        `Expected [State, Cmd[]], got ${typeof result}.`,
    );
  }
  const cmds = result[1] as readonly { type: string }[];
  for (const cmd of cmds) {
    const fnField = hasFunctionValues(cmd);
    if (fnField !== null) {
      throw new Error(
        `@demlik/tea: Cmd "${cmd.type}" has function field "${fnField}". ` +
          `Cmds must be plain data, not closures.`,
      );
    }
  }
}

// === Cmd: tagged-union, one-shot effect ===
export type Cmd<T extends string = string> = { type: T };

// === Reducer<S, M, C>: record-of-handlers form of `update` ===
//
// Flat dispatch table keyed by `Msg.type`. Each cell is a pure transition for
// a single Msg variant, narrowed via `Extract<M, { type: K }>`. The mapped type
// is *load-bearing*: adding a Msg variant without a matching key in the
// Reducer record is a compile error — no `absurd()` helper at call sites, no
// silent fall-through, no default branch hiding impurity.
//
// Strengthens invariant 2 (pure transitions — the record form has no
// fall-through default to hide impurity behind) and invariant 7 (identity is
// explicit — the Msg variant set is load-bearing at the type level).
//
// `defineMachine` accepts the Reducer record form via overload. The runtime
// dispatches via `update[msg.type](state, msg)`.
export type Reducer<S, M extends { type: string }, C extends Cmd> = {
  [K in M["type"]]: (state: S, msg: Extract<M, { type: K }>) => readonly [S, readonly C[]];
};

// === Transitions<S, M, C>: table form of `update` for state-machine-shaped machines ===
//
// When `State` is itself a discriminated union (`State.type` is the active
// phase), the table form makes every (state.type × msg.type) cell explicit at
// the type level. Missing a cell — e.g. forgetting how `phase: "settling"`
// handles `msg.type: "tab_stepped"` — fails to compile. No nested switch, no
// fall-through, no `_ -> (state, [])` default branch hiding regressions.
//
// Each cell receives the narrowed `State` for its phase and the narrowed
// `Msg` for its variant via two `Extract` lookups. Phantom-narrow at the
// type level; pure data at runtime.
//
// `defineMachine` accepts a third `update` form for `Transitions<S, M, C>` —
// the runtime dispatches via `update[state.type][msg.type](state, msg)`.
//
// Strengthens invariant 2 (table form has no fall-through default),
// invariant 6 (runtime walks the table predictably, no hidden dispatch
// fallback), and invariant 7 (both state.type and msg.type are load-bearing
// at the type level).
export type Transitions<S extends { type: string }, M extends { type: string }, C extends Cmd> = {
  [P in S["type"]]: {
    [K in M["type"]]: (
      state: Extract<S, { type: P }>,
      msg: Extract<M, { type: K }>,
    ) => readonly [S, readonly C[]];
  };
};

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
export const noop = <S, M, C extends Cmd>(state: S, _msg: M): readonly [S, readonly C[]] => [
  state,
  [],
];

// === Cmd: namespace for conditional Cmd emission ===
//
// Two recurring frictions in reducer cells:
//
//   1. "Emit cmd X only when condition Y holds."
//      Hand-rolled: `cond ? [{ type: "x", ... }] : []`
//      With Cmd:    `Cmd.when(cond, { type: "x", ... })`
//
//   2. "Emit cmd X carrying a value that may be undefined; if undefined,
//      emit nothing."
//      Hand-rolled: `value !== undefined ? [{ type: "x", value }] : []`
//      With Cmd:    `Cmd.whenDefined(value, (v) => ({ type: "x", value: v }))`
//
// Both forms return `readonly C[]` so they spread cleanly into the cmds
// array returned by a Transitions cell:
//
//   return [next, [
//     ...Cmd.when(state.tabId !== undefined, { type: "detach_debugger", tabId: state.tabId }),
//     ...Cmd.whenDefined(state.queueItemId, (id) => ({
//       type: "queue:complete", queueItemId: id, status: "done",
//     })),
//   ]];
//
// `Cmd` as a value namespace coexists with `Cmd<T>` as a type — TypeScript's
// declaration merging puts them in different name spaces (type vs. value).
// The reader sees `Cmd<...>` in type position and `Cmd.when(...)` in
// expression position; no ambiguity at use sites.
//
// Why a namespace and not top-level `when` / `whenDefined`: `when` at module
// scope reads as a generic conditional, but these helpers are specifically
// for *Cmd emission* (return `readonly C[]`, the cmds-array contract of
// every Transitions cell). The namespace pins that intent at the call site.
export const Cmd = {
  /**
   * The empty Cmd array. Typed `readonly never[]` so it's assignable to any
   * `readonly C[]` for any `C extends Cmd`. Use in `init` returns and
   * Transitions cells that emit zero effects:
   *
   *   init: (loaded) => [loaded ?? initial, Cmd.none],
   *   tick: (state) => [state, Cmd.none],
   *
   * Elm's `Cmd.none` analogue. Cultural signal alongside the runtime help:
   * `[state, Cmd.none]` reads as intent ("this transition emits nothing"),
   * `[state, []]` reads as "empty array of what".
   *
   * Frozen at runtime so a downstream consumer can't `.push()` into the
   * shared reference.
   */
  none: Object.freeze([]) as readonly never[],

  /**
   * Flat concat of cmd arrays. Use when a cell composes effects from
   * multiple conditional sources:
   *
   *   return [next, Cmd.batch(
   *     Cmd.whenDefined(state.queueItemId, (id) => ({ type: "complete", id })),
   *     Cmd.when(state.windowId !== undefined, { type: "close_window", windowId }),
   *     [{ type: "detach_debugger", tabId: state.tabId }],
   *   )];
   *
   * `<const C>` keeps inline cmd literals' discriminants narrow (same
   * rationale as `when` / `whenDefined` above).
   */
  batch: <const C extends Cmd>(...arrs: readonly (readonly C[])[]): readonly C[] => {
    const out: C[] = [];
    for (const arr of arrs) out.push(...arr);
    return out;
  },

  /**
   * Emit `cmd` wrapped in a single-element array iff `cond` is true.
   * Otherwise return the empty array. Spreads cleanly into the cmds array
   * returned by a Transitions cell.
   *
   * `const C` (TypeScript 5.0+) keeps the inferred `type:` discriminator
   * literal narrow when called with an object literal — so `Cmd.when(b,
   * { type: "x", ... })` infers as `{ type: "x", ... }`, not `{ type:
   * string, ... }`, and stays assignable to a discriminated-union arm
   * without `as const` at the call site.
   */
  when: <const C extends Cmd>(cond: boolean, cmd: C): readonly C[] => (cond ? [cmd] : []),

  /**
   * If `value` is defined, call `build(value)` and emit the resulting cmd
   * wrapped in a single-element array. If `value` is `undefined`, return
   * the empty array. `value` is narrowed to `T` inside `build`.
   *
   * `const C` on the return type keeps the callback's object-literal
   * `type:` field narrow (see `when` above for the full rationale).
   */
  whenDefined: <T, const C extends Cmd>(
    value: T | undefined,
    build: (value: T) => C,
  ): readonly C[] => (value !== undefined ? [build(value)] : []),
} as const;

// === SubId: branded string for Sub identity ===
//
// Subs are reconciled by id on every transition (canon §2.5, invariant 7).
// Before branding, `Sub.id` was a raw `string` — a typo at one call site and a
// different typo at another would silently produce two distinct subs that
// looked identical to a human reader. The brand makes id construction explicit
// (`subId("...")`) and catches accidental string-where-SubId at the type
// level.
//
// The brand is structural: `string & { __brand: "SubId" }`. The `subId(s)`
// constructor is the ONE permitted cast in the substrate — every other call
// site must go through it.
export type SubId = string & { readonly __brand: "SubId" };

/**
 * Construct a `SubId` from a string. Use this everywhere a Sub literal is
 * built — including ids derived from runtime data (`subId(\`ws:${auditId}\`)`).
 * The brand is structural, not nominal, so dynamic ids are permitted; the
 * constructor's job is to make the identity decision explicit at every call
 * site so the type system can catch accidental raw-string drift.
 *
 * Strengthens invariant 7 (identity is explicit).
 */
export function subId(s: string): SubId {
  return s as SubId;
}

// === Sub: tagged-union, continuous source of msgs; stable id used for diff/reconcile ===
export type Sub<T extends string = string> = { id: SubId; type: T };

// === Port<T>: typed escape hatch for "data leaving the runtime" ===
//
// A Port is a named, typed channel that Cmd handlers can `emit` to via the
// augmented `ctx.emit(port, value)`. Subscribers attach via
// `runtime.subscribePort(port, listener)` and receive every emitted value
// synchronously (same fanout discipline as `runtime.observe`).
//
// Why Ports are a substrate primitive, distinct from State and Observe:
// - **State** is "the world as the program sees it." Folding outgoing
//   announcements into State turns ephemeral signals into persisted facts —
//   the classic anti-pattern that motivated this primitive.
// - **Observe** sees every transition `(msg, state)`. That's the right channel
//   for devtools and logging, but it forces every consumer to filter the
//   entire firehose for a single signal.
// - **Ports** are typed and selective: one channel per concept, subscribers
//   only see what the handler chose to emit. Mirrors Elm's outgoing-port
//   semantics — a typed declaration with `port` keyword whose values flow
//   out of the program to the host.
//
// Port identity is **by reference** — the returned object IS the identity.
// Name is metadata for debugging. To prevent the "two modules definePort the
// same name expecting to share a channel, silently get distinct ports" class
// of bug, `definePort` asserts the name has not been seen in this process —
// the symmetric runtime check to `SubId` (canon §2.12, invariant 7). Each
// definePort call must use a unique name; if two modules need the same port,
// one module exports it and the other imports it.
export interface Port<T> {
  readonly __brand: "port";
  readonly name: string;
  // Phantom field — never assigned, never read at runtime. Carries `T` for
  // inference at `ctx.emit` and `subscribePort` call sites. Using `?` so
  // `definePort` can produce a Port without constructing a value of `T`.
  readonly __t?: T;
}

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

/**
 * Augmentation injected onto `ctx` inside Cmd handlers. Handlers receive
 * `ctx & PortEmitter` so they can call `ctx.emit(port, value)` synchronously.
 * Subscribers registered via `runtime.subscribePort(port, listener)` receive
 * the value immediately.
 *
 * Emitting to a port with no subscribers is a no-op (does not throw).
 */
export interface PortEmitter {
  emit<T>(port: Port<T>, value: T): void;
}

// === Interpret<M, C, Ctx>: record-of-handlers form of `interpret` ===
//
// Flat dispatch table keyed by `Cmd.type`. Each cell receives the narrowed Cmd
// and the runtime-augmented Ctx (`Ctx & PortEmitter`) and resolves to a
// follow-up Msg or `void` (fire-and-forget). The mapped type makes a missing
// handler a compile error — `defineMachine` cannot accept the dictionary until
// every Cmd variant has one.
//
// Hoisted out of `Machine.interpret` so consumers can type a free-standing
// handler dictionary with `Interpret<MyMsg, MyCmd, MyCtx>` instead of
// re-declaring the mapped type at every effects module.
//
// Strengthens invariant 2 (the record form has no fall-through default to
// hide impurity behind) and invariant 7 (identity is explicit — the Cmd
// variant set is load-bearing at the type level).
export type Interpret<M extends { type: string }, C extends Cmd, Ctx> = {
  [K in C["type"]]: (cmd: Extract<C, { type: K }>, ctx: Ctx & PortEmitter) => Promise<M | void>;
};

// === Subscribe<M, U, Ctx>: record-of-handlers form of `subscribe` ===
//
// Flat dispatch table keyed by `Sub.type`. Each cell receives the narrowed
// Sub, the Ctx, and a `dispatch` to fire follow-up Msgs. Returns a cleanup
// function the substrate calls when the Sub is reconciled out (state
// transitioned away). The mapped type guarantees every Sub variant has a
// handler at the type level; runtime dispatch is a single property lookup.
//
// Hoisted out of `Machine.subscribe` so consumers can type a free-standing
// handler dictionary with `Subscribe<MyMsg, MySub, MyCtx>` instead of
// re-declaring the mapped type at every subs module.
//
// Strengthens invariant 7 (identity is explicit — the Sub variant set is
// load-bearing at the type level).
export type Subscribe<M extends { type: string }, U extends Sub, Ctx> = {
  [K in U["type"]]: (
    sub: Extract<U, { type: K }>,
    ctx: Ctx,
    dispatch: (msg: M) => void,
  ) => () => void;
};

// === Machine: pure data, host-agnostic ===
//
// `update` is stored as a union of the two record forms — the runtime branches
// on shape at dispatch time. The public `defineMachine` overloads enforce one
// shape per call so consumers never see the union themselves.
//
// - Reducer form: `Reducer<S, M, C>` — flat record keyed by Msg.type;
//   exhaustiveness enforced by the mapped type.
// - Transitions form: `Transitions<S, M, C>` — 2D table keyed by
//   `state.type` then `msg.type`; only available when `S extends { type:
//   string }`. Conditional in the union so machines without a discriminated
//   State don't widen to include this branch.
//
// `M` is constrained to `{ type: string }` because both record forms require
// a string discriminant.
//
// `interpret` is conditionally optional: when `C` is `Cmd<never>` the
// interpret map is keyed by `never`, so the only valid value is `{}`. Forcing
// every cmdless machine to write `interpret: {} as never` is ceremony for a
// shape the type already pins. The tuple-wrap (`[C] extends [Cmd<never>]`)
// disables distributive conditional so a real cmd union (e.g.
// `Cmd<"a"> | Cmd<"b">`) doesn't degrade to optional just because one arm
// happens to be `Cmd<never>`. Same trick the `update` field uses.
export type Machine<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx> = {
  /**
   * Boot the runtime. Called once by `run(...)` with whatever `Store.load()`
   * returned: `null` on fresh boot, the persisted state on rehydrate.
   *
   * **Contract:** when `loaded !== null`, init MUST return `[loaded, []]` —
   * no Cmds. Init's rehydrate branch is the migration / parse boundary, not
   * the boot-effect hook. See Invariant 2 in `.patterns/tea/tea-invariants.md`.
   *
   * Boot effects routes:
   *   - Stateless infrastructure → host module top, outside TEA.
   *   - State-conditional resume → a `boot` Msg the host dispatches once
   *     after `run(...)` returns.
   *
   * Violations are caught at runtime by `replay` (which throws with a
   * pointer to the alternatives).
   */
  init: (loaded: S | null, ctx: Ctx) => readonly [S, readonly C[]];
  update:
    | Reducer<S, M, C>
    // Wrap in tuple to disable distributive conditional behavior. Without
    // `[S]`, TS distributes the conditional across `S`'s union members,
    // producing `Transitions<A,...> | Transitions<B,...>` instead of the
    // desired `Transitions<A|B,...>` — the table form needs a single
    // mapping over the full union of state types, not separate tables per
    // member.
    | ([S] extends [{ type: string }] ? Transitions<S, M, C> : never);
  subscriptions?: (state: S) => readonly U[];
  subscribe?: Subscribe<M, U, Ctx>;
} & ([C] extends [Cmd<never>]
  ? { interpret?: Interpret<M, C, Ctx> }
  : { interpret: Interpret<M, C, Ctx> });

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

// === RuntimeRef<M>: typed sibling-runtime handle ===
//
// A `RuntimeRef<M>` exposes only the inbox of a Runtime — `dispatch(msg)`.
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
  dispatch(msg: M): Promise<void>;
}

// === Runtime: handle returned from run() ===
//
// `subscribe(listener)` is the React-shaped change notifier (zero-arg, paired
// with `getState()` via `useSyncExternalStore`). `observe(observer)` is the
// devtools-shaped trace hook: it receives `(msg, state)` for every completed
// transition, including the boot transition where `msg` is `null`. Both fire
// from the same point in the dispatch loop (after save → reconcile →
// interpret), so what an observer sees is consistent with what a subscriber
// sees via `getState()`.
//
// Observe is separate from subscribe because the contracts differ: React
// consumers want "something changed, re-read state"; devtools consumers want
// "here is the exact (msg, state) pair, append it to a log". Folding them
// would force every React subscriber to type-check a `msg | null` arg they
// will never use, and would couple `useSyncExternalStore` to a particular Msg
// type at the substrate.
export interface Runtime<S, M extends { type: string }> extends RuntimeRef<M> {
  dispatch(msg: M): Promise<void>;
  getState(): S;
  subscribe(listener: () => void): () => void;
  observe(observer: (msg: M | null, state: S) => void): () => void;
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
   * Resolves after boot completes — i.e. after `store.load()` (if any), `init`,
   * `store.save()` of the initial state, `reconcileSubs`, `interpret` of any
   * init-emitted cmds, and the initial listener / observer fanout. Rejects with
   * the boot error if boot fails (the same error every subsequent `dispatch`
   * call rejects with).
   *
   * Idempotent — subsequent reads return the same settled promise. The runtime
   * holds exactly one `ready` promise per `run()` call.
   *
   * Closes the v1 boot-await gap previously documented in `stepBootEffects`:
   * components that need synchronous initial state under a store (e.g.,
   * `useSyncExternalStore` consumers) can `await runtime.ready` instead of
   * `runtime.dispatch(noopMsg)`.
   *
   * Expresses canon §2.3 (the `init` contract — boot is a named, awaitable
   * moment). Strengthens invariant 6 (runtime is small and inspectable).
   */
  ready: Promise<void>;
  stop(): Promise<void>;
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
export function defineMachine<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  m: Omit<Machine<S, M, C, U, Ctx>, "update"> & {
    // `[S]` tuple-wrap disables distributive conditional behavior — see
    // the comment on `Machine.update` for why distribution is wrong here.
    update: [S] extends [{ type: string }] ? Transitions<S, M, C> : never;
  },
): Machine<S, M, C, U, Ctx>;
// Reducer-form overload — `update` is a flat record keyed by Msg.type.
// Object literals where every property is a function match this shape.
export function defineMachine<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  m: Omit<Machine<S, M, C, U, Ctx>, "update"> & {
    update: Reducer<S, M, C>;
  },
): Machine<S, M, C, U, Ctx>;
// Implementation signature — accepts both via the union on `Machine.update`.
export function defineMachine<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
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
export function run<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
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
  // Observers receive (msg, state) for every completed transition. Boot fires
  // once with msg = null. Same throw-isolation contract as listeners.
  const observers = new Set<(msg: M | null, state: S) => void>();

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
  // The substrate accepts two `update` shapes (see `defineMachine` overloads):
  //
  //   1. Reducer:     `{ [msg.type]: (state, msg) => [S, C[]] }`
  //   2. Transitions: `{ [state.type]: { [msg.type]: (state, msg) => [S, C[]] } }`
  //
  // Branch is structural: an object's first inspected handler tells us
  // flat-vs-nested — if `update[msg.type]` is itself a function it's a
  // Reducer; if it's an object whose value is a function it's a Transitions
  // table. No runtime tag added to the Machine — the form is detectable from
  // the value shape, and the type system guarantees `update` matches one of
  // the two shapes at the `defineMachine` boundary.
  //
  // The form is detected ONCE per `run()` call (here, at runtime setup) and
  // cached as `updateMode`. The per-dispatch path is then a single branch +
  // 1-or-2 property lookups — no per-call shape inspection.
  type CellFn = (state: S, msg: M) => readonly [S, readonly C[]];
  type ReducerRecord = Reducer<S, M, C>;
  type TransitionsTable = {
    [stateType: string]: { [msgType: string]: CellFn };
  };
  const updateForm = machine.update;
  type UpdateMode = "reducer" | "transitions";
  const updateMode: UpdateMode = (() => {
    // Inspect a single value to disambiguate. Both Reducer and Transitions
    // are non-null objects; their values differ: Reducer's values are
    // functions, Transitions's values are objects (of functions). Pick the
    // first own key — order doesn't matter because the record forms are
    // uniform (every cell has the same value shape).
    const firstKey = Object.keys(updateForm as object)[0];
    if (firstKey === undefined) {
      // Empty object literal: M is `never`. No msg can ever be dispatched,
      // so the mode is irrelevant — pick "reducer" arbitrarily. Pre-boot
      // this never executes because the runtime never dispatches `never`.
      return "reducer";
    }
    const firstValue = (updateForm as Record<string, unknown>)[firstKey];
    return typeof firstValue === "function" ? "reducer" : "transitions";
  })();
  function applyUpdate(state: S, msg: M): readonly [S, readonly C[]] {
    if (__DEV__) deepFreeze(state);

    let result: readonly [S, readonly C[]];
    if (updateMode === "reducer") {
      // Flat record dispatch. Mapped type (`Reducer<S, M, C>`) guarantees
      // every Msg variant has a handler at the type level; runtime is a
      // single property lookup with no fallback default branch.
      const record = updateForm as ReducerRecord;
      const handler = record[msg.type as M["type"]];
      result = handler(state, msg as Extract<M, { type: M["type"] }>);
    } else {
      // Transitions table dispatch. `state` is constrained to
      // `{ type: string }` by the `defineMachine` Transitions overload; the
      // table guarantees every (state.type × msg.type) cell exists at the
      // type level. Runtime is two property lookups + the call.
      const table = updateForm as unknown as TransitionsTable;
      const stateKey = (state as unknown as { type: string }).type;
      // The Transitions overload guarantees every (state.type × msg.type) cell
      // exists at the type level; the runtime lookup cannot miss.
      const handler = table[stateKey]![msg.type]!;
      result = handler(state, msg);
    }

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
        const cleanup = handler(sub as Extract<U, { type: U["type"] }>, ctx, enqueueDispatch);
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
    [K in C["type"]]: (cmd: Extract<C, { type: K }>, ctx: Ctx & PortEmitter) => Promise<M | void>;
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
      const follow = await handler(cmd as Extract<C, { type: C["type"] }>, augmentedCtx);
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
   * Fire every observer with the just-applied msg + post-transition state.
   * Same throw-isolation contract as `fireListeners`. Called immediately
   * after `fireListeners` so observers see exactly what subscribers see.
   */
  function fireObservers(msg: M | null): void {
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
    const [next, cmds] = applyUpdate(state, msg);
    state = next;
    if (store) await store.save(state);
    // Subscriptions reconcile against the new state; throws propagate AFTER
    // the entire diff pass completes (so other subs still register / clean
    // up correctly). Cleanup throws are swallowed inside reconcileSubs.
    reconcileSubs();
    await runInterpret(cmds);
    fireListeners();
    fireObservers(msg);
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
    fireObservers(null);
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
    if (stopped) return Promise.reject(new Error("@demlik/tea: runtime stopped"));
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
  //
  // `bootPromise` is the original (un-swallowed) promise — it is what
  // `runtime.ready` exposes so callers see the boot error directly. `tail`
  // gets the swallowed branch so a boot failure does NOT poison every
  // subsequent dispatch's `.then` chain (each dispatch surfaces `bootError`
  // explicitly inside `enqueueDispatch`).
  const bootPromise = stepBootEffects();
  tail = bootPromise.catch((err) => {
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
        throw new Error("@demlik/tea: getState() called before runtime booted");
      }
      return state;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observe(observer: (msg: M | null, state: S) => void): () => void {
      observers.add(observer);
      return () => {
        observers.delete(observer);
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
    // `ready` is the original (un-swallowed) boot promise. Idempotency
    // comes for free — promises settle exactly once; every read returns the
    // same settled value. See the boot-promise note above for why this is
    // distinct from `tail`.
    ready: bootPromise,
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
 * @param runtime  Any `Runtime<S, M>`. The tracker uses only `observe`.
 * @param size     Buffer cap. `size <= 0` produces a tracker whose
 *                 snapshot is always `[]` (the observer is still attached
 *                 but pushes a no-op; cheaper to skip the tracker entirely
 *                 in that case).
 *
 * Memory cost: O(size × avg(msg + state size)). For audit-extension's
 * inspector use case (size 100, audit state ~5KB), ~500KB max — held
 * in-memory only, no persistence.
 */
export function historyTracker<S, M extends { type: string }>(
  runtime: Runtime<S, M>,
  size: number,
): HistoryTracker<S, M> {
  const buffer: { msg: M | null; state: S }[] = [];
  let stopped = false;

  const unobserve =
    size <= 0
      ? (): void => {}
      : runtime.observe((msg, state) => {
          buffer.push({ msg, state });
          if (buffer.length > size) buffer.shift();
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
export function replay<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
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

  let state: S = initialState;
  const cmds: C[] = [...initCmds];

  // Mirror the same form-branching the runtime does (see `applyUpdate` in
  // `run`). Detected once; reused per-msg. Keeping it inline (not factored
  // into a shared helper) so `replay` stays standalone — it is the pure
  // unit-test tool and must not depend on `run`'s internal closures.
  type CellFn = (state: S, msg: M) => readonly [S, readonly C[]];
  type ReducerRecord = Reducer<S, M, C>;
  type TransitionsTable = { [stateType: string]: { [msgType: string]: CellFn } };
  const updateForm = machine.update;
  type UpdateMode = "reducer" | "transitions";
  const updateMode: UpdateMode = (() => {
    const firstKey = Object.keys(updateForm as object)[0];
    if (firstKey === undefined) return "reducer";
    const firstValue = (updateForm as Record<string, unknown>)[firstKey];
    return typeof firstValue === "function" ? "reducer" : "transitions";
  })();

  for (const msg of opts.msgs) {
    if (__DEV__) deepFreeze(state);

    let result: readonly [S, readonly C[]];
    if (updateMode === "reducer") {
      result = (updateForm as ReducerRecord)[msg.type as M["type"]](
        state,
        msg as Extract<M, { type: M["type"] }>,
      );
    } else {
      const table = updateForm as unknown as TransitionsTable;
      const stateKey = (state as unknown as { type: string }).type;
      result = table[stateKey]![msg.type]!(state, msg);
    }

    if (__DEV__) assertPureResult(result, msg.type);

    const [next, emitted] = result;
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
