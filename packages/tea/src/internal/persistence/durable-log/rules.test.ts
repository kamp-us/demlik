import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { deepFreeze } from "../../../pure/core";
import type { LogMessage } from "../../../runtime-types";
import { op, optionsFor } from "../durable-wake.fixture";
import { memoryLog } from "./memory-log";
import * as operations from "./operations";
import * as projection from "./projection";

function checkPure<P, O, R>(verb: (p: P, op: O) => R, p: P, op: O): R {
  deepFreeze(p);
  deepFreeze(op);
  const first = verb(p, op);
  expect(verb(p, op)).toEqual(first);
  return first;
}

test("purity, whole projection replay, and cold cache equals incremental cache after every generated action", async () => {
  const decide = operations.decide;
  const fold = projection.fold;
  let decisions = 0;
  let folds = 0;
  const pureDecide: typeof decide = (p, op, policy) => {
    decisions += 1;
    return checkPure((p, input) => decide(p, input.op, input.policy), p, {
      op,
      policy,
    });
  };
  const pureFold: typeof fold = (p, input, boundary) => {
    folds += 1;
    const entries = [...input];
    return checkPure((p, entries) => fold(p, entries, boundary), p, entries);
  };
  const decisionSpy = vi
    .spyOn(operations, "decide")
    .mockImplementation(pureDecide);
  const foldSpy = vi.spyOn(projection, "fold").mockImplementation(pureFold);
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Parameters<typeof optionsFor>[0]>(
          "identity",
          "trim",
          "notIdempotent",
        ),
        fc.constantFrom(1, 2, 100),
        fc.array(op, { minLength: 1, maxLength: 30 }),
        async (decoder, every, actions) => {
          const options = optionsFor(decoder, every);
          const disk = new Map<string, string>();
          let live = memoryLog(disk, options);
          type Msg = Parameters<typeof live.store.appendMessage>[0]["msg"];
          let last: LogMessage<Msg> | undefined;
          let n = 0;
          await live.store.commitStep({
            _tag: "birth",
            at: 0,
            state: { value: null, count: 0 },
            cmds: [],
            timers: [],
          });
          const verify = () => {
            const current = live.inspect();
            const cold = memoryLog(new Map(disk), options).inspect();
            expect(current.projection).toEqual(cold.projection);
            expect(current.readModel).toEqual(cold.readModel);
          };
          verify();
          type Action = (typeof actions)[number];
          const admitted = async (
            action: Extract<Action, { op: "set" | "ignored" | "rejected" }>,
          ) => {
            const msg: Msg =
              action.op === "rejected"
                ? { _tag: "boom" }
                : {
                    _tag: "set",
                    value: "make" in action ? action.make() : action.value,
                    ...(action.op === "ignored" ? { to: "someone-else" } : {}),
                  };
            last = { _tag: "message", id: String(++n), at: n, msg };
            const appended = await live.store.appendMessage(last);
            if (action.op === "set") {
              const count = (live.inspect().projection.state?.count ?? 0) + 1;
              const value =
                appended.entry.record.msg._tag === "set"
                  ? appended.entry.record.msg.value
                  : undefined;
              const committed = await live.store.commitStep({
                _tag: "applied",
                sourceId: last.id,
                state: { value, count },
                cmds: [{ _tag: "see", n: count, value }],
                timers: [],
              });
              for (const owed of committed.owed)
                await live.store.confirmEffect(owed.id);
            } else
              await live.store.commitStep({
                _tag: "receipt",
                sourceId: last.id,
                disposition: action.op === "ignored" ? "ignored" : "rejected",
              });
          };
          const perform = {
            set: admitted,
            ignored: admitted,
            rejected: admitted,
            repeat: async () => {
              if (last) await live.store.appendMessage(last);
            },
            checkpoint: async () => {
              await live.store.checkpoint();
            },
            wake: async () => {
              live = memoryLog(disk, options);
            },
          } satisfies {
            [K in Action["op"]]: (
              action: Extract<Action, { op: K }>,
            ) => Promise<void>;
          };
          for (const action of actions) {
            await perform[action.op](action as never);
            verify();
          }
        },
      ),
      { seed: 954, numRuns: 200 },
    );
    expect(decisions).toBeGreaterThan(0);
    expect(folds).toBeGreaterThan(0);
  } finally {
    decisionSpy.mockRestore();
    foldSpy.mockRestore();
  }
});

test("mutation control: purity rejects a verb that pushes into its projection", () => {
  const broken = (p: { pending: unknown[] }, operation: unknown) => {
    p.pending.push(operation);
    return [p, []] as const;
  };
  expect(() => checkPure(broken, { pending: [] }, { _tag: "probe" })).toThrow(
    TypeError,
  );
});

