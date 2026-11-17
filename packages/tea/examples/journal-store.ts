/** A host driver using only the published journal types and durable-log factory. */
import assert from "node:assert/strict";
import { defineMachine } from "@demlik/tea";
import { memoryJournal } from "@demlik/tea/mem";
import {
  eventSourcedStore,
  type Journal,
  type JournalAppend,
  type JournalRead,
  type JournalRefusal,
} from "@demlik/tea/persistence";
import { run } from "@demlik/tea/promise";
import { z } from "zod";

function hostJournal(retained: Map<string, string[]>): Journal {
  let closed = false;
  const refusal = (): JournalRefusal => ({
    _tag: "journal_corrupt",
    message: "Journal is closed",
  });
  return {
    async read(stream, after): Promise<JournalRead | JournalRefusal> {
      if (closed) return refusal();
      const records = retained.get(stream) ?? [];
      return {
        _tag: "read",
        head: records.length,
        entries: records.flatMap((record, index) =>
          index + 1 > after ? [{ seq: index + 1, record }] : [],
        ),
      };
    },
    async append(stream, records): Promise<JournalAppend | JournalRefusal> {
      if (closed) return refusal();
      const prior = retained.get(stream) ?? [];
      const entries = records.map((record, index) => ({
        seq: prior.length + index + 1,
        record,
      }));
      retained.set(stream, [...prior, ...records]);
      return { _tag: "appended", head: prior.length + records.length, entries };
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
const retained = new Map<string, string[]>();
await closeAndReopen("host-authored Journal", () => hostJournal(retained));
