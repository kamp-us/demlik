/**
 * internal/resilience/retry-to-success — run a fallible async port through BOUNDED
 * retry + exponential backoff to success-or-terminal-give-up, and hand the
 * caller a `Promise<R>` that resolves on the first success or REJECTS with a
 * checkable {@link RetryExhaustedError} the moment the retry bound is hit.
 *
 * This is the retry-side parallel to `./await-terminal`. `runToTerminal` gives a
 * caller with a one-shot decision *machine* a fire-and-await `Promise<State>`
 * without wiring `observe`; this gives a caller with a one-shot fallible *port*
 * a fire-and-await `Promise<R>` without either hand-folding the
 * `./retry-backoff` primitives (`recordFailure` / `shouldRetry` / `nextDelayMs`)
 * into their own reducer each time, or standing up the full `./resilient-call`
 * verb contract (`init` + `attempt`/`succeed`/`fail`/`onTimer` + `subs` +
 * `handlers`) when they want retry only and none of cache / circuit / rate-limit
 * / deadline.
 *
 * It adds NO new runtime capability and NO new backoff math — the whole retry
 * decision is `./retry-backoff` exactly as `resilient-call`'s `backoff` verb
 * wires it:
 *   - `initRetry()` seeds the per-call attempt counter.
 *   - `recordFailure(retry, error)` folds each failure (attempt++).
 *   - `shouldRetry(retry, policy)` is the terminal-at-`maxAttempts` bound — the
 *     `maxAttempts`-th recorded failure refuses another attempt (attempts
 *     `0 .. maxAttempts-1` run; the port is invoked at most `maxAttempts` times).
 *   - `nextDelayMs(retry, policy, rng)` is the exp+jitter+cap delay before the
 *     next attempt, computed on the incremented state — same call order as
 *     `resilient-call`.
 *
 * Where the clock / RNG live: injected, never read on the module's own behalf,
 * mirroring `retry-backoff`'s purity discipline. `rng` is an {@link Rng} (branded
 * `[0, 1)` via `asRng` at the caller boundary) threaded straight into
 * `nextDelayMs`; the wait itself is a `sleep(ms)` port defaulting to a real
 * `setTimeout`, injectable so a test can drive the backoff schedule
 * deterministically without touching wall-clock timers.
 *
 * Exhaustion is NEVER a silent swallow: at the bound the returned promise
 * rejects with {@link RetryExhaustedError} (carrying the attempt count and the
 * final failure), the retry-side dialect of `await-terminal`'s
 * `TerminalTimeoutError` — a distinct `instanceof`- and `_tag`-checkable
 * rejection.
 *
 * NOT a substrate primitive: it depends on nothing from `../index`, only on the
 * leaf `retry-backoff` utility. Internal to the package
 * (`src/internal/resilience/`, #46), not a published subpath.
 */

import {
  defaultRng,
  initRetry,
  nextDelayMs,
  type RetryPolicy,
  type Rng,
  recordFailure,
  shouldRetry,
} from "../../../retry-backoff";

/**
 * Raised when `retryToSuccess` exhausts the retry bound without a success — the
 * `maxAttempts`-th recorded failure refuses another attempt. Follows the tea
 * error dialect (`override readonly name`) and carries a `_tag` discriminant, so
 * a caller can branch on it by `instanceof` or on the tag. It carries the number
 * of attempts made and the final failure (`lastError`) so the terminal give-up
 * is a distinct, checkable rejection — never a silent resolve, and never a
 * swallowed error.
 */
export class RetryExhaustedError extends Error {
  override readonly name = "RetryExhaustedError";
  readonly _tag = "RetryExhaustedError" as const;
  constructor(
    /** How many times the port was invoked before giving up (= `policy.maxAttempts`). */
    public readonly attempts: number,
    /** The failure the final attempt ended in: the error it threw, or the value `accept` refused — carried, never interpreted. */
    public readonly lastError: unknown,
  ) {
    super(
      `@demlik/tea: retryToSuccess gave up after ${attempts} attempt(s) — the ` +
        `bounded retry reached maxAttempts without a success. See .lastError ` +
        `for the final failure.`,
    );
  }
}

