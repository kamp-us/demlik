import { expect, test, vi } from "vitest";
import { options } from "./durable-host.fixture";
import {
  appendFrame,
  copyStorage,
  createStorage,
  Dropped,
  durableStore,
  readFrame,
  seedFrame,
  storageClosed,
  storageMutations,
  storageOf,
  storedLog,
} from "./durable-store.fixture";

const birth = {
  _tag: "birth" as const,
  at: 0,
  state: { files: [], uploaded: [] },
  cmds: [],
  timers: [],
};

test("seeding is not a physical write", () => {
  const cut = vi.fn(() => true);
  const storage = storageOf({ frames: [] }, cut);
  appendFrame(storage, "x");
  expect(cut).not.toHaveBeenCalled();
  expect(storageClosed(storage)).toBe(false);
  expect(readFrame(storage, 1)).toBe("x");
});

test("a copy holds the bytes at that moment and is independent", () => {
  const storage = storageOf({ frames: ["one"], checkpoint: "snapshot" });
  const copy = copyStorage(storage);
  seedFrame(storage, 1, "changed");
  appendFrame(storage, "two");
  expect(storedLog(copy)).toEqual({
    frames: ["one"],
    checkpoint: "snapshot",
  });
  expect(storedLog(storage).frames).toEqual(["changed", "two"]);
  seedFrame(copy, 1, "only-copy");
  expect(readFrame(storage, 1)).toBe("changed");
});

test("a cut keeps the bytes written before it and stops the activation", async () => {
  const cut = vi.fn(() => true);
  const storage = storageOf({ frames: [] }, cut);
  const store = durableStore(storage, options);
  await expect(store.commitStep(birth)).rejects.toBeInstanceOf(Dropped);
  expect(storageClosed(storage)).toBe(true);
  const reopened = durableStore(copyStorage(storage), options);
  expect(await reopened.load()).toEqual(birth.state);
  await expect(store.readLog()).rejects.toBeInstanceOf(Dropped);
  await expect(store.commitStep(birth)).rejects.toBeInstanceOf(Dropped);
  expect(cut).toHaveBeenCalledTimes(1);
});

test("the mutation spies see the store's real writes", async () => {
  const storage = createStorage();
  const { set, remove, clear } = storageMutations(storage);
  await durableStore(storage, options).commitStep(birth);
  expect(set).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  expect(await durableStore(copyStorage(storage), options).load()).toEqual(
    birth.state,
  );
});
