// Recorded replay folds captured post-init State and reports the first divergence.

import { type Cmd, foldMsgs, type Machine, type Sub } from "../../../index";
import type { Trace } from "../recorder";
import { indexPath, keyPath, typeOf, unionKeys } from "./state-walk";

/**
 * The outcome of {@link replayTrace}.
 *
 * @typeParam S - the machine's State type.
 */
export interface ReplayResult<S> {
  /** `true` iff the recomputed final state deep-equals the trace's `finalState`. */
  matches: boolean;
  /** The trace's recorded `finalState` — what the run originally produced. */
  expected: S;
  /** The state the current reducer produced for the same input. */
  actual: S;
  /**
   * Present iff `matches` is `false`. The FIRST point of divergence found by
   * a deterministic pre-order walk:
   *   - `path`     — a dotted/indexed access path from the state root, e.g.
   *                  `state.queue[2].status` or `state` for a root-level
   *                  scalar mismatch.
   *   - `expected` — the recorded value at that path.
   *   - `actual`   — the recomputed value at that path.
   */
  divergence?: { path: string; expected: unknown; actual: unknown };
}

/**
 * Replay a recorded {@link Trace} against `machine` and diff the recomputed
 * final state against the recorded one.
 *
 * Folds recorded messages from the captured post-init State, without calling
 * init, Cmd handlers, Store operations or Sub runners. A trace without that
 * anchor is refused; a fresh init cannot reconstruct its starting State.
 *
 * @param machine - the machine to replay against. Mutating its reducer (the
 *                  whole point of a regression check) is what makes a recorded
 *                  trace diverge.
 * @param trace   - a Trace from `../recorder` (live `dump()` or a re-hydrated
 *                  `parseJSONL(...)`).
 * @param _ctx    - optional legacy argument; recorded replay needs no init context.
 */
export function replayTrace<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  trace: Trace<S, M>,
  _ctx?: Ctx,
): ReplayResult<S> {
  if (trace.loaded === null) {
    throw new Error(
      "tea replayTrace: trace has no captured initial State; record boot before replaying.",
    );
  }
  const actual = foldMsgs(machine, trace.loaded, trace.msgs);
  const expected = trace.finalState;

  const divergence = firstDivergence(expected, actual, "state");
  if (divergence === null) {
    return { matches: true, expected, actual };
  }
  return { matches: false, expected, actual, divergence };
}

/**
 * Order-insensitive structural deep-equality — the comparator the
 * record/replay lane owns, exposed so consumers (e.g. `@demlik/tea/parity`'s
 * `parityEqual`) reuse it rather than adding a third deep-compare. It is one
 * of two structural walkers in the package, divergent on purpose:
 * this `deepEqual` returns a boolean verdict (order-insensitive, for
 * replay/parity equality), and `devtools`'s `diffState` returns a change list
 * (for a human-readable diff view) — same shape, two jobs, not one to collapse.
 * `true` iff `a` and `b` are structurally equal under {@link firstDivergence}'s
 * walk (object keys compared order-insensitively, arrays index-by-index).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  return firstDivergence(a, b, "state") === null;
}

// === deep-equal + first-divergence path finder ===
//
// One walk does both jobs: it returns the FIRST point where `expected` and
// `actual` differ (as a path + the two values), or `null` when they are
// deeply equal. "First" is defined by a deterministic pre-order traversal:
// the node itself, then its children in a stable key order (array index
// order; object keys sorted so the result does not depend on insertion
// order — two states with the same data but different key order are equal,
// and the reported path for a real mismatch is reproducible run-to-run).
//
// The path grammar (`typeOf`, `indexPath`/`keyPath` segments, `unionKeys`
// order) is shared with devtools' `diffState` via `./state-walk`, so the two
// walkers print the SAME path for the same cell by construction. Only the leaf
// policy differs, on purpose: first-hit here, collect-all there.
//
// Scope: TEA state is plain JSON-shaped data (the substrate's __DEV__ guards
// reject closures in Cmds, and states are conventionally serializable). So
// the walk handles: primitives, null/undefined, arrays, and plain objects.
// It treats other object kinds (Date, Map, Set, class instances) by reference
// identity + a structural fallback via Object.entries — sufficient for the
// JSON-shaped states this tool targets; a richer differ lives in ../devtools.

/** A divergence record, or `null` when the two values are deeply equal. */
type Divergence = { path: string; expected: unknown; actual: unknown } | null;

function firstDivergence(
  expected: unknown,
  actual: unknown,
  path: string,
): Divergence {
  // Identity / primitive fast path. Handles same-reference, and equal
  // primitives. `Object.is` so NaN === NaN and +0 ≠ -0 (matches structural
  // equality intent better than ===).
  if (Object.is(expected, actual)) return null;

  const te = typeOf(expected);
  const ta = typeOf(actual);
  // Different kinds at this node (e.g. object vs array, number vs string,
  // present vs null) — this node IS the divergence.
  if (te !== ta) return { path, expected, actual };

  if (te === "array") {
    const ae = expected as unknown[];
    const aa = actual as unknown[];
    if (ae.length !== aa.length) {
      // Length mismatch reported at the array node itself — the shape differs,
      // which is more informative than an arbitrary element index.
      return { path, expected, actual };
    }
    for (let i = 0; i < ae.length; i++) {
      const d = firstDivergence(ae[i], aa[i], indexPath(path, i));
      if (d !== null) return d;
    }
    return null;
  }

  if (te === "object") {
    const oe = expected as Record<string, unknown>;
    const oa = actual as Record<string, unknown>;
    // Sorted union of keys for deterministic traversal. A key present in one
    // but absent in the other diverges at that child path (its value is
    // `undefined` on the missing side).
    for (const key of unionKeys(oe, oa)) {
      const d = firstDivergence(oe[key], oa[key], keyPath(path, key));
      if (d !== null) return d;
    }
    return null;
  }

  // Primitives (string/number/boolean/bigint/symbol/function) that failed the
  // Object.is fast path, or null/undefined that differ — this node diverges.
  return { path, expected, actual };
}
