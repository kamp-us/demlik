// ---------------------------------------------------------------------------
// recorder — capture a Runtime's Msg sequence for later replay.
//
// `historyTracker` (in ../index) is the exemplar: a BOUNDED, in-memory ring
// buffer over `runtime.observe`. The recorder is its UNBOUNDED, SERIALIZABLE
// cousin. Where historyTracker exists to answer "what were the last N
// transitions?", the recorder exists to answer "reproduce this entire run
// locally against the current reducer."
//
// The killer feature this enables: record a prod Msg sequence, dump it as
// JSONL, ship the file home, and feed it to `../trace-replay`'s `replayTrace`
// — which folds the SAME msgs through `replay(machine, ...)` and diffs the
// resulting state against the recorded final state. If they diverge, the
// reducer changed behavior for that input. Regression-as-a-trace.
//
// What `replay` needs to reproduce a run (see `replay` in ../index):
//   - `loaded`   — the value `init` was booted with. Captured at the boot
//                  observe, where `msg === null` and `state` is the post-init
//                  initial state. (We capture the post-init state, not the raw
//                  storage value, because replay re-runs `init(loaded, ctx)`
//                  itself — and for a faithful re-run we feed it that initial
//                  state as `loaded` so `init` returns `[loaded, []]`. This is
//                  the rehydrate path, which the substrate guarantees is a pure
//                  passthrough; see Invariant 2.)
//   - `msgs`     — every non-null msg, in dispatch order.
//   - `ctx`      — NOT captured here. Ctx is host wiring (sibling runtimes,
//                  clients), supplied fresh at replay time. The trace is the
//                  INPUT (loaded + msgs); ctx is the ENVIRONMENT.
//
// This module OWNS the `Trace` type. `../trace-replay` imports it.
// ---------------------------------------------------------------------------

import type { BootingRuntime } from "../index";

/**
 * A recorded run, sufficient to reproduce it via `../trace-replay`.
 *
 * The recorder OWNS this type; `../trace-replay` imports it. It is the wire
 * contract between the two halves of the record/replay feature.
 *
 * @typeParam S - the machine's State type.
 * @typeParam M - the machine's Msg union.
 */
export interface Trace<S, M> {
  /**
   * The initial state captured at the boot observe (the transition where
   * `msg === null`). Fed back to replay as `loaded` so `init(loaded, ctx)`
   * reproduces the exact starting point. `null` only if the recorder attached
   * AFTER boot (it missed the boot observe) — replay then re-runs fresh `init`.
   */
  readonly loaded: S | null;
  /** The ordered, non-null msgs as observed. The replay input sequence. */
  readonly msgs: readonly M[];
  /**
   * The last observed state. The oracle: `replayTrace` deep-compares its
   * recomputed final state against this. Equal ⇒ the reducer still produces
   * the same result for this input.
   */
  readonly finalState: S;
  /**
   * Per-transition `(msg, post-state)` pairs, in dispatch order, for human
   * inspection (e.g. "show me the state after step 3"). When present, there
   * is exactly one entry per recorded msg and `state` is the POST-transition
   * state for that msg (so `steps[i].msg === msgs[i]` and `steps.at(-1).state`
   * deep-equals `finalState`). NOT required for replay — replay only needs
   * `loaded` + `msgs` + `finalState`.
   *
   * Present iff the recorder was created with `captureSteps: true`, OR the
   * Trace was re-hydrated from JSONL via {@link parseJSONL} (the JSONL format
   * carries per-step state, so the parser populates `steps` whenever a step
   * line had a non-null state). A trace dumped with `captureSteps: false` has
   * `steps === undefined`.
   */
  readonly steps?: readonly { readonly msg: M; readonly state: S }[];
}

