/**
 * @demlik/tea — pure-core leaf (ADR 0006).
 *
 * This is the runtime-free pure core of the substrate. It holds the
 * client-prediction fold seam (`foldMsgs`), the form reader
 * (`formOf`/`detectUpdateForm`), and the pure type vocabulary (`Machine`,
 * `Reducer`, `Transitions`, `Cmd`, `Sub`, `Port`, …).
 *
 * **Dependency direction (the actual decoupling):** this module imports
 * NOTHING from the runtime — no `run`/host/`Store`. The
 * runtime (`run`, the host, interpret, `Store`, subscribe — all in
 * `../index.ts`) imports *from* here; never the reverse. The root door
 * re-exports this surface through `./index.ts`, and
 * `pure/import-graph.test.ts` is the regression fence asserting the pure
 * entrypoint's import graph never reaches `run`.
 *
 * The one external name it reaches for is the Standard Schema TYPE surface
 * (`import type` from `@standard-schema/spec`), erased at compile time —
 * `Cmd.define` accepts any Standard Schema (zod, Effect Schema through
 * `Schema.toStandardSchemaV1`, …), and it imports no schema library.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";

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

/**
 * Drop one `key` from a `Record` immutably — returns a new record with `key`
 * omitted, leaving the input untouched. The immutable-record-key-drop the L2
 * resilience bricks reach for whenever a settled/restarted call must forget its
 * per-key bookkeeping (a retry counter, a parked input). A plain
 * object-rest spread, lifted here so `resilient-call` and `authed-call` share
 * one definition instead of open-coding `const { [key]: _drop, ...rest } = rec`
 * at each site.
 */
export function without<V>(
  rec: Readonly<Record<string, V>>,
  key: string,
): Readonly<Record<string, V>> {
  const { [key]: _dropped, ...rest } = rec;
  return rest;
}

// === Cmd: tagged-union, one-shot effect ===
//
// `Ok` and `E` are carried as PHANTOM type parameters (ADR 0014): the runtime
// value stays `{ readonly type: T }` — JSON-plain, hashable, replayable — and
// the two channels ride on optional fields that are never assigned, exactly as
// `Port.__t` carries its `T`.
//
//   - `Ok` — the value this Cmd settles with on success. Defaults to `unknown`.
//   - `E` — the `_tag` union this Cmd can settle with (`{ _tag: "timeout" } |
//     …`). A reducer's `_err` cell reads it, so a new failure mode is a compile
//     error at the cell, not a runtime surprise. Defaults to `unknown`, the
//     "untyped" reading every hand-written battery Cmd has today.
//
// A Cmd names no requirements (ADR 0020): which services run it is a fact
// about the handler that interprets it, not about the journaled Cmd.
//
// Both channels are named by `Cmd.define`; a Cmd literal never spells them.
// The phantoms are optional, so a `{ type }` literal still satisfies `Cmd`.
/**
 * A tagged-union, one-shot effect — JSON-plain, hashable, replayable.
 *
 * `T` is the tag. `Ok` and `E` are phantom type parameters (ADR 0014): `Ok` is
 * the value this Cmd settles with, and `E` is the `_tag` union it can fail
 * with. A Cmd carries no requirements (ADR 0020) — its handler gets its
 * services from the plain `ctx` handed to `run`.
 */
export type Cmd<T extends string = string, Ok = unknown, E = unknown> = {
  readonly type: T;
  /** Phantom — the value this Cmd settles with. Never assigned. */
  readonly __ok?: Ok;
  /** Phantom — the `_tag` union this Cmd can settle with. Never assigned. */
  readonly __e?: E;
};

/** The `E` union one Cmd can settle with; `unknown` for an untyped Cmd. */
export type ErrorsOf<C> = C extends { readonly __e?: infer E } ? E : unknown;

// === Outcome: what a `Cmd.define`d handler returns (ADR 0021) ===
//
// A handler reports whether the work succeeded and with what; the ENGINE turns
// that into the Cmd's `<name>_ok` / `<name>_err` Msg. The record is plain and
// tagged, so the core names no `Result` library and each engine converts its own
// native result into it at its edge.

/** The result a `Cmd.define`d handler returns: its value, or a declared failure. */
export type Outcome<Ok, E> =
  | { readonly _tag: "Ok"; readonly value: Ok }
  | { readonly _tag: "Err"; readonly error: E };

/**
 * The two builders the Promise engine hands a `Cmd.define`d handler on its
 * ctx: `ok(value)` and `err({ _tag })`, with `err` typed to the def's declared
 * tags.
 */
export interface OutcomeHelpers<Ok, E> {
  readonly ok: (value: Ok) => Outcome<Ok, never>;
  readonly err: (error: E) => Outcome<never, E>;
}

/**
 * Build an {@link Outcome} outside a handler's helpers — in a test that calls a
 * handler directly, or in an adapter converting another result type.
 */
export const Outcome = {
  ok: <Ok>(value: Ok): Outcome<Ok, never> => ({ _tag: "Ok", value }),
  err: <E>(error: E): Outcome<never, E> => ({ _tag: "Err", error }),
} as const;

function isOutcome(value: unknown): value is Outcome<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const tag = (value as { _tag?: unknown })._tag;
  return (
    (tag === "Ok" && "value" in value) || (tag === "Err" && "error" in value)
  );
}

// === Cmd.define: the typed Cmd constructor (ADR 0014 §1, 0015 §1, 0021) ===
//
// "Types on the constructor, data in the record." A Cmd built by hand carries
// no `Ok` and no `E`; one built by `Cmd.define` carries both, and the minted
// settled Msgs (`<name>_ok` / `<name>_err`) are derived from the same
// declaration — so the reducer, the interpret handler and the runtime edge all
// read ONE source for what this effect can produce.
//
// Everything a constructor names is a TYPE or a SCHEMA; the value it returns is
// still the dead record `{ type, ...input }`. `input` and `ok` are Standard
// Schemas (https://standardschema.dev) — zod passes straight in, Effect Schema
// through `Schema.toStandardSchemaV1` — and `err` is the `_tag` list a handler
// may fail with.
//
// The failure union always carries one kernel tag beside the declared ones:
// `MalformedResult`, minted at the interpret edge when a handler's `Ok` value
// fails the `ok` schema. Invariant 8 (the boundary parses, the core trusts): a
// corrupt result becomes a typed `_err` the reducer already has a cell for, and
// never reaches Model.

/** The shape every settled failure has (ADR 0011): a plain `_tag` record. */
export type Tagged = { readonly _tag: string };

/**
 * One declared failure per tag. Distributive, so `TaggedError<"a" | "b">` is
 * the two-arm union a `switch (error._tag)` narrows; the index signature lets a
 * settle site carry detail beside the tag (`{ _tag: "timeout", afterMs }`).
 */
export type TaggedError<Tag extends string> = Tag extends string
  ? { readonly _tag: Tag; readonly [detail: string]: unknown }
  : never;

/**
 * The kernel-minted failure: a handler returned an `Ok` value the Cmd's `ok`
 * schema rejects. Plain data, so it folds into Model like any settled error;
 * `issues` is the schema's issue list flattened to `path` + `message` strings.
 */
export type MalformedResult = {
  readonly _tag: "malformed_result";
  readonly issues: ReadonlyArray<{
    readonly path: string;
    readonly message: string;
  }>;
};

/** Render a Standard Schema issue list into the JSON-plain `MalformedResult`. */
export function malformedResult(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): MalformedResult {
  return {
    _tag: "malformed_result",
    issues: issues.map((issue) => ({
      path: (issue.path ?? [])
        .map((segment) =>
          String(typeof segment === "object" ? segment.key : segment),
        )
        .join("."),
      message: issue.message,
    })),
  };
}

/**
 * A schema whose `validate` returned a Promise where the kernel needs an answer
 * now — the `ok` check at the interpret edge, the `args` check in a reducer.
 * A contract breach (ADR 0021 §5): it goes to the error sink.
 */
export class AsyncSchemaError extends Error {
  override readonly name = "AsyncSchemaError";
  readonly _tag = "AsyncSchemaError" as const;
  constructor(
    /** What the schema was checking, e.g. `the "fetch" Cmd's ok schema`. */
    public readonly where: string,
  ) {
    super(
      `@demlik/tea: ${where} validated asynchronously. tea checks schemas ` +
        `synchronously, so a schema whose \`~standard.validate\` returns a ` +
        `Promise cannot be used here.`,
    );
  }
}

/**
 * Run a Standard Schema synchronously. Throws {@link AsyncSchemaError} when the
 * schema answers with a Promise; `where` names the check for that message.
 */
export function validateSync<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
  where: string,
): StandardSchemaV1.Result<T> {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    // Nobody awaits it; keep a late rejection from surfacing as unhandled.
    result.catch(() => {});
    throw new AsyncSchemaError(where);
  }
  return result;
}

