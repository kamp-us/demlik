import { expect, test, vi } from "vitest";
import { z } from "zod";
import {
  defineMachine,
  deliveryIdOf,
  type LoggedStore,
  NoCellError,
} from "../../index";
import { memoryEventSourcedStore } from "../../mem";
import { run } from "../../promise";
import { detachWorkOf } from "../../pure/core";
import {
  type Msg,
  machine,
  options,
  type State,
  type Upload,
} from "./durable-host.fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const quiet = () => {};

test("T3: concurrent and repeated caller IDs count once; serialized internal IDs cannot collide", async () => {
  const disk = new Map<string, string>();
  const store = memoryEventSourcedStore(disk, options);
  const live = await run(machine(), {
    store,
    interpret: { upload: async () => {} },
  }).ready;
  const input: Msg = { _tag: "picked", file: "a.png" };
  await Promise.all([
    live.dispatch(input, { id: "pick" }),
    live.dispatch({ ...input, file: "ignored.png" }, { id: "pick" }),
  ]);
  await live.dispatch(input, { id: "pick" });
  expect(live.getState().files).toEqual(["a.png"]);
  await live.dispatch(input);
  const generated = (await store.readLog()).records.find(
    ({ record }) =>
      record._tag === "message" && JSON.parse(record.id)[0] === "generated",
  );
  if (generated?.record._tag !== "message")
    throw new Error("Missing generated admission");
  await live.dispatch(
    { ...input, file: "caller.png" },
    { id: generated.record.id },
  );
  expect(live.getState().files).toEqual(["a.png", "a.png", "caller.png"]);
  expect(
    (await store.readLog()).records.filter(
      ({ record }) => record._tag === "message",
    ),
  ).toHaveLength(3);
  await live.stop();
  const wake = await run(machine(), {
    store: memoryEventSourcedStore(new Map(disk), options),
    interpret: { upload: async () => {} },
  }).ready;
  await wake.dispatch(input, { id: "pick" });
  expect(wake.getState().files).toEqual(["a.png", "a.png", "caller.png"]);
  await wake.stop();
});

test("T4: one birth and ten wakes initialize once, finish birth work once, and redeliver owed work with the same ID", async () => {
  let disk = new Map<string, string>();
  const initialized = vi.fn(
    (loaded: State | null): readonly [State, readonly Upload[]] => [
      loaded ?? { files: [], uploaded: [] },
      [{ _tag: "upload", file: loaded ? "forbidden-resume" : "birth" }],
    ],
  );
  const program = defineMachine({ ...machine(), init: initialized });
  let birthCalls = 0;
  let owedDisk = new Map<string, string>();
  const ids: (number | undefined)[] = [];
  const interrupted = new Error("activation dropped");
  const boot = (backing: Map<string, string>) =>
    run(program, {
      store: memoryEventSourcedStore(backing, options),
      onError: quiet,
      interpret: {
        upload: async (cmd, ctx) => {
          if (cmd.file === "birth") {
            birthCalls += 1;
            return;
          }
          ids.push(deliveryIdOf(ctx));
          owedDisk = new Map(backing);
          throw interrupted;
        },
      },
    });
  const first = await boot(disk).ready;
  await first.idle();
  await expect(
    first.dispatch({ _tag: "picked", file: "owed" }, { id: "owed" }),
  ).rejects.toBe(interrupted);
  for (let wake = 0; wake < 10; wake += 1) {
    disk = new Map(owedDisk);
    await expect(boot(disk).ready).rejects.toBe(interrupted);
  }
  expect(initialized).toHaveBeenCalledTimes(1);
  expect(birthCalls).toBe(1);
  expect(ids).toHaveLength(11);
  expect(new Set(ids).size).toBe(1);
  expect(ids[0]).toBe(2);
  expect(initialized.mock.calls[0]?.[0]).toBeNull();
});

test.each([
  "full",
  "before",
  "after",
] as const)("T5: recover committed restart State from %s checkpoint history without rerunning reducers", async (checkpoint) => {
  const disk = new Map<string, string>();
  const store = memoryEventSourcedStore(disk, {
    state: z.object({ n: z.number() }),
    message: z.object({ _tag: z.enum(["inc", "boom"]) }),
    command: z.never(),
    snapshotEvery: 100,
  });
  let throws = 0;
  const program = defineMachine({
    types: { model: {} as { n: number }, msg: {} as { _tag: "inc" | "boom" } },
    init: () => [{ n: 0 }, []],
    update: {
      inc: (s) => [{ n: s.n + 1 }, []],
      boom: () => {
        throws += 1;
        throw new Error("restart");
      },
    },
  });
  const live = await run(program, {
    store,
    onError: quiet,
    supervision: { strategy: "restart", rehydrate: () => ({ n: 40 }) },
  }).ready;
  await live.dispatch({ _tag: "inc" });
  if (checkpoint === "before") expect(await store.checkpoint()).toBe(true);
  await live.dispatch({ _tag: "boom" });
  if (checkpoint === "after") expect(await store.checkpoint()).toBe(true);
  await live.dispatch({ _tag: "inc" });
  await live.stop();
  const saved = await store.readLog();
  if (checkpoint !== "full") expect(saved.snapshot).not.toBeNull();
  const init = vi.fn(() => {
    throw new Error("wake called init");
  });
  const wake = await run(
    { ...program, init },
    {
      store: memoryEventSourcedStore(new Map(disk), {
        state: z.object({ n: z.number() }),
        message: z.object({ _tag: z.enum(["inc", "boom"]) }),
        command: z.never(),
      }),
    },
  ).ready;
  expect(wake.getState()).toEqual({ n: 41 });
  expect(throws).toBe(1);
  expect(init).not.toHaveBeenCalled();
  await wake.stop();
});