/** Default wait: a real `setTimeout(ms)`, the sole clock read this module makes. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Options for {@link retryToSuccess}. */
export interface RetryToSuccessOptions<R = unknown> {
  /**
   * The `[0, 1)` jitter source threaded into `nextDelayMs`, branded via
   * `asRng` at construction (a raw `() => number` is rejected by the type).
   * Injected for deterministic backoff in tests; defaults to `defaultRng`
   * (`Math.random`), read only at the delay boundary — never inside the loop's
   * decision.
   */
  readonly rng?: Rng;
  /**
   * The wait between attempts, given the backoff delay in ms. Injectable so a
   * test can drive the retry schedule without wall-clock timers (and assert the
   * exact delays); defaults to a real `setTimeout`. The delay value is always
   * `./retry-backoff`'s `nextDelayMs` — this port only realizes the wait.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Whether a thrown failure may be retried. Defaults to `() => true`. When it
   * returns `false` the failure is terminal at once: `retryToSuccess` rejects
   * with the thrown error itself (not a {@link RetryExhaustedError}), and the
   * failure consumes no budget. A `retryable` that throws replaces the failure
   * it was asked about: its throw is what rejects.
   */
  readonly retryable?: (error: unknown) => boolean;
  /**
   * Whether a resolved value is a success. Defaults to `() => true`. A value it
   * refuses counts as a failure on the same ladder as a retryable throw: it
   * consumes budget, backs off, and on exhaustion is the
   * {@link RetryExhaustedError}'s `lastError`. `retryable` never sees it. An
   * `accept` that throws rejects with its own throw, at once.
   */
  readonly accept?: (value: R) => boolean;
}

/**
 * Fire-and-await bounded retry: invoke the fallible `port`, and on each failure
 * (a throw, or a value `accept` refuses) fold it through `./retry-backoff` —
 * record it, and if the policy still permits an attempt, back off `nextDelayMs`
 * and retry; otherwise REJECT with {@link RetryExhaustedError}. Resolves with the port's value on the first
 * success.
 *
 * The port is invoked at most `policy.maxAttempts` times (attempts
 * `0 .. maxAttempts-1`); the `maxAttempts`-th failure is terminal. Every failure
 * is either retried or surfaced on the rejection's `lastError` — none is
 * swallowed. A failure `opts.retryable` refuses is rethrown as it is, at once.
 * A resolved value `opts.accept` refuses is a failure on the same ladder.
 *
 * @param port   the fallible work — throws (or resolves a value `accept`
 *               refuses) on failure, resolves with `R` on success.
 * @param policy the bounded-retry curve (`baseMs` / `factor` / `capMs` /
 *               `maxAttempts` / `jitter`) from `./retry-backoff`.
 * @param opts   optional injected `rng` (jitter) and `sleep` (the wait), and the
 *               `retryable` / `accept` failure classifiers — see
 *               {@link RetryToSuccessOptions}.
 */
export async function retryToSuccess<R>(
  port: () => Promise<R>,
  policy: RetryPolicy,
  opts: RetryToSuccessOptions<R> = {},
): Promise<R> {
  const rng = opts.rng ?? defaultRng;
  const sleep = opts.sleep ?? defaultSleep;
  const retryable = opts.retryable ?? (() => true);
  const accept = opts.accept ?? (() => true);

  // The retry counter folds over `./retry-backoff` exactly as resilient-call's
  // `backoff` verb does — no local attempt bookkeeping, no local backoff math.
  let retry = initRetry();
  const backOff = async (failure: unknown): Promise<void> => {
    retry = recordFailure(retry, failure);
    if (!shouldRetry(retry, policy)) {
      throw new RetryExhaustedError(retry.attempt, failure);
    }
    await sleep(nextDelayMs(retry, policy, rng));
  };
  for (;;) {
    let value: R;
    try {
      value = await port();
    } catch (error) {
      if (!retryable(error)) throw error;
      await backOff(error);
      continue;
    }
    if (accept(value)) return value;
    await backOff(value);
  }
}
