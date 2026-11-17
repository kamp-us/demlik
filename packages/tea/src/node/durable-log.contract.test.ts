import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Scope } from "effect";
import { describe } from "vitest";
import { run as effectRun } from "../effect";
import type { Journal } from "../internal/journal";
import { cacheContract } from "../internal/persistence/cache-contract.fixture";
import {
  type CodecDriver,
  codecContract,
} from "../internal/persistence/durable-codec.fixture";
import {
  crashContract,
  type Driver,
  machine,
} from "../internal/persistence/durable-host.fixture";
import {
  type ReceiptDriver,
  receiptContract,
} from "../internal/persistence/durable-receipts.fixture";
import {
  type FixtureJournal,
  journalStorage,
} from "../internal/persistence/durable-store.fixture";
import {
  liveEqualsWake,
  type WakeDriver,
} from "../internal/persistence/durable-wake.fixture";
import { run as promiseRun } from "../promise";
import { fileJournal } from "./index";
import { sqliteJournal } from "./turn-journal.fixture";

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
const promiseDriver: Driver = async (store, upload) =>
  promiseRun(machine(), { store, onError: () => {}, interpret: { upload } })
    .ready;

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

const promiseWake: WakeDriver = async (machine, store, see) =>
  promiseRun(machine, {
    store,
    onError: () => {},
    supervision: "escalate",
    interpret: { see: async (cmd) => see(cmd) },
  }).ready;

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

const promiseCodec: CodecDriver = async (program, store, see) =>
  promiseRun(program, {
    store,
    onError: () => {},
    interpret: { see: async (cmd) => see(cmd) },
  }).ready;

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

const promiseReceipt: ReceiptDriver = (program, store) =>
  promiseRun(program, {
    store,
    supervision: "escalate",
    onError: () => {},
    interpret: {},
  }).ready;

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

for (const kind of ["file", "fileFenced", "sqlite"] as const) {
  const make = (): FixtureJournal => {
    const dir = mkdtempSync(join(tmpdir(), "tea-durable-contract-"));
    return {
      open: () =>
        kind === "sqlite"
          ? sqliteJournal(join(dir, "journal.db"), () => {})
          : kind === "fileFenced"
            ? fileJournal(dir, { fenced: true })
            : fileJournal(dir),
      dispose: () => rmSync(dir, { recursive: true, force: true }),
    };
  };
  const storage = journalStorage(make, { fenced: kind === "fileFenced" });
  describe(`${kind} durable contracts`, { timeout: 480_000 }, () => {
    crashContract("Promise", promiseDriver, storage, {
      batches: 1,
      scripts: 10,
      messages: 200,
      sweepMessages: 12,
    });
    crashContract("Effect", effectDriver, storage, {
      batches: 1,
      scripts: 10,
      messages: 200,
      sweepMessages: 12,
    });
    liveEqualsWake("Promise", promiseWake, storage, 20);
    liveEqualsWake("Effect", effectWake, storage, 20);
    codecContract("Promise", promiseCodec, storage);
    codecContract("Effect", effectCodec, storage);
    receiptContract("Promise", promiseReceipt, storage);
    receiptContract("Effect", effectReceipt, storage);
    cacheContract(
      kind,
      () => {
        const resource = make();
        const handles: Journal[] = [];
        return {
          open() {
            const j = resource.open();
            handles.push(j);
            return j;
          },
          async close() {
            for (const j of handles) await j.close();
            resource.dispose();
          },
        };
      },
      kind === "fileFenced",
    );
  });
}
