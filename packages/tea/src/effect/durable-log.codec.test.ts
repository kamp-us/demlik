import { Cause, Effect, Exit, Scope } from "effect";
import {
  type CodecDriver,
  codecContract,
} from "../internal/persistence/durable-codec.fixture";
import { run } from "./index";

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
const driver: CodecDriver = async (program, store, see) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    run(program, {
      store,
      onError: () => {},
      interpret: { see: (cmd) => Effect.sync(() => see(cmd)) },
    }).pipe(Scope.provide(scope)),
  );
  const live = await settle(booting.ready).catch(async (error) => {
    await settle(Scope.close(scope, Exit.void));
    throw error;
  });
  return {
    dispatch: (msg) => settle(live.dispatch(msg)),
    stop: async () => {
      await settle(live.stop());
      await settle(Scope.close(scope, Exit.void));
    },
  };
};

codecContract("Effect", driver);