/** Options for {@link recorder}. */
export interface RecorderOptions {
  /**
   * Fraction of msgs to record, in `(0, 1]`. Default `1` (record everything).
   *
   * IMPORTANT — sampling breaks replay fidelity. A sampled trace DROPS msgs,
   * so its `msgs` array is no longer the complete input sequence and
   * `replayTrace` will NOT reproduce `finalState`. Sampling exists for
   * VOLUME STATISTICS (how much traffic, msg-type distribution), not for
   * faithful replay. Use the default `1` for any trace you intend to replay.
   *
   * The boot observe (`msg === null`) is ALWAYS recorded regardless of
   * `sampleRate` — `loaded` and `finalState` are anchors, not samples.
   */
  readonly sampleRate?: number;
  /**
   * When `true`, retain a per-transition `(msg, post-state)` pair in
   * {@link Trace.steps} for EVERY recorded transition. Default `false`.
   *
   * Size vs. fidelity — the precise trade-off:
   *
   *   - `captureSteps: false` (default) — the MINIMAL replay-faithful trace.
   *     The recorder keeps `loaded` (boot state), the ordered `msgs`, and
   *     `finalState`. That is exactly what `../trace-replay` needs to refold
   *     the run and diff the result. Memory is O(msgs) — one msg ref each, no
   *     per-step state snapshot. `dump().steps` is `undefined`; in JSONL,
   *     interior step lines carry `state: null` (the post-states were never
   *     retained) and only the LAST step line carries `finalState`. A trace
   *     dumped this way REPLAYS correctly but cannot answer "what was the
   *     state after step 3?".
   *
   *   - `captureSteps: true` — the FULL-fidelity trace. The recorder also
   *     snapshots the post-transition state for every msg, so `dump().steps`
   *     holds `{ msg, state }` for every transition (post-state) and
   *     `toJSONL()` emits a non-null `state` on every step line. Memory is
   *     O(msgs × |state|) — a state ref per transition (refs, not deep
   *     copies; TEA states are conventionally immutable, so the runtime's
   *     post-transition state object is retained by reference). This is the
   *     mode for per-step inspection and for a JSONL file that round-trips
   *     `steps` exactly via {@link parseJSONL}.
   *
   * Replay fidelity is identical in both modes — `../trace-replay` reads
   * `loaded` + `msgs` + `finalState` only and never touches `steps`. The
   * choice is purely "do I also want to inspect intermediate states?".
   */
  readonly captureSteps?: boolean;
}

/**
 * A live recorder attached to a Runtime. Mirrors `historyTracker`'s
 * stop/snapshot semantics: `dump()` works at any time (including after
 * `stop()`), `stop()` is idempotent and detaches the observer.
 *
 * @typeParam S - the machine's State type.
 * @typeParam M - the machine's Msg union.
 */
export interface Recorder<S, M> {
  /**
   * Snapshot the recording so far as a {@link Trace}. Returns a fresh object
   * with copied arrays on every call (callers may slice/replay without
   * affecting the recorder's buffers). Entry values are references to the
   * originals (TEA states/msgs are conventionally immutable).
   *
   * Throws only if called before the boot observe has fired AND no msgs have
   * been recorded — i.e. there is no `finalState` yet. In practice callers
   * `await runtime.ready` before `dump()`, after which boot has fired.
   */
  dump(): Trace<S, M>;
  /**
   * Serialize the recording as JSONL (one JSON object per line) — a streamable
   * format that appends cleanly and survives truncation (a partial tail line
   * is the only loss). The first line is the boot header
   * `{ kind: "boot", state }`; each subsequent line is
   * `{ kind: "step", msg, state }` for one recorded transition.
   *
   * Re-hydrate with {@link parseJSONL}.
   *
   * Round-trip fidelity depends on `captureSteps`:
   *   - `captureSteps: true` — every step line carries its non-null
   *     post-state, so `parseJSONL(rec.toJSONL())` reconstructs `steps`
   *     EXACTLY and deep-equals `rec.dump()` (which also has `steps`). Full
   *     per-step fidelity round-trips.
   *   - `captureSteps: false` (default) — interior step lines carry
   *     `state: null` (those post-states were never retained); only the last
   *     step line carries `finalState`. `parseJSONL` then populates `steps`
   *     with just the entries that had a non-null state (the final one), so
   *     the re-hydrated Trace is NOT deep-equal to `rec.dump()` (which has no
   *     `steps`). It is still fully replay-faithful: `loaded`, `msgs`, and
   *     `finalState` are intact. Record with `captureSteps: true` if you need
   *     interior states to survive the round-trip.
   */
  toJSONL(): string;
  /**
   * Detach the underlying observer. After `stop()`:
   *   - no new transitions are recorded;
   *   - `dump()` / `toJSONL()` keep working against the buffered contents;
   *   - the recorder holds no observer reference into the runtime.
   *
   * Idempotent — subsequent calls are no-ops.
   */
  stop(): void;
}