test("T6: reducer refusal and handler failure leave the run usable; a failed log write alone poisons later work", async () => {
  const disk = new Map<string, string>();
  const inner = memoryEventSourcedStore(disk, options);
  let breakWrite = false;
  const failure = new Error("disk write failed");
  const store: LoggedStore<State, Msg, Upload> = {
    ...inner,
    commitStep: async (step) => {
      if (breakWrite) throw failure;
      return inner.commitStep(step);
    },
  };
  let handled = 0;
  const live = await run(machine(), {
    store,
    onError: quiet,
    interpret: {
      upload: async () => {
        handled += 1;
        if (handled === 1) throw new Error("receiver");
      },
    },
  }).ready;
  await expect(
    live.dispatch({ _tag: "uploaded", file: "no work" }),
  ).resolves.toBeUndefined();
  await expect(
    live.dispatch({ _tag: "picked", file: "first" }),
  ).rejects.toThrow("receiver");
  await expect(
    live.dispatch({ _tag: "picked", file: "second" }),
  ).resolves.toBeUndefined();
  expect(handled).toBe(2);
  breakWrite = true;
  await expect(
    live.dispatch({ _tag: "picked", file: "unsaved" }),
  ).rejects.toMatchObject({ cause: failure });
  breakWrite = false;
  await expect(
    live.dispatch({ _tag: "picked", file: "after poison" }),
  ).rejects.toMatchObject({ cause: failure });
  expect(handled).toBe(2);
  expect(live.getState().files).toEqual(["first", "second"]);
  const atFailure = new Map(disk);
  await live.stop();
  expect(disk).toEqual(atFailure);
});

test("stored deliveries wait for detached answers to be admitted, while the next handler starts", async () => {
  const disk = new Map<string, string>();
  const store = memoryEventSourcedStore(disk, options);
  const blocked = deferred();
  const second = deferred();
  const program = defineMachine({
    ...machine(),
    init: (): readonly [State, readonly Upload[]] => [
      { files: [], uploaded: [] },
      [
        { _tag: "upload", file: "one" },
        { _tag: "upload", file: "two" },
      ],
    ],
  });
  const booting = run(program, {
    store,
    onError: quiet,
    interpret: {
      upload: async (cmd, ctx, dispatch) => {
        if (cmd.file === "one")
          detachWorkOf(ctx)(
            blocked.promise.then(() => {
              dispatch?.({ _tag: "uploaded", file: cmd.file });
            }),
          );
        else second.resolve();
      },
    },
  });
  await second.promise;
  const before = await store.readLog();
  expect(
    before.records.some(
      ({ record }) => record._tag === "confirmed" && record.event.id === 1,
    ),
  ).toBe(false);
  blocked.resolve();
  const live = await booting.ready;
  await live.idle();
  expect(live.getState().uploaded).toEqual(["one"]);
  const after = await store.readLog();
  const answer = after.records.findIndex(
    ({ record }) => record._tag === "message",
  );
  const confirmation = after.records.findIndex(
    ({ record }) => record._tag === "confirmed" && record.event.id === 1,
  );
  expect(answer).toBeGreaterThanOrEqual(0);
  expect(confirmation).toBeGreaterThan(answer);
  await live.stop();
});

test("T6: missing cells, escaping reducer failures and ignored messages retain distinct receipts without poisoning", async () => {
  type S = { _tag: "closed"; owner: string } | { _tag: "open"; owner: string };
  type M = { _tag: "open" | "close" | "boom"; to?: string };
  const disk = new Map<string, string>();
  const store = memoryEventSourcedStore(disk, {
    state: z.object({ _tag: z.enum(["closed", "open"]), owner: z.string() }),
    message: z.object({
      _tag: z.enum(["open", "close", "boom"]),
      to: z.string().optional(),
    }),
    command: z.never(),
  });
  const program = defineMachine({
    types: { model: {} as S, msg: {} as M },
    init: (): readonly [S, readonly never[]] => [
      { _tag: "closed", owner: "own" },
      [],
    ],
    identity: { ofState: (s) => s.owner, ofMsg: (m) => m.to },
    update: {
      closed: {
        open: (s) => [{ ...s, _tag: "open" }, []],
        boom: () => {
          throw new Error("broken reducer");
        },
      },
      open: { close: (s) => [{ ...s, _tag: "closed" }, []] },
    },
  });
  const live = await run(program, {
    store,
    supervision: "escalate",
    onError: quiet,
  }).ready;
  await expect(live.dispatch({ _tag: "close" })).rejects.toBeInstanceOf(
    NoCellError,
  );
  await expect(live.dispatch({ _tag: "boom" })).rejects.toThrow(
    "broken reducer",
  );
  await live.dispatch({ _tag: "open", to: "foreign" });
  expect(live.getState()._tag).toBe("closed");
  await live.dispatch({ _tag: "open", to: "own" });
  expect(live.getState()._tag).toBe("open");
  const steps = (await store.readLog()).records.flatMap(({ record }) =>
    record._tag === "applied" || record._tag === "receipt" ? [record] : [],
  );
  expect(
    steps.map((step) =>
      step._tag === "applied" ? "applied" : step.disposition,
    ),
  ).toEqual(["rejected", "rejected", "ignored", "applied"]);
  expect(
    steps
      .slice(0, 2)
      .map((step) =>
        step._tag === "receipt" ? step.failure?.kind : undefined,
      ),
  ).toEqual(["no_cell", "reduce"]);
  await live.stop();
});
