import { Cause, Effect, Exit, Scope } from "effect";
import type { CodecDriver } from "../internal/persistence/durable-codec.fixture";
import {
  type Driver,
  machine,
} from "../internal/persistence/durable-host.fixture";
import type { ReceiptDriver } from "../internal/persistence/durable-receipts.fixture";
import type { WakeDriver } from "../internal/persistence/durable-wake.fixture";
import type { BoundaryDriver } from "../internal/persistence/log-store.fixture";
import { run as effectRun } from "./index";

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
const effectDriver: Driver = async (store, upload) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    effectRun(machine(), {
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

const effectWake: WakeDriver = async (machine, store, see) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    effectRun(machine, {
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

const effectCodec: CodecDriver = async (program, store, see) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    effectRun(program, {
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

const effectReceipt: ReceiptDriver = async (program, store) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    effectRun(program, {
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

export const effectDrivers = {
  crash: effectDriver,
  wake: effectWake,
  codec: effectCodec,
  receipt: effectReceipt,
};

export const effectBoundaryDriver: BoundaryDriver = async (program, store) => {
  const scope = Scope.makeUnsafe();
  const boot = await settle(
    effectRun(program, { store, onError: () => {} }).pipe(Scope.provide(scope)),
  );
  const live = await settle(boot.ready);
  return {
    getState: () => live.getState(),
    dispatch: (msg, opts) => settle(live.dispatch(msg, opts)),
    stop: async () => {
      await settle(live.stop());
      await settle(Scope.close(scope, Exit.void));
    },
  };
};
