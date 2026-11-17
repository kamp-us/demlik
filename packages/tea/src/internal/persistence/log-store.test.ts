import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventSourcedStore } from "@demlik/tea/persistence";
import { Cause, Effect, Exit, Scope } from "effect";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { run as effectRun } from "../../effect";
import { defineMachine, StoreConflictError } from "../../index";
import { fileJournal } from "../../node";
import { sqliteJournal } from "../../node/turn-journal.fixture";
import { run as promiseRun } from "../../promise";
import { type FencedJournal, type Journal, memoryJournal } from "../journal";
import { cacheContract } from "./cache-contract.fixture";
import { createLogStore } from "./log-store";

const options = {
  state: z.object({ n: z.number() }),
  message: z.object({ _tag: z.literal("go") }),
  command: z.never(),
  snapshotEvery: 1,
};
const program = defineMachine({
  types: { model: {} as { n: number }, msg: {} as { _tag: "go" } },
  init: () => [{ n: 0 }, []],
  update: { go: (s) => [{ n: s.n + 1 }, []] },
});
const birth = {
  _tag: "birth" as const,
  at: 0,
  state: { n: 0 },
  cmds: [],
  timers: [],
};
const stream = JSON.stringify(["default", "log"]);
async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
const engines = {
  Promise: async (
    store: ReturnType<
      typeof eventSourcedStore<{ n: number }, { _tag: "go" }, never>
    >,
  ) => promiseRun(program, { store, onError: () => {} }).ready,
  Effect: async (
    store: ReturnType<
      typeof eventSourcedStore<{ n: number }, { _tag: "go" }, never>
    >,
  ) => {
    const scope = Scope.makeUnsafe();
    const boot = await settle(
      effectRun(program, { store, onError: () => {} }).pipe(
        Scope.provide(scope),
      ),
    );
    const live = await settle(boot.ready);
    return {
      getState: () => live.getState(),
      dispatch: (msg: { _tag: "go" }, opts?: { id: string }) =>
        settle(live.dispatch(msg, opts)),
      stop: async () => {
        await settle(live.stop());
        await settle(Scope.close(scope, Exit.void));
      },
    };
  },
};
describe("factory boundary", { timeout: 240_000 }, () => {
  for (const kind of ["memory", "file", "sqlite"])
    for (const [engine, run] of Object.entries(engines))
      test(`A6 ${kind} ${engine}: stale writer refused through the existing logged failure path`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "tea-log-store-"));
        const shared = memoryJournal({ fenced: true });
        const open = (): FencedJournal =>
          kind === "memory"
            ? shared
            : kind === "file"
              ? fileJournal(dir, { fenced: true })
              : sqliteJournal(join(dir, "journal.db"), () => {});
        const ja = open(),
          jb = open();
        const a = eventSourcedStore(ja, { ...options, fenced: true }),
          b = eventSourcedStore(jb, { ...options, fenced: true });
        try {
          await a.commitStep(birth);
          await b.readLog();
          const first = await run(a),
            second = await run(b);
          await first.dispatch({ _tag: "go" }, { id: "first" });
          const error = await second
            .dispatch({ _tag: "go" }, { id: "second" })
            .catch((e) => e);
          expect(error.cause).toBeInstanceOf(StoreConflictError);
          expect(error.cause.cause).toMatchObject({
            _tag: "journal_conflict",
            expected: 1,
            head: 3,
          });
          expect(first.getState()).toEqual({ n: 1 });
          expect(second.getState()).toEqual({ n: 0 });
          const before = await ja.read(stream, 0);
          const again = await second
            .dispatch({ _tag: "go" }, { id: "third" })
            .catch((e) => e);
          expect(again.cause).toBe(error.cause);
          expect(await ja.read(stream, 0)).toEqual(before);
          await first.stop();
          await second.stop();
        } finally {
          await ja.close();
          if (jb !== ja) await jb.close();
          rmSync(dir, { recursive: true, force: true });
        }
      });

  test("A3: automatic checkpoint is one append; cache installs only after acknowledgement; driver calls are counted", async () => {
    const base = memoryJournal();
    const calls: {
      method: string;
      stream: string;
      after?: number;
      size?: number;
    }[] = [];
    let hold = false;
    let release!: () => void;
    let reached!: () => void;
    let waiting = Promise.resolve();
    const driver: Journal = {
      ...base,
      async read(s, a) {
        calls.push({ method: "read", stream: s, after: a });
        return base.read(s, a);
      },
      async append(s, r) {
        calls.push({ method: "append", stream: s, size: r.length });
        const ack = await base.append(s, r);
        if (hold) {
          reached();
          await waiting;
        }
        return ack;
      },
    };
    const live = createLogStore(driver, options);
    await live.store.commitStep(birth);
    await live.store.appendMessage({
      _tag: "message",
      id: "one",
      at: 0,
      msg: { _tag: "go" },
    });
    calls.length = 0;
    waiting = new Promise<void>((r) => {
      release = r;
    });
    const reachedWrite = new Promise<void>((r) => {
      reached = r;
    });
    hold = true;
    const writing = live.store.commitStep({
      _tag: "applied",
      sourceId: "one",
      state: { n: 1 },
      cmds: [],
      timers: [],
    });
    await reachedWrite;
    expect(live.inspect().projection.version).toBe(2);
    release();
    await writing;
    expect(live.inspect().projection.version).toBe(3);
    expect(live.inspect().projection.snapshot?.through).toBe(2);
    expect(calls.map((c) => c.method)).toEqual(["append"]);
    expect(calls[0]?.size).toBe(1);
    console.info(
      JSON.stringify({
        case: "calls",
        operation: "commitStep with automatic checkpoint",
        calls,
      }),
    );
    const ack = await base.read(stream, 0);
    if (ack._tag !== "read") throw new Error("read failed");
    const stored = ack.entries[2];
    if (!stored) throw new Error("Missing acknowledged frame");
    const frame = JSON.parse(stored.record);
    expect(frame.snapshot).toEqual({ through: 2, state: { n: 1 } });
    calls.length = 0;
    hold = false;
    await live.store.appendMessage({
      _tag: "message",
      id: "two",
      at: 0,
      msg: { _tag: "go" },
    });
    await live.store.commitStep({
      _tag: "receipt",
      sourceId: "two",
      disposition: "ignored",
    });
    console.info(
      JSON.stringify({
        case: "calls",
        operation: "admit plus consume",
        reads: calls.filter((c) => c.method === "read").length,
        appends: calls.filter((c) => c.method === "append").length,
      }),
    );

    const countedStore = eventSourcedStore(driver, {
      ...options,
      key: "counts",
      snapshotEvery: 100,
      command: z.object({ _tag: z.literal("work") }),
    });
    calls.length = 0;
    await countedStore.load();
    expect(calls.map((call) => call.method)).toEqual(["read", "read"]);
    const count = async (
      operation: string,
      use: () => Promise<unknown>,
      appends: number,
    ) => {
      calls.length = 0;
      await use();
      const observed = {
        reads: calls.filter((call) => call.method === "read").length,
        appends: calls.filter((call) => call.method === "append").length,
      };
      expect(observed).toEqual({ reads: 0, appends });
      console.info(
        JSON.stringify({ case: "operation-counts", operation, ...observed }),
      );
    };
    await count("birth", () => countedStore.commitStep(birth), 1);
    await count("repeated birth", () => countedStore.commitStep(birth), 0);
    const admitted = {
      _tag: "message" as const,
      id: "owed",
      at: 0,
      msg: { _tag: "go" as const },
    };
    await count("appendMessage", () => countedStore.appendMessage(admitted), 1);
    await count(
      "duplicate appendMessage",
      () => countedStore.appendMessage(admitted),
      0,
    );
    const step = {
      _tag: "applied" as const,
      sourceId: "owed",
      state: { n: 1 },
      cmds: [{ _tag: "work" as const }],
      timers: [],
    };
    await count("applied commitStep", () => countedStore.commitStep(step), 1);
    await count("repeated commitStep", () => countedStore.commitStep(step), 0);
    const owed = (await countedStore.readLog()).records.flatMap(({ record }) =>
      record._tag === "applied" ? record.owed : [],
    );
    const delivery = owed[0];
    if (!delivery) throw new Error("Missing owed delivery");
    await count(
      "confirmEffect",
      () => countedStore.confirmEffect(delivery.id),
      1,
    );
    await count(
      "repeated confirmEffect",
      () => countedStore.confirmEffect(delivery.id),
      0,
    );
    await count("checkpoint", () => countedStore.checkpoint(), 1);
    await count("repeated checkpoint", () => countedStore.checkpoint(), 0);
    await count("load", () => countedStore.load(), 0);
    await count("readLog", () => countedStore.readLog(), 0);
    const ignored = { ...admitted, id: "ignored" };
    await countedStore.appendMessage(ignored);
    await count(
      "receipt commitStep",
      () =>
        countedStore.commitStep({
          _tag: "receipt",
          sourceId: ignored.id,
          disposition: "ignored",
        }),
      1,
    );
  });

  test("A3: uncertain acknowledgements discard cache; next call equals cold open", async () => {
    for (const after of [false, true]) {
      const base = memoryJournal();
      const refusal = {
        _tag: "journal_io" as const,
        operation: "append" as const,
        message: "lost acknowledgement",
        uncertain: after,
      };
      let armed = false;
      const driver: Journal = {
        ...base,
        async append(s, r) {
          if (!armed) return base.append(s, r);
          armed = false;
          if (after) await base.append(s, r);
          return refusal;
        },
      };
      const live = createLogStore(driver, options);
      await live.store.commitStep(birth);
      armed = true;
      const error = await live.store
        .appendMessage({
          _tag: "message",
          id: "one",
          at: 0,
          msg: { _tag: "go" },
        })
        .catch((e) => e);
      expect(error.cause).toBe(refusal);
      const cold = eventSourcedStore(base, options);
      expect(await live.store.readLog()).toEqual(await cold.readLog());
      expect((await live.store.readLog()).records.length).toBe(after ? 2 : 1);
    }
  });

  test("R4: disagreement between frame sequence and driver position is refused without overwriting", async () => {
    const base = memoryJournal();
    await base.append(stream, [
      JSON.stringify({
        protocol: 2,
        seq: 2,
        record: { ...birth, owed: [] },
        snapshot: null,
      }),
    ]);
    const before = await base.read(stream, 0);
    const store = eventSourcedStore(base, options);
    await expect(store.readLog()).rejects.toThrow(
      "Invalid durable log ordering",
    );
    await expect(store.commitStep(birth)).rejects.toThrow();
    expect(await base.read(stream, 0)).toEqual(before);
  });

  test("must-fail control: the fence detector rejects an unconditional driver", async () => {
    const base = memoryJournal({ fenced: true });
    const broken: FencedJournal = {
      ...base,
      appendFenced: (s, r) => base.append(s, r),
    };
    const detects = async (driver: FencedJournal) => {
      const first = await driver.appendFenced("control", ["first"], 0);
      expect(first._tag).toBe("appended");
      const second = await driver.appendFenced("control", ["second"], 0);
      expect(second._tag).toBe("journal_conflict");
    };
    await detects(memoryJournal({ fenced: true }));
    await expect(detects(broken)).rejects.toThrow();
  });

  test("plain opt-in stays unconditional even when the journal supports fencing", async () => {
    const base = memoryJournal({ fenced: true });
    const store = eventSourcedStore(base, options);
    expect("fenced" in store).toBe(false);
    await store.commitStep(birth);
    await store.appendMessage({
      _tag: "message",
      id: "a",
      at: 0,
      msg: { _tag: "go" },
    });
    expect((await store.readLog()).version).toBe(2);
  });

  test("an uncloneable decoded response is refused before the first driver append", async () => {
    const base = memoryJournal();
    const store = eventSourcedStore(base, {
      ...options,
      state: {
        safeParse: (_raw: unknown) => ({
          success: true as const,
          data: (): number => 0,
        }),
      },
    });
    await expect(
      store.commitStep({
        _tag: "birth",
        at: 0,
        state: () => 1,
        cmds: [],
        timers: [],
      }),
    ).rejects.toMatchObject({ name: "DataCloneError" });
    expect(await base.read(stream, 0)).toEqual({
      _tag: "read",
      head: 0,
      entries: [],
    });
  });

  test.each(
    Object.entries(engines),
  )("%s: a genuinely asynchronous driver survives concurrent dispatch and cold open", async (_engine, run) => {
    const base = memoryJournal();
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const driver: Journal = {
      ...base,
      async read(stream, after) {
        await pause();
        return base.read(stream, after);
      },
      async append(stream, records) {
        await pause();
        return base.append(stream, records);
      },
    };
    const live = await run(eventSourcedStore(driver, options));
    const messages = Array.from({ length: 3 }, (_, i) => ({
      id: String(i),
      msg: { _tag: "go" as const },
    }));
    await Promise.all(
      messages.map(({ id, msg }) => live.dispatch(msg, { id })),
    );
    const model = { n: messages.length };
    expect(live.getState()).toEqual(model);
    await live.stop();
    const wake = await run(eventSourcedStore(driver, options));
    expect(wake.getState()).toEqual(model);
    await wake.stop();
  });
});

cacheContract(
  "memory",
  () => {
    const journal = memoryJournal({ fenced: true });
    return {
      open: () => journal,
      async close() {
        await journal.close();
      },
    };
  },
  true,
);
