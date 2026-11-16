import { expect, test, vi } from "vitest";
import { StoreRefusedError } from "../index";
import { machine, options } from "../internal/persistence/durable-host.fixture";
import { run } from "../promise";
import { memoryEventSourcedStore } from "./index";

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
  const disk = new Map([
    ["@@es/default/log", bytes],
    ["another namespace", "leave alone"],
  ]);
  const before = new Map(disk);
  const set = vi.spyOn(disk, "set");
  const remove = vi.spyOn(disk, "delete");
  const clear = vi.spyOn(disk, "clear");
  const store = memoryEventSourcedStore(disk, options);
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
