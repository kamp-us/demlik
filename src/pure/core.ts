/**
 * @demlik/tea — pure-core leaf (ADR 0006).
 *
 * This is the runtime-free pure core of the substrate. It holds the
 * client-prediction fold seam (`foldMsgs`), the form reader
 * (`formOf`/`detectUpdateForm`), and the pure type vocabulary (`Machine`,
 * `Reducer`, `Transitions`, `Cmd`, `Sub`, `Port`, …).
 *
 * **Dependency direction (the actual decoupling):** this module imports
 * NOTHING from the runtime — no `better-result`, no `run`/host/`Store`. The
 * runtime (`run`, the host, interpret, `Store`, subscribe — all in
 * `../index.ts`) imports *from* here; never the reverse. The
 * `@demlik/tea/pure` subpath re-exports this surface, and
 * `pure/import-graph.test.ts` is the regression fence asserting the pure
 * entrypoint's import graph never reaches `run`.
 */

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
export const __DEV__: boolean = (() => {
  try {
    const meta = import.meta as unknown as { env?: { DEV?: boolean } };
    if (meta.env?.DEV !== undefined) {
      return meta.env.DEV;
    }
  } catch {
    // import.meta not available (Node CJS, service workers)
  }
  try {
    return (
      typeof process !== "undefined" && process.env?.NODE_ENV !== "production"
    );
  } catch {
    return false;
  }
})();

export function deepFreeze<T>(obj: T, seen?: WeakSet<object>): T {
  if (obj === null || typeof obj !== "object") return obj;
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null)
    return obj;
  const visited = seen ?? new WeakSet();
  if (visited.has(obj as object)) return obj;
  visited.add(obj as object);
  Object.freeze(obj);
  for (const v of Object.values(obj as Record<string, unknown>))
    deepFreeze(v, visited);
  return obj;
}

export function hasFunctionValues(obj: unknown): string | null {
  if (obj === null || typeof obj !== "object") return null;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof value === "function") return key;
  }
  return null;
}

