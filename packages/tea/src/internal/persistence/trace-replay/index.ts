// Recorded replay folds captured post-init State and reports the first divergence.

import {
  applyCellChecked,
  type Cmd,
  type Machine,
  NoCellError,
  type Sub,
} from "../../../index";
import type { Trace } from "../recorder";
import { indexPath, keyPath, typeOf, unionKeys } from "./state-walk";

/**
 * The outcome of {@link replayTrace}.
 *
 * @typeParam S - the machine's State type.
 * @typeParam M - the machine's Msg union.
 */
export interface ReplayResult<S, M = unknown> {
  /**
   * `true` iff every recorded msg replayed and the recomputed states match the
   * recording: each step's state when the trace carries `steps`, the final
   * state otherwise.
   */
  matches: boolean;
  /** The trace's recorded `finalState` — what the run originally produced. */
  expected: S;
  /**
   * The state the current reducer produced for the same input. On a
   * {@link ReplayResult.refusal | refusal} it is the state the refused msg
   * arrived in.
   */
  actual: S;
  /**
   * The state the current reducer computed after each replayed msg, in order:
   * `states[i]` follows `trace.msgs[i]`. It stops short of `msgs.length` on a
   * refusal. A viewer draws the session from it as the current code sees it.
   */
  states: readonly S[];
  /**
   * The Cmds the current reducer started for each replayed msg, in order:
   * `cmds[i]` follows `trace.msgs[i]`, like `states`. Nothing runs them.
   */
  cmds: readonly (readonly Cmd[])[];
  /**
   * Present iff the states differ, or a step's Cmds differ from the recorded
   * ones. The FIRST point of divergence found by a
   * deterministic pre-order walk:
   *   - `path`     — a dotted/indexed access path from the state root, e.g.
   *                  `state.queue[2].status` or `state` for a root-level
   *                  scalar mismatch. When every State matches but a step's
   *                  Cmds do not, the path starts at that step's Cmd list,
   *                  e.g. `cmds[0].total`.
   *   - `expected` — the recorded value at that path.
   *   - `actual`   — the recomputed value at that path.
   *   - `at`       — the first msg after which the recomputed state differs
   *                  from the recorded one. Present when the trace carries
   *                  `steps`; a trace with only a final state can name the
   *                  path but not the msg.
   */
  divergence?: {
    path: string;
    expected: unknown;
    actual: unknown;
    at?: { index: number; msg: M };
  };
  /**
   * Present iff the current machine has no update cell for a recorded msg in
   * the state it arrived in: a Msg renamed or removed since the recording, or
   * a cell the state no longer has. Replay stops there; `states` holds the
   * steps before it.
   */
  refusal?: {
    index: number;
    msg: M;
    stateName: string;
    acceptedTypes: readonly string[];
  };
}

/**
 * Replay a recorded {@link Trace} against `machine` and diff the recomputed
 * states against the recorded ones.
 *
 * Folds recorded messages from the captured post-init State, without calling
 * init, Cmd handlers, Store operations or Sub runners. A trace without that
 * anchor is refused; a fresh init cannot reconstruct its starting State.
 *
 * When the trace carries `steps`, every step is compared and the divergence
 * names the msg it starts at. A step that also carries its `cmds` has them
 * compared after its State, so a change that starts different effects from
 * the same States is caught too. When the machine has no cell for a recorded msg,
 * replay stops and the result carries a `refusal` instead of throwing.
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
): ReplayResult<S, M> {
  if (trace.loaded === null) {
    throw new Error(
      "tea replayTrace: trace has no captured initial State; record boot before replaying.",
    );
  }
  const expected = trace.finalState;
  const steps = trace.steps;
  const states: S[] = [];
  const cmdsPerStep: (readonly C[])[] = [];
  let state: S = trace.loaded;
  let firstStepDivergence: ReplayResult<S, M>["divergence"];

  for (const [index, msg] of trace.msgs.entries()) {
    let cmds: readonly C[];
    try {
      [state, cmds] = applyCellChecked<S, M, C>(machine, state, msg);
    } catch (err) {
      if (!(err instanceof NoCellError)) throw err;
      const { stateName, acceptedTypes } = err;
      return {
        matches: false,
        expected,
        actual: state,
        states,
        cmds: cmdsPerStep,
        refusal: { index, msg, stateName, acceptedTypes },
      };
    }
    states.push(state);
    cmdsPerStep.push(cmds);
    const recorded = steps?.[index];
    if (firstStepDivergence === undefined && recorded !== undefined) {
      const d =
        firstDivergence(recorded.state, state, "state") ??
        (recorded.cmds === undefined
          ? null
          : firstDivergence(recorded.cmds, cmds, "cmds"));
      if (d !== null) firstStepDivergence = { ...d, at: { index, msg } };
    }
  }

  const divergence =
    firstStepDivergence ?? firstDivergence(expected, state, "state");
  if (divergence === null) {
    return {
      matches: true,
      expected,
      actual: state,
      states,
      cmds: cmdsPerStep,
    };
  }
  return {
    matches: false,
    expected,
    actual: state,
    states,
    cmds: cmdsPerStep,
    divergence,
  };
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
