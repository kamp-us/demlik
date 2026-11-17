/** A host driver using only the published journal types and durable-log factory. */
import assert from "node:assert/strict";
import { defineMachine } from "@demlik/tea";
import { memoryJournal } from "@demlik/tea/mem";
import {
  type JournalKitFactory,
  type JournalKitFixture,
  journalConformance,
  type KitOptions,
  type KitResult,
} from "@demlik/tea/pbt";
import {
  eventSourcedStore,
  type Journal,
  type JournalAppend,
  type JournalEntry,
  type JournalRead,
  type JournalRefusal,
} from "@demlik/tea/persistence";
import { run } from "@demlik/tea/promise";
import { z } from "zod";

type StoredBatch = {
  readonly head: number;
  readonly entries: readonly JournalEntry[];
  readonly previous: StoredBatch | undefined;
};

function hostJournal(retained: Map<string, StoredBatch>): Journal {
  let closed = false;
  const refusal = (): JournalRefusal => ({
    _tag: "journal_corrupt",
    message: "Journal is closed",
  });
  return {
    async read(stream, after): Promise<JournalRead | JournalRefusal> {
      if (closed) return refusal();
      const latest = retained.get(stream);
      const batches: (readonly JournalEntry[])[] = [];
      for (let batch = latest; batch; batch = batch.previous) {
        if (batch.head <= after) break;
        batches.push(batch.entries.filter((entry) => entry.seq > after));
      }
      return {
        _tag: "read",
        head: latest?.head ?? 0,
        entries: batches.reverse().flat(),
      };
    },
    async append(stream, records): Promise<JournalAppend | JournalRefusal> {
      if (closed) return refusal();
      const previous = retained.get(stream);
      const head = previous?.head ?? 0;
      const entries = records.map((record, index) => ({
        seq: head + index + 1,
        record,
      }));
      try {
        retained.set(stream, {
          head: head + records.length,
          entries,
          previous,
        });
        return { _tag: "appended", head: head + records.length, entries };
      } catch (error) {
        return {
          _tag: "journal_io",
          operation: "append",
          message: String(error),
          uncertain: true,
        };
      }
    },
    async close() {
      closed = true;
    },
  };
}

const schemas = {
  state: z.object({ n: z.number() }),
  message: z.object({ _tag: z.literal("increment") }),
  command: z.never(),
};
async function closeAndReopen(
  name: string,
  open: () => Journal,
): Promise<void> {
  let births = 0;
  let reductions = 0;
  const machine = defineMachine({
    types: {
      model: {} as z.infer<typeof schemas.state>,
      msg: {} as z.infer<typeof schemas.message>,
    },
    init: () => {
      births += 1;
      return [{ n: 0 }, []];
    },
    update: {
      increment: (state) => {
        reductions += 1;
        return [{ n: state.n + 1 }, []];
      },
    },
  });
  const first = open();
  const live = await run(machine, { store: eventSourcedStore(first, schemas) })
    .ready;
  await live.dispatch({ _tag: "increment" }, { id: "one" });
  assert.deepEqual(live.getState(), { n: 1 });
  await live.stop();
  await first.close();
  const reopened = open();
  const wake = await run(machine, {
    store: eventSourcedStore(reopened, schemas),
  }).ready;
  assert.deepEqual(wake.getState(), { n: 1 });
  assert.equal(births, 1);
  assert.equal(reductions, 1);
  await wake.dispatch({ _tag: "increment" }, { id: "one" });
  assert.deepEqual(wake.getState(), { n: 1 });
  assert.equal(reductions, 1);
  await wake.stop();
  await reopened.close();
  console.log(
    `verify-exports: ${name} recovers saved State after close/reopen`,
  );
}
const memory = memoryJournal();
await closeAndReopen("published memoryJournal", () => memory);
const retained = new Map<string, StoredBatch>();
await closeAndReopen("host-authored Journal", () => hostJournal(retained));

// The fixture interrupts the storage commit itself, before or after its atomic set.
const hostFixture =
  (decorate: (driver: Journal) => Journal): JournalKitFactory =>
  async (): Promise<JournalKitFixture> => {
    let cut: number | undefined;
    const storage = new (class extends Map<string, StoredBatch> {
      override set(stream: string, batch: StoredBatch): this {
        if (cut === 0) throw new Error("interrupted before commit");
        super.set(stream, batch);
        if (cut === 1) throw new Error("interrupted after commit");
        return this;
      }
    })();
    const opened = new Set<Journal>();
    return {
      byteFile: false,
      async open() {
        const driver = decorate(hostJournal(storage));
        opened.add(driver);
        return driver;
      },
      interruptAt(point) {
        cut = point;
      },
      writePoints: () => [0, 1],
      async dispose() {
        for (const driver of opened) await driver.close();
        storage.clear();
      },
    };
  };

const kitOptions: KitOptions = {
  records: 1000,
  now: () => performance.now(),
};
const correct: readonly KitResult[] = await journalConformance(
  hostFixture((driver) => driver),
  kitOptions,
);
for (const result of correct)
  console.log(`host journal: ${result.id} ${result.status}`);
assert.equal(correct.length, 8);
assert.ok(
  correct.every(({ status }) => status === "passed" || status === "skipped"),
);
for (const id of ["K1", "K2", "K3"] as const) {
  assert.equal(correct.find((result) => result.id === id)?.status, "passed");
}

const broken = await journalConformance(
  hostFixture((driver) => ({
    ...driver,
    append: (stream, records) => driver.append(stream, [records[0]]),
  })),
  kitOptions,
);
const failures = broken.filter(({ status }) => status === "failed");
for (const result of broken)
  console.log(`broken journal: ${result.id} ${result.status}`);
assert.ok(
  failures.length > 0,
  "the batch-dropping driver must fail a named case",
);
assert.ok(
  failures.some(({ id }) => id === "K1"),
  "K1 must detect the dropped batch tail",
);
console.log(
  `broken journal: failed cases ${failures.map(({ id }) => id).join(", ")}`,
);