export function assertPureResult(result: unknown, msgType: string): void {
  if (result && typeof (result as { then?: unknown }).then === "function") {
    throw new Error(
      `@demlik/tea: update cell "${msgType}" returned a Promise. ` +
        `update must be synchronous. Move async work to interpret.`,
    );
  }
  if (
    !Array.isArray(result) ||
    result.length < 2 ||
    !Array.isArray(result[1])
  ) {
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

// === SyncReturn<S, C>: the compile-time reentrancy guard (ADR 0003 #5) ===
//
// The canon rule (`.patterns/tea-do/reentrancy.md`,
// `.patterns/tea-do/reentrancy-deadlock.md`): a reducer must never
// inline-`await` a re-entrant result. "Non-reentrant by default" ≡ "the reducer
// is pure AND synchronous": a reducer that returns a `Promise` (because it is
// `async`, or inline-`await`s) is the suspended-but-still-blocking turn Orleans
// serializes against — it occupies the single-writer slot across a suspension
// point and can be re-entered mid-flight → deadlock.
//
// So the guard is purely type-level: every reducer/transition cell returns
// `SyncReturn<S, C>` — the synchronous result tuple, intersected with `{ then?:
// never }` to make it *non-thenable*. A `Promise<readonly [S, readonly C[]]>`
// is an object with a `then` method, so it fails to satisfy `then?: never`; an
// `async (s, m) => [...]` (or one that inline-`await`s) is therefore
// unrepresentable at compile time — `tsc` rejects it *at the cell*, not at a
// runtime hang. A plain synchronous tuple `[next, cmds]` has no `then` property,
// so the optional-absent `then?: never` is satisfied and existing pure reducers
// compile unchanged. `SyncReturn<S, C>` is also assignable *to* `readonly [S,
// readonly C[]]` (the intersection is narrower), so the runtime dispatch in
// `run`/`replay` consumes a cell result exactly as before.
//
// This mirrors `retry-backoff`'s `Rng` brand (#63): the obligation lives in the
// type at the construction boundary ("parse, don't validate"), not in a comment.
export type SyncReturn<S, C extends Cmd> = readonly [S, readonly C[]] & {
  // A thenable carries a callable `then`; forbidding it rejects every Promise.
  // Optional + `never` means "absent on a sync tuple, impossible on a Promise".
  readonly then?: never;
};

// === update form: Reducer vs Transitions, tagged once ===
//
// The substrate accepts two `update` shapes (see the `Machine.update` union and
// the `defineMachine` overloads):
//
//   - "reducer"     — flat record keyed by Msg.type, every cell a function.
//   - "transitions" — 2D table keyed by State.type then Msg.type, every cell a
//                     record of functions.
//
// Which one a given machine is must be known at runtime by `run`, `replay`, and
// the `withX` wrappers (their dispatch / key-enumeration / reserved-namespace
// scans differ per form). Rather than re-derive it structurally at every reader
// — a `typeof update[firstKey] === "function"` heuristic that breaks the day a
// reducer cell is itself an object-with-a-call — `defineMachine` computes the
// form ONCE at construction and stamps it on the machine as a non-enumerable
// `__form` (so it never serializes, never collides with a Msg.type key, never
// shows up in `Object.keys(machine)`). Every reader calls `formOf(machine)`.
export type UpdateForm = "reducer" | "transitions";

// The single structural heuristic, defined ONCE. Used only by `defineMachine`
// (and `formOf`'s fallback for machines built without it, e.g. a plain object
// literal annotated as `Machine`). A Reducer's first own value is a function; a
// Transitions table's first own value is a record (of functions). An empty
// record (`M` is `never`) can never dispatch a Msg, so the form is irrelevant —
// "reducer" is returned arbitrarily.
export function detectUpdateForm(update: object): UpdateForm {
  const firstKey = Object.keys(update)[0];
  if (firstKey === undefined) return "reducer";
  const firstValue = (update as Record<string, unknown>)[firstKey];
  return typeof firstValue === "function" ? "reducer" : "transitions";
}

// The single reader every form-sensitive site goes through. Prefers the
// `__form` tag stamped by `defineMachine` (authoritative — computed once at the
// typed construction boundary); falls back to `detectUpdateForm` only for a
// machine that never passed through `defineMachine`. No reader re-implements the
// heuristic.
export function formOf(machine: {
  update: object;
  __form?: UpdateForm;
}): UpdateForm {
  return machine.__form ?? detectUpdateForm(machine.update);
}

// === NoCellError: the named cell-lookup failure (#276) ===
//
// An unknown `msg.type` (wire data reaching dispatch) or a type-bypassed
// missing cell used to surface as a bare `TypeError: ... is not a function`
// deep inside dispatch — no msg.type, no state name, nothing actionable. The
// guard lives in `applyCell` because it is the single dispatch primitive
// every stepping site goes through (#275), so one guard covers `run`,
// replay/foldMsgs, the PBT fold runner, and the withX wrappers.
export class NoCellError extends Error {
  override readonly name = "NoCellError";
  constructor(
    public readonly msgType: string,
    public readonly stateName: string,
  ) {
    super(
      `@demlik/tea: no update cell for msg.type "${msgType}" in state ` +
        `"${stateName}" — the machine's update does not handle this Msg ` +
        `(an unknown wire msg.type, or a missing cell reached by bypassing ` +
        `the mapped types).`,
    );
  }
}

// Reducer-form State carries no mandatory discriminant; best-effort read of a
// string `state.type` for the error, else a placeholder.
function stateNameOf(state: unknown): string {
  if (typeof state === "object" && state !== null && "type" in state) {
    const t = (state as { type: unknown }).type;
    if (typeof t === "string") return t;
  }
  return "(untagged state)";
}

// === applyCell: THE single reducer-vs-transitions dispatch primitive ===
//
// Applies the one update cell selected by `(formOf(machine), state, msg)` and
// returns its `[nextState, cmds]` verbatim. Every site that steps a machine —
// `run`'s applyUpdate, `foldUpdates` (replay/foldMsgs), the PBT fold runner,
// and the withX wrappers — dispatches through THIS function, so production and
// the verification tools agree on the update form by construction (#275).
// Pure and dev-check-free: `deepFreeze`/`assertPureResult` stay at the call
// sites that want them. A missing cell throws `NoCellError` (#276), never a
// bare TypeError.
export function applyCell<S, M extends { type: string }, C extends Cmd>(
  machine: { update: object; __form?: UpdateForm },
  state: S,
  msg: M,
): readonly [S, readonly C[]] {
  type CellFn = (state: S, msg: M) => readonly [S, readonly C[]];
  if (formOf(machine) === "reducer") {
    const record = machine.update as Record<string, CellFn | undefined>;
    const cell = record[msg.type];
    if (typeof cell !== "function") {
      throw new NoCellError(msg.type, stateNameOf(state));
    }
    return cell(state, msg);
  }
  const table = machine.update as Record<
    string,
    Record<string, CellFn | undefined> | undefined
  >;
  // The ONE sanctioned `state as unknown as { type }` read: the Transitions
  // overload constrains S to `{ type: string }` at the `defineMachine`
  // boundary, but that constraint is erased on the runtime-facing `object`
  // here — every former per-site copy of this double-cast collapsed into
  // this line (#275).
  const stateKey = (state as unknown as { type: string }).type;
  const cell = table[stateKey]?.[msg.type];
  if (typeof cell !== "function") {
    throw new NoCellError(msg.type, String(stateKey));
  }
  return cell(state, msg);
}

// === msgKeysOf: recover the Msg.type set from either update form ===
//
// A Reducer's own keys ARE the Msg.type set. A Transitions table's keys are
// state.type; its INNER keys are the Msg.type set (uniform across phases by
// the mapped-type contract), so the first phase's inner keys are read. An
// empty update (`M` is `never`) yields `[]`. Keyed on `formOf` — the withX
// wrappers and the PBT `msgTypeKeys` all read through this one helper (#275).
export function msgKeysOf(machine: {
  update: object;
  __form?: UpdateForm;
}): readonly string[] {
  const keys = Object.keys(machine.update);
  const firstKey = keys[0];
  if (firstKey === undefined) return [];
  if (formOf(machine) === "reducer") return keys;
  const firstValue = (machine.update as Record<string, unknown>)[firstKey];
  return Object.keys(firstValue as object);
}

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
  [K in M["type"]]: (
    state: S,
    msg: Extract<M, { type: K }>,
    // `SyncReturn<S, C>` (not `readonly [S, readonly C[]]`) is the reentrancy
    // guard: a non-thenable return type, so an `async`/inline-`await`ing cell —
    // which returns `Promise<...>` — fails to compile at the cell. See the
    // `SyncReturn` doc above.
  ) => SyncReturn<S, C>;
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
export type Transitions<
  S extends { type: string },
  M extends { type: string },
  C extends Cmd,
> = {
  [P in S["type"]]: {
    [K in M["type"]]: (
      state: Extract<S, { type: P }>,
      msg: Extract<M, { type: K }>,
      // Same reentrancy guard as `Reducer`: a transition cell that returns a
      // Promise (async / inline-await) is the suspended-blocking turn the canon
      // forbids, so its return is the non-thenable `SyncReturn<S, C>`.
    ) => SyncReturn<S, C>;
  };
};

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
  batch: <const C extends Cmd>(
    ...arrs: readonly (readonly C[])[]
  ): readonly C[] => {
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
  when: <const C extends Cmd>(cond: boolean, cmd: C): readonly C[] =>
    cond ? [cmd] : [],

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

// === NoCtx: the context-free marker ===
//
// A handler, Sub, or machine that reads NOTHING from `ctx` says so by using
// `NoCtx` for its Ctx slot. This is the DELIBERATE absence of context — not
// the accidental `unknown` looseness that erodes a boundary (see issue #64).
//
// `unknown` at a Ctx seam is ambiguous: it can mean "I intentionally need no
// context" OR "I gave up tightening this type." `NoCtx` resolves that
// ambiguity at the type level. A reader (and the next agent) sees `NoCtx` and
// knows the context-free-ness is a choice the author made, not a hole.
//
// Shape: an empty readonly record. A `Ctx & PortEmitter` is-a `NoCtx`, so a
// context-free handler still composes at a richer call site. It carries no
// own fields, so the name's claim ("reads nothing from ctx") is what callers
// read at the seam.
//
// Strengthens invariant 6 (no silent looseness — a context-free seam is named,
// not inferred) and invariant 8 (the boundary is legible; `unknown` stays
// reserved for genuine wire-edge erasure, not for "didn't bother").
export type NoCtx = Readonly<Record<never, never>>;

/** Spelled-out alias for `NoCtx`, for sites that prefer the long name. */
export type ContextFree = NoCtx;

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
  [K in C["type"]]: (
    cmd: Extract<C, { type: K }>,
    ctx: Ctx & PortEmitter,
    // biome-ignore lint/suspicious/noConfusingVoidType: an interpret handler returns a follow-up Msg or nothing; `void` permits no-return bodies that `M | undefined` would reject
  ) => Promise<M | void>;
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
export type Machine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
> = {
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
  /**
   * The update form ("reducer" | "transitions"), stamped non-enumerably by
   * `defineMachine` at construction (see `UpdateForm` / `formOf`). Optional in
   * the type so the structural `Machine` annotation form keeps accepting plain
   * object literals; readers go through `formOf`, which falls back to
   * `detectUpdateForm` when the tag is absent. Never written by hand.
   */
  readonly __form?: UpdateForm;
} & ([C] extends [Cmd<never>]
  ? { interpret?: Interpret<M, C, Ctx> }
  : { interpret: Interpret<M, C, Ctx> }) &
  // `subscribe`/`subscriptions` are conditionally REQUIRED the same way
  // `interpret` is (#276): a machine declaring a real Sub union without a
  // subscribe map compiled and silently wired no subs (`reconcileSubs` skips
  // undefined handlers) — the exact silent-failure class the `interpret`
  // conditional prevents. The optional declarations above stay as U's
  // inference sites (a conditional type is not an inference site); this
  // intersection only adds requiredness when U is a real union. Same
  // tuple-wrap trick as `interpret` to disable distribution.
  ([U] extends [Sub<never>]
    ? unknown
    : {
        subscriptions: (state: S) => readonly U[];
        subscribe: Subscribe<M, U, Ctx>;
      });

// === foldUpdates: the single internal fold `replay` and `foldMsgs` share ===
//
// Folds `machine.update` over `msgs` from `initialState`, dispatching each
// Msg through `applyCell` — the same primitive `run` uses — so every fold site
// agrees on the reducer-vs-transitions form by construction (no second copy of
// the dispatch to drift). Returns the final state plus the Cmds the cells emitted
// along the way; the caller keeps them (`replay`) or discards them (`foldMsgs`).
//
// Touches no `Store`, no `interpret` handler, and starts no subscription — it
// only calls `update` cells. The two public folds differ only in how they
// enter and what they return: `replay` enters via `init` and returns
// `{ state, cmds, subs }`; `foldMsgs` enters from a base state and returns `S`.
export function foldUpdates<S, M extends { type: string }, C extends Cmd>(
  machine: { update: object; __form?: UpdateForm },
  initialState: S,
  msgs: readonly M[],
): { state: S; cmds: C[] } {
  let state: S = initialState;
  const cmds: C[] = [];

  for (const msg of msgs) {
    if (__DEV__) deepFreeze(state);

    const result = applyCell<S, M, C>(machine, state, msg);

    if (__DEV__) assertPureResult(result, msg.type);

    const [next, emitted] = result;
    state = next;
    cmds.push(...emitted);
  }

  return { state, cmds };
}

// === foldMsgs: runtime-free client-prediction fold seam (ADR 0006, #211) ===
//
// Folds `machine.update` over an ordered `Msg[]` starting from a caller-supplied
// `base` state and returns the resulting state ONLY. This is the client-side
// replay primitive a prediction loop needs (the Gambetta/Valve
// authoritative-server reconcile step): re-simulate a queue of un-acked inputs
// on top of an authoritative snapshot —
// `foldMsgs(machine, snapshot, pendingInputs)`.
//
// Distinct from `replay` (the test idiom), by design (ADR 0006):
// - Enters from a direct `base` parameter, NOT via `init`/`loaded` — so
//   reconciliation correctness never depends on the machine author's `init`
//   rehydrate discipline. Takes no `ctx` (the fold calls `update` only).
// - Returns just the final `S` — not `{ state, cmds, subs }`. During prediction
//   the inputs' effects were already sent to the server; re-emitting their Cmds
//   on the client would double-fire, and `subs` are a runtime concern. Returning
//   only `S` makes "replay fires no effects" structural, not caller discipline.
//   A caller that wants the emitted Cmds for assertions uses `replay`.
//
// Invokes no `Store`, no `interpret` handler, and starts no subscription — it
// shares `replay`'s `foldUpdates` fold, which only calls `update` cells, and
// reads the reducer-vs-transitions form via the same `formOf(machine)` reader
// `run`/`replay` use, so it agrees with them by construction.
//
// Per ADR 0006 the runtime-free *guarantee* lives on a dedicated
// `@demlik/tea/pure` subpath whose module graph never reaches `run`; that
// subpath export + import-graph guard are #213's scope. Here `foldMsgs` ships
// as a reachable public API from root; #213 formalizes the boundary.
export function foldMsgs<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(machine: Machine<S, M, C, U, Ctx>, base: S, msgs: readonly M[]): S {
  return foldUpdates<S, M, C>(machine, base, msgs).state;
}
