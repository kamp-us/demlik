export const POLICY_SEED = 0x7011c1e5;

export function policyCases(seed = POLICY_SEED) {
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const pick = (values) => values[Math.floor(random() * values.length)];
  const nan = { $number: "NaN" };
  const infinity = { $number: "Infinity" };
  const negativeInfinity = { $number: "-Infinity" };
  const negativeZero = { $number: "-0" };
  const times = [
    -10,
    -1,
    0,
    1,
    9,
    10,
    11,
    20,
    30,
    31,
    1000,
    nan,
    infinity,
    negativeInfinity,
    negativeZero,
  ];
  const bounds = [
    -1,
    0,
    0.5,
    1,
    2,
    5,
    10,
    nan,
    infinity,
    negativeInfinity,
    negativeZero,
  ];
  const keys = [
    "a",
    "b",
    "hot",
    "cold",
    "",
    "0",
    "10",
    "unicode😀",
    "__proto__",
    "toString",
    "constructor",
    "value",
    "atMs",
    "expiresAtMs",
    "hasOwnProperty",
  ];
  const values = [
    null,
    { _tag: "timeout", afterMs: 5 },
    { answer: 42 },
    false,
    "",
    0,
    ["nested"],
  ];
  values.push(
    { value: "nested", expiresAtMs: "0xA", atMs: [10] },
    { value: null, expiresAtMs: null, atMs: "\ufeff0b1010" },
    {
      value: { nested: 1 },
      expiresAtMs: { toString: "not callable" },
      atMs: [],
    },
    JSON.parse('{"__proto__":{"payload":"own data"}}'),
  );
  const cases = [];
  for (let index = 0; index < 100; index++) {
    const coerced = pick([
      "",
      " -0 ",
      "1.e2",
      "\u0085",
      "\ufeff0b1010",
      "0x20000000000001",
      "0x20000000000003",
      `0x${"f".repeat(256)}`,
      "0o77777777777777777777",
      "+0x10",
      "Infinity",
      "-Infinity",
      "inf",
      true,
      false,
      null,
      [],
      [null],
      [1],
      ["2"],
      [[1]],
      [1, 2],
      {},
      { valueOf: 10 },
      { toString: "not callable" },
    ]);
    const coercedOperation = index % 2 === 0 ? "cache" : "idempotency";
    cases.push({
      id: `generated.policies.coercion.${seed}.${index}`,
      operation: `tea.policies.${coercedOperation}`,
      input: {
        ...(coercedOperation === "idempotency"
          ? { options: { ttlMs: pick(times) } }
          : {}),
        steps: [
          coercedOperation === "cache"
            ? {
                event: "set",
                key: "__proto__",
                value: { value: "projected", expiresAtMs: coerced },
                nowMs: 0,
                ttlMs: 100,
              }
            : {
                event: "remember",
                key: "__proto__",
                value: { value: "projected", atMs: coerced },
                nowMs: 0,
              },
          ...Array.from({ length: 10 }, () => ({
            event: "read",
            key: "value",
            nowMs: pick(times),
          })),
        ],
      },
    });
    cases.push({
      id: `generated.policies.circuit.${seed}.${index}`,
      operation: "tea.policies.circuit",
      input: {
        ...(index % 3 === 0
          ? {
              initial: pick([
                { phase: "closed", failures: pick(bounds) },
                { phase: "open", openedAtMs: pick(times) },
                { phase: "half_open", probes: pick(bounds) },
              ]),
            }
          : {}),
        policy: {
          failureThreshold: pick(bounds),
          cooldownMs: pick(times),
          halfOpenMaxProbes: pick(bounds),
        },
        steps: Array.from({ length: 30 }, () => {
          const event = pick(["pass", "failure", "success"]);
          return event === "success"
            ? { event }
            : { event, nowMs: pick(times) };
        }),
      },
    });
    cases.push({
      id: `generated.policies.bucket.${seed}.${index}`,
      operation: "tea.policies.bucket",
      input: {
        ...(index % 2 === 0
          ? {
              initial: {
                tokens: pick(bounds),
                capacity: pick(bounds),
                refillPerSec: pick(bounds),
                lastRefillMs: pick(times),
              },
            }
          : {}),
        capacity: pick(bounds),
        refillPerSec: pick(bounds),
        nowMs: pick(times),
        steps: Array.from({ length: 35 }, () =>
          pick([
            { event: "refill", nowMs: pick(times) },
            { event: "consume", nowMs: pick(times), n: pick(bounds) },
            { event: "consume", nowMs: pick(times) },
          ]),
        ),
      },
    });
    cases.push({
      id: `generated.policies.window.${seed}.${index}`,
      operation: "tea.policies.window",
      input: {
        ...(index % 2 === 0
          ? {
              initial: {
                hits: Array.from({ length: 5 }, () => pick(times)),
                windowMs: pick(times),
                limit: pick(bounds),
              },
            }
          : {}),
        windowMs: pick(times),
        limit: pick(bounds),
        steps: Array.from({ length: 30 }, () => ({
          event: pick(["record", "remaining"]),
          nowMs: pick(times),
        })),
      },
    });
    cases.push({
      id: `generated.policies.cache.${seed}.${index}`,
      operation: "tea.policies.cache",
      input: {
        ...(index % 4 === 0
          ? {
              initial: {
                entries: {
                  a: { value: pick(values), expiresAtMs: pick(times) },
                },
              },
            }
          : {}),
        steps: Array.from({ length: 35 }, () =>
          pick([
            {
              event: "set",
              key: pick(keys),
              value: pick(values),
              nowMs: pick(times),
              ttlMs: pick(times),
            },
            { event: "remove", key: pick(keys) },
            { event: "evict", nowMs: pick(times) },
            { event: "read", key: pick(keys), nowMs: pick(times) },
          ]),
        ),
      },
    });
    cases.push({
      id: `generated.policies.idempotency.${seed}.${index}`,
      operation: "tea.policies.idempotency",
      input: {
        ...(index % 4 === 0
          ? {
              initial: {
                entries: {
                  a: { value: pick(values), atMs: pick(times) },
                  b: { value: null, atMs: 0 },
                },
                order: ["missing", "a"],
                capacity: pick(bounds),
                ttlMs: pick(times),
              },
            }
          : {}),
        options: {
          ...(index % 2 ? { capacity: pick(bounds) } : {}),
          ...(index % 3 ? { ttlMs: pick(times) } : {}),
        },
        steps: Array.from({ length: 35 }, () =>
          pick([
            {
              event: "remember",
              key: pick(keys),
              value: pick(values),
              nowMs: pick(times),
            },
            { event: "evict", nowMs: pick(times) },
            { event: "read", key: pick(keys), nowMs: pick(times) },
          ]),
        ),
      },
    });
  }
  return cases;
}
