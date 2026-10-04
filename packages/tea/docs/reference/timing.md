# @demlik/tea/timing

> the call-rate batteries: coalesce a burst into one fire, cap a stream to one fire per window, and gate a high-frequency input into a settled, rate-capped, optionally deduped sequence of emits.

Tier: `battery`

```ts
import { … } from "@demlik/tea/timing";
```

## Exports (19)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`createThrottledInput`](#createThrottledInput) | Function | battery | Build a throttled-input knob from `config`. |
| [`debounce`](#debounce) | Function | battery | Wrap `fn` so a BURST of calls collapses to a single invocation. |
| [`Debounced`](#Debounced) | Interface | battery | A debounced wrapper around `fn`. |
| [`initThrottledInput`](#initThrottledInput) | Function | battery | The starting slice: no prior emit, nothing pending. |
| [`input`](#input) | Function | battery | Feed a new input `value` arriving at clock `at` through the gates. |
| [`onFlush`](#onFlush) | Function | battery | Emit the pending value because the settle (debounce) window closed. |
| [`PendingInput`](#PendingInput) | Interface | battery | A value held for the settle window: the `value` itself and the `at` it was held (the anchor the debounce deadline targets, `at + debounceMs`). |
| [`subscribeThrottledInput`](#subscribeThrottledInput) | Variable | battery | The `deadline` runner for the DEFAULT `setTimeout` backing. |
| [`subsFor`](#subsFor) | Function | battery | The settle timer deadline, derived from the slice. |
| [`throttle`](#throttle) | Function | battery | Wrap `fn` so it runs AT MOST once per `ms` window, no matter how often it is called. |
| [`Throttled`](#Throttled) | Interface | battery | A throttled wrapper around `fn`. |
| [`ThrottledInput`](#ThrottledInput) | Interface | battery | The Model slice a throttled input owns — its visible slice (the knob principle: managed state lives in the Model, never a closure, so it is durable and replayable). |
| [`ThrottledInputConfig`](#ThrottledInputConfig) | Type | battery | Configuration for a throttled input — the knob. |
| [`ThrottledInputKnob`](#ThrottledInputKnob) | Interface | battery | The bound knob returned by `createThrottledInput`. |
| [`ThrottledInputNoCache`](#ThrottledInputNoCache) | Interface | battery | The no-dedupe config variant: gates only, no cache. |
| [`throttledInputSettled`](#throttledInputSettled) | Function | battery | Construct the Msg the deadline dispatches. |
| [`ThrottledInputSettled`](#ThrottledInputSettled) | Type | battery | The Msg the deadline dispatches when the wall clock crosses `atMs`. |
| [`ThrottledInputSub`](#ThrottledInputSub) | Type | battery | The deadline a throttled input's settle timer lists — a `../deadline` entry (so the window fires at the correct ABSOLUTE moment even after a late subscribe / rehydrate, and so a consumer running several gates routes each by `id`). |
| [`ThrottledInputWithCache`](#ThrottledInputWithCache) | Interface | battery | The dedupe config variant: a per-entry TTL plus a REQUIRED `cacheKey`. |

## Declarations

<a id="createThrottledInput"></a>

### `createThrottledInput`

```ts
function createThrottledInput<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
): ThrottledInputKnob<V, C>
```

<a id="debounce"></a>

### `debounce`

```ts
function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  opts?: {
    /**
     * Fire on the FIRST call of a burst (the leading edge),
     *             with that first call's args. Default `false`.
     */
    leading?: boolean;
    /**
     * Fire on the trailing edge with the LAST call's args.
     *             Default `true`.
     *
     * Edge combinations (matching lodash's settled semantics, the de-facto
     * standard the ecosystem rediscovered):
     *
     *   - `{ trailing: true }` (default): one fire, after the burst, last args.
     *   - `{ leading: true, trailing: false }`: one fire, at the burst START,
     *     first args. Subsequent calls within the window are swallowed; the timer
     *     only re-opens the "can lead again" latch after `ms` of quiet.
     *   - `{ leading: true, trailing: true }`: fires at the start AND end of a
     *     burst — BUT the trailing fire is SUPPRESSED for a burst of exactly ONE
     *     call (the leading fire already covered it, so a lone call doesn't
     *     double-fire). This matches lodash and is the behavior tests pin.
     *   - `{ leading: false, trailing: false }`: never fires. Degenerate but legal;
     *     we don't throw — the caller asked for a no-op transformer.
     *
     * WHY a default of trailing-only: a debounce's whole job is "act after the
     * activity settles." The trailing edge IS that semantic — fire with the final
     * state of the burst (the last keystroke, the final scroll position). Leading
     * is the opt-in for "respond instantly, then go quiet."
     */
    trailing?: boolean;
  },
): Debounced<A>
```

<a id="Debounced"></a>

### `Debounced`

```ts
interface Debounced<A extends readonly unknown[]> {
  (...args: A): void;
  /**
   * Drop any pending trailing fire WITHOUT invoking `fn`. Clears the timer and
   * forgets the captured args. Idempotent — calling it with nothing pending is
   * a no-op. The leading-edge latch (if `leading` is enabled) also resets, so
   * the next call after `cancel` is treated as a fresh burst.
   *
   * The host-cleanup partner of `removeEventListener`: cancel the pending fire
   * when the component unmounts / the listener detaches, so a queued
   * `dispatch` can't land after teardown.
   */
  cancel(): void;
  /**
   * Fire any pending trailing call IMMEDIATELY with its captured args, then
   * clear the timer. No-op when nothing is pending. Use to force the last
   * coalesced call out early — e.g. flush a debounced save on `beforeunload`,
   * or flush a debounced search when the user presses Enter.
   */
  flush(): void;
}
```

<a id="initThrottledInput"></a>

### `initThrottledInput`

```ts
function initThrottledInput<V>(): ThrottledInput<V>
```

<a id="input"></a>

### `input`

```ts
function input<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
  state: ThrottledInput<V>,
  value: V,
  at: number,
): readonly [ThrottledInput<V>, readonly C[]]
```

<a id="onFlush"></a>

### `onFlush`

```ts
function onFlush<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
  state: ThrottledInput<V>,
  at: number,
): readonly [ThrottledInput<V>, readonly C[]]
```

<a id="PendingInput"></a>

### `PendingInput`

```ts
interface PendingInput<V> {
  readonly at: number;
  readonly value: V;
}
```

<a id="subscribeThrottledInput"></a>

### `subscribeThrottledInput`

```ts
const subscribeThrottledInput: <N extends string | undefined = undefined>(
  sub: DeadlinesSub<N>,
  ctx: unknown,
  dispatch: (msg: DeadlineExceeded<N>) => void,
) => Dispose
```

<a id="subsFor"></a>

### `subsFor`

```ts
function subsFor<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
  state: ThrottledInput<V>,
  id?: string,
): readonly ThrottledInputSub[]
```

<a id="throttle"></a>

### `throttle`

```ts
function throttle<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  opts?: {
    /**
     * Fire on the FIRST call of a window (the leading edge),
     *             immediately. Default `true`.
     */
    leading?: boolean;
    /**
     * Fire once at window END with the latest args dropped
     *             during the window. Default `true`.
     *
     * Edge combinations (matching lodash's settled semantics, the de-facto
     * standard the ecosystem rediscovered):
     *
     *   - `{ leading: true, trailing: true }` (default): immediate fire + a
     *     trailing fire per window while calls keep arriving. The trailing fire is
     *     SUPPRESSED when no extra call arrived during the window (a lone call
     *     already fired on the leading edge — no stale trailing double-fire).
     *   - `{ leading: true, trailing: false }`: only the immediate fire; everything
     *     in the window is dropped with no catch-up at the end.
     *   - `{ leading: false, trailing: true }`: no immediate fire; the FIRST call
     *     opens a window and `fn` fires at the window's end with the latest args.
     *     Steady "sample every `ms`" behavior with no instant response.
     *   - `{ leading: false, trailing: false }`: never fires. Degenerate but legal;
     *     we don't throw — the caller asked for a no-op transformer.
     *
     * WHY a default of leading + trailing both `true`: a throttle's job is "respond
     * now, then keep responding at a steady rate." Leading gives the instant
     * response (the first `mousemove` updates immediately); trailing guarantees the
     * FINAL sample of a window isn't lost (the cursor ends where the user actually
     * left it, not one window-width behind). Dropping either loses one of those two
     * guarantees, so both default on.
     */
    trailing?: boolean;
  },
): Throttled<A>
```

<a id="Throttled"></a>

### `Throttled`

```ts
interface Throttled<A extends readonly unknown[]> {
  (...args: A): void;
  /**
   * Drop any pending trailing fire WITHOUT invoking `fn`, and close the active
   * window. Clears the timer, forgets the captured trailing args, and resets
   * the cursor so the next call fires immediately on the leading edge (if
   * `leading` is enabled). Idempotent.
   *
   * The host-cleanup partner of `removeEventListener`: cancel the pending fire
   * when the component unmounts / the listener detaches, so a queued
   * `dispatch` can't land after teardown.
   */
  cancel(): void;
  /**
   * Fire any pending trailing call IMMEDIATELY with its latest captured args,
   * then close the window. No-op when nothing is pending. Use to force the last
   * dropped call out early — e.g. flush the final cursor position when a drag
   * ends, so the rest state isn't a stale mid-drag sample.
   */
  flush(): void;
}
```

<a id="ThrottledInput"></a>

### `ThrottledInput`

```ts
interface ThrottledInput<V> {
  readonly cache?: TtlCache<V>;
  readonly lastAt: number | null;
  readonly pending: PendingInput<V> | null;
}
```

<a id="ThrottledInputConfig"></a>

### `ThrottledInputConfig`

```ts
type ThrottledInputConfig<V, C extends Cmd> = ThrottledInputNoCache<V, C> | ThrottledInputWithCache<V, C>
```

<a id="ThrottledInputKnob"></a>

### `ThrottledInputKnob`

```ts
interface ThrottledInputKnob<V, C extends Cmd> {
  /** Seed the Model slice (with a cache iff `cacheTtlMs` is configured). */
  init(): ThrottledInput<V>;
  /** Feed a new input through the dedupe → rate → settle gates. See `input`. */
  input(
    state: ThrottledInput<V>,
    value: V,
    at: number,
  ): readonly [ThrottledInput<V>, readonly C[]];
  /** Emit the held value because the settle window closed. See `onFlush`. */
  onFlush(
    state: ThrottledInput<V>,
    at: number,
  ): readonly [ThrottledInput<V>, readonly C[]];
  /**
   * The settle timer deadline, listed only while a value is held. See
   * `subsFor`. `id` keys the deadline so several gates on one machine route
   * distinctly.
   */
  subs(state: ThrottledInput<V>, id?: string): readonly ThrottledInputSub[];
}
```

<a id="ThrottledInputNoCache"></a>

### `ThrottledInputNoCache`

```ts
interface ThrottledInputNoCache<V, C extends Cmd> extends ThrottledInputGates<V, C> {
  readonly cacheKey?: undefined;
  readonly cacheTtlMs?: undefined;
}
```

<a id="throttledInputSettled"></a>

### `throttledInputSettled`

```ts
function throttledInputSettled<N extends string | undefined = undefined>(
  id: string,
  atMs: number,
  name?: N,
): DeadlineExceeded<N>
```

<a id="ThrottledInputSettled"></a>

### `ThrottledInputSettled`

```ts
type ThrottledInputSettled<N extends string | undefined = undefined> = {
  readonly atMs: number;
  readonly id: string;
  readonly type: DeadlineMsgType<N>;
}
```

<a id="ThrottledInputSub"></a>

### `ThrottledInputSub`

```ts
type ThrottledInputSub = DeadlineSub
```

<a id="ThrottledInputWithCache"></a>

### `ThrottledInputWithCache`

```ts
interface ThrottledInputWithCache<V, C extends Cmd> extends ThrottledInputGates<V, C> {
  /**
   * Key a value for the dedupe cache. REQUIRED whenever `cacheTtlMs` is set:
   * there is no `String(value)` fallback, so a structured value's identity is
   * always the consumer's explicit choice and two distinct values can never
   * collapse to one slot. A primitive stream passes `(v) => v` / `String`.
   */
  readonly cacheKey: (value: V) => string;
  /**
   * Dedupe / memoize TTL, in milliseconds. An input whose `cacheKey` is already
   * cached and unexpired emits NOTHING; a fresh emit writes the value into the
   * cache so the next identical input within `cacheTtlMs` is suppressed.
   */
  readonly cacheTtlMs: number;
}
```