/**
 * A `Cmd.define`d handler failed outside its declared channel: its `Err` carried
 * no `_tag`, or a tag the def does not declare. A contract breach (ADR 0011,
 * 0021 §4): it goes to the error sink, never to `<name>_err`.
 */
export class UndeclaredFailureError extends Error {
  override readonly name = "UndeclaredFailureError";
  readonly _tag = "UndeclaredFailureError" as const;
  constructor(
    public readonly cmdType: string,
    /** The `error` the handler's `Err` carried, verbatim. */
    public readonly failure: unknown,
    /** The tags the def declares. */
    public readonly declared: readonly string[],
  ) {
    super(
      `@demlik/tea: the "${cmdType}" handler failed with ${describeTag(failure)}, ` +
        `which its Cmd.define does not declare (declared: ` +
        `${declared.length === 0 ? "none" : declared.map((t) => `"${t}"`).join(", ")}). ` +
        `An undeclared failure goes to the error sink, never to "${cmdType}_err".`,
    );
  }
}

function describeTag(failure: unknown): string {
  const tag =
    typeof failure === "object" && failure !== null
      ? (failure as { _tag?: unknown })._tag
      : undefined;
  return typeof tag === "string" ? `_tag "${tag}"` : "a value with no _tag";
}

/**
 * A `Cmd.define`d handler returned something the engine cannot settle: its own
 * `<name>_ok` / `<name>_err` Msg (the engine mints those, never the handler —
 * ADR 0021), or a value that is neither an {@link Outcome}, a Msg, nor nothing.
 */
export class OutcomeContractError extends Error {
  override readonly name = "OutcomeContractError";
  readonly _tag = "OutcomeContractError" as const;
  constructor(
    public readonly cmdType: string,
    detail: string,
  ) {
    super(
      `@demlik/tea: the "${cmdType}" handler ${detail}. A Cmd.define'd ` +
        `handler returns an outcome — \`ok(value)\` or \`err({ _tag })\` — and ` +
        `the engine mints "${cmdType}_ok" / "${cmdType}_err" from it.`,
    );
  }
}

/**
 * The payload a constructor accepts: a plain record spread beside `type`. A
 * `type` key is refused at the type level — it would overwrite the discriminant.
 */
export type CmdInput = { readonly type?: never } & Record<string, unknown>;

/** The value `Cmd.define("fetch", …)` builds: `{ type: "fetch", ...input }`. */
export type CmdValue<
  Name extends string,
  Input extends CmdInput,
  Ok,
  E extends Tagged,
> = Cmd<Name, Ok, E | MalformedResult> & Readonly<Input>;

export type SettledOk<Name extends string, C, Ok> = {
  readonly type: `${Name}_ok`;
  readonly cmd: C;
  readonly value: Ok;
  /** Stamped by the runtime at the interpret edge (`run`'s `clock`). */
  readonly at: number;
};

export type SettledErr<Name extends string, C, E extends Tagged> = {
  readonly type: `${Name}_err`;
  readonly cmd: C;
  readonly error: E | MalformedResult;
  /** Stamped by the runtime at the interpret edge (`run`'s `clock`). */
  readonly at: number;
};

/**
 * What `Cmd.define` returns: the Cmd builder itself (`fetch({ url })`), with
 * the minted Msg builders and the declaration hung on it. `E` here is the
 * DECLARED tag union; the settled `_err` arm widens it by `MalformedResult`.
 *
 * `ok` / `err` mint a settled Msg OUTSIDE the runtime (a `replay` log, a unit
 * test) and take an optional `at`. A handler never calls them: it returns an
 * {@link Outcome}, and inside `run` the interpret edge mints and stamps.
 */
export interface CmdDef<
  Name extends string,
  Input extends CmdInput,
  Ok,
  E extends Tagged,
> {
  (input: Input): CmdValue<Name, Input, Ok, E>;
  /** The `type` discriminant of every Cmd this builds. */
  readonly cmdType: Name;
  readonly okType: `${Name}_ok`;
  readonly errType: `${Name}_err`;
  readonly ok: (
    cmd: CmdValue<Name, Input, Ok, E>,
    value: Ok,
    at?: number,
  ) => SettledOk<Name, CmdValue<Name, Input, Ok, E>, Ok>;
  readonly err: (
    cmd: CmdValue<Name, Input, Ok, E>,
    error: E,
    at?: number,
  ) => SettledErr<Name, CmdValue<Name, Input, Ok, E>, E>;
  readonly schema: {
    readonly input: StandardSchemaV1<unknown, Input>;
    readonly ok: StandardSchemaV1<unknown, Ok>;
  };
  /** The declared `_tag` list, verbatim. */
  readonly errTags: ReadonlyArray<E["_tag"]>;
}

/**
 * The declaration-erased view the runtime reads: which `type` a def builds,
 * which two Msg types it settles with, the `ok` schema the edge parses against
 * and the tags an `Err` may carry. Every `CmdDef<…>` is one of these
 * structurally.
 */
export type AnyCmdDef = {
  readonly cmdType: string;
  readonly okType: string;
  readonly errType: string;
  readonly schema: { readonly ok: StandardSchemaV1 };
  readonly errTags: ReadonlyArray<string>;
};

// === The interpret edge — the boundary a `Cmd.define`d result crosses ===
//
// `run` builds ONE edge over `machine.cmds` and its clock, applies it to every
// interpret handler's return, and hands the same edge to the handlers under
// `cmdEdge` on ctx (beside `emit`). The hand-off is for a wrapper that invokes
// a base handler INSIDE its own — `withResilience`'s `$resilience:run` carrier,
// the agent's fanned tool cells — where `run`'s edge sees the carrier's `type`,
// never the def's, so the base outcome would cross unminted (#66). Settling
// through `cmdEdgeOf(ctx)` at the site the def's handler is actually invoked
// keeps one mint, one parse and one clock for the bare and the wrapped machine
// alike.

/**
 * Settle one handler's return: mint a def's outcome into its `_ok` / `_err`
 * Msg, or pass anything else through. Throws on a contract breach.
 */
export type CmdEdge = (
  cmd: { readonly type: string },
  returned: unknown,
) => unknown;

/** The ctx key `run` hands its edge under. A symbol, so no Ctx port can collide. */
export const cmdEdge: unique symbol = Symbol("tea.cmdEdge");

/**
 * The edge over a def list (ADR 0021; invariant 8: the boundary parses, the
 * core trusts). For a Cmd one of `defs` builds, the handler's return is:
 *
 *   - `Ok` — parsed against the `ok` schema: a pass mints `<name>_ok` carrying
 *     the PARSED value (the schema's strip / transform applied), a fail mints
 *     `<name>_err` carrying `malformed_result`, so a corrupt result never
 *     reaches a reducer cell that would fold it into Model;
 *   - `Err` — minted into `<name>_err` when its `_tag` is declared, and thrown
 *     as {@link UndeclaredFailureError} when it is not;
 *   - nothing — nothing is dispatched;
 *   - its own `_ok` / `_err` Msg, or a non-Msg value — thrown as
 *     {@link OutcomeContractError};
 *   - any other Msg — passed through as a follow-up. That arm is the L2
 *     helpers' `handlers(ports)`, which answer in their own Msg vocabulary
 *     until they ship run Cmds instead (#282).
 *
 * Minted Msgs are stamped with `at` from the clock. A Cmd no def builds — a
 * hand-written Cmd's follow-up — passes through untouched.
 */
export function cmdEdgeOver(
  defs: Iterable<AnyCmdDef>,
  clock: () => number,
): CmdEdge {
  const byType = new Map<string, AnyCmdDef>();
  for (const def of defs) byType.set(def.cmdType, def);
  return (cmd, returned) => {
    const def = byType.get(cmd.type);
    if (def === undefined) return returned;
    if (returned === undefined || returned === null) return undefined;
    if (isOutcome(returned)) return mint(def, cmd, returned, clock());
    const type =
      typeof returned === "object"
        ? (returned as { type?: unknown }).type
        : undefined;
    if (typeof type !== "string") {
      throw new OutcomeContractError(
        def.cmdType,
        "returned a value that is neither an outcome nor a Msg",
      );
    }
    if (type === def.okType || type === def.errType) {
      throw new OutcomeContractError(
        def.cmdType,
        `returned its own "${type}" Msg`,
      );
    }
    return returned;
  };
}

