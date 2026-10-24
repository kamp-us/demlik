import { z } from "zod";
import * as idem from "../../packages/tea/src/internal/idempotency/idempotency/index.ts";
import * as cache from "../../packages/tea/src/internal/resilience/cache/index.ts";
import * as circuit from "../../packages/tea/src/internal/resilience/circuit-breaker/index.ts";
import * as rate from "../../packages/tea/src/internal/resilience/rate-limit/index.ts";

export function policyOperations(
  number: z.ZodType<number>,
  encodeNumber: (value: number) => unknown,
): Record<string, (input: unknown) => unknown> {
  function encode(value: unknown): unknown {
    if (typeof value === "number") return encodeNumber(value);
    if (Array.isArray(value)) return value.map(encode);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => [key, encode(value)]),
      );
    return value;
  }
  // Record parsing must preserve an own __proto__ key created by JSON.parse.
  function record<T>(entry: z.ZodType<T>) {
    return z
      .custom<Record<string, unknown>>(
        (value) =>
          value !== null && typeof value === "object" && !Array.isArray(value),
        "Expected a record",
      )
      .transform(Object.entries)
      .pipe(z.array(z.tuple([z.string(), entry])))
      .transform((entries) => Object.fromEntries(entries));
  }
  const jsonSchema = z.json();
  const jsonData = z.custom<z.infer<typeof jsonSchema>>(
    (value) => jsonSchema.safeParse(value).success,
    "Expected JSON data",
  );
  const circuitState = z.discriminatedUnion("phase", [
    z.object({ phase: z.literal("closed"), failures: number }),
    z.object({ phase: z.literal("open"), openedAtMs: number }),
    z.object({ phase: z.literal("half_open"), probes: number }),
  ]);
  const circuitInput = z.object({
    initial: circuitState.optional(),
    policy: z
      .object({
        failureThreshold: number,
        cooldownMs: number,
        halfOpenMaxProbes: number,
      })
      .optional(),
    steps: z.array(
      z.discriminatedUnion("event", [
        z.object({ event: z.literal("success") }),
        z.object({ event: z.literal("failure"), nowMs: number }),
        z.object({ event: z.literal("pass"), nowMs: number }),
      ]),
    ),
  });
  const bucketInput = z.object({
    initial: z
      .object({
        tokens: number,
        capacity: number,
        refillPerSec: number,
        lastRefillMs: number,
      })
      .optional(),
    capacity: number,
    refillPerSec: number,
    nowMs: number,
    steps: z.array(
      z.discriminatedUnion("event", [
        z.object({ event: z.literal("refill"), nowMs: number }),
        z.object({
          event: z.literal("consume"),
          nowMs: number,
          n: number.optional(),
        }),
      ]),
    ),
  });
  const windowInput = z.object({
    initial: z
      .object({ hits: z.array(number), windowMs: number, limit: number })
      .optional(),
    windowMs: number,
    limit: number,
    steps: z.array(
      z.object({ event: z.enum(["record", "remaining"]), nowMs: number }),
    ),
  });
  const cacheInput = z.object({
    initial: z
      .object({
        entries: record(z.object({ value: jsonData, expiresAtMs: number })),
      })
      .optional(),
    steps: z.array(
      z.discriminatedUnion("event", [
        z.object({
          event: z.literal("set"),
          key: z.string(),
          value: jsonData,
          nowMs: number,
          ttlMs: number,
        }),
        z.object({ event: z.literal("remove"), key: z.string() }),
        z.object({ event: z.literal("evict"), nowMs: number }),
        z.object({ event: z.literal("read"), key: z.string(), nowMs: number }),
      ]),
    ),
  });
  const idempotencyInput = z.object({
    options: z
      .object({ capacity: number.optional(), ttlMs: number.optional() })
      .optional(),
    initial: z
      .object({
        entries: record(z.object({ value: jsonData, atMs: number })),
        order: z.array(z.string()),
        capacity: number.optional(),
        ttlMs: number.optional(),
      })
      .optional(),
    steps: z.array(
      z.discriminatedUnion("event", [
        z.object({
          event: z.literal("remember"),
          key: z.string(),
          value: jsonData,
          nowMs: number,
        }),
        z.object({ event: z.literal("evict"), nowMs: number }),
        z.object({
          event: z.enum(["read", "presence"]),
          key: z.string(),
          nowMs: number,
        }),
      ]),
    ),
  });
  return {
    "tea.policies.idempotency": (raw) => {
      const input = idempotencyInput.parse(raw);
      let state: idem.IdempotencyStore<unknown> =
        input.initial ?? idem.initStore(input.options);
      const trace: unknown[] = [{ state }];
      try {
        for (const step of input.steps) {
          switch (step.event) {
            case "remember":
              state = idem.remember(state, step.key, step.value, step.nowMs);
              break;
            case "evict":
              state = idem.evictExpired(state, step.nowMs);
              break;
            case "presence":
              trace.push({
                state,
                present: idem.seen(state, step.key, step.nowMs),
              });
              continue;
            case "read": {
              const value = idem.recall(state, step.key, step.nowMs);
              trace.push({
                state,
                present: idem.seen(state, step.key, step.nowMs),
                found: value !== undefined,
                ...(value === undefined ? {} : { value }),
              });
              continue;
            }
          }
          trace.push({ state });
        }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return encode({
          trace,
          refusal: { name: error.name, message: error.message },
        });
      }
      return encode({ trace });
    },
    "tea.policies.cache": (raw) => {
      const input = cacheInput.parse(raw);
      let state: cache.TtlCache<unknown> = input.initial ?? cache.initCache();
      const trace: unknown[] = [{ state }];
      try {
        for (const step of input.steps) {
          switch (step.event) {
            case "set":
              state = cache.set(
                state,
                step.key,
                step.value,
                step.nowMs,
                step.ttlMs,
              );
              break;
            case "remove":
              state = cache.remove(state, step.key);
              break;
            case "evict":
              state = cache.evictExpired(state, step.nowMs);
              break;
            case "read": {
              const value = cache.get(state, step.key, step.nowMs);
              trace.push({
                state,
                present: cache.has(state, step.key, step.nowMs),
                found: value !== undefined,
                ...(value === undefined ? {} : { value }),
              });
              continue;
            }
          }
          trace.push({ state });
        }
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return encode({
          trace,
          refusal: { name: error.name, message: error.message },
        });
      }
      return encode({ trace });
    },
    "tea.policies.bucket": (raw) => {
      const input = bucketInput.parse(raw);
      let state =
        input.initial ??
        rate.initBucket(input.capacity, input.refillPerSec, input.nowMs);
      const trace: unknown[] = [{ state }];
      for (const step of input.steps) {
        if (step.event === "refill") {
          state = rate.refill(state, step.nowMs);
          trace.push({ state });
        } else {
          const [next, allowed] = rate.tryConsume(state, step.nowMs, step.n);
          state = next;
          trace.push({ state, allowed });
        }
      }
      return encode({ trace });
    },
    "tea.policies.window": (raw) => {
      const input = windowInput.parse(raw);
      let state = input.initial ?? rate.initWindow(input.windowMs, input.limit);
      const trace: unknown[] = [{ state }];
      for (const step of input.steps) {
        if (step.event === "remaining") {
          trace.push({ state, remaining: rate.remaining(state, step.nowMs) });
        } else {
          const [next, allowed] = rate.record(state, step.nowMs);
          state = next;
          trace.push({ state, allowed });
        }
      }
      return encode({ trace });
    },
    "tea.policies.circuit": (raw) => {
      const input = circuitInput.parse(raw);
      const policy = input.policy ?? circuit.defaultCircuitPolicy;
      let state = input.initial ?? circuit.initCircuit();
      const trace: unknown[] = [{ state }];
      for (const step of input.steps) {
        if (step.event === "pass") {
          const [next, allowed] = circuit.canPass(state, policy, step.nowMs);
          state = next;
          trace.push({ state, allowed });
        } else {
          state =
            step.event === "success"
              ? circuit.onSuccess(state, policy)
              : circuit.onFailure(state, policy, step.nowMs);
          trace.push({ state });
        }
      }
      return encode({ trace });
    },
  };
}
