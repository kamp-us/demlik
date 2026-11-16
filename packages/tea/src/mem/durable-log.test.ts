import { expect, test, vi } from "vitest";
import { z } from "zod";
import {
  defineMachine,
  deliveryIdOf,
  type LogStep,
  logUpdates,
} from "../index";
import {
  type Msg,
  machine,
  options,
  type State,
  type Upload,
} from "../internal/persistence/durable-host.fixture";
import { run } from "../promise";
import { memoryEventSourcedStore } from "./index";

const input = (id: string) =>
  ({
    _tag: "message",
    id: JSON.stringify(["caller", id]),
    at: 1,
    msg: { _tag: "picked", file: id },
  }) as const;
const birth = {
  _tag: "birth",
  at: 0,
  state: { files: [], uploaded: [] },
  cmds: [],
  timers: [],
} satisfies LogStep<State, Msg, Upload>;

test("one atomic Map write stores State, all deliveries and the source receipt; retries return original deliveries", async () => {
  const disk = new Map<string, string>();
  const store = memoryEventSourcedStore(disk, options);
  await store.commitStep(birth);
  const source = await store.appendMessage(input("one"));
  const before = await store.readLog();
  expect(before.records.map(({ record }) => record._tag)).toEqual([
    "birth",
    "message",
  ]);
  const cmds = [
    { _tag: "upload", file: "one" },
    { _tag: "upload", file: "two" },
  ] as const;
  const step = {
    _tag: "message",
    sourceId: source.entry.record.id,
    state: { files: ["one"], uploaded: [] },
    cmds,
    timers: [],
    disposition: "applied",
  } satisfies LogStep<State, Msg, Upload>;
  let writes = 0;
  const set = disk.set.bind(disk);
  disk.set = (key, value) => {
    writes += 1;
    return set(key, value);
  };
  const committed = await store.commitStep(step);
  expect(writes).toBe(1);
  expect(committed.owed).toEqual(
    cmds.map((effect, index) => ({ id: index + 1, effect })),
  );
  expect(await store.load()).toEqual(step.state);
  const after = await store.readLog();
  expect(after.records.at(-1)?.record).toMatchObject({
    _tag: "step",
    sourceId: step.sourceId,
    state: step.state,
    owed: [{ id: 1 }, { id: 2 }],
  });
  expect(await store.commitStep({ ...step, cmds: [] })).toEqual(committed);
  expect(writes).toBe(1);
  await store.confirmEffect(2);
  await store.confirmEffect(1);
  expect((await store.confirmEffect(2)).confirmed).toBe(false);
  const second = await store.appendMessage(input("two"));
  expect(
    (
      await store.commitStep({
        ...step,
        sourceId: second.entry.record.id,
        cmds: [cmds[0]],
      })
    ).owed[0]?.id,
  ).toBe(3);
  await expect(
    store.save({ files: ["replacement"], uploaded: [] }),
  ).rejects.toThrow();
  await expect(store.save(step.state)).resolves.toBeUndefined();
});

test("manual and automatic checkpoints share an applied-message baseline and retain queries and receipts", async () => {
  const disk = new Map<string, string>();
  const store = memoryEventSourcedStore(disk, { ...options, snapshotEvery: 3 });
  await store.commitStep(birth);
  expect(await store.checkpoint()).toBe(false);
  const consume = async (
    id: string,
    disposition: "applied" | "ignored" | "rejected",
  ) => {
    const row = await store.appendMessage(input(id));
    return store.commitStep({
      _tag: "message",
      sourceId: row.entry.record.id,
      state: birth.state,
      cmds: [],
      timers: [],
      disposition,
    });
  };
  await consume("one", "applied");
  const version = (await store.readLog()).version;
  expect(await store.checkpoint()).toBe(true);
  expect((await store.readLog()).version).toBe(version);
  expect(await store.checkpoint()).toBe(false);
  await consume("ignored", "ignored");
  await consume("rejected", "rejected");
  expect(await store.checkpoint()).toBe(false);
  const baseline = (await store.readLog()).snapshot;
  await consume("two", "applied");
  await consume("three", "applied");
  expect((await store.readLog()).snapshot).toEqual(baseline);
  await consume("four", "applied");
  const log = await store.readLog();
  expect(log.snapshot?.through).toBeGreaterThan(baseline?.through ?? 0);
  expect(await store.checkpoint()).toBe(false);
  expect(logUpdates(log).map((row) => [row.seq, row.event.file])).toEqual([
    [1, "one"],
    [2, "two"],
    [3, "three"],
    [4, "four"],
  ]);
  expect(
    logUpdates(log, { fromSeq: 2, toSeq: 3 }).map((row) => row.seq),
  ).toEqual([2, 3]);
  expect(logUpdates(log, { fromSeq: 3, toSeq: 2 })).toEqual([]);
  expect(logUpdates(log, { fromSeq: 9 })).toEqual([]);
  expect((await store.appendMessage(input("one"))).appended).toBe(false);
  const before = new Map(disk);
  logUpdates(await store.readLog());
  expect(disk).toEqual(before);
});

