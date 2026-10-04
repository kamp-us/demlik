# @demlik/tea/parity

> the record → replay → normalized-diff go/no-go gate.

Tier: `stable`

```ts
import { … } from "@demlik/tea/parity";
```

## Exports (8)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`goldenReplay`](#goldenReplay) | Function | stable | Reproduce a recording's final state by folding its msgs through the pure `replay` — `init(loaded, ctx)` then `update` per msg, never `interpret`, never a `Store`, never a live subscription. |
| [`normalizeForParity`](#normalizeForParity) | Function | stable | Build a finding-normalizer: a pure `(value) => normalized` that strips the schema's `stripKeys`, recursively sorts object keys, and stable-key-sorts arrays by the schema's `sortKeys`. |
| [`parityEqual`](#parityEqual) | Function | stable | The parity verdict: `true` iff `a` and `b` are structurally equal. |
| [`ParitySchema`](#ParitySchema) | Interface | stable | Configuration for normalizeForParity. |
| [`RecorderOptions`](#RecorderOptions) | Interface | stable | Options for recorder. |
| [`Recording`](#Recording) | Interface | stable | A live parity recording attached to a Runtime — the go/no-go gate's golden artifact. |
| [`recordRun`](#recordRun) | Function | stable | Attach a parity recording to a Runtime, reusing the `recorder`/`historyTracker` capture (the boot observe for `loaded` + every non-null msg in order) rather than a fresh observer path. |
| [`Trace`](#Trace) | Interface | stable | A recorded run, sufficient to reproduce it via `../trace-replay`. |

## Declarations

<a id="goldenReplay"></a>

### `goldenReplay`

```ts
function goldenReplay<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  recording: Recording<S, M> | Trace<S, M>,
  ctx?: Ctx,
): S
```

<a id="normalizeForParity"></a>

### `normalizeForParity`

```ts
function normalizeForParity(schema?: ParitySchema): (value: unknown) => unknown
```

<a id="parityEqual"></a>

### `parityEqual`

```ts
function parityEqual(a: unknown, b: unknown): boolean
```

<a id="ParitySchema"></a>

### `ParitySchema`

```ts
interface ParitySchema {
  /**
   * Candidate keys used to stable-sort arrays of objects. For each array the
   * first candidate present (as a primitive) on the items decides the order;
   * arrays with no candidate fall back to canonical-JSON order. Default:
   * `ruleId`, `selector`, `url`.
   */
  readonly sortKeys?: readonly string[];
  /**
   * Object keys stripped wherever they appear — the record-time
   * non-determinism `replay` never re-mints. Default: `id`, `runId`,
   * `timestamp`.
   */
  readonly stripKeys?: readonly string[];
}
```

<a id="RecorderOptions"></a>

### `RecorderOptions`

```ts
interface RecorderOptions {
  /**
   * When `true`, retain a per-transition `(msg, post-state)` pair in
   * Trace.steps for EVERY recorded transition. Default `false`.
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
   *     `steps` exactly via parseJSONL.
   *
   * Replay fidelity is identical in both modes — `../trace-replay` reads
   * `loaded` + `msgs` + `finalState` only and never touches `steps`. The
   * choice is purely "do I also want to inspect intermediate states?".
   */
  readonly captureSteps?: boolean;
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
}
```

<a id="Recording"></a>

### `Recording`

```ts
interface Recording<S, M> {
  /** Detach the underlying observer. Idempotent. */
  stop(): void;
  /** Serialize the recording as JSONL (see recorder's `toJSONL`). */
  toJSONL(): string;
  /**
   * Snapshot the recording so far as a replayable Trace — `loaded`
   * (boot state), the ordered non-null `msgs`, and `finalState`. Sufficient to
   * reproduce the run via goldenReplay. Fresh object each call.
   */
  trace(): Trace<S, M>;
}
```

<a id="recordRun"></a>

### `recordRun`

```ts
function recordRun<S, M extends { type: string }>(
  runtime: BootingRuntime<S, M>,
  opts?: RecorderOptions,
): Recording<S, M>
```

<a id="Trace"></a>

### `Trace`

```ts
interface Trace<S, M> {
  /**
   * The last observed state. The oracle: `replayTrace` deep-compares its
   * recomputed final state against this. Equal ⇒ the reducer still produces
   * the same result for this input.
   */
  readonly finalState: S;
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
   * Per-transition `(msg, post-state)` pairs, in dispatch order, for human
   * inspection (e.g. "show me the state after step 3"). When present, there
   * is exactly one entry per recorded msg and `state` is the POST-transition
   * state for that msg (so `steps[i].msg === msgs[i]` and `steps.at(-1).state`
   * deep-equals `finalState`). NOT required for replay — replay only needs
   * `loaded` + `msgs` + `finalState`.
   *
   * Present iff the recorder was created with `captureSteps: true`, OR the
   * Trace was re-hydrated from JSONL via parseJSONL (the JSONL format
   * carries per-step state, so the parser populates `steps` whenever a step
   * line had a non-null state). A trace dumped with `captureSteps: false` has
   * `steps === undefined`.
   */
  readonly steps?: readonly { readonly msg: M; readonly state: S }[];
}
```