/**
 * Attach a recorder to a Runtime. Subscribes via `runtime.observe`, capturing
 * the boot state as `loaded` and every subsequent non-null msg in order.
 *
 * One-line creation, mirroring `historyTracker`:
 *
 *     const rec = recorder(runtime);
 *     // ... drive the runtime ...
 *     await runtime.ready;            // boot observe has fired
 *     const trace = rec.dump();       // { loaded, msgs, finalState }
 *
 * @param runtime - any `BootingRuntime<S, M>` (a full `Runtime` satisfies it).
 *                  The recorder uses only `observe`, which is total before boot
 *                  — so you attach it to the synchronous `run()` handle to
 *                  capture the boot transition as `loaded`.
 * @param opts    - see {@link RecorderOptions}. Default records everything,
 *                  no step retention.
 */
export function recorder<S, M extends { type: string }>(
  runtime: BootingRuntime<S, M>,
  opts?: RecorderOptions,
): Recorder<S, M> {
  // Clamp sampleRate into (0, 1]. A non-positive or NaN rate would record
  // nothing (and break replay anchors); default it to 1 (record all). Rates
  // above 1 are meaningless — clamp to 1.
  const rawRate = opts?.sampleRate;
  const sampleRate =
    rawRate === undefined || Number.isNaN(rawRate) || rawRate <= 0
      ? 1
      : Math.min(rawRate, 1);
  const captureSteps = opts?.captureSteps ?? false;

  // `loaded` is the post-init state captured at the boot observe. `undefined`
  // sentinel = boot not yet seen; resolved to `S | null` in dump() (null when
  // the recorder attached after boot and never observed msg === null).
  let loaded: S | undefined;
  let sawBoot = false;
  // The ordered, recorded msgs. Unbounded (the recorder's whole point vs the
  // bounded historyTracker).
  const msgs: M[] = [];
  // Per-step (msg, state) pairs — only populated when captureSteps is on.
  const steps: { msg: M; state: S }[] = [];
  // The last observed state — boot state until the first step, then advances
  // with every recorded OR dropped transition (finalState must reflect the
  // true latest state even under sampling, so it stays a valid replay oracle
  // for the unsampled case and an honest "where the run ended" marker).
  let finalState: S | undefined;
  let stopped = false;

  // The boot transition — the post-init initial state the old `observe(msg ===
  // null)` arm captured as `loaded` — now arrives via `onBoot` (#47). Always
  // captured (boot is the replay anchor). It is also the first `finalState`
  // until the first applied transition advances it.
  const unboot = runtime.onBoot((state) => {
    finalState = state;
    loaded = state;
    sawBoot = true;
  });

  const unobserve = runtime.observe((msg, state) => {
    // finalState tracks the latest state regardless of sampling — it is the
    // run's endpoint, an anchor, not a sample.
    finalState = state;

    // Sampling decision. sampleRate === 1 short-circuits to always-record so
    // the common (faithful) path pays no RNG cost. Math.random() < rate keeps
    // a `rate` fraction in expectation.
    if (sampleRate < 1 && Math.random() >= sampleRate) return;

    msgs.push(msg);
    if (captureSteps) steps.push({ msg, state });
  });

  return {
    dump(): Trace<S, M> {
      if (finalState === undefined) {
        throw new Error(
          "@demlik/tea/recorder: dump() called before any transition was observed. " +
            "Await `runtime.ready` (boot fires the first observe) before dumping.",
        );
      }
      return {
        // sawBoot ⇒ `loaded` is the captured boot state; otherwise the
        // recorder attached post-boot and replay must re-run fresh init.
        loaded: sawBoot ? (loaded as S) : null,
        msgs: msgs.slice(),
        finalState,
        // Only attach `steps` when captureSteps was requested — keeps the
        // dumped Trace shape honest about what was retained.
        ...(captureSteps ? { steps: steps.slice() } : {}),
      };
    },
    toJSONL(): string {
      if (finalState === undefined) {
        throw new Error(
          "@demlik/tea/recorder: toJSONL() called before any transition was observed. " +
            "Await `runtime.ready` (boot fires the first observe) before serializing.",
        );
      }
      // Serialize the live snapshot via the shared Trace→JSONL writer so the
      // recorder and the standalone `traceAttachment` path emit byte-identical
      // wire format. `dump()` resolves the captureSteps logic (steps present
      // iff captureSteps was on); `traceToJSONL` then emits a non-null state
      // on every step line when steps exist, or `null` interior + finalState
      // on the last line when they don't. The replay path never reads step
      // states, so the captureSteps:false null-interiors never affect replay.
      return traceToJSONL(this.dump());
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      unobserve();
      unboot();
    },
  };
}

