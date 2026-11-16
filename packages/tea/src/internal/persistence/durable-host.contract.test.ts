import fc from "fast-check";
import { expect, test } from "vitest";
import { run } from "../../promise";
import { execute, machine, type Driver } from "./durable-host.fixture";

const promiseDriver: Driver = async (store, upload) => run(machine(), { store, onError: () => {}, interpret: { upload } }).ready;

test("T2 Promise: 200 messages, crashes between durable writes, 100 runs", async () => {
  const reference = await execute(promiseDriver);
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: reference.writes }), async (cut) => {
    const recovered = await execute(promiseDriver, cut);
    expect(recovered.crashed).toBe(true);
    expect(recovered.state).toEqual(reference.state);
    expect(new Set(recovered.state.files).size).toBe(200);
  }), { numRuns: Number(process.env.FC_NUMRUNS ?? 100) });
});