function mint(
  def: AnyCmdDef,
  cmd: unknown,
  outcome: Outcome<unknown, unknown>,
  at: number,
): { readonly type: string; readonly cmd: unknown; readonly at: number } & (
  | { readonly value: unknown }
  | { readonly error: unknown }
) {
  if (outcome._tag === "Err") {
    const tag =
      typeof outcome.error === "object" && outcome.error !== null
        ? (outcome.error as { _tag?: unknown })._tag
        : undefined;
    if (typeof tag !== "string" || !def.errTags.includes(tag)) {
      throw new UndeclaredFailureError(def.cmdType, outcome.error, def.errTags);
    }
    return { type: def.errType, cmd, error: outcome.error, at };
  }
  const parsed = validateSync(
    def.schema.ok,
    outcome.value,
    `the "${def.cmdType}" Cmd's ok schema`,
  );
  if (parsed.issues !== undefined) {
    return {
      type: def.errType,
      cmd,
      error: malformedResult(parsed.issues),
      at,
    };
  }
  return { type: def.okType, cmd, value: parsed.value, at };
}

/**
 * The edge `run` put on this ctx, or the pass-through when the handler runs
 * outside `run` (a unit test calling it directly).
 */
export function cmdEdgeOf(ctx: unknown): CmdEdge {
  const edge =
    typeof ctx === "object" && ctx !== null
      ? (ctx as { [cmdEdge]?: CmdEdge })[cmdEdge]
      : undefined;
  return edge ?? ((_, returned) => returned);
}

// === The detached-work edge — work a handler outlives ===
//
// A handler that returns BEFORE its effect finishes (so the serial interpret
// loop can reach the next Cmd — ADR 0018's fan-out-inside-the-Cmd shape) leaves
// the runtime with no promise to count. Handing that promise to `detachWorkOf`
// puts it back on the two accountings a returned promise would have been on:
// `inFlightCmds`, which `stop()` reports as discarded work, and the serial
// dispatch tail, which `idle()` drains to quiescence. Without it a fanned run
// reads as quiescent while its tools are still running.

/** Enlist a promise the handler will not return in the runtime's accounting. */
export type DetachWork = (work: Promise<unknown>) => void;

/** The ctx key `run` hands its detach seam under — a symbol, like `cmdEdge`. */
export const detachWork: unique symbol = Symbol("tea.detachWork");

/**
 * The detach seam `run` put on this ctx, or a no-op when the handler runs
 * outside `run` (a unit test calling it directly), where there is no tail to
 * extend and no count to hold.
 */
export function detachWorkOf(ctx: unknown): DetachWork {
  const detach =
    typeof ctx === "object" && ctx !== null
      ? (ctx as { [detachWork]?: DetachWork })[detachWork]
      : undefined;
  return detach ?? (() => undefined);
}

/** The Cmd value a def (or a union of defs) builds. */
// (`infer C extends Cmd` keeps the derived union inside `Machine`'s `C extends
// Cmd` constraint — without it the inference site is unconstrained.)
export type CmdOf<D extends AnyCmdDef> = D extends ((
  input: never,
) => infer C extends Cmd)
  ? C
  : never;

/**
 * The settled-Msg union a def (or a union of defs) mints: `<name>_ok` carrying
 * `value`, `<name>_err` carrying `error`. `defineMachine({ cmds })` folds this
 * into the machine's `M` so the user never spells the effect half of it.
 */
export type Settled<D extends AnyCmdDef> =
  D extends CmdDef<infer Name, infer Input, infer Ok, infer E>
    ?
        | SettledOk<Name, CmdValue<Name, Input, Ok, E>, Ok>
        | SettledErr<Name, CmdValue<Name, Input, Ok, E>, E>
    : never;

// Both read one slot of a `CmdDef`; every OTHER slot is `infer`red too, because
// a fixed `string` / `CmdInput` there would sit in a contravariant position (the
// call signature's `input`) and refuse every concrete def.

/** The `Ok` a def's handler must produce. */
export type OkOf<D extends AnyCmdDef> =
  D extends CmdDef<infer _Name, infer _Input, infer Ok, infer _E> ? Ok : never;

/** The DECLARED failure union a def's handler may settle with. */
export type ErrOf<D extends AnyCmdDef> =
  D extends CmdDef<infer _Name, infer _Input, infer _Ok, infer E> ? E : never;

function defineCmd<
  const Name extends string,
  Input extends CmdInput,
  Ok,
  const Tags extends readonly string[],
>(
  name: Name,
  spec: {
    readonly input: StandardSchemaV1<unknown, Input>;
    readonly ok: StandardSchemaV1<unknown, Ok>;
    readonly err: Tags;
  },
): CmdDef<Name, Input, Ok, TaggedError<Tags[number]>> {
  type E = TaggedError<Tags[number]>;
  type C = CmdValue<Name, Input, Ok, E>;
  const okType = `${name}_ok` as const;
  const errType = `${name}_err` as const;
  const build = (input: Input): C => ({ ...input, type: name });
  return Object.assign(build, {
    cmdType: name,
    okType,
    errType,
    ok: (cmd: C, value: Ok, at?: number) =>
      stamp({ type: okType, cmd, value }, at),
    err: (cmd: C, error: E, at?: number) =>
      stamp({ type: errType, cmd, error }, at),
    schema: { input: spec.input, ok: spec.ok },
    errTags: spec.err,
  });
}

// The builders leave `at` ABSENT unless given one; the runtime fills it at the
// interpret edge. The return type carries `at: number` because that is what
// every reducer sees — no Msg reaches `update` unstamped.
function stamp<T extends object>(
  msg: T,
  at: number | undefined,
): T & { at: number } {
  return (at === undefined ? msg : { ...msg, at }) as T & { at: number };
}

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
//
// It also carries `acceptedTypes` — what the refusing state WOULD have taken
// (#14). Without it a caller learns "not this one" and nothing else, so
// discovering that a state accepts nothing at all took one refusal per Msg
// type: N probe dispatches to establish one fact. The empty set is the
// load-bearing case, so the message states it in words rather than rendering an
// empty list — a caller skimming `accepts: []` reads a formatting artefact,
// not a dead end.
export class NoCellError extends Error {
  override readonly name = "NoCellError";
  readonly _tag = "NoCellError" as const;
  constructor(
    public readonly msgType: string,
    public readonly stateName: string,
    /** The Msg types the refusing state has cells for; empty when it has none. */
    public readonly acceptedTypes: readonly string[],
  ) {
    super(
      // The pre-#14 text is kept VERBATIM as a prefix: a caller matching on it
      // keeps matching, and the new clause only ever appends.
      `@demlik/tea: no update cell for msg.type "${msgType}" in state ` +
        `"${stateName}" — the machine's update does not handle this Msg ` +
        `(an unknown wire msg.type, or a missing cell reached by bypassing ` +
        `the mapped types).` +
        (acceptedTypes.length === 0
          ? ` This state accepts no Msg at all.`
          : ` This state accepts: ${acceptedTypes
              .map((t) => `"${t}"`)
              .join(", ")}.`),
    );
  }
}

// Reducer-form State carries no mandatory discriminant; best-effort read of a
// string `state.type` for the error, else a placeholder.
function stateNameOf(state: unknown): string {
  if (state === undefined || state === null) return "(no state)";
  if (typeof state === "object" && "type" in state) {
    const t = (state as { type: unknown }).type;
    if (typeof t === "string") return t;
  }
  return "(untagged state)";
}

// === acceptedTypes: what a state WOULD take, asked before the refusal ===
//
// The refusal's `acceptedTypes` and this helper are ONE reading, not two that
// agree by inspection: `lookupCell`'s miss arm calls this function, so a caller
// that asks first and a caller that dispatches and catches can never be told
// different things about the same `(machine, state)` pair (#14, folded #21).
//
// It takes a STATE, not a `state.type`, which is what separates it from
// `acceptsOf` next door: `acceptsOf` answers about a state NAME a tool already
// has in hand, and this answers about the state value a caller is actually
// holding — including a reducer-form state that carries no discriminant at all.
// That untagged case is handled exactly as the refusal path handles it: the
// reducer form never consults the state, so the flat table's keys ARE the
// answer and nothing throws.
//
// A NULLISH state is not an untagged state — it is no state at all, so it
// accepts nothing in either form (#196). Reading `.type` off it would have
// thrown under the transitions form, which the doc below promises never
// happens, and answering the flat table's keys under the reducer form would
// name a set for a machine that has not booted.
//
// Returns a fresh array, empty when the state has no cells — never `undefined`,
// so a caller can `.includes` the result without a null check.
/**
 * The Msg types this machine would accept in this state — the same set a
 * `NoCellError` reports, asked before anything is dispatched. Returns the
 * state's own row keys in transitions form and the flat table's keys in
 * reducer form, counting only keys whose cell is a function, and an empty
 * array (never `undefined`, never a throw) for a state with no cells, no row
 * at all, or no state value at all.
 */
