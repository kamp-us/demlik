// The legacy key layout itself is this test's subject.
import { expect, test } from "vitest";
import { StoreRefusedError } from "../index";
import { machine, options } from "../internal/persistence/durable-host.fixture";
import {
  copyStorage,
  createStorage,
  durableStore,
  storageMutations,
} from "../internal/persistence/durable-store.fixture";
import { run } from "../promise";

test("protocol-1 storage refuses boot without writing or deleting any bytes", async () => {
  const state = { files: [], uploaded: [] };
  const bytes = JSON.stringify({
    protocol: 1,
    version: 1,
    records: [
      {
        seq: 1,
        record: { _tag: "birth", at: 0, state, owed: [], timers: [] },
      },
    ],
    snapshot: null,
    timers: [],
  });
  const disk = createStorage([
    ["@@es/default/log", bytes],
    ["another namespace", "leave alone"],
  ]);
  const before = copyStorage(disk);
  const { set, remove, clear } = storageMutations(disk);
  const store = durableStore(disk, options);
  await expect(
    run(machine(), {
      store,
      onError: () => {},
      interpret: { upload: async () => {} },
    }).ready,
  ).rejects.toBeInstanceOf(StoreRefusedError);
  await expect(
    store.commitStep({ _tag: "birth", at: 0, state, cmds: [], timers: [] }),
  ).rejects.toThrow("Unsupported durable log protocol");
  expect(set).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  expect(disk).toStrictEqual(before);
});
