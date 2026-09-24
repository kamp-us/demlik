import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doStore } from "./do";
import {
  type DeletableStore,
  defineMachine,
  type FencedStore,
  type Reducer,
  type Store,
  StoreConflictError,
} from "./index";
import { memoryStore } from "./mem";
import { fileStore } from "./node";
import { run } from "./promise";

// ───────────────────────────────────────────────────────────────────────────
// DeletableStore (#314) — a host forgets a run through the store itself.
//
// Every shipped factory runs the same contract, fenced and unfenced, so the
// suite is one table of factories driven through one set of cases.
// ───────────────────────────────────────────────────────────────────────────

type NoteState = { readonly notes: readonly string[] };
type NoteMsg = { readonly type: "note"; readonly text: string };

function parseNotes(raw: unknown): NoteState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const notes = (raw as Record<string, unknown>).notes;
  return Array.isArray(notes) && notes.every((n) => typeof n === "string")
    ? { notes: notes as readonly string[] }
    : null;
}

const update: Reducer<NoteState, NoteMsg, never> = {
  note: (state, msg) => [{ notes: [...state.notes, msg.text] }, []],
};

const noteMachine = defineMachine({
  types: { model: {} as NoteState, msg: {} as NoteMsg, ctx: undefined },
  init: (loaded) => [loaded ?? { notes: [] }, []],
  update,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tea-deletable-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Each shipped factory, in both forms. */
type Factory = {
  readonly name: string;
  readonly unfenced: () => DeletableStore<NoteState>;
  readonly fenced: () => FencedStore<NoteState> & DeletableStore<NoteState>;
};

const factories: readonly Factory[] = [
  {
    name: "memoryStore",
    unfenced: () => memoryStore<NoteState>(),
    fenced: () => memoryStore<NoteState>(null, undefined, { fenced: true }),
  },
  {
    name: "fileStore",
    unfenced: () => fileStore(join(dir, "state.json"), parseNotes),
    fenced: () =>
      fileStore(join(dir, "state.json"), parseNotes, { fenced: true }),
  },
  {
    name: "doStore",
    unfenced: () => doStore<NoteState>(fakeDoStorage(), parseNotes),
    fenced: () =>
      doStore<NoteState>(fakeDoStorage(), parseNotes, { fenced: true }),
  },
];

describe.each(factories)("$name — delete()", (factory) => {
  describe.each([
    ["unfenced", factory.unfenced],
    ["fenced", factory.fenced],
  ] as const)("%s", (_form, make) => {
    it("resolves on a store with nothing saved", async () => {
      const store = make();
      await expect(store.delete()).resolves.toBeUndefined();
      await expect(store.delete()).resolves.toBeUndefined();
    });

    it("leaves load() answering what a never-saved store answers", async () => {
      const neverSaved = await make().load();
      const store = make();
      await store.save({ notes: ["a"] });
      await store.delete();
      await expect(store.load()).resolves.toEqual(neverSaved);
    });

    it("lets an unfenced save write the state again", async () => {
      const store = make();
      await store.save({ notes: ["before"] });
      await store.delete();
      await store.save({ notes: ["after"] });
      await expect(store.load()).resolves.toEqual({ notes: ["after"] });
    });

    it("lets the next run boot fresh", async () => {
      const store = make();
      const first = await run(noteMachine, { ctx: undefined, store }).ready;
      await first.dispatch({ type: "note", text: "old" });
      await first.stop();

      await store.delete();
      const next = await run(noteMachine, { ctx: undefined, store }).ready;
      expect(next.getState()).toEqual({ notes: [] });
      await next.stop();
    });
  });

  it("refuses a fenced run that saves after delete()", async () => {
    const store = factory.fenced();
    const live = await run(noteMachine, { ctx: undefined, store }).ready;
    await live.dispatch({ type: "note", text: "one" });

    await store.delete();

    await expect(
      live.dispatch({ type: "note", text: "two" }),
    ).rejects.toBeInstanceOf(StoreConflictError);
  });
});

describe("fileStore — delete() removes both files", () => {
  it.each([
    ["unfenced", undefined],
    ["fenced", { fenced: true } as const],
  ] as const)("%s", async (_form, options) => {
    const path = join(dir, "agent.json");
    // Write fenced so the `.fence` sidecar exists either way: an unfenced
    // store opened on a fenced file must not leave the stamp behind.
    await fileStore(path, parseNotes, { fenced: true }).saveFenced(
      { notes: ["a"] },
      0,
    );
    await expect(access(`${path}.fence`)).resolves.toBeUndefined();

    await fileStore(path, parseNotes, options).delete();

    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${path}.fence`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(`${path}.fence.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("doStore — delete() removes both cells", () => {
  it.each([
    ["unfenced", {}],
    ["fenced", { fenced: true } as const],
  ] as const)("%s", async (_form, options) => {
    const storage = fakeDoStorage();
    await doStore<NoteState>(storage, parseNotes, {
      fenced: true,
    }).saveFenced({ notes: ["a"] }, 0);
    expect([...storage.cells.keys()].sort()).toEqual([
      "@@state",
      "@@state@@version",
    ]);

    await doStore<NoteState>(storage, parseNotes, options).delete();
    expect([...storage.cells.keys()]).toEqual([]);
  });
});

it("Store<S> stays assignable from a store with no delete", () => {
  // The widening is optional: an implementor without `delete` is still a Store.
  const plain: Store<NoteState> = {
    load: async () => null,
    save: async () => {},
    migrate: parseNotes,
  };
  expect("delete" in plain).toBe(false);
});

/**
 * The slice of `DurableObjectStorage` `doStore` touches: `get`, `put`, a
 * multi-key `delete`, and a `transaction` whose writes commit together.
 */
function fakeDoStorage(): {
  cells: Map<string, unknown>;
} & DurableObjectStorage {
  const cells = new Map<string, unknown>();
  const api = {
    cells,
    async get<T>(key: string): Promise<T | undefined> {
      return cells.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      cells.set(key, value);
    },
    async delete(keys: string | string[]): Promise<boolean | number> {
      const list = Array.isArray(keys) ? keys : [keys];
      let removed = 0;
      for (const key of list) if (cells.delete(key)) removed += 1;
      return Array.isArray(keys) ? removed : removed === 1;
    },
    async transaction<T>(closure: (txn: unknown) => Promise<T>): Promise<T> {
      const staged = new Map<string, unknown>();
      const txn = {
        async get<T2>(key: string): Promise<T2 | undefined> {
          return (staged.has(key) ? staged.get(key) : cells.get(key)) as
            | T2
            | undefined;
        },
        async put(key: string, value: unknown): Promise<void> {
          staged.set(key, value);
        },
      };
      const result = await closure(txn);
      for (const [key, value] of staged) cells.set(key, value);
      return result;
    },
  };
  return api as unknown as {
    cells: Map<string, unknown>;
  } & DurableObjectStorage;
}
