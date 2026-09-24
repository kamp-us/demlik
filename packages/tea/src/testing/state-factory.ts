// ---------------------------------------------------------------------------
// stateFactory — typed phase-constructor API for a discriminated-union State.
//
// The motivating callsite: every reducer test today opens with ~60–80 lines
// of hand-rolled factory functions, one per phase, each one's defaults
// duplicated across files:
//
//   function idleState() { return { type: "idle" }; }
//   function creatingWindowState(overrides?: Partial<...>) {
//     return { type: "creating_window", auditId: ..., wsUrl: ..., ...overrides };
//   }
//   ...
//
// `stateFactory<BackgroundState>({...})` collapses the whole block to one
// declaration: pass each phase's REQUIRED defaults once (the type system
// enforces every phase has an entry), and the helper builds an API of
// `factory.idle()`, `factory.creating_window({...})`, etc.
//
// Two type-level guarantees:
//
//   1. Every phase has a defaults entry — `StateFactoryDefaults<S>` is a
//      mapped type keyed by every `S["type"]`. Missing an entry is a
//      compile error (the @ts-expect-error in testing.spec.ts pins this).
//
//   2. Each phase's defaults match that phase's required shape minus the
//      `type` discriminator. Passing wrong fields fails to compile.
//
// The runtime is pure data:
//
//   api[k] = (overrides) => ({
//     type: k,
//     ...defaults[k],
//     ...stripUndefined(overrides ?? {}),
//   })
//
// The `stripUndefined` pass is what preserves `exactOptionalPropertyTypes`
// assignability — without it, calling `factory.creating_window({
// queueItemId: undefined })` would land an explicit `queueItemId: undefined`
// on the object, which is NOT assignable to `queueItemId?: string` under
// `exactOptionalPropertyTypes`. Stripping undefineds before spread keeps
// the boundary clean.
//
// `stripUndefined` is inlined (not imported from a shared stdlib) so this
// package can stay dep-free of stdlib.
// ---------------------------------------------------------------------------

/** A factory-constructed phase: `S` narrowed to the arm whose discriminator equals `K`. */
type StateOf<S, K> = Extract<S, { type: K }>;

/** A factory-constructed phase with the `type` discriminator removed — the "fields the caller cares about" half. */
type RequiredFields<T> = Omit<T, "type">;

/**
 * Defaults shape passed to `stateFactory`. Mapped type over the discriminant
 * set: every phase MUST have an entry, and that entry MUST match the phase's
 * required fields minus the `type` discriminator.
 */
export type StateFactoryDefaults<S extends { type: string }> = {
  readonly [K in S["type"]]: RequiredFields<StateOf<S, K>>;
};

/**
 * The API returned by `stateFactory`. One method per phase; calling it with
 * no args returns the default snapshot, calling it with a partial overrides
 * object merges those overrides in (with undefineds stripped — see
 * stripUndefined below).
 */
export type StateFactoryAPI<S extends { type: string }> = {
  readonly [K in S["type"]]: (
    overrides?: Partial<RequiredFields<StateOf<S, K>>>,
  ) => StateOf<S, K>;
};

/**
 * Strip own-enumerable properties whose value is `undefined`. Used inside
 * the factory's spread chain so callers can pass `{ queueItemId: undefined }`
 * without the explicit-undefined landing on the result object (which would
 * fail to assign to a `queueItemId?: string` field under
 * `exactOptionalPropertyTypes`).
 *
 * Inlined (not imported from `a shared stdlib`) so `@demlik/tea/testing` can stay
 * dependency-free of stdlib. The 8-line cost of duplication is cheaper than
 * a package-graph edge.
 */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const value = obj[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Build a typed phase-constructor API from per-phase defaults. The defaults
 * object MUST have one entry per `S["type"]` discriminant; the returned API
 * has one method per phase. Each method merges the defaults with optional
 * overrides (undefineds stripped), then stamps the `type` discriminator.
 *
 * @example
 *   type S = { type: "a"; n: number } | { type: "b"; s: string };
 *   const f = stateFactory<S>({ a: { n: 0 }, b: { s: "" } });
 *   f.a();              // { type: "a", n: 0 }
 *   f.a({ n: 42 });     // { type: "a", n: 42 }
 *   f.b({ s: "hi" });   // { type: "b", s: "hi" }
 */
export function stateFactory<S extends { type: string }>(
  defaults: StateFactoryDefaults<S>,
): StateFactoryAPI<S> {
  // Build the API by walking the defaults' own keys. Each key corresponds
  // to one phase discriminator; the constructor closes over both the key
  // (for the `type` stamp) and that phase's defaults snapshot.
  const api = {} as { [k: string]: (overrides?: object) => unknown };
  for (const key of Object.keys(
    defaults,
  ) as (keyof StateFactoryDefaults<S>)[]) {
    const phaseDefaults = defaults[key];
    api[key as string] = (overrides?: object) => {
      // The strip-undefined pass lives here, not at the caller. See the
      // module header for the `exactOptionalPropertyTypes` rationale.
      const cleanedOverrides = overrides ? stripUndefined(overrides) : {};
      return { type: key, ...phaseDefaults, ...cleanedOverrides };
    };
  }
  return api as StateFactoryAPI<S>;
}
