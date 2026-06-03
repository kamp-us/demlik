// ---------------------------------------------------------------------------
// `stubCtxThrowingProxy<Ctx>()` — a Proxy that satisfies the Ctx type-shape
// at compile time but throws on every property access at runtime.
//
// Why this exists: PBT runs the pure reducer surface ONLY — `replay` never
// invokes `interpret` and never starts a Sub, so Ctx should never be
// dereferenced during property generation. But the substrate's `replay`
// signature requires a `ctx: Ctx` value at compile time (it forwards ctx
// into `init`, which on some machines IS pure but on others reads ctx). A
// hand-rolled `{} as Ctx` would silently pass through any accidental ctx
// access — exactly the silent footgun this proxy catches.
//
// Open question 2 (design doc): we ship this as the default. Tests that
// genuinely need a working ctx (because their `init` reads from it) can
// pass a real ctx value instead — the proxy is opt-in, not load-bearing.
//
// Strengthens invariant 6 (no silent failures — accidental ctx reads
// produce a useful error, not a `undefined.foo` confusion later).
// ---------------------------------------------------------------------------

/**
 * Build a Ctx value whose every property access throws. Use as the `ctx`
 * argument to PBT runners when the reducer under test is pure (does not
 * read from ctx). Accidental ctx access during property generation
 * surfaces as a labelled error instead of a silent `undefined` or
 * downstream type-error.
 *
 * Returns a typed `Ctx` (via `as unknown as Ctx`) — the proxy satisfies the
 * type-shape requirement at the call site; the runtime contract is
 * "throw on first read." The `as unknown` cast is the one boundary cast
 * this helper requires; the proxy is structurally a `Ctx` for every
 * property accessor.
 *
 * @example
 *   import { stubCtxThrowingProxy } from "../index";
 *   const ctx = stubCtxThrowingProxy<MyCtx>();
 *   propertyTerminates(machine, ctx, ...);
 *   // If anything reads ctx.someField during the run, an Error throws:
 *   //   "@demlik/tea/pbt: ctx access denied (PBT operates on the pure
 *   //    reducer; ctx field 'someField' was read)"
 */
export function stubCtxThrowingProxy<Ctx>(): Ctx {
  const handler: ProxyHandler<object> = {
    get(_target, prop: string | symbol): unknown {
      // Allow vitest / fast-check internals to introspect via Symbol-keyed
      // checks (e.g. Symbol.toStringTag, Symbol.iterator). Returning
      // undefined on symbol keys keeps property-tree walks cheap; the
      // throw fires on real domain field reads.
      if (typeof prop === "symbol") return undefined;
      // Some shrinkers / pretty-printers in fast-check probe a small set
      // of conventional field names (`toJSON`, `toString`, `valueOf`,
      // `then` — the last for thenable-check). Return undefined for those
      // so the proxy doesn't fail a probe before the property body runs.
      if (prop === "toJSON" || prop === "toString" || prop === "valueOf" || prop === "then") {
        return undefined;
      }
      throw new Error(
        `@demlik/tea/pbt: ctx access denied (PBT operates on the pure reducer; ` +
          `ctx field '${prop}' was read). Pass a real ctx value if the reducer's ` +
          `init reads from ctx.`,
      );
    },
    has(): boolean {
      return false;
    },
    ownKeys(): ArrayLike<string | symbol> {
      return [];
    },
  };
  return new Proxy({}, handler) as unknown as Ctx;
}
