// ---------------------------------------------------------------------------
// state-diff — the RICHER cousin of trace-replay's first-divergence walk.
//
// `../trace-replay` answers "did the state drift, and where FIRST?" — it stops
// at the first differing cell because a regression check only needs to point at
// one. This module answers the fuller devtools question: "show me EVERY cell
// that differs," classified as added / removed / changed, ready to render.
//
// Same substrate, same path grammar (root `state`, `foo[2]` for arrays,
// `foo.bar` for objects, sorted-union key order, `Object.is` leaf equality) so
// a path printed here is the SAME string trace-replay would print for that
// cell. The two tools are deliberately consistent: a `divergence.path` from a
// replay result indexes straight into this module's `StateChange[]`.
//
// Pure + zero-dep on purpose — runs in Node, in tests, in a Worker. The React
// view (`./state-diff.tsx`) is the only React-touching layer.
// ---------------------------------------------------------------------------

/**
 * A single differing cell between two states.
 *
 *   - `kind: "added"`   — the path exists in `actual` but not `expected`
 *                         (`expected` is `undefined`).
 *   - `kind: "removed"` — the path exists in `expected` but not `actual`
 *                         (`actual` is `undefined`).
 *   - `kind: "changed"` — the path exists on both sides with differing leaf
 *                         values (or differing kinds, e.g. object vs array).
 */
export interface StateChange {
  /** Access path from the state root, e.g. `state.items[1].status`. */
  path: string;
  /** How the cell differs between the two states. */
  kind: "added" | "removed" | "changed";
  /** The value on the `expected` side (`undefined` when `added`). */
  expected: unknown;
  /** The value on the `actual` side (`undefined` when `removed`). */
  actual: unknown;
}

/** Coarse type tag used by the walk to decide how to recurse. Mirrors trace-replay. */
function typeOf(
  v: unknown,
): "null" | "undefined" | "array" | "object" | "primitive" {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return "primitive";
}

/**
 * Deep-walk two states and return EVERY differing cell, in deterministic
 * pre-order (the node before its children; children in array-index order, then
 * sorted-union key order for objects). The empty array means the two states are
 * deeply equal.
 *
 * Equality + path grammar match `../trace-replay`'s `firstDivergence` exactly:
 *   - `Object.is` leaf equality, so `NaN` equals `NaN` and `+0` ≠ `-0`.
 *   - arrays index by `[i]`; a length mismatch is NOT reported at the array
 *     node — instead each surplus/missing element surfaces as its own
 *     added/removed child, which is what a devtools list wants to show.
 *   - objects walk the sorted union of both sides' keys; a key on only one
 *     side becomes an `added`/`removed` child.
 *   - the root path is `"state"`.
 *
 * Scope is JSON-shaped state (the same substrate trace-replay targets):
 * primitives, null/undefined, arrays, plain objects. A differing kind at a node
 * (object vs array, number vs string) is reported as a single `changed` at that
 * node — the walk does not descend into mismatched kinds.
 */
export function diffState(expected: unknown, actual: unknown): StateChange[] {
  const out: StateChange[] = [];
  walk(expected, actual, "state", out);
  return out;
}

function walk(
  expected: unknown,
  actual: unknown,
  path: string,
  out: StateChange[],
): void {
  // Identity / primitive fast path. Equal cells contribute nothing. `Object.is`
  // so NaN equals NaN and +0 ≠ -0 — same intent as trace-replay's leaf check.
  if (Object.is(expected, actual)) return;

  const te = typeOf(expected);
  const ta = typeOf(actual);

  // A present/absent pair at this node is an add or a remove — the structural
  // signal a viewer color-codes differently from a value change.
  if (te === "undefined") {
    out.push({ path, kind: "added", expected, actual });
    return;
  }
  if (ta === "undefined") {
    out.push({ path, kind: "removed", expected, actual });
    return;
  }

  // Different kinds at a present node (object vs array, number vs string,
  // value vs null) — one `changed` at the node; do not descend into mismatched
  // shapes, mirroring trace-replay's "this node IS the divergence".
  if (te !== ta) {
    out.push({ path, kind: "changed", expected, actual });
    return;
  }

  if (te === "array") {
    const ae = expected as unknown[];
    const aa = actual as unknown[];
    // Walk the union of indices so surplus elements on EITHER side surface as
    // their own added/removed children (vs trace-replay, which reports a length
    // mismatch at the array node and stops). A viewer wants the per-element
    // detail.
    const len = Math.max(ae.length, aa.length);
    for (let i = 0; i < len; i++) {
      walk(ae[i], aa[i], `${path}[${i}]`, out);
    }
    return;
  }

  if (te === "object") {
    const oe = expected as Record<string, unknown>;
    const oa = actual as Record<string, unknown>;
    // Sorted union of keys — deterministic regardless of insertion order, so
    // two states with the same data in different key order produce no changes,
    // and the reported order is reproducible run-to-run.
    const keys = [...new Set([...Object.keys(oe), ...Object.keys(oa)])].sort();
    for (const key of keys) {
      walk(oe[key], oa[key], `${path}.${key}`, out);
    }
    return;
  }

  // Two present primitives (string/number/boolean/bigint/symbol) or two
  // differing nulls that failed the Object.is fast path — a leaf change.
  out.push({ path, kind: "changed", expected, actual });
}

/** Render a single value compactly for the text diff. Strings get quotes so
 * `"3"` is visibly distinct from `3`; everything else is JSON-ish, with the
 * `undefined`/`NaN`/`BigInt` cases JSON.stringify mishandles spelled out. */
function fmtValue(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "function" || typeof v === "symbol") return String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    // Circular / non-serializable — fall back to a coarse tag.
    return String(v);
  }
}

/**
 * Pretty multi-line text for a {@link diffState} result. One `±`-prefixed line
 * per change, in the array's (pre-order, deterministic) order:
 *
 *   - `~ state.total: 121.5 → 135`   (changed: old → new)
 *   - `- state.coupon: "X"`          (removed: only the old value)
 *   - `+ state.tax: 8`               (added: only the new value)
 *
 * Deterministic given a deterministic `changes` array. An empty array yields
 * the empty string.
 */
export function formatDiff(changes: StateChange[]): string {
  return changes.map(formatChange).join("\n");
}

/** One `±`-prefixed line for a single change. Split out so the `map` callback
 * is total (Biome's useIterableCallbackReturn) without a dead default branch. */
function formatChange(c: StateChange): string {
  switch (c.kind) {
    case "changed":
      return `~ ${c.path}: ${fmtValue(c.expected)} → ${fmtValue(c.actual)}`;
    case "removed":
      return `- ${c.path}: ${fmtValue(c.expected)}`;
    case "added":
      return `+ ${c.path}: ${fmtValue(c.actual)}`;
  }
}
