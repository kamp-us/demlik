import {
  asRng,
  backoffDelay,
  type DurationRetryPolicy,
  initRetry,
  recordFailure,
  shouldRetry,
} from "../../packages/tea/src/retry-backoff/index.ts";

const policy: DurationRetryPolicy = {
  baseMs: 100,
  factor: 2,
  capMs: 1000,
  jitter: "full",
  maxElapsedMs: 5000,
};
const retry = initRetry();
backoffDelay(
  0,
  policy,
  asRng(() => 0.5),
);
shouldRetry(recordFailure(retry, "offline", 100), policy, 101);

// @ts-expect-error A random source must enter through its branded boundary.
backoffDelay(0, policy, () => 0.5);
// @ts-expect-error A duration budget requires the observation clock.
shouldRetry(recordFailure(retry, "offline", 100), policy);
// @ts-expect-error A duration budget requires a failure-streak origin.
shouldRetry(retry, policy, 101);
