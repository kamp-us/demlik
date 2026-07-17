import { describe, expect, it } from "vitest";
import { defineMachine, type Reducer, run, type Store } from "../index";
import { memoryStore } from "./index";

// ───────────────────────────────────────────────────────────────────────────
// @demlik/tea/mem — the standard test Store. Until now it was only exercised
// transitively through other suites; these tests pin its own contract:
// save→load round-trip, seed semantics, reference (not clone) semantics, the
// permissive identity migrate default, and the strict-parse override. The
// final block is the vertical tracer: state written through the store by a
// real `run()` is read back by a second `run()` over the same store.
// ───────────────────────────────────────────────────────────────────────────

type CounterState = { readonly n: number };
type CounterMsg = { readonly type: "inc" };

function counterMachine() {
  const update: Reducer<CounterState, CounterMsg, never> = {
    inc: (s) => [{ n: s.n + 1 }, []],
  };
  return defineMachine<CounterState, CounterMsg, never, never, undefined>({
    // Rehydrate contract: loaded !== null MUST return [loaded, []].
    init: (loaded) => [loaded ?? { n: 0 }, []],
    update,
  });
}

function parseCounter(raw: unknown): CounterState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const n = (raw as Record<string, unknown>).n;
  return typeof n === "number" ? { n } : null;
}

describe("memoryStore: save → load round-trip", () => {
  it("load() returns exactly the value the last save() wrote", async () => {
    const store = memoryStore<CounterState>();
    await store.save({ n: 5 });
    await expect(store.load()).resolves.toEqual({ n: 5 });

    // A later save overwrites — load reflects the newest write, not the first.
    await store.save({ n: 9 });
    await expect(store.load()).resolves.toEqual({ n: 9 });
  });

  it("load() resolves null before the first save (no seed)", async () => {
    await expect(memoryStore<CounterState>().load()).resolves.toBeNull();
    await expect(memoryStore<CounterState>(null).load()).resolves.toBeNull();
  });

  it("a concrete seed is served by load() until overwritten", async () => {
    const store = memoryStore<CounterState>({ n: 42 });
    await expect(store.load()).resolves.toEqual({ n: 42 });
    await store.save({ n: 43 });
    await expect(store.load()).resolves.toEqual({ n: 43 });
  });

  it("has reference semantics, not deep-clone semantics (documented contract)", async () => {
    const store = memoryStore<{ items: string[] }>();
    const saved = { items: ["a"] };
    await store.save(saved);

    const loaded = (await store.load()) as { items: string[] };
    expect(loaded).toBe(saved); // the SAME reference, not a copy

    // Mutations through the caller's reference are observable on re-load.
    saved.items.push("b");
    expect(((await store.load()) as { items: string[] }).items).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("memoryStore: migrate (the Store<S> boundary parse)", () => {
  it("defaults to identity — whatever was stored comes back as S", () => {
    const store = memoryStore<CounterState>();
    expect(store.migrate({ n: 7 })).toEqual({ n: 7 });
  });

  it("an explicit parse overrides the identity default and can reject", () => {
    const store = memoryStore<CounterState>(undefined, parseCounter);
    expect(store.migrate({ n: 3 })).toEqual({ n: 3 });
    expect(store.migrate({ bogus: true })).toBeNull();
    expect(store.migrate("not even an object")).toBeNull();
  });
});

describe("memoryStore through a real run() — the round-trip tracer", () => {
  it("state persisted by one runtime rehydrates a second runtime over the same store", async () => {
    const store: Store<CounterState> = memoryStore<CounterState>(
      undefined,
      parseCounter,
    );

    // First life: boot fresh (store empty), advance to n = 3, stop.
    const first = await run(counterMachine(), { ctx: undefined, store }).ready;
    await first.dispatch({ type: "inc" });
    await first.dispatch({ type: "inc" });
    await first.dispatch({ type: "inc" });
    expect(first.getState()).toEqual({ n: 3 });
    await first.stop();

    // The store now holds the round-tripped value — assert it directly, not
    // just through the second runtime.
    await expect(store.load()).resolves.toEqual({ n: 3 });

    // Second life: same store, fresh runtime. init receives the loaded state
    // (migrate parsed it) and boots at n = 3, not 0.
    const second = await run(counterMachine(), { ctx: undefined, store }).ready;
    expect(second.getState()).toEqual({ n: 3 });

    // And it keeps counting from where the first life left off.
    await second.dispatch({ type: "inc" });
    expect(second.getState()).toEqual({ n: 4 });
    await second.stop();
    await expect(store.load()).resolves.toEqual({ n: 4 });
  });

  it("a seeded store rehydrates the very first runtime (no prior save needed)", async () => {
    const store = memoryStore<CounterState>({ n: 10 }, parseCounter);
    const runtime = await run(counterMachine(), { ctx: undefined, store })
      .ready;
    expect(runtime.getState()).toEqual({ n: 10 });
    await runtime.stop();
  });

  it("a seed the parse rejects boots fresh (migrate → null → init(null))", async () => {
    // Hand-seed the cell with a shape parseCounter rejects. migrate returns
    // null, so the substrate boots init(null) — n = 0, never the bad shape.
    const store = memoryStore<CounterState>(
      { bogus: true } as unknown as CounterState,
      parseCounter,
    );
    const runtime = await run(counterMachine(), { ctx: undefined, store })
      .ready;
    expect(runtime.getState()).toEqual({ n: 0 });
    await runtime.stop();
  });
});
