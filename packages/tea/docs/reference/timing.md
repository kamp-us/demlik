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
  opts?: { leading?: boolean; trailing?: boolean },
): Debounced<A>
```

<a id="Debounced"></a>

### `Debounced`

```ts
interface Debounced<A extends readonly unknown[]> {
  (...args: A): void;
  cancel(): void;
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
  opts?: { leading?: boolean; trailing?: boolean },
): Throttled<A>
```

<a id="Throttled"></a>

### `Throttled`

```ts
interface Throttled<A extends readonly unknown[]> {
  (...args: A): void;
  cancel(): void;
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
  init(): ThrottledInput<V>;
  input(
    state: ThrottledInput<V>,
    value: V,
    at: number,
  ): readonly [ThrottledInput<V>, readonly C[]];
  onFlush(
    state: ThrottledInput<V>,
    at: number,
  ): readonly [ThrottledInput<V>, readonly C[]];
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
  readonly cacheKey: (value: V) => string;
  readonly cacheTtlMs: number;
}
```
