/**
 * @packageDocumentation
 * The composition seam — the layer between a battery and a door.
 *
 * A battery is pure state plus verbs over that state. A door holds several
 * batteries side by side in one Model. Everything between those two facts was,
 * until now, hand-written at every consumer: the one-key record rebuild that
 * threads a verb's `[slice, cmds]` result back into the host state, and the
 * statement order that decides which slice wins a derived read.
 *
 * Two helpers cover it, and neither is an optics kit. {@link liftSlice} is the
 * record rebuild with the key checked by the type system; {@link readInOrder}
 * turns a read's precedence from statement order into a value you can name,
 * export and assert on. ADR 0001 (no off-the-shelf resilience) and ADR 0014
 * (Effect's types, never its runtime values) between them settle why this is
 * forty lines here rather than a dependency.
 *
 * Both are pure: no clock, no RNG, no storage, nothing captured. A `liftSlice`
 * result is a fresh record and a Cmd array, so ADR 0014's journal/hash promise
 * over a reducer's return value is untouched.
 */

/**
 * Lift a battery verb's result into the host state that carries its slice.
 *
 * `liftSlice("resilience", state, knob.attempt(state.resilience, …))` is the
 * `{ ...state, resilience: slice }` every consumer writes by hand, with the key
 * checked: `key` must be a key of `S`, and the slice the verb returned must be
 * assignable to the type that key carries — so naming the wrong field, or
 * threading one battery's slice into another's key, is a compile error rather
 * than a state shape nothing reads correctly.
 *
 * PURE — a fresh record and the verb's own Cmds, unchanged.
 */
export function liftSlice<S, K extends keyof S, C>(
  key: K,
  state: S,
  [slice, cmds]: readonly [S[K], readonly C[]],
): readonly [S, readonly C[]] {
  // A computed-key spread widens to `S & { [k in K]: S[K] }` in TS's own
  // arithmetic, which is `S` by construction; the assertion states that rather
  // than re-deriving it. The runtime shape is exactly `S`'s.
  return [{ ...state, [key]: slice } as S, cmds];
}

/**
 * One step of a composed read: the slice it consults, under the name that slice
 * goes by. `read` returns `undefined` for "this slice has nothing to say",
 * which is what hands the read on to the next step.
 */
export interface ReadStep<In, Out> {
  /** The slice this step consults — `"cache"`, `"failed"`, `"inFlight"`. */
  readonly name: string;
  /** What this slice says about `input`, or `undefined` to defer. */
  readonly read: (input: In) => Out | undefined;
}

/**
 * Run a composed read through `order` and return the first answer any step
 * gives, or `absent` when every one defers.
 *
 * The point is that `order` is a VALUE. A derived read over three battery
 * slices otherwise states its precedence as the order of three `if` statements,
 * where it is invisible to the type system, unnameable in a test and one
 * innocent-looking reshuffle away from being wrong — which is exactly the
 * defect that escaped `classify-batch`'s per-battery test suites. Written as
 * data, the precedence can be exported, printed and asserted on directly.
 *
 * PURE — it evaluates `read` in order and stores nothing.
 */
export function readInOrder<In, Out>(
  input: In,
  order: readonly ReadStep<In, Out>[],
  absent: Out,
): Out {
  for (const step of order) {
    const answer = step.read(input);
    if (answer !== undefined) return answer;
  }
  return absent;
}
