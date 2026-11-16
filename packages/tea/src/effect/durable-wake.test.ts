import { Cause, Effect, Exit, Scope } from "effect";
import {
  liveEqualsWake,
  type WakeDriver,
} from "../internal/persistence/durable-wake.fixture";
import { run } from "./index";

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
const driver: WakeDriver = async (machine, store, see) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    run(machine, {
      store,
      onError: () => {},
      supervision: "escalate",
      interpret: { see: (cmd) => Effect.sync(() => see(cmd)) },
    }).pipe(Scope.provide(scope)),
  );
  const live = await settle(booting.ready).catch(async (error) => {
    await settle(Scope.close(scope, Exit.void));
    throw error;
  });
  return {
    dispatch: (msg, opts) => settle(live.dispatch(msg, opts)),
    getState: () => live.getState(),
    subscribe: (listener) => live.subscribe(listener),
    stop: async () => {
      await settle(live.stop());
      await settle(Scope.close(scope, Exit.void));
    },
  };
};

liveEqualsWake("Effect", driver);
