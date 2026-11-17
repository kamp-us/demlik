import { expect, test } from "vitest";
import { z } from "zod";
import {
  type DispatchOptions,
  defineMachine,
  type LoggedStore,
} from "../../index";
import {
  copyStorage,
  type DurableStorage,
  createStorage as defaultStorage,
  durableStore,
  type StorageFactory,
  storedLog,
} from "./durable-store.fixture";

type State = { n: number };
type Msg = { _tag: "apply" | "ignore" | "reject" };
const options = {
  state: z.object({ n: z.number().transform((n) => n + 1) }),
  message: z.object({ _tag: z.enum(["apply", "ignore", "reject"]) }),
  command: z.never(),
};
function programFor(visits = { ignored: 0, rejected: 0 }) {
  return defineMachine({
    types: { model: {} as State, msg: {} as Msg },
    init: () => [{ n: 0 }, []],
    identity: {
      ofState: () => "own",
      ofMsg: (msg) => {
        if (msg._tag !== "ignore") return undefined;
        visits.ignored += 1;
        return "foreign";
      },
    },
    update: {
      apply: (s) => [{ n: s.n + 1 }, []],
      ignore: () => {
        throw new Error("ignored message reached reducer");
      },
      reject: () => {
        visits.rejected += 1;
        throw new Error("reducer rejected");
      },
    },
  });
}

/** The engine-neutral doors for receipt and checkpoint recovery tests. */
export type ReceiptDriver = (
  program: ReturnType<typeof programFor>,
  store: LoggedStore<State, Msg, never>,
) => Promise<{
  getState(): State;
  subscribe(listener: () => void): () => void;
  dispatch(msg: Msg, options?: DispatchOptions): Promise<void>;
  stop(): Promise<void>;
}>;

function records(disk: DurableStorage) {
  return storedLog(disk)
    .frames.map((bytes) => JSON.parse(bytes))
    .filter((r) => r.record);
}
async function sendReceipt(
  live: Awaited<ReturnType<ReceiptDriver>>,
  kind: "ignore" | "reject",
) {
  const sent = live.dispatch({ _tag: kind }, { id: kind });
  if (kind === "reject") await expect(sent).rejects.toThrow("reducer rejected");
  else await sent;
}

/** Keep the same receipt and stored-State contract on both engines. */
export function receiptContract(
  engine: string,
  driver: ReceiptDriver,
  createStorage: StorageFactory = defaultStorage,
): void {
  test.each([
    "ignore",
    "reject",
  ] as const)(`${engine}: %s receipt preserves State and the last subscribed value without notifying`, async (kind) => {
    const disk = createStorage();
    const program = programFor();
    const store = durableStore(disk, options);
    const live = await driver(program, store);
    const heard: State[] = [];
    live.subscribe(() => heard.push(live.getState()));
    await live.dispatch({ _tag: "apply" });
    const stable = live.getState();
    await sendReceipt(live, kind);
    expect(heard).toHaveLength(1);
    expect(live.getState()).toBe(stable);
    expect(heard.at(-1)).toBe(stable);
    const result = await store.commitStep({
      _tag: "receipt",
      sourceId: JSON.stringify(["caller", kind]),
      disposition: kind === "ignore" ? "ignored" : "rejected",
    });
    expect(result.state).toEqual(stable);
    expect(result.owed).toEqual([]);
    const wake = await driver(
      program,
      durableStore(copyStorage(disk), options),
    );
    expect(wake.getState()).toEqual(stable);
    expect(wake.getState()).toEqual(heard.at(-1));
    await wake.stop();
    await live.stop();
  });
  test.each([
    "ignore",
    "reject",
  ] as const)(`${engine}: %s receipt bytes contain no State, deliveries or timers`, async (kind) => {
    const disk = createStorage();
    const live = await driver(programFor(), durableStore(disk, options));
    await sendReceipt(live, kind);
    const saved = records(disk).find(({ record }) => record.sourceId);
    expect(saved).toBeDefined();
    for (const key of ["state", "cmds", "owed", "timers"])
      expect(Object.hasOwn(saved.record, key)).toBe(false);
    await live.stop();
  });
  test.each([
    "manual",
    "automatic",
  ] as const)(`${engine}: %s checkpoint copies stored State across a trailing ignored receipt`, async (kind) => {
    const disk = createStorage();
    const store = durableStore(disk, {
      ...options,
      snapshotEvery: kind === "automatic" ? 2 : 100,
    });
    const program = programFor();
    const live = await driver(program, store);
    for (let n = 0; n < 4; n += 1) await live.dispatch({ _tag: "apply" });
    const stable = live.getState();
    await sendReceipt(live, "ignore");
    if (kind === "manual")
      expect(await durableStore(disk, options).checkpoint()).toBe(true);
    const frames = records(disk);
    const lastAppliedMessage = frames
      .filter(
        ({ record }) =>
          record._tag === "message" && record.msg._tag === "apply",
      )
      .at(-1);
    const applied = frames.find(
      ({ record }) => record.sourceId === lastAppliedMessage.record.id,
    );
    const stored = storedLog(disk);
    const checkpoint = [
      ...stored.frames,
      ...(stored.checkpoint === undefined ? [] : [stored.checkpoint]),
    ]
      .map((bytes) => JSON.parse(bytes))
      .filter((raw) => raw.snapshot !== null)
      .at(-1)?.snapshot;
    expect(checkpoint.state).toEqual(applied.record.state);
    const wake = await driver(
      program,
      durableStore(copyStorage(disk), options),
    );
    expect(wake.getState()).toEqual(stable);
    expect(wake.getState()).toEqual({ n: 9 });
    await wake.stop();
    await live.stop();
  });
  test(`${engine}: repeated ignored id returns the stored admission and folds zero times after wake`, async () => {
    const disk = createStorage();
    const visits = { ignored: 0, rejected: 0 };
    const program = programFor(visits);
    const store = durableStore(disk, options);
    const live = await driver(program, store);
    const stable = live.getState();
    await sendReceipt(live, "ignore");
    const input = (await store.readLog()).records.find(
      ({ record }) => record._tag === "message",
    );
    if (input?.record._tag !== "message")
      throw new Error("Missing ignored admission");
    const copied = copyStorage(disk);
    const fresh = durableStore(copied, options);
    const before = copyStorage(copied);
    const duplicate = await fresh.appendMessage(input.record);
    expect(duplicate.appended).toBe(false);
    expect(duplicate.entry).toEqual(input);
    expect(copied).toEqual(before);
    const wake = await driver(program, fresh);
    await wake.dispatch({ _tag: "ignore" }, { id: "ignore" });
    expect(visits.ignored).toBe(1);
    expect(wake.getState()).toEqual(stable);
    await wake.stop();
    await live.stop();
  });
}
