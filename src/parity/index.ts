// ---------------------------------------------------------------------------
// parity — the record → replay → normalized-diff go/no-go gate.
//
// The parity spike proved the mechanism already composes from in-tree
// primitives: `recorder` captures a run's Msg sequence (the recording), `replay`
// re-folds it purely, and `trace-replay`'s order-insensitive deep-equal diffs
// the result. Non-determinism is a RECORD-TIME property — ids/timestamps freeze
// into the recording, `replay` never re-mints them — so the same recording
// replays byte-identical every time.
//
// This module is the thin packaging over that substrate plus the one genuinely
// new helper, `normalizeForParity`: the finding-normalizer that strips
// record-time non-determinism (generated ids/timestamps) and stable-key-sorts
// collections, so an OLD-engine golden run and a NEW-engine run diff as equal
// exactly when they are behaviourally equivalent. Every domain (audit, auth,
// ingest, …) gets its old-vs-new parity check without reinventing the capture,
// the normalization, and the diff.
//
//   recordRun(runtime)            → Recording        // wraps the recorder
//   goldenReplay(machine, rec)    → State            // wraps replay
//   normalizeForParity(schema)    → (finding) => norm // strip + stable-sort
//   parityEqual(a, b)             → boolean           // normalized deep-equal
// ---------------------------------------------------------------------------

import type { BootingRuntime, Cmd, Machine, Sub } from "../index";
import { replay } from "../index";
import { type RecorderOptions, recorder, type Trace } from "../recorder";
import { deepEqual } from "../trace-replay";

/**
 * A live parity recording attached to a Runtime — the go/no-go gate's golden
 * artifact. Wraps a {@link recorder}: drive the runtime, then snapshot with
 * {@link Recording.trace} (or hand the live `Recording` straight to
 * {@link goldenReplay}, which snapshots for you).
 *
 * @typeParam S - the machine's State type.
 * @typeParam M - the machine's Msg union.
 */
export interface Recording<S, M> {
  /**
   * Snapshot the recording so far as a replayable {@link Trace} — `loaded`
   * (boot state), the ordered non-null `msgs`, and `finalState`. Sufficient to
   * reproduce the run via {@link goldenReplay}. Fresh object each call.
   */
  trace(): Trace<S, M>;
  /** Serialize the recording as JSONL (see {@link recorder}'s `toJSONL`). */
  toJSONL(): string;
  /** Detach the underlying observer. Idempotent. */
  stop(): void;
}

/**
 * Attach a parity recording to a Runtime, reusing the `recorder`/`historyTracker`
 * capture (the boot observe for `loaded` + every non-null msg in order) rather
 * than a fresh observer path.
 *
 * Attach on the synchronous `run()` handle so the boot transition is captured
 * as `loaded`; drive the runtime; then `trace()` (or pass the handle to
 * {@link goldenReplay}). See {@link RecorderOptions} for `captureSteps` (needed
 * only for the per-step / resume-cache-prefix inspection, not for replay).
 */
export function recordRun<S, M extends { type: string }>(
  runtime: BootingRuntime<S, M>,
  opts?: RecorderOptions,
): Recording<S, M> {
  const rec = recorder(runtime, opts);
  return {
    trace: () => rec.dump(),
    toJSONL: () => rec.toJSONL(),
    stop: () => rec.stop(),
  };
}

/**
 * Reproduce a recording's final state by folding its msgs through the pure
 * `replay` — `init(loaded, ctx)` then `update` per msg, never `interpret`,
 * never a `Store`, never a live subscription. Accepts a live {@link Recording}
 * (snapshotted here) or a bare {@link Trace}.
 *
 * `ctx` is the ENVIRONMENT supplied fresh at replay time (the trace is the
 * INPUT: `loaded` + `msgs`), mirroring `replayTrace`. It is optional so a
 * void-ctx machine can call `goldenReplay(machine, rec)`; a machine that reads
 * ctx passes it explicitly.
 */
