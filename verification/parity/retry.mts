import { z } from "zod";
import {
  asRng,
  initRetry,
  recordFailure,
  retryElapsedMs,
  shouldRetry,
} from "../../packages/tea/src/retry-backoff/index.ts";

export const retryStateInput = z.object({
  initial: z
    .object({
      attempt: z.number(),
      lastError: z.unknown().optional(),
      firstFailureAtMs: z.number().optional(),
    })
    .optional(),
  failures: z.array(
    z.object({ error: z.unknown(), atMs: z.number().optional() }),
  ),
  budget: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("count"), maxAttempts: z.number() }),
    z.object({
      kind: z.literal("duration"),
      maxElapsedMs: z.number(),
      maxAttempts: z.number().optional(),
    }),
    z.object({ kind: z.literal("unbounded") }),
  ]),
  nowMs: z.number().optional(),
});

export function executeRetryState(input: z.infer<typeof retryStateInput>) {
  let state: {
    attempt: number;
    lastError?: unknown;
    firstFailureAtMs?: number;
  } = input.initial ?? initRetry();
  const states = [state];
  for (const failure of input.failures) {
    state =
      failure.atMs === undefined
        ? recordFailure(state, failure.error)
        : recordFailure(state, failure.error, failure.atMs);
    states.push(state);
  }
  const budget =
    input.budget.kind === "unbounded" ? { unbounded: true } : input.budget;
  const policy = {
    baseMs: 100,
    factor: 2,
    capMs: 30_000,
    jitter: "full",
    ...budget,
  };
  // Exercise the JS boundary's missing-clock/origin refusal as well as typed use.
  const allowed: unknown = Reflect.apply(shouldRetry, undefined, [
    state,
    policy,
    input.nowMs,
  ]);
  return {
    states,
    allowed,
    ...(state.firstFailureAtMs !== undefined && input.nowMs !== undefined
      ? {
          elapsedMs: retryElapsedMs(
            { ...state, firstFailureAtMs: state.firstFailureAtMs },
            input.nowMs,
          ),
        }
      : {}),
  };
}

export const probeInput = z
  .object({
    probe: z.boolean(),
    samples: z.array(z.number()).min(1),
    sampleCount: z.number().int().nonnegative().default(0),
  })
  .refine(
    (input) => input.samples.length >= input.sampleCount + Number(input.probe),
    "recorded random draws exhausted",
  );
export function executeProbe(input: z.infer<typeof probeInput>) {
  let draws = 0;
  try {
    const rng = asRng(() => input.samples[draws++], input.probe);
    const values = Array.from({ length: input.sampleCount }, () => rng());
    return {
      draws,
      accepted: true,
      ...(input.sampleCount > 0 ? { values } : {}),
    };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return {
      draws,
      accepted: false,
      error: { name: error.name, message: error.message },
    };
  }
}
