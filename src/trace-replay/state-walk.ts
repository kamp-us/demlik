// ---------------------------------------------------------------------------
// state-walk — the structural-walk primitives the record/replay lane owns and
// devtools' `diffState` reuses.
//
// Two walkers cross this substrate: `trace-replay`'s `firstDivergence` (first
// differing cell, for a regression verdict) and `devtools`' `diffState` (EVERY
// differing cell, classified add/remove/change, for a human diff). They diverge
// on PURPOSE at the leaf — first-hit vs collect-all, length-mismatch-at-node vs
// per-element — but they MUST agree on the path grammar: the same cell has to
// print the same path in both, so a `divergence.path` from a replay result
// indexes straight into a `StateChange[]`.
//
// That agreement used to be enforced by copy-paste discipline plus a comment.
// Here it is enforced by construction: both walkers import the same `typeOf`,
// the same `indexPath`/`keyPath` segment builders, and the same `unionKeys`
// sorted-union order, so key-sorting and leaf equality cannot silently drift
// between the two. Pure + zero-dep — it runs anywhere a machine runs.
// ---------------------------------------------------------------------------

/** Coarse type tag both walkers use to decide how to recurse. */
export function typeOf(
  v: unknown,
): "null" | "undefined" | "array" | "object" | "primitive" {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return "primitive";
}

/** Path to the `i`-th element of an array node, e.g. `state.queue[2]`. */
export function indexPath(path: string, i: number): string {
  return `${path}[${i}]`;
}

/** Path to a keyed child of an object node, e.g. `state.user.name`. */
export function keyPath(path: string, key: string): string {
  return `${path}.${key}`;
}

/**
 * Sorted union of both sides' own keys — the deterministic, insertion-order-
 * independent child order both walkers traverse. Shared so two states with the
 * same data in different key order compare equal in BOTH, and the reported path
 * for a real mismatch is reproducible run-to-run and identical across walkers.
 */
export function unionKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
}