test("two keyed drivers share a Map while isolating history, dedup, revisions, checkpoints and delivery high-water", async () => {
  const disk = new Map<string, string>();
  const left = memoryEventSourcedStore(disk, { ...options, key: "a/b" });
  const right = memoryEventSourcedStore(disk, { ...options, key: "a%2Fb" });
  await left.commitStep(birth);
  await right.commitStep(birth);
  const rightBefore = await right.readLog();
  const source = await left.appendMessage(input("same"));
  await left.commitStep({
    _tag: "message",
    sourceId: source.entry.record.id,
    state: { files: ["left"], uploaded: [] },
    cmds: [{ _tag: "upload", file: "left" }],
    timers: [],
    disposition: "applied",
  });
  await left.checkpoint();
  expect(await right.readLog()).toEqual(rightBefore);
  expect((await right.appendMessage(input("same"))).appended).toBe(true);
  expect(
    await memoryEventSourcedStore(new Map(disk), {
      ...options,
      key: "a/b",
    }).load(),
  ).toEqual({ files: ["left"], uploaded: [] });
  expect(new Set([...disk.keys()].map((key) => key.split("/")[1])).size).toBe(
    2,
  );
});

test("schema transformations supply canonical admitted messages to the reducer", async () => {
  const disk = new Map<string, string>();
  const transformed = {
    ...options,
    message: z.discriminatedUnion("_tag", [
      z.object({ _tag: z.literal("picked"), file: z.string().trim() }),
      z.object({ _tag: z.literal("uploaded"), file: z.string() }),
    ]),
  };
  const live = await run(machine(), {
    store: memoryEventSourcedStore(disk, transformed),
    interpret: { upload: async () => {} },
  }).ready;
  await live.dispatch({ _tag: "picked", file: " a.png " });
  expect(live.getState().files).toEqual(["a.png"]);
  await live.stop();
});

test("invalid derived checkpoint State falls back to committed records; malformed protocol refuses without mutation", async () => {
  const disk = new Map<string, string>();
  const store = memoryEventSourcedStore(disk, { ...options, snapshotEvery: 1 });
  const live = await run(machine(), {
    store,
    interpret: { upload: async () => {} },
  }).ready;
  await live.dispatch({ _tag: "picked", file: "one" });
  await live.stop();
  const key = [...disk.keys()].find(
    (key) => JSON.parse(disk.get(key) ?? "null")?.snapshot !== null,
  );
  if (!key) throw new Error("Missing serialized log");
  const valid = disk.get(key);
  if (!valid) throw new Error("Missing log bytes");
  const raw = JSON.parse(valid);
  raw.snapshot.state = { retired: true };
  disk.set(key, JSON.stringify(raw));
  expect(await memoryEventSourcedStore(disk, options).load()).toEqual({
    files: ["one"],
    uploaded: [],
  });
  for (const bytes of [
    "{",
    JSON.stringify({ ...raw, protocol: 0 }),
    JSON.stringify({ ...raw, seq: -1 }),
    JSON.stringify({
      ...raw,
      record: { _tag: "unknown" },
    }),
  ]) {
    disk.set(key, bytes);
    const before = new Map(disk);
    const invalid = memoryEventSourcedStore(disk, options);
    await expect(invalid.readLog()).rejects.toThrow();
    await expect(invalid.commitStep(birth)).rejects.toThrow();
    expect(disk).toEqual(before);
  }
});

