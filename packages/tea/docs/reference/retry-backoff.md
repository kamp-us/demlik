# @demlik/tea/retry-backoff

> exponential backoff with jitter + cap, and the retry-attempt state every fallible `interpret` handler folds over.

Tier: `battery`

```ts
import { … } from "@demlik/tea/retry-backoff";
```

## Exports (22)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`AnyRetryPolicy`](#AnyRetryPolicy) | Type | battery | Any well-formed policy. |
| [`asRng`](#asRng) | Function | battery | Brand a `[0, 1)` generator as an Rng. |
| [`BackoffCurve`](#BackoffCurve) | Interface | battery | The shape of the delay ladder, with no terminal bound attached — `baseMs`, `factor`, `capMs`, `jitter`. |
| [`backoffDelay`](#backoffDelay) | Function | battery | Compute the delay for a given 0-based `attempt` under `policy`. |
| [`CountBound`](#CountBound) | Interface | battery | Bound by ATTEMPT COUNT — the original bound, and the right one when each attempt costs about the same and the caller is the outermost ladder. |
| [`defaultRetryPolicy`](#defaultRetryPolicy) | Variable | battery | Sensible defaults: 100ms base, doubling, capped at 30s, up to 5 attempts, full jitter (the herd-avoidance default). |
| [`defaultRng`](#defaultRng) | Variable | battery | The production default: `Math.random`, branded. |
| [`DurationBound`](#DurationBound) | Interface | battery | Bound by WALL-CLOCK OUTAGE DURATION, optionally also by count. |
| [`DurationRetryPolicy`](#DurationRetryPolicy) | Type | battery | A curve bounded by wall-clock outage duration (and optionally by count). |
| [`initRetry`](#initRetry) | Function | battery | The starting state: zero attempts, no error yet, no streak. |
| [`Jitter`](#Jitter) | Type | battery | Jitter strategy applied to the computed backoff delay. |
| [`nextDelayMs`](#nextDelayMs) | Function | battery | The delay to wait before the next attempt, given the current state. |
| [`recordFailure`](#recordFailure) | Function | battery | Record a failed attempt. |
| [`RetryBudget`](#RetryBudget) | Type | battery | The terminal bound a policy declares: a count, a duration (optionally with a count), or an explicit opt-in to neither. |
| [`retryElapsedMs`](#retryElapsedMs) | Function | battery | How long the current failure streak has lasted, in milliseconds. |
| [`RetryPolicy`](#RetryPolicy) | Type | battery | A retry policy is pure configuration — the shape of the backoff curve plus the bound that ends the retrying. |
| [`RetryState`](#RetryState) | Interface | battery | Per-operation retry state: how many attempts have failed so far, and the most recent error. |
| [`Rng`](#Rng) | Type | battery | A source of uniform randomness in `[0, 1)` — the `Math.random` contract. |
| [`shouldRetry`](#shouldRetry) | Function | battery | Whether another attempt is permitted under `policy`. |
| [`TimedRetryState`](#TimedRetryState) | Interface | battery | A retry state that also knows WHEN its failure streak began — the origin a duration bound is measured from. |
| [`Unbounded`](#Unbounded) | Interface | battery | No bound at all — retry forever. |
| [`UnboundedRetryPolicy`](#UnboundedRetryPolicy) | Type | battery | A curve with the explicit opt-in to unbounded retry. |

## Declarations

<a id="AnyRetryPolicy"></a>

### `AnyRetryPolicy`

```ts
type AnyRetryPolicy = BackoffCurve & RetryBudget
```

<a id="asRng"></a>

### `asRng`

```ts
function asRng(fn: () => number, probe?: boolean): Rng
```

<a id="BackoffCurve"></a>

### `BackoffCurve`

```ts
interface BackoffCurve {
  /** Delay for attempt 0, in milliseconds, before any jitter or cap. */
  readonly baseMs: number;
  /** Hard ceiling, in milliseconds. The capped exponential never exceeds this. */
  readonly capMs: number;
  /** Geometric growth factor. `2` doubles the delay each attempt. */
  readonly factor: number;
  /** Jitter strategy applied to the capped exponential delay. */
  readonly jitter: Jitter;
}
```

<a id="backoffDelay"></a>

### `backoffDelay`

```ts
function backoffDelay(attempt: number, policy: BackoffCurve, rng?: Rng): number
```

<a id="CountBound"></a>

### `CountBound`

```ts
interface CountBound {
  /**
   * Maximum number of attempts. `shouldRetry` allows attempts `0 .. maxAttempts-1`,
   * so `maxAttempts: 3` means "try once, then retry at most twice" (attempts 0, 1, 2).
   */
  readonly maxAttempts: number;
  readonly maxElapsedMs?: undefined;
  readonly unbounded?: undefined;
}
```

<a id="defaultRetryPolicy"></a>

### `defaultRetryPolicy`

```ts
const defaultRetryPolicy: RetryPolicy
```

<a id="defaultRng"></a>

### `defaultRng`

```ts
const defaultRng: Rng
```

<a id="DurationBound"></a>

### `DurationBound`

```ts
interface DurationBound {
  /** Optional secondary count bound; omitted means "no count bound". */
  readonly maxAttempts?: number;
  /**
   * Outage budget in wall-clock milliseconds. `shouldRetry` permits another
   * attempt while `nowMs - firstFailureAtMs < maxElapsedMs`, however many
   * attempts that takes.
   */
  readonly maxElapsedMs: number;
  readonly unbounded?: undefined;
}
```

<a id="DurationRetryPolicy"></a>

### `DurationRetryPolicy`

```ts
type DurationRetryPolicy = BackoffCurve & DurationBound
```

<a id="initRetry"></a>

### `initRetry`

```ts
function initRetry(): RetryState
```

<a id="Jitter"></a>

### `Jitter`

```ts
type Jitter = "none" | "full" | "equal"
```

<a id="nextDelayMs"></a>

### `nextDelayMs`

```ts
function nextDelayMs(state: RetryState, policy: BackoffCurve, rng?: Rng): number
```

<a id="recordFailure"></a>

### `recordFailure`

```ts
function recordFailure(
  state: TimedRetryState,
  error: unknown,
  atMs?: number,
): TimedRetryState
function recordFailure(
  state: RetryState,
  error: unknown,
  atMs: number,
): TimedRetryState
function recordFailure(state: RetryState, error: unknown): RetryState
```

<a id="RetryBudget"></a>

### `RetryBudget`

```ts
type RetryBudget = CountBound | DurationBound | Unbounded
```

<a id="retryElapsedMs"></a>

### `retryElapsedMs`

```ts
function retryElapsedMs(state: TimedRetryState, nowMs: number): number
```

<a id="RetryPolicy"></a>

### `RetryPolicy`

```ts
type RetryPolicy = BackoffCurve & CountBound
```

<a id="RetryState"></a>

### `RetryState`

```ts
interface RetryState {
  /** Count of failures recorded so far. Also the 0-based index of the next attempt. */
  readonly attempt: number;
  /** The error from the most recent failure, if any. Carried, never interpreted. */
  readonly lastError?: unknown;
}
```

<a id="Rng"></a>

### `Rng`

```ts
type Rng = (() => number) & { readonly "[RngBrand]": true }
```

<a id="shouldRetry"></a>

### `shouldRetry`

```ts
function shouldRetry(
  state: RetryState,
  policy: BackoffCurve & (CountBound | Unbounded),
  nowMs?: number,
): boolean
function shouldRetry(
  state: TimedRetryState,
  policy: AnyRetryPolicy,
  nowMs: number,
): boolean
```

<a id="TimedRetryState"></a>

### `TimedRetryState`

```ts
interface TimedRetryState extends RetryState {
  /** When the streak's first failure was observed (caller's clock, epoch ms). */
  readonly firstFailureAtMs: number;
}
```

<a id="Unbounded"></a>

### `Unbounded`

```ts
interface Unbounded {
  readonly maxAttempts?: undefined;
  readonly maxElapsedMs?: undefined;
  readonly unbounded: true;
}
```

<a id="UnboundedRetryPolicy"></a>

### `UnboundedRetryPolicy`

```ts
type UnboundedRetryPolicy = BackoffCurve & Unbounded
```
