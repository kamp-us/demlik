import { Cause, Effect, Exit, Scope } from "effect";
import fc from "fast-check";
import { expect, test } from "vitest";
import { execute, machine, type Driver } from "../internal/persistence/durable-host.fixture";
import { run } from "./index";

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
const effectDriver: Driver = async (store, upload) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(run(machine(), { store, onError: () => {}, interpret: {
    upload: (cmd) => Effect.promise(() => upload(cmd)),
  } }).pipe(Scope.provide(scope)));
  const live = await settle(booting.ready);
  return {
    dispatch: (msg, opts) => settle(live.dispatch(msg, opts)),
    getState: () => live.getState(),
    stop: async () => { await settle(live.stop()); await settle(Scope.close(scope, Exit.void)); },
  };
};

test("T2 Effect: 200 messages, crashes between durable writes, 100 runs", async () => {
  const reference = await execute(effectDriver);
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: reference.writes }), async (cut) => {
    const recovered = await execute(effectDriver, cut);
    expect(recovered.crashed).toBe(true);
    expect(recovered.state).toEqual(reference.state);
  }), { numRuns: Number(process.env.FC_NUMRUNS ?? 100) });
});