export function acceptedTypes<S>(
  machine: { update: object; __form?: UpdateForm },
  state: S,
): readonly string[] {
  if (state === undefined || state === null) return [];
  if (formOf(machine) === "reducer") {
    // Dispatch here never consults the state, so the flat table's own keys are
    // the whole accepted set — the same reading `msgKeysOf` gives this form,
    // and it is well-defined for an untagged state.
    return cellKeysOf(machine.update);
  }
  const table = machine.update as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const row = table[(state as unknown as { type: string }).type];
  // A state with no row at all — a type-bypassed or absent `state.type` —
  // accepts nothing, which is true of it.
  return row === undefined || row === null ? [] : cellKeysOf(row);
}

// `lookupCell` admits a cell only on `typeof cell === "function"`, so the
// accept-set reading applies the SAME admission (#196). A non-function row
// value is unreachable through the mapped `Transitions`/`Reducer` types and
// reachable through a cast or wire-shaped data, and reporting one as accepted
// promises a dispatch the refusal path would then refuse.
function cellKeysOf(row: object): readonly string[] {
  return Object.keys(row).filter(
    (key) => typeof (row as Record<string, unknown>)[key] === "function",
  );
}

// === lookupCell: THE single cell SELECTION, split from the invocation ===
//
// The form-branching (`reducer` → flat `update[msg.type]`; `transitions` →
// `update[state.type][msg.type]`) lives here and NOWHERE else. `applyCell`
// (throwing) and `tryApplyCell` (`Result`-returning, in `../runtime-types`)
// are both thin skins over this one selection, so the two error disciplines
// can never disagree about WHICH cell a `(machine, state, msg)` triple picks
// — the failure mode a second hand-written copy of the branching would have.
//
// Returns the selected cell (or `undefined` when there is none) together with
// the `stateName` the `NoCellError` message needs — the caller decides whether
// that absence becomes a throw or an `Err`.
//
// The MISS arm additionally carries `acceptedTypes`, and it is a union rather
// than one optional field because the accepted set is only ever a fact about a
// refusal: on a hit there is no set to state, and a field holding `[]` there
// would read as "accepts nothing" to anyone who looked (#14).
//
// Pure and allocation-light: one small record per lookup, never a closure. The
// keys array is allocated on the miss arm only, so the dispatch hot path is
// unchanged.
export type CellLookup<S, M, C extends Cmd> =
  | {
      readonly cell: (state: S, msg: M) => readonly [S, readonly C[]];
      readonly stateName: string;
    }
  | {
      readonly cell: undefined;
      readonly stateName: string;
      readonly acceptedTypes: readonly string[];
    };

