/**
 * @demlik/tea/mem — in-memory `Store<S>` adapter for `@demlik/tea`.
 *
 * The standard test adapter — used everywhere a Worker or DO would be
 * overkill. Mirrors the source-only convention from `packages/widget-engine`
 * and `packages/tea` (no build step).
 *
 * Reference semantics, NOT deep-clone semantics:
 *   - `save(state)` stores the reference; subsequent mutations to that
 *     reference by the caller are observable through later `load()` calls.
 *   - `load()` returns the stored reference; mutations made through it are
 *     observable on the next `load()`.
 *
 * This matches what a real KV/DO `get()` would NOT do (those serialize +
 * deserialize), but it also matches what an in-memory cache obviously does.
 * Adding a deep clone here would lie about the boundary and impose a JSON
 * round-trip on every test. Tests that need fresh copies should clone at the
 * call site.
 *
 * Boundary parse (invariant 8): `Store<S>` requires `migrate(raw)`. For
 * `memoryStore` we ship a permissive identity-default — `(raw) => raw as
 * S | null` — because this adapter is a degenerate same-process boundary:
 * there is no serialization, the reference we read is structurally the
 * reference we wrote. The `as` cast here is the documented exception to the
 * invariant-8 no-`as` rule, scoped to the parameter default. Callers that
 * want strict parsing (e.g. a test that hand-seeds the cell from outside)
 * may pass an explicit `parse` to override.
 */

import type { Store } from "../index";

/**
 * Build an in-memory `Store<S>`.
 *
 * @param initial - optional seed value. `undefined` and explicit `null` both
 *   mean "no seed"; `load()` resolves with `null` until the first `save()`.
 *   A concrete `S` seed is returned by `load()` until overwritten.
 * @param parse - optional boundary parse for the `Store<S>.migrate` contract.
 *   Defaults to identity (`(raw) => raw as S | null`) — honest for this
 *   adapter's degenerate same-process boundary. Pass an explicit parser when
 *   the test wants to reject seeded shapes that don't match `S`.
 */
export function memoryStore<S>(
  initial?: S | null,
  parse: (raw: unknown) => S | null = (raw) => raw as S | null,
): Store<S> {
  // Single internal cell — `undefined` and `null` collapse to one
  // representation so the load site is branchless.
  let cell: S | null = initial ?? null;

  return {
    async load(): Promise<unknown> {
      return cell;
    },
    async save(state: S): Promise<void> {
      cell = state;
    },
    migrate(raw: unknown): S | null {
      return parse(raw);
    },
  };
}
