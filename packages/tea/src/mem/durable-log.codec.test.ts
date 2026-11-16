import { isDeepStrictEqual } from "node:util";
import fc from "fast-check";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { memoryEventSourcedStore } from "./index";

const options = {
  state: z.unknown(),
  message: z.object({ _tag: z.literal("go") }),
  command: z.object({
    _tag: z.literal("upload"),
    value: z.unknown().optional(),
  }),
};
const birth = {
  _tag: "birth",
  at: 0,
  state: { value: null },
  cmds: [],
  timers: [],
} as const;
const cases = [
  ["birth", "State"],
  ["birth", "Cmd"],
  ["step", "State"],
  ["step", "Cmd"],
] as const;

async function prepare(phase: "birth" | "step") {
  const disk = new Map<string, string>();
  const store = memoryEventSourcedStore(disk, options);
  if (phase === "step") {
    await store.commitStep(birth);
    await store.appendMessage({
      _tag: "message",
      id: "go",
      at: 1,
      msg: { _tag: "go" },
    });
  }
  return {
    disk,
    store,
    commit(state: unknown, value: unknown) {
      const payload = {
        state,
        cmds: [{ _tag: "upload" as const, value }],
        timers: [],
      };
      return store.commitStep(
        phase === "birth"
          ? { _tag: "birth", at: 0, ...payload }
          : {
              _tag: "message",
              sourceId: "go",
              disposition: "applied",
              ...payload,
            },
      );
    },
  };
}

test.each(
  cases,
)("%s refuses a %s own undefined key before writing", async (phase, changed) => {
  const { disk, commit } = await prepare(phase);
  const before = new Map(disk);
  const set = vi.spyOn(disk, "set");
  const pending = { pending: undefined };
  await expect(
    commit(
      changed === "State" ? pending : {},
      changed === "Cmd" ? pending : {},
    ),
  ).rejects.toThrow("round trip unchanged");
  expect(set).not.toHaveBeenCalled();
  expect(disk).toStrictEqual(before);
});

test("lossless guard accepts exactly strict codec round trips for nested JSON-like values", async () => {
  const values = fc.anything({
    values: [
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.constant(-0),
    ],
    maxDepth: 3,
    maxKeys: 4,
  });
  await fc.assert(
    fc.asyncProperty(values, async (value) => {
      const state = { value };
      const decoded = JSON.parse(JSON.stringify(state));
      const lossless = isDeepStrictEqual(state, decoded);
      for (const [phase, changed] of cases) {
        const { disk, store, commit } = await prepare(phase);
        const before = new Map(disk);
        const result = commit(
          changed === "State" ? state : {},
          changed === "Cmd" ? value : {},
        );
        if (lossless) {
          await result;
          const last = (await store.readLog()).records.at(-1)?.record;
          expect(last).toMatchObject({
            state: changed === "State" ? decoded : {},
            owed: [
              {
                effect: {
                  _tag: "upload",
                  value: changed === "Cmd" ? decoded.value : {},
                },
              },
            ],
          });
        } else {
          await expect(result).rejects.toThrow("round trip unchanged");
          expect(disk).toStrictEqual(before);
        }
      }
    }),
    {
      numRuns: 1_000,
      examples: [
        [{ pending: undefined }],
        [[{ nested: [1, { pending: undefined }] }]],
        [{ nested: [null, { value: 1 }] }],
      ],
    },
  );
});

test("save refuses an own undefined key instead of affirming different committed State", async () => {
  const { disk, store, commit } = await prepare("birth");
  await commit({}, {});
  const before = new Map(disk);
  await expect(store.save({ pending: undefined })).rejects.toThrow(
    "Logged State can only change through commitStep",
  );
  expect(disk).toStrictEqual(before);
});
