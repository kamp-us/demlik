import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { fakeDoStorage } from "../../__fixtures__/do-storage";
import { defineMachine } from "../../index";
import { doEventSourcedStore } from "../event-sourced-store";

const collect = global.gc;
assert.ok(collect, "this fixture requires --expose-gc");

const { storage } = fakeDoStorage(
  new Map([
    ["@@es/snapshot", '{"seq":1,"state":{"count":1}}'],
    ["@@es/meta", '{"lastSeq":1}'],
  ]),
);
const machine = defineMachine({
  types: {
    model: {} as { readonly count: number },
    msg: {} as { readonly _tag: "advance" },
  },
  init: (loaded) => [loaded ?? { count: 0 }, []],
  update: { advance: (state) => [{ count: state.count + 1 }, []] },
});
const es = doEventSourcedStore(storage, machine, {});

async function weakLoaded(): Promise<WeakRef<object>> {
  const state = await es.store.load();
  assert.ok(state !== null && typeof state === "object");
  return new WeakRef(state);
}

const recovered = await weakLoaded();
await es.store.save({ count: 2 }, { _tag: "advance" });
// End the WeakRef creation job before forcing collection; do not dereference between passes.
for (let pass = 0; pass < 5; pass++) {
  await setImmediate();
  collect();
}
assert.equal(
  recovered.deref(),
  undefined,
  "the replaced recovered state must be collectible",
);
assert.equal(await es.getCommittedSeq(), 2);
// Keep the storage identity alive so the WeakMap entry itself cannot disappear.
assert.equal(await storage.get("@@es/meta"), '{"lastSeq":2}');
process.stdout.write("collected");
