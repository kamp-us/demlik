/** A host binds one SQL row to a `RowPort`, and a request is one `run` over `rowStore`. */
import assert from "node:assert/strict";
import {
  type DeletableStore,
  defineMachine,
  type FencedStore,
  NoCellError,
  type Refusal,
  refuse,
  StoreConflictError,
} from "@demlik/tea";
import {
  type RowPort,
  type RowStoreOptions,
  rowStore,
} from "@demlik/tea/persistence";
import { run } from "@demlik/tea/promise";
import { z } from "zod";

type Ticket =
  | { readonly _tag: "open" }
  | { readonly _tag: "claimed"; readonly by: string };
type TicketMsg = { readonly _tag: "claim"; readonly by: string };

const ticket = defineMachine({
  types: { model: {} as Ticket, msg: {} as TicketMsg },
  init: (loaded) => [loaded ?? { _tag: "open" }, []],
  update: {
    open: { claim: (_state, msg) => [{ _tag: "claimed", by: msg.by }, []] },
    claimed: {},
  },
});

const columns = z.union([
  z.object({ status: z.literal("open"), claimed_by: z.null() }),
  z.object({ status: z.literal("claimed"), claimed_by: z.string() }),
]);

const options: RowStoreOptions<Ticket> = {
  parse: (row): Ticket | Refusal => {
    const parsed = columns.safeParse(row);
    if (!parsed.success) return refuse("not a ticket row");
    return parsed.data.status === "open"
      ? { _tag: "open" }
      : { _tag: "claimed", by: parsed.data.claimed_by };
  },
  encode: (state) => ({
    status: state._tag,
    claimed_by: state._tag === "claimed" ? state.by : null,
  }),
  fenced: true,
};

type Cell = { row: Record<string, unknown>; revision: number };

/** The host's side: one table, one row id, one SQL statement per call. */
function boundRow(table: Map<string, Cell>, id: string): RowPort {
  return {
    read: async () => table.get(id) ?? null,
    insert: async (cols) => {
      if (table.has(id)) return false;
      table.set(id, { row: { ...cols }, revision: 1 });
      return true;
    },
    update: async (cols, expected) => {
      if (table.get(id)?.revision !== expected) return false;
      table.set(id, { row: { ...cols }, revision: expected + 1 });
      return true;
    },
    remove: async () => {
      table.delete(id);
    },
  };
}

export function unfenced(port: RowPort) {
  // @ts-expect-error there is no unfenced form: `fenced` is required
  rowStore(port, { parse: options.parse, encode: options.encode });
  // @ts-expect-error `fenced: false` is not the fenced form
  rowStore(port, { ...options, fenced: false });
}

const table = new Map<string, Cell>();
table.set("t1", { row: { status: "open", claimed_by: null }, revision: 1 });
const store: FencedStore<Ticket> & DeletableStore<Ticket> = rowStore(
  boundRow(table, "t1"),
  options,
);

async function request(by: string): Promise<void> {
  const booting = run(ticket, {
    store: rowStore(boundRow(table, "t1"), options),
    boot: "restored",
    onError: () => {},
  });
  const rt = await booting.ready;
  try {
    await rt.dispatch({ _tag: "claim", by });
  } finally {
    await rt.stop();
  }
}

await request("w1");
assert.deepEqual(table.get("t1"), {
  row: { status: "claimed", claimed_by: "w1" },
  revision: 2,
});
await assert.rejects(request("w2"), NoCellError);
assert.equal(table.get("t1")?.revision, 2);

assert.deepEqual(await store.loadFenced(), {
  raw: { status: "claimed", claimed_by: "w1" },
  version: 2,
});
await assert.rejects(
  store.saveFenced({ _tag: "open" }, 1),
  (error: unknown) =>
    error instanceof StoreConflictError &&
    error.expectedVersion === 1 &&
    error.actualVersion === 2,
);
await store.delete();
assert.equal(await store.load(), null);
console.log(
  "verify-exports: rowStore moves one row once and refuses a stale writer",
);
