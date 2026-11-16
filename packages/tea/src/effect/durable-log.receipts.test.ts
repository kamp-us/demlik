import { Cause, Effect, Exit, Scope } from "effect";
import {
  type ReceiptDriver,
  receiptContract,
} from "../internal/persistence/durable-receipts.fixture";
import { run } from "./index";

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
const driver: ReceiptDriver = async (program, store) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    run(program, {
      store,
      supervision: "escalate",
      onError: () => {},
      interpret: {},
    }).pipe(Scope.provide(scope)),
  );
  const live = await settle(booting.ready).catch(async (error) => {
    await settle(Scope.close(scope, Exit.void));
    throw error;
  });
  return {
    getState: () => live.getState(),
    subscribe: (listener) => live.subscribe(listener),
    dispatch: (msg, options) => settle(live.dispatch(msg, options)),
    stop: async () => {
      await settle(live.stop());
      await settle(Scope.close(scope, Exit.void));
    },
  };
};

receiptContract("Effect", driver);