export function lookupCell<S, M extends { type: string }, C extends Cmd>(
  machine: { update: object; __form?: UpdateForm },
  state: S,
  msg: M,
): CellLookup<S, M, C> {
  type CellFn = (state: S, msg: M) => readonly [S, readonly C[]];
  // A nullish state is no state at all, and it refuses BEFORE the form branch
  // in both forms (#199). Under transitions, reading `.type` off it threw a
  // `TypeError` where the whole path otherwise raises `NoCellError`; under
  // reducer, dispatch never consults the state, so a cell would have RUN on a
  // machine that has not booted — and `acceptedTypes` already answers `[]`
  // there (#196), which this arm is what makes true.
  if (state === undefined || state === null) {
    return {
      cell: undefined,
      stateName: stateNameOf(state),
      acceptedTypes: acceptedTypes(machine, state),
    };
  }
  if (formOf(machine) === "reducer") {
    const record = machine.update as Record<string, CellFn | undefined>;
    const cell = record[msg.type];
    const stateName = stateNameOf(state);
    return typeof cell === "function"
      ? { cell, stateName }
      : {
          cell: undefined,
          stateName,
          acceptedTypes: acceptedTypes(machine, state),
        };
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
  const stateName = String(stateKey);
  return typeof cell === "function"
    ? { cell, stateName }
    : {
        cell: undefined,
        stateName,
        acceptedTypes: acceptedTypes(machine, state),
      };
}

// === applyCell: THE single reducer-vs-transitions dispatch primitive ===
//
// Applies the one update cell selected by `lookupCell(machine, state, msg)` and
// returns its `[nextState, cmds]` verbatim. Every site that steps a machine —
// `run`'s applyUpdate, `foldUpdates` (replay/foldMsgs), the PBT fold runner,
// and the withX wrappers — dispatches through THIS function, so production and
// the verification tools agree on the update form by construction (#275).
// Pure and dev-check-free: `deepFreeze`/`assertPureResult` stay at the call
// sites that want them. A missing cell throws `NoCellError` (#276), never a
// bare TypeError.
//
// The `Outcome`-returning twin is `tryApplyCell` (in `../runtime-types`).
// Both read the SAME `lookupCell`, so "which cell" is decided once.
export function applyCell<S, M extends { type: string }, C extends Cmd>(
  machine: { update: object; __form?: UpdateForm },
  state: S,
  msg: M,
): readonly [S, readonly C[]] {
  const found = lookupCell<S, M, C>(machine, state, msg);
  if (found.cell === undefined) {
    throw new NoCellError(msg.type, found.stateName, found.acceptedTypes);
  }
  return found.cell(state, msg);
}

// === applyCellChecked: `applyCell` wrapped in the DEV pre/post invariant pair ===
//
// The dev-mode discipline every fold site shares: `deepFreeze` the input `state`
// so a reducer that mutates it in place trips synchronously, then
// `assertPureResult` the returned `[state, cmds]` shape. Both guards compile out
// of production (`__DEV__`). `run`'s dispatch loop and `foldUpdates` both step
// through THIS wrapper so the invariant enforcement lives in exactly one place
// and cannot drift between the runtime and the pure fold.
export function applyCellChecked<S, M extends { type: string }, C extends Cmd>(
  machine: { update: object; __form?: UpdateForm },
  state: S,
  msg: M,
): readonly [S, readonly C[]] {
  if (__DEV__) deepFreeze(state);
  const result = applyCell<S, M, C>(machine, state, msg);
  if (__DEV__) assertPureResult(result, msg.type);
  return result;
}

// === msgKeysOf: recover the Msg.type set from either update form ===
//
// A Reducer's own keys ARE the Msg.type set. A Transitions table's keys are
// state.type; its INNER keys are the Msg.type set, so the UNION of every row's
// inner keys is read — first-seen order, deduped. An empty update (`M` is
// `never`) yields `[]`. Keyed on `formOf` — the withX wrappers and the PBT
// `msgTypeKeys` all read through this one helper (#275).
//
// Why the union and not the first row's keys (the former reading): the
// mapped-type `Transitions<S, M, C>` contract makes the Msg key set uniform
// across phases, so for a hand-written TOTAL table the first row already IS
// the union and this is a no-op. But the contract only binds where the types
// bind. A table assembled DYNAMICALLY — the discriminants widened to plain
// `string`, rows pushed in a loop — is structurally ragged, and reading row
// zero then under-reports the Msg union. That under-report is not cosmetic:
// all three withX wrappers build their flat merged Reducer by iterating
// `msgKeysOf(base)`, so a Msg missing from row zero got NO cell in the wrapped
// machine and threw `NoCellError` at dispatch for a Msg the base handles
// perfectly well; and `withDeadline`'s reserved-namespace scan silently missed
// a `$deadline:`-prefixed base Msg that appeared only in a later row.
//
// The widening is pure: for any total table the returned array is identical
// (same keys, same order). Cost goes from O(msgs) to O(states × msgs), paid
// ONCE per wrapper construction — never inside the dispatch loop.
export function msgKeysOf(machine: {
  update: object;
  __form?: UpdateForm;
}): readonly string[] {
  const keys = Object.keys(machine.update);
  if (keys.length === 0) return [];
  if (formOf(machine) === "reducer") return keys;
  const table = machine.update as Record<string, object | undefined>;
  const seen = new Set<string>();
  const union: string[] = [];
  for (const stateKey of keys) {
    const row = table[stateKey];
    if (row === null || row === undefined) continue;
    for (const msgKey of Object.keys(row)) {
      if (seen.has(msgKey)) continue;
      seen.add(msgKey);
      union.push(msgKey);
    }
  }
  return union;
}

// === describeMachine / acceptsOf: the per-state accept-sets, as a reading ===
//
// "Which Msgs does this machine accept, and in which state?" — the question a
// tool asks when it drives a machine ITSELF instead of through `run`: a CLI
// rendering the legal next moves, a doc generator, a log validator. Before
// this the only answer was to cast `machine.update as Record<string,
// Record<string, unknown>>` at the call site and hand-branch the form — one
// private copy of the form-branching per consumer, drifting from the kernel's.
//
// This is a DERIVED READING over the table, deliberately NOT a property on the
// machine. It has to be: every `withX` wrapper builds a fresh flat
// `Record<string, Cell>`, casts it to `Reducer`, and returns a NEW object
// literal carrying `init`/`update`/`subs` plus the
// base's `cmds` — the one property a wrapper forwards on purpose,
// because `run`'s interpret edge reads it (#66). Any OTHER property hung on a
// machine is destroyed by the first wrap, and the wrapped table is
// reducer-form regardless of the base's. A function over `(update, formOf)`
// survives wrapping and tells the truth about the machine it is actually
// handed.
//
// The return type is a DISCRIMINATED union on `form` because the two forms
// genuinely answer different questions, and faking the missing one would be a
// lie the type system would then propagate:
//   - `transitions` — carries `states` and `accepts` (state.type → Msg.types).
//   - `reducer`     — has NO per-state accept-sets AT ALL. Its dispatch does
//     not consult the state, so `msgs` is the whole answer and there is no
//     `accepts` field to read. Reaching for one is a compile error, not an
//     empty object.
export type MachineShape =
  | {
      readonly form: "reducer";
      /** Every `Msg.type` the flat reducer has a cell for. */
      readonly msgs: readonly string[];
    }
  | {
      readonly form: "transitions";
      /** The union of every row's `Msg.type` keys (see `msgKeysOf`). */
      readonly msgs: readonly string[];
      /** Every `state.type` the table has a row for, in table order. */
      readonly states: readonly string[];
      /** `state.type` → the `Msg.type`s that state has a cell for. */
      readonly accepts: Readonly<Record<string, readonly string[]>>;
    };

export function describeMachine(machine: {
  update: object;
  __form?: UpdateForm;
}): MachineShape {
  const msgs = msgKeysOf(machine);
  if (formOf(machine) === "reducer") return { form: "reducer", msgs };
  const table = machine.update as Record<string, object | undefined>;
  const states = Object.keys(table);
  const accepts: Record<string, readonly string[]> = {};
  for (const stateKey of states) {
    const row = table[stateKey];
    accepts[stateKey] =
      row === null || row === undefined ? [] : Object.keys(row);
  }
  return { form: "transitions", msgs, states, accepts };
}

// The one-state shorthand over `describeMachine`. Reducer-form is not a
// special case being papered over: a flat reducer's dispatch never reads the
// state, so EVERY state accepts the full Msg set and returning it is the true
// answer, not a stand-in. A `stateType` with no row in a Transitions table
// accepts nothing, so `[]` — equally true.
export function acceptsOf(
  machine: { update: object; __form?: UpdateForm },
  stateType: string,
): readonly string[] {
  const shape = describeMachine(machine);
  if (shape.form === "reducer") return shape.msgs;
  return shape.accepts[stateType] ?? [];
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
// phase), the table form keys every cell by (state.type × msg.type). Each cell
// receives the narrowed `State` for its phase and the narrowed `Msg` for its
// variant via two `Extract` lookups. Phantom-narrow at the type level; pure
// data at runtime.
//
// The ROW is required and the CELL is optional, and that asymmetry is the whole
// declaration (#203). A state must appear — adding a phase to `S` is a
// compile-time obligation to say what it does, and a state that accepts nothing
// writes the empty row `{}` rather than being silently absent. A cell is
// optional because a MISSING cell is a declared refusal, not an omission: it
// says this state does not accept that message, exactly as a statechart's `on`
// lists the events a state handles and XState treats an unlisted event as no
// transition. What tea does differently is stay loud (ADR 0011) — `lookupCell`
// misses, and the dispatch raises `NoCellError` naming `acceptedTypes`, or
// `tryApplyCell` returns it as data. Nothing is silently absorbed.
//
// Required cells made every phase check an `if (msg.phase !== …) return [s, []]`
// inside a cell that had to exist, which both cost a 6×9 machine 54 cells and
// made `acceptedTypes` report every message type for every state — truthfully,
// and uselessly, for anything asking which buttons to light.
//
// `defineMachine` accepts a third `update` form for `Transitions<S, M, C>` —
// the runtime dispatches via `update[state.type]?.[msg.type]`.
//
// Authors who want the old floor back take it per machine with
// `ExhaustiveTransitions<S, M, C>` below; it is opt-in, never the default.
//
// Strengthens invariant 2 (table form has no fall-through default — an absent
// cell refuses, it does not fall through), invariant 6 (runtime walks the table
// predictably, no hidden dispatch fallback), and invariant 7 (both state.type
// and msg.type are load-bearing at the type level).
/**
 * The state × message table form of `update`. Every state of `S` needs a row;
 * a cell inside a row is optional, and leaving one out DECLARES that the state
 * does not accept that message — the runtime refuses it with `NoCellError`
 * naming `acceptedTypes`. `ExhaustiveTransitions` requires every cell instead.
 */
export type Transitions<
  S extends { type: string },
  M extends { type: string },
  C extends Cmd,
> = {
  [P in S["type"]]: Partial<ExhaustiveTransitions<S, M, C>[P]>;
};

// === ExhaustiveTransitions: the opt-in "every cell must exist" floor ===
//
// The same table with every cell REQUIRED — what `Transitions` was before
// optional cells landed (#203). It is one definition, not a second copy:
// `Transitions` is this type with each row made `Partial`, so the cell
// signature can never drift between the two.
//
// Reach for it when a machine genuinely wants the compiler to force a decision
// per (state, message) pair — a protocol where every pair is meaningful, or a
// table under review. The cost is the one that made it a bad default: every
// refusal has to be spelled as a cell that returns `[state, []]`, and every
// state then reports every message type from `acceptedTypes`.
//
// Use it as an annotation on the table, then hand the table to `defineMachine`:
//
//   const update: ExhaustiveTransitions<State, Msg, Cmds> = { … };
//   export const machine = defineMachine({ init, update });
//
// `satisfies` works the same way and keeps the literal's own type.
/**
 * `Transitions<S, M, C>` with every cell REQUIRED — the opt-in floor for a
 * machine that wants the compiler to force a decision on every (state,
 * message) pair. An annotation on your own table, not a third update form:
 * `defineMachine` takes the annotated table unchanged.
 */
export type ExhaustiveTransitions<
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
   * Declare a typed Cmd constructor (ADR 0014, 0021). Returns the builder —
   * `fetch({ url })` yields `{ type: "fetch", url }` — carrying the minted Msg
   * builders `fetch.ok(cmd, value)` / `fetch.err(cmd, error)` (for replay
   * logs and tests) and the declaration the runtime edge parses against.
   * `Settled<typeof fetch>` is the two-arm Msg union it settles with;
   * `defineMachine({ cmds: [fetch] })` folds that union into the machine's `M`.
   *
   *   const fetch = Cmd.define("fetch", {
   *     input: z.object({ url: z.string() }),
   *     ok: z.object({ status: z.number(), body: z.string() }),
   *     err: ["not_found", "timeout"],
   *   });
   *
   * `input` and `ok` take any Standard Schema whose `validate` is synchronous:
   * zod directly, Effect Schema through `Schema.toStandardSchemaV1(...)`. `err`
   * is the `_tag` list the handler may fail with; the runtime adds
   * `malformed_result` for an `Ok` value the `ok` schema rejects.
   *
   * The handler returns an outcome and the engine mints the Msg:
   *
   *   fetch: async (cmd, { ok, err }) =>
   *     res.status === 404 ? err({ _tag: "not_found" }) : ok(await res.json()),
   *
   * A throw or an undeclared tag goes to the error sink, never to `fetch_err`.
   * The handler reads its services off the plain `ctx` handed to `run` (ADR
   * 0020).
   *
   * A Cmd must not wait; see `DepKeyedSub` for anything that watches.
   */
  define: defineCmd,

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

// === Sub: a running subscription, as its runner sees it ===
//
// A machine never builds one of these. It declares `{ type, deps(state) }` in
// `subs` (see `DepKeyedSub`), and the engine derives the rest: `deps` is the
// value `deps(state)` returned, and `id` is `structuralHash({ type, deps })`.
// So a runner reads its data off `sub.deps`, and `id` changes exactly when the
// type or the deps value does — which is when the engine restarts the runner.
export type Sub<T extends string = string, D = unknown> = {
  readonly id: SubId;
  readonly type: T;
  readonly deps: D;
};

// === Dispose: the cleanup a sub runner returns ===
//
// A runner opens a resource and returns the function that closes it. The
// engine calls it when the Sub's `deps` go null (torn down), change (restarted:
// old `Dispose`, then a fresh runner) or when the runtime stops. A returned
// Promise is awaited by `stop()` (bounded).
export type Dispose = () => void | Promise<void>;

// === Built-in sub runners: names every engine ships ===
//
// Each engine ships a runner for these Sub types, so a machine declares one
// and passes no `subscribe` entry for it (#270 R1.1). A `subscribe` entry of
// the same name handed to `run` replaces the built-in (#270 R2.1) — a test
// swaps in a fake clock that way.
//
// `timer` dispatches `deps.msg` once, `deps.ms` after it starts. A changed
// `ms` or `msg` is a changed `deps`, so the engine restarts the countdown.
/** The `deps` a `timer` Sub declares: fire `msg` once, `ms` after it starts. */
export type TimerDeps<M> = { readonly ms: number; readonly msg: M };
/** The built-in `timer` Sub, as its runner sees it. */
export type TimerSub<M> = Sub<"timer", TimerDeps<M>>;
/** The Sub types every engine ships a runner for. */
export type BuiltinSubType = "timer";
/** The built-in Subs a machine over `M` may declare without declaring them. */
export type BuiltinSub<M> = TimerSub<M>;

/**
 * The one `id` of a Sub: a structural hash of its `type` and its `deps`
 * value. Same type and same deps → same id → the running Sub is left alone.
 */
export function subIdOf(type: string, deps: unknown): SubId {
  return subId(structuralHash({ type, deps }));
}

// === depsInactive: the dep-keyed gate, defined ONCE ===
//
// "This Sub has no slice in this state" is one fact every engine's reconcile
// and `replay`'s desired set read (all through `desiredSub`), so it gets one
// definition rather than a `deps === null` written at each.
//
// It reads NULLISH, not `null`. `(s) => s.runId` over an optional field is the
// natural projection an author writes, and it yields `undefined` on the states
// that mean "inactive"; a `=== null` gate armed the Sub there and hashed the
// slice to the string `"undefined"` — one shared key under which a resource
// was acquired for a state that had none. The typed alternative (`deps: (s) =>
// {} | null`) would reject that projection at compile time, but it also rejects
// every battery's `(state) => TKey | null` for an unconstrained `TKey`, so the
// gate is widened instead of the type narrowed.
export function depsInactive(deps: unknown): boolean {
  return deps === null || deps === undefined;
}

// === structuralHash: deterministic, order-independent id from a deps value ===
//
// The id of a dep-keyed Sub (invariant 7 — identity is explicit) is DERIVED
// from the slice of state the Sub depends on, never hand-authored. So adding a
// field to `deps` changes the id exactly when that field changes, and a
// churning id — the named #1 Sub bug (a Sub that remounts every tick, so its
// timer never fires) — becomes impossible by construction: the author cannot
// build the id wrong because the author does not build it.
//
// Determinism is load-bearing (invariant 2 — the reconcile pass runs inside
// the pure-transition path's reconcile step; the same `deps` must always hash
// to the same id). So: NO `Date`, NO random, NO insertion-order dependence.
// Object keys are sorted so `{ runId, phase }` and `{ phase, runId }` hash
// identically — the canonical "name the slice → stable key" adaptation FoldKit
// makes for TS (its `modelToDependencies`), which Elm gets free from its
// structural compare.
//
// The supported `deps` shape is plain JSON-compatible data (string / number /
// boolean / null / array / plain object). A function, class instance, symbol,
// or bigint in `deps` is a programming error — `deps` names a state SLICE, and
// state is a value (invariant 1); such a value would also break the
// determinism this hash promises. The walk throws on all of them to surface
// that loudly rather than silently producing an unstable — or, worse, a
// COLLIDING — id.
//
// The non-plain OBJECT case is the one that bites: `Object.keys` reports no own
// enumerable property on a `Date`, `Map`, `Set`, `Error`, or a typical class
// instance, so a walk that trusts it renders every one of them — and `{}` —
// as `"{}"`. That is not an unstable id, it is ONE id for every value, which
// defeats the identity filter (a foreign run's message compares equal), pins a
// dep-keyed Sub to its first slice forever, and makes a battery's handle table
// return the previous key's handle. The guard is therefore on the PROTOTYPE
// (`Object.prototype` or `null`), not on a list of known classes: a
// user-defined `RunKey` is refused by the same rule as `Date`, and no future
// exotic builtin slips through.
//
// Rendering `Date`/`Map`/`Set` structurally was the alternative. It was
// rejected: it buys a second rule to remember for a value the author can
// project in one call (`startedAt.toISOString()`), and `Map`/`Set` iteration is
// INSERTION-ordered, so any faithful rendering is order-sensitive — exactly the
// churn this hash exists to prevent. One rule, stated once: plain data only.
//
// It is also the ONE "turn this key value into a stable string" primitive the
// Sub factories in `src/subs/` address their interpret-local handle tables
// with, so a battery's key rendering and the kernel's Sub identity can never
// drift into two hashes for one fact.
export function structuralHash(deps: unknown): string {
  return stableStringify(deps);
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number" || t === "boolean") return String(value);
  if (t === "undefined") return "undefined";
  if (t === "function") {
    throw new Error(
      "@demlik/tea: structuralHash received a function in `deps`. " +
        "A dep-keyed Sub's `deps` must be a plain state slice (string / number / " +
        "boolean / null / array / object), not a closure — see invariant 1.",
    );
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (t === "object") {
    // Plain-object gate. `Object.keys` is only a faithful reading of a value
    // whose prototype is `Object.prototype` (or `null` — a bag built with
    // `Object.create(null)` is plain by every measure that matters here).
    // Anything else keeps its data somewhere `Object.keys` cannot see, and
    // would render as `"{}"` — one id for every such value.
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      const ctor = (value as { constructor?: { name?: string } }).constructor;
      const label = ctor?.name ?? "object";
      throw new Error(
        `@demlik/tea: structuralHash received a non-plain object (${label}) in \`deps\`. ` +
          "A `Date`, `Map`, `Set`, `Error` or class instance carries no own enumerable " +
          "properties, so every one of them would hash to the same id as `{}` — a silent " +
          "collision, not a wrong-looking key. Project it to plain data first " +
          "(e.g. `startedAt.toISOString()`, `[...set].sort()`) — see invariant 1.",
      );
    }
    const obj = value as Record<string, unknown>;
    // A key holding `undefined` is an absent key, as in JSON: `{ name:
    // undefined }` and `{}` are one slice, so they are one id.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  // bigint / symbol — not JSON-representable; same class of error as function.
  throw new Error(
    `@demlik/tea: structuralHash received an unsupported \`deps\` value of type "${t}". ` +
      "Use plain JSON-compatible data for a dep-keyed Sub's `deps`.",
  );
}

// === DepKeyedSub<S, U>: what a machine declares in `subs` ===
//
// The machine names a Sub's `type` and the slice of state it depends on
// (`deps`). That is all it says — a Sub is data (#251 R1.4, spike #252). The
// engine derives the rest:
//
//   - the **gate** = `deps(state)` nullish ⇒ off in this state (stopped if
//     running); anything else ⇒ on.
//   - the **id** = `structuralHash({ type, deps })` — changes exactly when the
//     slice changes (restart), stable otherwise (left alone). A constant `deps`
//     (`() => ({ name: "main" })`) is a Sub that runs for the machine's life.
//   - the **runner** = `subscribe[type]` handed to `run`, or the engine's
//     built-in of that name (`timer`). The runner gets `{ id, type, deps }`.
//
// This is the FoldKit `modelToDependencies` shape, and Elm's: a Sub names the
// state slice it depends on, the kernel keys on that slice, and the code that
// opens the resource lives with the host, never on the machine.
//
// `DepKeyedSub<S, U>` distributes over the Sub union `U`: each variant
// `Sub<T, D>` becomes `{ type: T; deps: (state: S) => D | null | undefined }`,
// so an entry's `deps` is checked against the data its runner will read.
//
// Strengthens invariant 4 (external lifecycle owned by the substrate) and
// invariant 7 (identity derived, never hand-authored).
export type DepKeyedSub<S, U extends Sub = Sub> =
  U extends Sub<infer T, infer D>
    ? {
        readonly type: T;
        /**
         * The slice of state this Sub depends on. `null` or `undefined` ⇒ off in
         * this state (see `depsInactive`), so `(s) => s.optionalRunId` gates
         * correctly. Pure (invariant 2). Plain JSON-compatible data only
         * (invariant 1): the structural hash THROWS on a `Date`, `Map`, `Set`,
         * `Error` or class instance rather than collapsing them onto one id.
         */
        readonly deps: (state: S) => D | null | undefined;
      }
    : never;

// === desiredSub: one entry's Sub at one state, derived ONCE ===
//
// The engines' reconcile and `replay`'s desired set both ask "what Sub does
// this entry want in this state?", so the answer has one definition: `null`
// when the entry is off, else `{ id, type, deps }` with the derived id. It may
// throw — `deps` is user code, and `structuralHash` refuses non-plain data —
// and each caller decides what a throw means for it.
/** An entry of `Machine.subs`, read structurally (its `U` erased). */
export type SubEntry<S> = {
  readonly type: string;
  readonly deps: (state: S) => unknown;
};

/** The entries of `machine.subs`, read structurally. */
export function subEntriesOf<S>(machine: {
  readonly subs?: ReadonlyArray<unknown>;
}): readonly SubEntry<S>[] {
  return (machine.subs ?? []) as readonly SubEntry<S>[];
}

/** The Sub `entry` wants at `state`, or `null` when it is off there. */
export function desiredSub<S>(entry: SubEntry<S>, state: S): Sub | null {
  const deps = entry.deps(state);
  if (depsInactive(deps)) return null;
  return { id: subIdOf(entry.type, deps), type: entry.type, deps };
}

// === Identity<S, M>: declare the instance's identity once; the kernel drops
//     mis-addressed messages before they reach `update` ===
//
// Without this: the substrate dispatches EVERY message to `update`, so an
// author who needs "this message is for THIS run" must repeat
// `if (msg.runId !== state.runId) return [state, []]` in every reducer cell.
// Forget one cell and a stale or foreign run's message is applied → silent
// corruption. That per-cell check is a rung-4 runtime stand-in for invariant 7
// (identity is explicit): the identity invariant the host already holds (one
// instance per run — `idFromName(runId)`) is re-asserted, cell by cell, where
// it can be forgotten.
//
// `Identity<S, M>` lifts that to ONE declaration the kernel enforces. The
// machine names two projections:
//
//   - `ofState(state)`  → the identity THIS instance owns, derived from state.
//   - `ofMsg(msg)`       → the identity a message is ADDRESSED to, or
//                          `undefined` when the message carries no identity
//                          (lifecycle messages like `boot`, or `start_audit`
//                          before the run exists — those are never dropped).
//
// Per transition the kernel compares `ofMsg(msg)` to `ofState(state)` by
// `structuralHash` (so the identity can be any plain value, same machinery the
// dep-keyed Sub id uses). A message addressed to a DIFFERENT identity is
// dropped BEFORE `update` runs — the reducer never sees it, so no cell needs a
// guard. A message with `ofMsg === undefined` is identity-agnostic and always
// reaches `update`.
//
// Two projections rather than a single `(state) => state.runId`: the kernel
// needs BOTH the state's identity AND the message's to compare, and splitting
// them keeps the comparison `K`-to-`K` with no `as` cast (a message union
// carries its identity field on only SOME arms — `ofMsg` narrows per arm in
// author-land, returning `undefined` on the arms that have none, instead of
// the substrate reaching into `msg.runId` it cannot type).
//
// Opt-in (escape hatch): a machine that declares no `identity` skips the filter
// entirely — every message reaches `update`, exactly as before.
//
// Strengthens invariant 7 (identity is explicit — declared once, derived
// deterministically, kernel-enforced rather than re-checked per cell) and
// invariant 6 (the runtime is small and inspectable — a mis-addressed message
// is dropped at ONE observable point, not silently mishandled in N cells).
export interface Identity<S, M> {
  /** The identity THIS instance owns. Pure (invariant 2); plain value. */
  readonly ofState: (state: S) => unknown;
  /**
   * The identity a message is addressed to, or `undefined` when the message
   * carries no identity (lifecycle / pre-identity messages — never dropped).
   * Pure (invariant 2); plain value when defined.
   */
  readonly ofMsg: (msg: M) => unknown;
}

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

// === Interpret<M, C, Ctx>: record-of-handlers form of `interpret` ===
//
// Flat dispatch table keyed by `Cmd.type`. Each cell receives the narrowed Cmd
// and the runtime-augmented Ctx (`Ctx & PortEmitter`) and resolves to a
// follow-up Msg or `void` (fire-and-forget). The mapped type makes a missing
// handler a compile error — `defineMachine` cannot accept the dictionary until
// every Cmd variant has one.
//
// **The injected `dispatch` — the typed Cmd→Msg edge.** A leaf handler that
// resolves on its own returns its follow-up Msg (`Promise<M | void>`) and
// IGNORES the third argument. A DETACHED handler (one that hands long-running
// work to `ctx.waitUntil` and CANNOT return its terminal Msg inline — awaiting
// it would deadlock the serial dispatch tail) fires its terminal Msg through
// this injected `dispatch` instead. Today such a handler reaches for a
// host-wired `ctx.dispatch` typed to the FULL Msg union — so a typo'd or wrong
// terminal Msg from a detached site compiles silently (rung 5: the allowed set
// lives only in a comment). `wrapDetached<C, Allowed>` (in `../runtime-types`)
// narrows THIS injected `dispatch` to the Cmd's declared result-Msg set, so a
// wrong terminal Msg fails to compile (rung 2).
//
// Additive: the third arg is OPTIONAL (`dispatch?: (msg: M) => void`), so a
// handler declaring only `(cmd, ctx)` stays assignable, and a unit test that
// invokes a handler directly with two args still typechecks. The kernel ALWAYS
// passes the dispatch (see `runInterpret` in `../promise/run.ts`); the optionality is
// purely a backward-compatibility affordance on the TYPE, not a runtime "maybe
// absent". A handler authored via `wrapDetached` receives a NARROWER view of
// this dispatch (only its declared result-Msg set).
//
// A named type so consumers can type the free-standing handler dictionary
// they hand `run` with `Interpret<MyMsg, MyCmd, MyCtx>` instead of
// re-declaring the mapped type at every effects module.
//
// A cell's `ctx` is the machine's plain `Ctx` plus the kernel's `emit`; tea
// does no dependency injection (ADR 0020), so every handler reads the same
// object `run` was handed.
//
// Strengthens invariant 2 (the record form has no fall-through default to
// hide impurity behind) and invariant 7 (identity is explicit — the Cmd
// variant set is load-bearing at the type level).
//
// **A `Cmd.define`d Cmd's cell returns an `Outcome` (ADR 0021).** Its ctx also
// carries the `ok` / `err` builders (`OutcomeHelpers`), `err` typed to the
// def's declared tags, and the engine mints `<name>_ok` / `<name>_err` from
// what it returns. Such a cell may still resolve to another Msg or nothing:
// the L2 helpers' `handlers(ports)` answer in their own Msg vocabulary until
// they ship run Cmds instead (#282). A hand-written Cmd's cell is unchanged.
export type Interpret<M extends { type: string }, C extends Cmd, Ctx> = {
  [K in C["type"]]: InterpretCell<M, Extract<C, { type: K }>, Ctx>;
};

/**
 * One cell of {@link Interpret}: the outcome-returning form for a
 * `Cmd.define`d Cmd, the Msg-returning form for a hand-written one. A Cmd is
 * `Cmd.define`d exactly when its `E` phantom is declared (not `unknown`).
 */
export type InterpretCell<M extends { type: string }, C extends Cmd, Ctx> =
  unknown extends ErrorsOf<C>
    ? (
        cmd: C,
        ctx: Ctx & PortEmitter,
        dispatch?: (msg: M) => void,
        // biome-ignore lint/suspicious/noConfusingVoidType: an interpret handler returns a follow-up Msg or nothing; `void` permits no-return bodies that `M | undefined` would reject
      ) => Promise<M | void>
    : (
        cmd: C,
        ctx: Ctx &
          PortEmitter &
          OutcomeHelpers<OkOfCmd<C>, DeclaredErrorsOf<C>>,
        dispatch?: (msg: M) => void,
      ) => Promise<
        // biome-ignore lint/suspicious/noConfusingVoidType: as above — a no-return body is legal
        Outcome<OkOfCmd<C>, DeclaredErrorsOf<C>> | M | void
      >;

/** The value a Cmd settles with; `unknown` for a hand-written Cmd. */
export type OkOfCmd<C> = C extends { readonly __ok?: infer Ok } ? Ok : unknown;

/** The failures a `Cmd.define`d Cmd's handler may return: its declared tags. */
export type DeclaredErrorsOf<C> = Exclude<ErrorsOf<C>, MalformedResult>;

// === InterpretDetached<C, Allowed, Ctx>: a detached interpret handler ===
//
// A handler that detaches long-running work (`ctx.waitUntil(...)`) and therefore
// CANNOT return its terminal Msg inline (awaiting it would deadlock the serial
// dispatch tail). It returns `Promise<void>` and fires its terminal Msg through
// the kernel-injected `dispatch`, which is NARROWED to `Allowed` — the subset
// of the Msg union this Cmd is permitted to produce. A wrong / typo'd terminal
// Msg then fails to compile.
//
// `Allowed extends { type: string }` is the declared result-Msg set (e.g.
// `GraphFinished | GraphFailed`). `dispatch: (msg: Allowed) => void` is the
// narrowed edge. The handler still receives `ctx` (carrying `waitUntil`).
//
// Authored via `wrapDetached` (in `../runtime-types`), which adapts this shape
// back into a plain `Interpret` cell so it drops into the existing `interpret`
// dictionary with no kernel change at the call site.
export type InterpretDetached<
  C extends Cmd,
  Allowed extends { type: string },
  Ctx,
> = (
  cmd: C,
  ctx: Ctx & PortEmitter,
  dispatch: (msg: Allowed) => void,
) => Promise<void>;

// === Subscribe<M, U, Ctx>: the sub runners an engine is handed at run ===
//
// Flat table keyed by `Sub.type`. Each runner receives the running Sub
// (`{ id, type, deps }`), the Ctx, and a `dispatch` to fire follow-up Msgs, and
// returns the `Dispose` the engine calls when the Sub stops. The mapped type
// guarantees every Sub variant has a runner at the type level.
//
// A returned Promise from the `Dispose` is AWAITED by `stop()` (bounded), so an
// async teardown a host relies on before evicting the isolate actually
// completes. Mid-run reconcile does not await it — the reconcile pass is
// synchronous by construction (invariant 2) — but the promise is tracked from
// the moment it exists, so `stop()` catches it either way.
//
// A runner's `dispatch` never runs a transition on the runner's own call
// stack (spike #260): the engine queues the Msg behind the step in progress.
//
// Strengthens invariant 7 (identity is explicit — the Sub variant set is
// load-bearing at the type level).
export type Subscribe<M extends { type: string }, U extends Sub, Ctx> = {
  [K in U["type"]]: (
    sub: Extract<U, { type: K }>,
    ctx: Ctx,
    dispatch: (msg: M) => void,
  ) => Dispose;
};

// === InterpretArg / RunHandlers: the handlers an engine is handed at run ===
//
// The Cmd handlers live beside the machine, never on it (#251 R1.1): every
// engine's `run(machine, { interpret, subscribe })` and `/react`'s
// `useMachine(machine, { interpret, … })` take them in their options. So the
// requiredness `Machine.interpret` used to carry lives here instead: a machine
// that emits no Cmd (`C` is `Cmd<never>`) has nothing to interpret and may omit
// the map, and one that emits a real Cmd union must hand over a handler for
// every variant. The tuple-wrap (`[C] extends [Cmd<never>]`) disables the
// distributive conditional, so a real union never degrades to optional because
// one arm happens to be `Cmd<never>`.
/**
 * The `interpret` option of an engine's `run`: optional for a machine that
 * emits no Cmd, required — one handler per Cmd variant — for one that does.
 */
export type InterpretArg<M extends { type: string }, C extends Cmd, Ctx> = [
  C,
] extends [Cmd<never>]
  ? { interpret?: Interpret<M, C, Ctx> }
  : { interpret: Interpret<M, C, Ctx> };

/**
 * The `subscribe` option of an engine's `run`: one runner per Sub type the
 * machine declares, except the built-ins (`timer`) the engine already ships.
 * Optional when every declared type is a built-in. An entry named after a
 * built-in replaces it (#270 R2.1), which is how a test drives time.
 */
export type SubscribeArg<M extends { type: string }, U extends Sub, Ctx> = [
  Exclude<U["type"], BuiltinSubType>,
] extends [never]
  ? {
      readonly subscribe?: Partial<
        // `Exclude` drops the subless marker `Sub<never>`, whose `never` type
        // would otherwise match every key.
        Subscribe<M, Exclude<U, Sub<never>> | BuiltinSub<M>, Ctx>
      >;
    }
  : {
      readonly subscribe: Subscribe<
        M,
        Exclude<U, { readonly type: BuiltinSubType }>,
        Ctx
      > &
        Partial<Subscribe<M, BuiltinSub<M>, Ctx>>;
    };

/**
 * The handlers an engine is handed beside a machine: the {@link InterpretArg}
 * Cmd handlers and the {@link SubscribeArg} sub runners. A machine carries
 * neither — it is data, and one machine file runs under any engine.
 */
export type RunHandlers<
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
> = InterpretArg<M, C, Ctx> & SubscribeArg<M, U, Ctx>;

/**
 * A machine beside the handlers it runs under — what a wrapper, a battery's
 * `toMachine` or an agent host hands around, and what an engine takes apart:
 * `run(wired.machine, { ...wired, ctx })`.
 */
export type Wired<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
> = { readonly machine: Machine<S, M, C, U, Ctx> } & RunHandlers<M, C, U, Ctx>;

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
// A machine carries no handlers (#251 R1.1, R1.4). `interpret` and the sub
// runners are code, and the machine is data: they arrive where the machine is
// run — `run(machine, { interpret, subscribe })`, `useMachine(machine, { … })`
// — so one machine file runs unchanged under any engine. Their conditional
// requiredness lives on {@link RunHandlers}.
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
  /**
   * The typed Cmd constructors this machine emits (`Cmd.define`). Declared
   * through `defineMachine({ cmds })`, which derives `C` and the settled half
   * of `M` from them; the runtime reads the list to parse each handler's
   * `_ok` value against its `ok` schema and stamp `at` at the interpret edge.
   * A machine of hand-written Cmds omits it and runs exactly as before.
   */
  readonly cmds?: readonly AnyCmdDef[];
  update:
    | Reducer<S, M, C>
    // Wrap in tuple to disable distributive conditional behavior. Without
    // `[S]`, TS distributes the conditional across `S`'s union members,
    // producing `Transitions<A,...> | Transitions<B,...>` instead of the
    // desired `Transitions<A|B,...>` — the table form needs a single
    // mapping over the full union of state types, not separate tables per
    // member.
    | ([S] extends [{ type: string }] ? Transitions<S, M, C> : never);
  /**
   * The machine's Subs, as data: each entry names a Sub `type` and the state
   * slice it depends on (`deps`). The engine derives the id
   * (`structuralHash({ type, deps })`) and the gate (`deps` non-null), starts
   * the runner for `type` when an entry turns on, leaves it alone while the id
   * holds, restarts it when the id changes, and stops it on `null` or `stop()`.
   *
   * `U` is the machine's own Sub union (`types.sub`); the built-in `timer`
   * (`{ type: "timer", deps: (s) => ({ ms, msg }) }`) is always available.
   *
   * Strengthens invariant 4 (lifecycle owned by the substrate) and invariant 7
   * (identity derived, not hand-authored).
   */
  readonly subs?: ReadonlyArray<DepKeyedSub<S, U | BuiltinSub<M>>>;
  /**
   * Phantom — never assigned, never read. `subs` reaches `U` only through a
   * conditional type, which is no inference site, so this is the slot a caller
   * like `run(machine, …)` infers the Sub union from (and so what types its
   * `subscribe` runners). Same device as `Cmd`'s `__ok`. Tuple-wrapped so an
   * empty union (`never`) is still a candidate rather than `undefined`.
   */
  readonly __sub?: readonly [U];
  /**
   * Instance-identity filter. Declares THIS instance's identity once; the
   * substrate drops any message addressed to a DIFFERENT identity before it
   * reaches `update`. Replaces the per-cell `if (msg.runId !== state.runId)`
   * guard entirely — the reducer never sees a foreign-instance message, so no
   * cell needs to check.
   *
   * Opt-in: a machine that omits `identity` skips the filter (every message
   * reaches `update`, exactly as before). A message whose `ofMsg` returns
   * `undefined` is identity-agnostic and always reaches `update` (lifecycle /
   * pre-identity messages).
   *
   * Strengthens invariant 7 (identity is explicit — declared once, enforced by
   * the substrate) and invariant 6 (mis-addressed messages dropped at one
   * observable point, not per cell).
   */
  identity?: Identity<S, M>;
  /**
   * The update form ("reducer" | "transitions"), stamped non-enumerably by
   * `defineMachine` at construction (see `UpdateForm` / `formOf`). Optional in
   * the type so the structural `Machine` annotation form keeps accepting plain
   * object literals; readers go through `formOf`, which falls back to
   * `detectUpdateForm` when the tag is absent. Never written by hand.
   */
  readonly __form?: UpdateForm;
};

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
    const [next, emitted] = applyCellChecked<S, M, C>(machine, state, msg);
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
// Per ADR 0006 the runtime-free *guarantee* lives in `src/pure/`, whose module
// graph never reaches `run`; that barrel + the import-graph guard are #213's
// scope. `foldMsgs` ships as a reachable public API from the root door, which
// is where the whole runtime-free surface publishes since #51.
export function foldMsgs<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(machine: Machine<S, M, C, U, Ctx>, base: S, msgs: readonly M[]): S {
  return foldUpdates<S, M, C>(machine, base, msgs).state;
}