const options = {
  state: z.object({ n: z.number() }),
  message: z.object({ _tag: z.literal("go"), n: z.number() }),
  command: z.object({ _tag: z.literal("work"), n: z.number() }),
  snapshotEvery: 1,
};
async function projectionAfter(n: number) {
  const live = memoryLog(new Map(), {
    ...options,
    snapshotEvery: Number.MAX_SAFE_INTEGER,
  });
  await live.store.commitStep({
    _tag: "birth",
    at: 0,
    state: { n: 0 },
    cmds: [],
    timers: [],
  });
  for (let i = 0; i < n; i += 1) {
    const id = String(i);
    await live.store.appendMessage({
      _tag: "message",
      id,
      at: 1,
      msg: { _tag: "go", n: 0 },
    });
    const commit = await live.store.commitStep({
      _tag: "applied",
      sourceId: id,
      state: { n: 0 },
      cmds: [{ _tag: "work", n: 0 }],
      timers: [],
    });
    for (const owed of commit.owed) await live.store.confirmEffect(owed.id);
  }
  return live.inspect().projection;
}

test("the projection is bounded by unfinished work", async () => {
  const small = JSON.stringify(await projectionAfter(16)).length;
  const large = JSON.stringify(await projectionAfter(16_000)).length;
  expect(large).toBeLessThan(small + 64);
});

const key = "@@es/default/log";
const frame = (seq: number, record: unknown, snapshot: unknown = null) =>
  JSON.stringify({ protocol: 2, seq, record, snapshot });
const birth = {
  _tag: "birth",
  at: 0,
  state: { n: 0 },
  owed: [],
  timers: [],
} as const;
const message = (id: string) =>
  ({ _tag: "message", id, at: 1, msg: { _tag: "go", n: 0 } }) as const;

test("consumed duplicate storage IDs are refused without overwriting, and a failed partial rebuild is discarded", async () => {
  const disk = new Map([
    [key, frame(1, birth)],
    [`${key}/2`, frame(2, message("a"))],
    [
      `${key}/3`,
      frame(3, { _tag: "receipt", sourceId: "a", disposition: "ignored" }),
    ],
    [`${key}/4`, frame(4, message("a"))],
  ]);
  const before = new Map(disk);
  const live = memoryLog(disk, options);
  await expect(live.store.readLog()).rejects.toThrow("Duplicate log source");
  expect(disk).toEqual(before);
  disk.set(`${key}/4`, frame(4, message("b")));
  expect(live.inspect()).toEqual(memoryLog(new Map(disk), options).inspect());
});

test("receipt commitment at applied count zero is a valid checkpoint boundary", async () => {
  const disk = new Map([
    [key, frame(1, birth)],
    [`${key}/2`, frame(2, message("a"))],
    [
      `${key}/3`,
      frame(3, { _tag: "receipt", sourceId: "a", disposition: "ignored" }),
    ],
    [
      `${key}/checkpoint`,
      JSON.stringify({
        protocol: 2,
        snapshot: { through: 2, state: { n: 0 } },
      }),
    ],
  ]);
  expect((await memoryLog(disk, options).store.readLog()).snapshot).toEqual({
    through: 2,
    state: { n: 0 },
  });
});

test("stored original commitments win across requested dispositions at the current version", async () => {
  const { store } = memoryLog(new Map(), options);
  await store.commitStep({
    _tag: "birth",
    at: 0,
    state: { n: 0 },
    cmds: [],
    timers: [],
  });
  await store.appendMessage(message("a"));
  await store.commitStep({
    _tag: "receipt",
    sourceId: "a",
    disposition: "ignored",
  });
  await store.appendMessage(message("b"));
  const applied = await store.commitStep({
    _tag: "applied",
    sourceId: "b",
    state: { n: 2 },
    cmds: [{ _tag: "work", n: 0 }],
    timers: [],
  });
  expect(
    await store.commitStep({
      _tag: "applied",
      sourceId: "a",
      state: { n: 99 },
      cmds: [],
      timers: [],
    }),
  ).toEqual({ version: applied.version, state: { n: 2 }, owed: [] });
  expect(
    await store.commitStep({
      _tag: "receipt",
      sourceId: "b",
      disposition: "rejected",
    }),
  ).toEqual(applied);
});

test("delivery gaps preserve high-water allocation and invalid stored confirmations refuse", async () => {
  const owed = [3, 8].map((id) => ({
    _tag: "effect_owed",
    id,
    effect: { _tag: "work", n: 0 },
  }));
  const { store } = memoryLog(
    new Map([[key, frame(1, { ...birth, owed })]]),
    options,
  );
  expect(await store.confirmEffect(5)).toEqual({
    version: 1,
    confirmed: false,
  });
  await store.appendMessage(message("a"));
  const next = await store.commitStep({
    _tag: "applied",
    sourceId: "a",
    state: { n: 0 },
    cmds: [{ _tag: "work", n: 0 }],
    timers: [],
  });
  expect(next.owed[0]?.id).toBe(9);
  const invalid = new Map([
    [key, frame(1, { ...birth, owed })],
    [
      `${key}/2`,
      frame(2, {
        _tag: "confirmed",
        event: { _tag: "effect_confirmed", id: 5 },
      }),
    ],
  ]);
  await expect(memoryLog(invalid, options).store.readLog()).rejects.toThrow(
    "Invalid delivery receipt",
  );
});