/** One line of the JSONL format produced by {@link Recorder.toJSONL}. */
type JsonlLine<S, M> =
  | { readonly kind: "boot"; readonly state: S | null }
  | { readonly kind: "step"; readonly msg: M; readonly state: S | null };

/**
 * Re-hydrate a {@link Trace} from the JSONL produced by
 * {@link Recorder.toJSONL}. The inverse of `toJSONL`, so
 * `parseJSONL(rec.toJSONL())` deep-equals `rec.dump()`.
 *
 * Parsing rules:
 *   - The first non-blank line MUST be the boot header `{ kind: "boot", state }`.
 *     Its `state` becomes `Trace.loaded`.
 *   - Each `{ kind: "step", msg, state }` line contributes `msg` to
 *     `Trace.msgs` and `(msg, state)` to `Trace.steps`.
 *   - `Trace.finalState` is the `state` of the LAST step line, or the boot
 *     `state` when there are no steps (a boot-only trace).
 *
 * Blank lines are skipped (tolerant of trailing newlines / hand-edited files).
 * A malformed line, a missing/duplicate boot header, or a step with `null`
 * final state throws — the trace is unusable for replay and silent corruption
 * is worse than a loud parse error (errors are data; surface them).
 *
 * @typeParam S - the machine's State type.
 * @typeParam M - the machine's Msg union.
 */
export function parseJSONL<S, M>(jsonl: string): Trace<S, M> {
  const rawLines = jsonl.split("\n");
  let loaded: S | null = null;
  let sawBoot = false;
  const msgs: M[] = [];
  const steps: { msg: M; state: S }[] = [];
  let finalState: S | null = null;
  let finalKnown = false;

  for (const [i, rawLine] of rawLines.entries()) {
    const line = rawLine.trim();
    if (line === "") continue; // tolerate blank / trailing-newline lines

    let parsed: JsonlLine<S, M>;
    try {
      parsed = JSON.parse(line) as JsonlLine<S, M>;
    } catch (err) {
      throw new Error(
        `@demlik/tea/recorder: parseJSONL failed on line ${i + 1}: not valid JSON. ${String(err)}`,
      );
    }

    if (parsed.kind === "boot") {
      if (sawBoot) {
        throw new Error(
          `@demlik/tea/recorder: parseJSONL saw a second boot header on line ${i + 1}. ` +
            "A trace has exactly one boot line.",
        );
      }
      sawBoot = true;
      loaded = parsed.state;
      // The boot state is the finalState until a step supersedes it (boot-only
      // trace case).
      finalState = parsed.state;
      finalKnown = parsed.state !== null;
    } else if (parsed.kind === "step") {
      if (!sawBoot) {
        throw new Error(
          `@demlik/tea/recorder: parseJSONL saw a step line before the boot header on line ${i + 1}.`,
        );
      }
      msgs.push(parsed.msg);
      if (parsed.state !== null) {
        steps.push({ msg: parsed.msg, state: parsed.state });
        finalState = parsed.state;
        finalKnown = true;
      }
    } else {
      throw new Error(
        `@demlik/tea/recorder: parseJSONL saw an unknown line kind on line ${i + 1}: ` +
          JSON.stringify((parsed as { kind?: unknown }).kind),
      );
    }
  }

  if (!sawBoot) {
    throw new Error(
      "@demlik/tea/recorder: parseJSONL found no boot header. A trace must start with " +
        '{ kind: "boot", state }.',
    );
  }
  if (!finalKnown || finalState === null) {
    throw new Error(
      "@demlik/tea/recorder: parseJSONL could not determine finalState — the boot state " +
        "was null and no step carried a non-null state. The trace is unusable for replay.",
    );
  }

  return { loaded, msgs, finalState, steps };
}

