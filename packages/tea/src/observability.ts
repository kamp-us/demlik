import type { BootingRuntime } from "./runtime-types";

// === historyTracker: composable observability helper ===
//
// A bounded ring buffer of recent `(msg, state)` transitions, built on the
// Runtime's public `observe` API. The substrate itself stays minimal — it has
// no notion of history, no opt to enable one, no method on the Runtime
// interface to read one. Anything that wants "recent transitions" composes via
// this helper.
//
// Why not put this on the Runtime interface as `runtime.history()`? Because
// history is derivable. Putting it on the Runtime privileges one use case
// (debug inspectors) at the substrate level and grows the interface for
// everyone; the composition shape stays out of the dispatch loop entirely, so
// the substrate's hot path pays no cost for a feature it doesn't need.

export interface HistoryTracker<S, M extends { type: string }> {
  /**
   * Snapshot of recorded transitions, oldest first. Each entry is
   * `{ msg, state }`: `msg` is `null` for the boot transition (recorded via
   * `onBoot`) and the applied Msg for every other (recorded via `observe`).
   *
   * Returns a shallow copy: the array is fresh on every call (callers may
   * iterate, slice, or replay without affecting the tracker's buffer).
   * Entry values are references to the originals (TEA states/msgs are
   * conventionally immutable; do not mutate them if your S/M is not).
   */
  snapshot(): readonly { readonly msg: M | null; readonly state: S }[];
  /**
   * Detach the underlying observer. After `stop()`:
   *   - No new transitions are recorded.
   *   - `snapshot()` continues to work and returns the buffer's contents
   *     at the moment of stop (useful for post-hoc inspection in tests).
   *   - The tracker holds no references that would prevent GC of the
   *     `runtime` argument other than the entries already buffered.
   *
   * Idempotent — subsequent calls are no-ops.
   */
  stop(): void;
}

/**
 * Create a bounded history tracker over a Runtime. The tracker subscribes to
 * the runtime via `observe(...)` and retains the last `size` `(msg, state)`
 * transitions in a FIFO ring buffer.
 *
 * @param runtime  Any `BootingRuntime<S, M>` (a full `Runtime` satisfies it).
 *                 The tracker uses only `observe`, which is total before boot —
 *                 attach it to the synchronous `run()` handle to record the
 *                 boot transition.
 * @param size     Buffer cap. `size <= 0` produces an inert no-op tracker:
 *                 no observer is attached to the runtime, `snapshot()` is
 *                 always `[]`, and `stop()` is a no-op.
 */
export function historyTracker<S, M extends { type: string }>(
  runtime: BootingRuntime<S, M>,
  size: number,
): HistoryTracker<S, M> {
  const buffer: { msg: M | null; state: S }[] = [];
  let stopped = false;

  const push = (entry: { msg: M | null; state: S }): void => {
    buffer.push(entry);
    if (buffer.length > size) buffer.shift();
  };

  // The boot transition (the `{ msg: null, state }` head entry) arrives via
  // `onBoot`; applied transitions arrive via `observe` with a total `msg`. The
  // public snapshot shape (`msg: M | null`) is unchanged — boot is still
  // `msg: null`.
  const unobserve =
    size <= 0
      ? (): void => {}
      : runtime.observe((msg, state) => {
          push({ msg, state });
        });
  const unboot =
    size <= 0
      ? (): void => {}
      : runtime.onBoot((state) => {
          push({ msg: null, state });
        });

  return {
    snapshot() {
      // Shallow copy — callers may freely iterate or mutate the returned
      // array. Entry values are references; see HistoryTracker docs.
      return buffer.slice();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unobserve();
      unboot();
    },
  };
}
