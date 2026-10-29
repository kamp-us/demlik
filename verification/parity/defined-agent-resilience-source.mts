import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  type AgentMessage,
  type DefinedAgentState,
  defineAgent,
  status,
} from "../../packages/tea/src/agent/index.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";
import { DriveFailedError } from "../../packages/tea/src/runtime-types.ts";

type S = DefinedAgentState<never>;
const cases = [
  "unset",
  "count-recover",
  "count-exhaust",
  "duration-recover",
  "duration-exhaust",
  "duration-only-recover",
  "duration-both-exhaust",
  "unbounded-recover",
  "resume-count",
  "resume-duration",
  "watchdog-stall",
  "watchdog-progress",
];
async function execute(id: string, seed?: S) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: seed ? 55 : 50 });
  let calls = 0,
    done = false;
  const prompts: unknown[] = [],
    events: unknown[] = [],
    saves: S[] = [],
    saveWires: string[] = [];
  const error = Object.assign(new Error("Provider unavailable"), {
    code: "provider_busy",
    status: 429,
    nested: {
      requestId: "request-17",
      retry: { afterMs: 5, attempts: [1, 2] },
    },
  });
  function cause(value: unknown) {
    assert(value && typeof value === "object" && "error" in value);
    return value.error;
  }
  const prior = new Set(
    Object.values(seed?.resilience.retry ?? {}).map((progress) =>
      cause(progress.lastError),
    ),
  );
  const memory = memoryStore<S>(seed);
  const retry = id.includes("count")
    ? {
        baseMs: 5,
        factor: 2,
        capMs: 20,
        jitter: "none" as const,
        maxAttempts: 3,
      }
    : id.includes("duration")
      ? {
          baseMs: 5,
          factor: 2,
          capMs: 20,
          jitter: "none" as const,
          maxElapsedMs: id === "duration-exhaust" ? 4 : 30,
          ...(id.includes("only")
            ? {}
            : { maxAttempts: id.includes("both") ? 2 : 4 }),
        }
      : id.startsWith("unbounded")
        ? {
            baseMs: 5,
            factor: 2,
            capMs: 20,
            jitter: "none" as const,
            unbounded: true as const,
          }
        : undefined;
  const model = async (messages: readonly AgentMessage[]) => {
    prompts.push(messages);
    calls++;
    if (id.startsWith("watchdog")) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, id.endsWith("stall") ? 25 : 6),
      );
      return {
        content: `round-${calls}`,
        toolCalls:
          id.endsWith("progress") && calls < 3
            ? [{ callId: `c${calls}`, name: "missing", args: {} }]
            : [],
        provider: { opaque: 17 },
      };
    }
    if (id.includes("exhaust") || (seed ? calls <= 1 : calls <= 2)) throw error;
    return { content: "Recovered.", toolCalls: [], provider: { opaque: 17 } };
  };
  const common = {
    model,
    tools: [],
    instructions: "Recover or report a stall.",
    ...(id.startsWith("watchdog") ? { deadlineMs: 10 } : {}),
  };
  const agent =
    retry && ("maxElapsedMs" in retry || "unbounded" in retry)
      ? // @ts-expect-error The frozen lid declares count-only retry; other budgets are untyped runtime cases.
        defineAgent<never>({ ...common, retry })
      : defineAgent<never>({ ...common, ...(retry ? { retry } : {}) });
  let final: S | undefined,
    outcome = "resolved";
  const drive = agent
    .run("Complete the request.", {
      runId: "resilience-run",
      clock: () => Date.now(),
      store: {
        ...memory,
        async save(s) {
          saves.push(s);
          saveWires.push(JSON.stringify(s));
          await memory.save(s);
        },
      },
      onEvent: (e) => events.push(e),
    })
    .then(
      (s) => {
        final = s;
      },
      (error) => {
        assert(error instanceof DriveFailedError);
        final = error.state;
        outcome = "failed";
      },
    )
    .finally(() => {
      done = true;
    });
  for (let ticks = 0; !done && ticks < 200; ticks++) {
    await setImmediate();
    if (!done) mock.timers.tick(1);
  }
  await drive;
  assert(final);
  assert(saves.includes(final), "drive returns a canonical saved checkpoint");
  for (const saved of saves)
    for (const progress of Object.values(saved.resilience.retry)) {
      const original = cause(progress.lastError);
      assert(
        original === error || prior.has(original),
        "durable retry retains its original provider Error owner",
      );
    }
  const phase = {
    prompts,
    events,
    saves: saveWires.map((w) => JSON.parse(w)),
    saveWires,
    final,
    finalWire: JSON.stringify(final),
    calls,
    outcome,
    settledAt: Date.now(),
  };
  if (id === "unset") assert.equal(calls, 1);
  if (id.includes("recover") || id.startsWith("resume"))
    assert.equal(status(final).kind, "done");
  if (id === "watchdog-stall") {
    assert.equal(final.run.phase, "failed");
    assert(final.run.phase === "failed");
    assert.equal(final.run.failure.reason, "deadline");
    assert.equal(final.failure, null);
    assert.equal(phase.settledAt, 75);
  }
  if (id === "watchdog-progress") {
    assert.equal(calls, 3);
    assert.equal(status(final).kind, "done");
  }
  mock.timers.reset();
  return { phase, saves };
}
for (const id of cases) {
  let seed: S | undefined;
  if (id.startsWith("resume")) {
    const first = await execute(
      id.includes("count") ? "count-recover" : "duration-recover",
    );
    seed = first.saves.find((s) =>
      Object.values(s.resilience.calls).some(
        (c) => c.phase === "waiting_retry",
      ),
    );
    assert(seed, "retained retry wait checkpoint");
  }
  const { phase } = await execute(id, seed);
  console.log(JSON.stringify({ id, phase }));
}