export function goldenReplay<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  recording: Recording<S, M> | Trace<S, M>,
  ctx?: Ctx,
): S {
  const trace = asTrace(recording);
  const { state } = replay(machine, {
    msgs: trace.msgs,
    ctx: ctx as Ctx,
    loaded: trace.loaded,
  });
  return state;
}

/** Narrow a `Recording | Trace` to a `Trace`, snapshotting a live recording. */
function asTrace<S, M>(recording: Recording<S, M> | Trace<S, M>): Trace<S, M> {
  return typeof (recording as Recording<S, M>).trace === "function"
    ? (recording as Recording<S, M>).trace()
    : (recording as Trace<S, M>);
}

/** Configuration for {@link normalizeForParity}. */
export interface ParitySchema {
  /**
   * Object keys stripped wherever they appear — the record-time
   * non-determinism `replay` never re-mints. Default: `id`, `runId`,
   * `timestamp`.
   */
  readonly stripKeys?: readonly string[];
  /**
   * Candidate keys used to stable-sort arrays of objects. For each array the
   * first candidate present (as a primitive) on the items decides the order;
   * arrays with no candidate fall back to canonical-JSON order. Default:
   * `ruleId`, `selector`, `url`.
   */
  readonly sortKeys?: readonly string[];
}

// Defaults proven by the spike: strip the generated id/runId/timestamp,
// stable-key-sort by ruleId | selector | url. Fan-out ordering is already
// deterministic on this substrate (array order); the sort only defends against
// intra-effect concurrency (Promise.all / Set).
const DEFAULT_STRIP_KEYS: readonly string[] = ["id", "runId", "timestamp"];
const DEFAULT_SORT_KEYS: readonly string[] = ["ruleId", "selector", "url"];

/**
 * Build a finding-normalizer: a pure `(value) => normalized` that strips the
 * schema's `stripKeys`, recursively sorts object keys, and stable-key-sorts
 * arrays by the schema's `sortKeys`. Two runs that differ only in generated
 * ids/timestamps or intra-effect ordering normalize to a byte-identical value,
 * so {@link parityEqual} on the normalized pair reflects behavioural (not incidental)
 * difference.
 */
export function normalizeForParity(
  schema?: ParitySchema,
): (value: unknown) => unknown {
  const stripKeys = new Set(schema?.stripKeys ?? DEFAULT_STRIP_KEYS);
  const sortKeys = schema?.sortKeys ?? DEFAULT_SORT_KEYS;

  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const items = value.map(normalize);
      // Decorate-sort-undecorate: primary key = first present sortKey value,
      // secondary = canonical JSON (items are already normalized so keys are
      // sorted), original index last for a stable total order.
      return items
        .map((item, index) => ({
          item,
          index,
          primary: primarySortKey(item, sortKeys),
          json: JSON.stringify(item) ?? "",
        }))
        .sort(
          (a, b) =>
            compareStrings(a.primary, b.primary) ||
            compareStrings(a.json, b.json) ||
            a.index - b.index,
        )
        .map((decorated) => decorated.item);
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)
        .filter((key) => !stripKeys.has(key))
        .sort()) {
        out[key] = normalize(value[key]);
      }
      return out;
    }
    return value;
  };

  return normalize;
}

/** The first present `sortKeys` candidate on `item` as a string, or `""`. */
function primarySortKey(item: unknown, sortKeys: readonly string[]): string {
  if (!isPlainObject(item)) return "";
  for (const key of sortKeys) {
    const candidate = item[key];
    if (
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    ) {
      return String(candidate);
    }
  }
  return "";
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parity verdict: `true` iff `a` and `b` are structurally equal. Reuses
 * `trace-replay`'s order-insensitive deep-equal (the single comparator this
 * package owns) rather than adding a second one — feed it the pair produced by
 * {@link normalizeForParity} for the normalized-JSON equality the gate rests on.
 */
export function parityEqual(a: unknown, b: unknown): boolean {
  return deepEqual(a, b);
}

/**
 * @deprecated Inverted name — it returns `true` when the values are EQUAL, so
 * `if (diff(old, new))` reads backwards (#278). Use {@link parityEqual}.
 * Alias kept for one minor, then removed.
 */
export const diff = parityEqual;