// ---------------------------------------------------------------------------
// Sentry crash→trace adapters — pure, zero-dependency, Sentry-SHAPED.
//
// The killer DevX flow: a machine crashes in prod → its recorded Trace rides
// along on the Sentry event → one click later you `parseJSONL` it and replay
// the exact run locally against the (possibly fixed) reducer. These two
// adapters are the bridge from a `Trace` to the two Sentry surfaces that carry
// it: an Attachment (the full replayable trace) and Breadcrumbs (a human-
// readable timeline of the msgs that led to the crash).
//
// They take NO dependency on `@sentry/*`. They emit PLAIN OBJECTS whose shapes
// match Sentry's public `Attachment` and `Breadcrumb` types, and the consumer
// wires them at their own Sentry boundary (browser or node). This keeps the
// recorder runnable anywhere a machine runs (a Worker, a Node script, a test)
// and lets the consumer pin whatever Sentry SDK version they already ship.
// ---------------------------------------------------------------------------

/**
 * A Sentry-shaped attachment carrying the full {@link Trace} as JSONL. The
 * shape matches Sentry's `Attachment` type so the consumer can hand it
 * straight to `addAttachment(...)` without any adaptation.
 *
 * - `filename`    — `"tea-trace.jsonl"`. The name Sentry shows in the UI and
 *                   uses for download; `.jsonl` signals the streamable format.
 * - `data`        — the trace serialized via {@link Recorder.toJSONL}'s format
 *                   (re-hydrate downstream with {@link parseJSONL}).
 * - `contentType` — `"application/x-ndjson"`, the standard MIME for
 *                   newline-delimited JSON.
 */
export interface TraceAttachment {
  readonly filename: string;
  readonly data: string;
  readonly contentType: string;
}

/**
 * Serialize a {@link Trace} into a Sentry-shaped attachment so a crash event
 * carries the full, replayable run. Pure — no Sentry import, no I/O. The
 * returned object matches Sentry's `Attachment` shape exactly.
 *
 * The `data` field is JSONL in the same format {@link Recorder.toJSONL}
 * produces, so the home-side flow is `parseJSONL(attachment.data)` →
 * `replayTrace(machine, trace, ctx)`.
 *
 * Consumer wiring (no Sentry import here — the consumer owns the boundary):
 *
 * ```ts
 * import * as Sentry from "@sentry/browser"; // or "@sentry/node"
 * import { traceAttachment } from "@demlik/tea/recorder";
 * Sentry.getCurrentScope().addAttachment(traceAttachment(rec.dump()));
 * ```
 *
 * @typeParam S - the machine's State type.
 * @typeParam M - the machine's Msg union.
 */
export function traceAttachment<S, M extends { type: string }>(
  trace: Trace<S, M>,
): TraceAttachment {
  return {
    filename: "tea-trace.jsonl",
    data: traceToJSONL(trace),
    contentType: "application/x-ndjson",
  };
}