test.each([
  ["birth", "state"],
  ["birth", "command"],
  ["step", "state"],
  ["step", "command"],
] as const)("refuses schema-normalized %s %s before writing", async (phase, changed) => {
  const disk = new Map<string, string>();
  const store = memoryEventSourcedStore(disk, {
    state: z.object({ value: z.string().trim() }),
    message: z.object({ _tag: z.literal("go") }),
    command: z.object({ _tag: z.literal("upload"), value: z.string().trim() }),
  });
  if (phase === "step") {
    await store.commitStep({
      _tag: "birth",
      at: 0,
      state: { value: "hello" },
      cmds: [],
      timers: [],
    });
    await store.appendMessage({
      _tag: "message",
      id: "go",
      at: 1,
      msg: { _tag: "go" },
    });
  }
  const before = new Map(disk);
  const payload = {
    state: { value: changed === "state" ? " hello " : "hello" },
    cmds: [
      {
        _tag: "upload" as const,
        value: changed === "command" ? " hello " : "hello",
      },
    ],
    timers: [],
  };
  const result =
    phase === "birth"
      ? store.commitStep({ _tag: "birth", at: 0, ...payload })
      : store.commitStep({
          _tag: "message",
          sourceId: "go",
          disposition: "applied",
          ...payload,
        });
  await expect(result).rejects.toThrow("round trip unchanged");
  expect(disk).toEqual(before);
});

test("valid delivered payload is identical live and after wake for the same delivery ID", async () => {
  const disk = new Map<string, string>();
  const typed = {
    state: z.object({ value: z.string().trim() }),
    message: z.object({ _tag: z.literal("go") }),
    command: z.object({ _tag: z.literal("upload"), value: z.string().trim() }),
  };
  const program = defineMachine({
    types: {
      model: {} as { value: string },
      msg: {} as { _tag: "go" },
      cmd: {} as { _tag: "upload"; value: string },
    },
    init: (): readonly [
      { value: string },
      readonly { _tag: "upload"; value: string }[],
    ] => [{ value: "hello" }, [{ _tag: "upload", value: "hello" }]],
    update: { go: (s) => [s, []] },
  });
  const handouts: unknown[] = [];
  const interrupted = new Error("drop");
  for (let activation = 0; activation < 2; activation += 1) {
    const store = memoryEventSourcedStore(
      activation === 0 ? disk : new Map(disk),
      typed,
    );
    await expect(
      run(program, {
        store,
        onError: () => {},
        interpret: {
          upload: async (cmd, ctx) => {
            handouts.push({ id: deliveryIdOf(ctx), cmd });
            throw interrupted;
          },
        },
      }).ready,
    ).rejects.toBe(interrupted);
  }
  expect(handouts).toEqual([
    { id: 1, cmd: { _tag: "upload", value: "hello" } },
    { id: 1, cmd: { _tag: "upload", value: "hello" } },
  ]);
});

test("appending a fixed-size record validates and writes only that record, independent of retained history", async () => {
  const disk = new Map<string, string>();
  const validate = vi.fn((raw: unknown) => options.message.safeParse(raw));
  const store = memoryEventSourcedStore(disk, {
    ...options,
    message: { safeParse: validate },
  });
  await store.commitStep(birth);
  const sizes: number[] = [];
  const put = disk.set.bind(disk);
  disk.set = (key, bytes) => {
    sizes.push(bytes.length);
    return put(key, bytes);
  };
  for (let index = 0; index < 200; index += 1)
    await store.appendMessage(input(String(index).padStart(3, "0")));
  expect(validate.mock.calls.length).toBeLessThanOrEqual(800);
  expect(sizes).toHaveLength(200);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(2);
  expect(Math.max(...sizes)).toBeLessThan(256);
  expect(
    (await memoryEventSourcedStore(new Map(disk), options).readLog()).records,
  ).toHaveLength(201);
});
