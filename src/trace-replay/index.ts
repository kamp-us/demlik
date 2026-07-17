// ---------------------------------------------------------------------------
// trace-replay — replay a recorded Trace against a machine and diff the state.
//
// This is the back half of the record/replay feature. `../recorder` captures
// a run (`loaded` + `msgs` + `finalState`); this module feeds that input
// through the core `replay(machine, { msgs, ctx, loaded })` fold and asks:
//
//     does the current reducer still produce the SAME final state for this
//     recorded input?
//
// Equal ⇒ the reducer is behavior-compatible with the recording. Diverged ⇒
// the reducer changed for that input, and the divergence path
// (`state.queue[2].status`) points at exactly the cell that drifted. This is
// the regression / production-repro tool: record a prod incident, replay it
// against the fixed reducer locally, confirm the fix changes the state at the
// path you expected — or catch an unintended drift before it ships.
//
// Standalone by design. It imports ONLY the `Trace` type from `../recorder`
// and the `replay` engine from `../index`. The deep-equal + first-divergence
// path finder is self-contained (no external diff lib) — a richer pretty-diff
// lands in `../devtools` later; trace-replay stays dependency-free so it can
// run anywhere a machine runs (CI, a Worker, a Node script).
// ---------------------------------------------------------------------------

import { type Cmd, type Machine, replay, type Sub } from "../index";
import type { Trace } from "../recorder";

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
 * Runs the core pure fold `replay(machine, { msgs: trace.msgs, ctx,
 * loaded: trace.loaded })` — init + update only, never `interpret`, never a
 * `Store`, never a live subscription (see `replay` in ../index). The `ctx` is
 * supplied fresh by the caller: the trace is the INPUT (loaded + msgs); ctx is
 * the ENVIRONMENT the reducer runs against now.
 *
 * @param machine - the machine to replay against. Mutating its reducer (the
 *                  whole point of a regression check) is what makes a recorded
 *                  trace diverge.
 * @param trace   - a Trace from `../recorder` (live `dump()` or a re-hydrated
 *                  `parseJSONL(...)`).
 * @param ctx     - the runtime ctx, supplied fresh at replay time.
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
  ctx: Ctx,
): ReplayResult<S> {
  const result = replay(machine, {
    msgs: trace.msgs,
    ctx,
    loaded: trace.loaded,
  });
  const actual = result.state;
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
 * `parityEqual`) reuse it rather than adding a fourth deep-compare. It is one
 * of three structural walkers in the package, divergent on purpose:
 * this `deepEqual` returns a boolean verdict (order-insensitive, for
 * replay/parity equality), `devtools`'s `diffState` returns a change list (for
 * a human-readable diff view), and `testing`'s `__deepEqual` is the assertion
 * helpers' internal compare — same shape, three jobs, not one to collapse.
 * `true` iff `a` and `b` are structurally equal under {@link firstDivergence}'s
 * walk (object keys compared order-insensitively, arrays index-by-index).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  return firstDivergence(a, b, "state") === null;
}

// === self-contained deep-equal + first-divergence path finder ===
//
// One walk does both jobs: it returns the FIRST point where `expected` and
// `actual` differ (as a path + the two values), or `null` when they are
// deeply equal. "First" is defined by a deterministic pre-order traversal:
// the node itself, then its children in a stable key order (array index
// order; object keys sorted so the result does not depend on insertion
// order — two states with the same data but different key order are equal,
// and the reported path for a real mismatch is reproducible run-to-run).
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
      const d = firstDivergence(ae[i], aa[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }

  if (te === "object") {
    const oe = expected as Record<string, unknown>;
    const oa = actual as Record<string, unknown>;
    // Union of keys, sorted for deterministic traversal. A key present in one
    // but absent in the other diverges at that child path (its value is
    // `undefined` on the missing side).
    const keys = [...new Set([...Object.keys(oe), ...Object.keys(oa)])].sort();
    for (const key of keys) {
      const d = firstDivergence(oe[key], oa[key], `${path}.${key}`);
      if (d !== null) return d;
    }
    return null;
  }

  // Primitives (string/number/boolean/bigint/symbol/function) that failed the
  // Object.is fast path, or null/undefined that differ — this node diverges.
  return { path, expected, actual };
}

/** Coarse type tag used by the divergence walk to decide how to recurse. */
function typeOf(
  v: unknown,
): "null" | "undefined" | "array" | "object" | "primitive" {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return "primitive";
}