/** A Sentry-shaped breadcrumb. Matches the fields of Sentry's `Breadcrumb`. */
export interface TraceBreadcrumb {
  readonly category: string;
  readonly type: string;
  readonly level: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

/** Options for {@link breadcrumbsFromTrace}. */
export interface BreadcrumbsOptions<M> {
  /**
   * Max breadcrumbs to emit. Default `100` (Sentry's own default breadcrumb
   * cap). When the trace has more msgs than `limit`, the OLDEST are dropped —
   * the returned list is the newest-last tail, matching how a Sentry
   * breadcrumb ring buffer behaves (the crash context is the recent past).
   */
  readonly limit?: number;
  /**
   * Customize each breadcrumb's `message`. Default uses `msg.type`. Provide a
   * serializer to surface a richer one-liner (e.g. include an id). The msg is
   * ALSO always attached verbatim under `data.msg` regardless of this option,
   * so the structured payload is never lost to the string rendering.
   */
  readonly serialize?: (msg: M) => string;
}

/**
 * Project a {@link Trace}'s recorded msgs into Sentry-shaped breadcrumbs — a
 * human-readable timeline of "what happened before the crash". Pure — no
 * Sentry import, no I/O. Each returned object matches Sentry's `Breadcrumb`
 * shape, so the consumer can loop and call `addBreadcrumb(...)`.
 *
 * One breadcrumb per recorded msg, in dispatch order (NEWEST LAST — Sentry
 * renders breadcrumbs oldest-first and the crash is the most recent event).
 * Each breadcrumb:
 *   - `category` — `"tea"` (groups them in the Sentry breadcrumb panel).
 *   - `type`     — `"default"` (the generic Sentry breadcrumb type).
 *   - `level`    — `"info"` (msgs are normal flow; the crash is the event).
 *   - `message`  — `msg.type`, or `serialize(msg)` when provided.
 *   - `data.msg` — the full msg object (structured detail kept verbatim).
 *
 * Capped at `opts.limit` (default 100). When the trace has more msgs than the
 * cap, the OLDEST are dropped and the newest `limit` are kept — the recent
 * lead-up to the crash is the useful context.
 *
 * Consumer wiring (no Sentry import here — the consumer owns the boundary):
 *
 * ```ts
 * import * as Sentry from "@sentry/browser"; // or "@sentry/node"
 * import { breadcrumbsFromTrace } from "@demlik/tea/recorder";
 * for (const b of breadcrumbsFromTrace(rec.dump())) Sentry.addBreadcrumb(b);
 * ```
 *
 * @typeParam S - the machine's State type.
 * @typeParam M - the machine's Msg union.
 */
export function breadcrumbsFromTrace<S, M extends { type: string }>(
  trace: Trace<S, M>,
  opts?: BreadcrumbsOptions<M>,
): TraceBreadcrumb[] {
  const rawLimit = opts?.limit;
  // Clamp limit to a non-negative integer. `undefined`/NaN → 100 (Sentry's
  // default). A negative or zero limit yields an empty list (the caller asked
  // for no breadcrumbs); fractional values floor (you can't emit half a crumb).
  const limit =
    rawLimit === undefined || Number.isNaN(rawLimit)
      ? 100
      : Math.max(0, Math.floor(rawLimit));
  const serialize = opts?.serialize;

  // Keep the NEWEST `limit` msgs (the recent lead-up to the crash). Slicing
  // from `length - limit` (clamped to 0) preserves dispatch order within the
  // kept window. Note we do NOT use `slice(-limit)`: `slice(-0)` is `slice(0)`
  // (JS treats -0 as 0), which would return the WHOLE array for `limit: 0`.
  const start = Math.max(0, trace.msgs.length - limit);
  const kept = start === 0 ? trace.msgs : trace.msgs.slice(start);

  const crumbs: TraceBreadcrumb[] = [];
  for (const msg of kept) {
    crumbs.push({
      category: "tea",
      type: "default",
      level: "info",
      message: serialize ? serialize(msg) : msg.type,
      // Full msg kept verbatim so the structured payload survives even when
      // `message` is a terse one-liner. Cast: a Msg is a `{ type: string }`
      // record, which is a `Record<string, unknown>` for Sentry's `data`.
      data: { msg: msg as unknown as Record<string, unknown> },
    });
  }
  return crumbs;
}

// ---------------------------------------------------------------------------
// traceToJSONL — serialize a STANDALONE Trace to JSONL (the dump→file path).
//
// `Recorder.toJSONL()` serializes the recorder's live buffers. `traceAttachment`
// works over a plain `Trace` value (a `dump()` snapshot or a `parseJSONL`
// result), which has no recorder behind it — so it needs a Trace→JSONL
// function. This is the same wire format `Recorder.toJSONL` emits and
// `parseJSONL` reads, so `parseJSONL(traceToJSONL(trace))` round-trips.
//
// When `trace.steps` is present (captureSteps was on, or the trace came from
// parseJSONL), every step line carries its post-state. When absent, interior
// step states are unknown — emitted as `null`, with `finalState` on the LAST
// step line (identical to the captureSteps:false path in `Recorder.toJSONL`).
// ---------------------------------------------------------------------------
function traceToJSONL<S, M>(trace: Trace<S, M>): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ kind: "boot", state: trace.loaded }));

  const steps = trace.steps;
  for (let i = 0; i < trace.msgs.length; i++) {
    const msg = trace.msgs[i];
    const stepState = steps
      ? steps[i]?.state
      : i === trace.msgs.length - 1
        ? trace.finalState
        : null;
    lines.push(JSON.stringify({ kind: "step", msg, state: stepState }));
  }
  return lines.join("\n");
}
