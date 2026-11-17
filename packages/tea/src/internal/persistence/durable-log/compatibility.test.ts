import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  createStorage,
  durableStore,
  storageBytes,
} from "../durable-store.fixture";

const state = z.object({ n: z.number() });
const message = z.object({ _tag: z.literal("go"), n: z.number() });
const command = z.object({ _tag: z.literal("work"), n: z.number() });
const work = { state, cmds: z.array(command), timers: z.array(z.never()) };
const fixture = z
  .object({
    head: z.string().regex(/^[0-9a-f]{40}$/),
    operations: z.array(
      z.discriminatedUnion("op", [
        z.object({
          op: z.literal("commit"),
          step: z.discriminatedUnion("_tag", [
            z.object({ _tag: z.literal("birth"), at: z.number(), ...work }),
            z.object({
              _tag: z.literal("applied"),
              sourceId: z.string(),
              ...work,
            }),
            z.object({
              _tag: z.literal("receipt"),
              sourceId: z.string(),
              disposition: z.enum(["ignored", "rejected"]),
              failure: z
                .object({
                  kind: z.enum(["reduce", "no_cell"]),
                  message: z.string(),
                })
                .optional(),
            }),
          ]),
        }),
        z.object({
          op: z.literal("append"),
          message: z.object({
            _tag: z.literal("message"),
            id: z.string(),
            at: z.number(),
            msg: message,
          }),
        }),
        z.object({ op: z.literal("confirm"), id: z.number() }),
        z.object({ op: z.literal("checkpoint") }),
      ]),
    ),
    entries: z.array(z.tuple([z.string(), z.string()])),
    read: z.unknown(),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("./bytes-origin-main.json", import.meta.url),
        "utf8",
      ),
    ),
  );

const options = { state, message, command, snapshotEvery: 3 };

async function replay() {
  const disk = createStorage();
  const store = durableStore(disk, options);
  type Operation = (typeof fixture.operations)[number];
  const calls = {
    commit: (op) => store.commitStep(op.step),
    append: (op) => store.appendMessage(op.message),
    confirm: (op) => store.confirmEffect(op.id),
    checkpoint: () => store.checkpoint(),
  } satisfies {
    [K in Operation["op"]]: (
      op: Extract<Operation, { op: K }>,
    ) => Promise<unknown>;
  };
  for (const op of fixture.operations) await calls[op.op](op as never);
  return disk;
}

test("bytes written by origin/main are read back as origin/main read them", async () => {
  expect(
    await durableStore(createStorage(fixture.entries), options).readLog(),
  ).toEqual(fixture.read);
});

test("the same operations write exactly the bytes origin/main wrote", async () => {
  const disk = storageBytes(await replay());
  expect([...disk]).toEqual(fixture.entries);
});

test("an uncloneable decoded response refuses before writing", async () => {
  const storage = createStorage();
  const store = durableStore(storage, {
    ...options,
    state: {
      safeParse: (_raw: unknown) => ({
        success: true as const,
        data: (): number => 0,
      }),
    },
  });
  await expect(
    store.commitStep({
      _tag: "birth",
      at: 0,
      state: () => 1,
      cmds: [],
      timers: [],
    }),
  ).rejects.toMatchObject({ name: "DataCloneError" });
  const disk = storageBytes(storage);
  expect(disk.size).toBe(0);
});
