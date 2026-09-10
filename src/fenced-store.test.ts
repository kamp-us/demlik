import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doStore } from "./do";
import {
  defineMachine,
  type FencedStore,
  isFencedStore,
  type Reducer,
  run,
  type Store,
  StoreConflictError,
} from "./index";
import { memoryStore } from "./mem";
import { fileStore } from "./node";

// ───────────────────────────────────────────────────────────────────────────
// FencedStore (#143) — the second live writer is refused.
//
// The defect this pins: `Store.save` is unconditional, so two processes against
// one `agent.json` both drove the same run to done and a 3-note run wrote 7
// lines. The fix is opt-in per store, so every test here comes in a pair — the
// fenced call refuses, the unfenced call is byte-for-byte what it always was.
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

describe("isFencedStore", () => {
  it("an unfenced store is not fenced — the default is untouched", () => {
    expect(isFencedStore(memoryStore<NoteState>())).toBe(false);
  });

  it("a store built with { fenced: true } narrows to FencedStore", () => {
    const store: Store<NoteState> = memoryStore<NoteState>(null, undefined, {
      fenced: true,
    });
    expect(isFencedStore(store)).toBe(true);
  });
});

describe("StoreConflictError", () => {
  it("is a throw carrying the `store_conflict` tag and both versions", () => {
    const err = new StoreConflictError(1, 4);
    expect(err).toBeInstanceOf(Error);
    expect(err._tag).toBe("store_conflict");
    expect(err.expectedVersion).toBe(1);
    expect(err.actualVersion).toBe(4);
  });
});

describe("memoryStore — fenced", () => {
  it("compare-and-swap advances on the expected version and refuses a stale one", async () => {
    const store = memoryStore<NoteState>(null, undefined, { fenced: true });

    const first = await store.loadFenced();
    expect(first).toEqual({ raw: null, version: 0 });

    const v1 = await store.saveFenced({ notes: ["a"] }, 0);
    expect(v1).toBe(1);
    await expect(store.loadFenced()).resolves.toEqual({
      raw: { notes: ["a"] },
      version: 1,
    });

    // A second writer still holding version 0 is refused, and the state it
    // tried to write is NOT there.
    await expect(store.saveFenced({ notes: ["b"] }, 0)).rejects.toBeInstanceOf(
      StoreConflictError,
    );
    await expect(store.load()).resolves.toEqual({ notes: ["a"] });
  });
});

describe("run — a fenced store refuses the second live writer", () => {
  it("the loser is refused at its first save, and `run` never starts it", async () => {
    const store = memoryStore<NoteState>(null, undefined, { fenced: true });
    // Both runs read the same version before either writes — the two-resumers
    // race, with the read taken explicitly so there is no timing to lose.
    const stale = await store.loadFenced();

    const winner = await run(noteMachine, { ctx: undefined, store }).ready;
    await winner.dispatch({ type: "note", text: "one" });

    const loser = run(noteMachine, {
      ctx: undefined,
      store: resumedAt(store, stale),
    });
    await expect(loser.ready).rejects.toBeInstanceOf(StoreConflictError);

    // The winner's state is intact — a refused boot writes nothing.
    expect(winner.getState()).toEqual({ notes: ["one"] });
    await winner.stop();
  });

  it("an UNFENCED store still lets both writers through — the documented precondition", async () => {
    const store = memoryStore<NoteState>();
    const a = await run(noteMachine, { ctx: undefined, store }).ready;
    const b = await run(noteMachine, { ctx: undefined, store }).ready;
    // No refusal anywhere: this is exactly the old behaviour, kept on purpose.
    await a.dispatch({ type: "note", text: "a" });
    await b.dispatch({ type: "note", text: "b" });
    await a.stop();
    await b.stop();
  });
});

