import { Cause, Effect, Exit, Scope } from "effect";
import {
  crashContract,
  type Driver,
  machine,
} from "../internal/persistence/durable-host.fixture";
import { run } from "./index";

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
const effectDriver: Driver = async (store, upload) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    run(machine(), {
      store,
      onError: () => {},
      interpret: {
        upload: (cmd) => Effect.promise(() => upload(cmd)),
      },
    }).pipe(Scope.provide(scope)),
  );
  const live = await settle(booting.ready).catch(async (error) => {
    await settle(Scope.close(scope, Exit.void));
    throw error;
  });
  return {
    dispatch: (msg, opts) => settle(live.dispatch(msg, opts)),
    getState: () => live.getState(),
    stop: async () => {
      await settle(live.stop());
      await settle(Scope.close(scope, Exit.void));
    },
  };
};

crashContract("Effect", effectDriver);