describe("fileStore — fenced", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tea-fenced-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("two stores on one path both read version 0; exactly one save wins", async () => {
    const path = join(dir, "state.json");
    const one = fileStore(path, parseNotes, { fenced: true });
    const two = fileStore(path, parseNotes, { fenced: true });

    expect(await one.loadFenced()).toEqual({ raw: null, version: 0 });
    expect(await two.loadFenced()).toEqual({ raw: null, version: 0 });

    expect(await one.saveFenced({ notes: ["won"] }, 0)).toBe(1);
    await expect(two.saveFenced({ notes: ["lost"] }, 0)).rejects.toBeInstanceOf(
      StoreConflictError,
    );

    // The loser's bytes never landed, and the lock left no residue.
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      notes: ["won"],
    });
    expect(await readFile(`${path}.fence`, "utf8")).toBe("1");
  });

  it("the state file is the same file an unfenced store reads and writes", async () => {
    const path = join(dir, "compat.json");
    const unfenced = fileStore(path, parseNotes);
    await unfenced.save({ notes: ["written unfenced"] });

    const fenced = fileStore(path, parseNotes, { fenced: true });
    // No stamp yet: an existing file reads as version 0 and fences from there.
    expect(await fenced.loadFenced()).toEqual({
      raw: { notes: ["written unfenced"] },
      version: 0,
    });
    await fenced.saveFenced({ notes: ["now fenced"] }, 0);
    await expect(unfenced.load()).resolves.toEqual({ notes: ["now fenced"] });
  });

  it("two runs against ONE file: the second refuses, and the notes are written once", async () => {
    const path = join(dir, "agent.json");
    const notesPath = join(dir, "notes.txt");

    // The second process's read, taken before the first writes anything — the
    // "two resumers started against one agent.json" state, recorded rather
    // than raced so the test cannot flake.
    const second = fileStore(path, parseNotes, { fenced: true });
    const stale = await second.loadFenced();

    const first = await run(noteMachine, {
      ctx: undefined,
      store: fileStore(path, parseNotes, { fenced: true }),
    }).ready;
    // The notes are the side effect the duplicate worker doubled: one line per
    // transition, written by whichever process owns the run.
    first.observe((msg) => {
      appendFileSync(notesPath, `${msg.text}\n`, "utf8");
    });
    await first.dispatch({ type: "note", text: "one" });
    await first.dispatch({ type: "note", text: "two" });
    await first.dispatch({ type: "note", text: "three" });

    const loser = run(noteMachine, {
      ctx: undefined,
      store: resumedAt(second, stale),
    });
    await expect(loser.ready).rejects.toBeInstanceOf(StoreConflictError);

    await first.stop();
    // Three notes dispatched, three lines on disk — not seven.
    expect((await readFile(notesPath, "utf8")).trim().split("\n")).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("an unfenced fileStore exposes no fencing surface at all", () => {
    expect(isFencedStore(fileStore(join(dir, "plain.json"), parseNotes))).toBe(
      false,
    );
  });
});

describe("doStore — fenced", () => {
  it("compare-and-swaps inside a storage transaction and rolls a refusal back", async () => {
    const storage = fakeDoStorage();
    const one = doStore<NoteState>(storage, parseNotes, { fenced: true });
    const two = doStore<NoteState>(storage, parseNotes, { fenced: true });

    expect(await one.loadFenced()).toEqual({ raw: null, version: 0 });
    expect(await two.loadFenced()).toEqual({ raw: null, version: 0 });

    expect(await one.saveFenced({ notes: ["won"] }, 0)).toBe(1);
    await expect(two.saveFenced({ notes: ["lost"] }, 0)).rejects.toBeInstanceOf(
      StoreConflictError,
    );
    await expect(one.load()).resolves.toEqual({ notes: ["won"] });
  });

  it("an unfenced doStore is unchanged — no version cell is written", async () => {
    const storage = fakeDoStorage();
    const store = doStore<NoteState>(storage, parseNotes);
    await store.save({ notes: ["plain"] });
    expect([...storage.cells.keys()]).toEqual(["@@state"]);
    expect(isFencedStore(store)).toBe(false);
  });
});

/**
 * A fenced store as a second process holds it: same writes, but its `loadFenced`
 * answers with the version that process read when it started. That recorded read
 * is the whole difference between the two resumers — the loser's problem is not
 * that it is late, it is that it is swapping against a version the winner has
 * already moved past.
 */
function resumedAt<S>(
  store: FencedStore<S>,
  read: { readonly raw: unknown; readonly version: number },
): FencedStore<S> {
  return { ...store, loadFenced: async () => read };
}

/**
 * The slice of `DurableObjectStorage` `doStore` touches, with `transaction`
 * modelled the way the platform behaves: the closure's writes are buffered and
 * commit together, and a throw discards them.
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
