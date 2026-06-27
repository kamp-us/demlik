/**
 * Event-sourced `doEventSourcedStore` — property + example tests.
 *
 * The load-bearing property (recovery.md / ADR 0003): rebuilding state by
 * folding the log on the latest snapshot after a simulated DO eviction yields
 * the SAME state as (a) the never-evicted live runtime and (b) a snapshot-only
 * fold of the same Msg sequence. The fold is the substrate's `replay`, so this
 * is true by construction; the property tests guard the storage/seq/snapshot
 * plumbing around it.
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported
 * explicitly, matching the rest of the package's test files.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineMachine, type Reducer, replay, run } from "../index";
import { arbMsg, arbMsgSequence, type MsgArbitraryTable } from "../pbt";
import { doEventSourcedStore } from "./event-sourced-store";

// ── A tiny counter machine with a few Msg variants. ─────────────────────────
// State folds every Msg, so an arbitrary Msg sequence exercises a real fold
// (not a no-op log). `init`'s rehydrate branch is a pure passthrough (TEA
// invariant 2): a non-null `loaded` is returned as-is with no cmds.

interface State {
  readonly type: "counting";
  readonly count: number;
  readonly log: readonly string[];
}

type Msg =
  | { type: "inc"; by: number }
  | { type: "dec"; by: number }
  | { type: "reset" }
  | { type: "note"; text: string };

const update: Reducer<State, Msg, never> = {
  inc: (s, m) => [{ ...s, count: s.count + m.by }, []],
  dec: (s, m) => [{ ...s, count: s.count - m.by }, []],
  reset: (s) => [{ ...s, count: 0 }, []],
  note: (s, m) => [{ ...s, log: [...s.log, m.text] }, []],
};

function counter() {
  return defineMachine<State, Msg, never, never, Record<string, never>>({
    init: (loaded) => [loaded ?? { type: "counting", count: 0, log: [] }, []],
    update,
    subscribe: {},
  });
}

const ctx: Record<string, never> = {};

// ── In-memory `DurableObjectStorage` fake. ──────────────────────────────────
// Backs the three methods the store touches (get/put/list). The backing Map is
// returned so a test can build a SECOND store over the SAME bytes — that is the
// eviction/rehydrate simulation (the isolate dies, the storage survives).

function fakeStorage(backing: Map<string, string> = new Map()) {
  const storage = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return backing.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      backing.set(key, value as unknown as string);
    },
    async list<T = unknown>(options?: {
      prefix?: string;
    }): Promise<Map<string, T>> {
      const prefix = options?.prefix ?? "";
      const out = new Map<string, T>();
      // Real DO list() returns keys in lexicographic order.
      for (const key of [...backing.keys()].sort()) {
        if (key.startsWith(prefix)) out.set(key, backing.get(key) as T);
      }
      return out;
    },
  };
  // Only get/put/list are exercised; cast through unknown for the rest.
  return {
    backing,
    storage: storage as unknown as DurableObjectStorage,
  };
}

// Drive a fresh runtime with an event-sourced store over `backing`, dispatch
// every msg, return the live final state. `onReady` counts are captured.
async function liveRun(
  backing: Map<string, string>,
  msgs: readonly Msg[],
  snapshotEvery: number,
): Promise<{ state: State; readyCalls: number }> {
  const { storage } = fakeStorage(backing);
  let readyCalls = 0;
  const es = doEventSourcedStore<State, Msg, typeof ctx>(
    storage,
    counter(),
    ctx,
    { snapshotEvery, onReady: () => readyCalls++ },
  );
  const runtime = await run(counter(), { ctx, store: es.store }).ready;
  // Append every applied (non-null) msg to the log — the documented wiring.
  // The runtime's observe is sync (it can't await us), so we collect the
  // append promises and await them after dispatch to make the test
  // deterministic. In production the DO turn keeps the isolate alive until
  // these settle; here we make that explicit.
  const appends: Promise<void>[] = [];
  runtime.observe((msg) => {
    if (msg !== null) appends.push(es.append(msg));
  });
  await runtime.ready;
  for (const m of msgs) await runtime.dispatch(m);
  await Promise.all(appends);
  const state = runtime.getState();
  await runtime.stop();
  return { state, readyCalls };
}

// Simulate eviction + rehydrate: a brand-new store over the SAME backing bytes.
// Its load() folds snapshot + log. Returns the rebuilt state + onReady count.
async function rehydrate(
  backing: Map<string, string>,
  snapshotEvery: number,
): Promise<{ state: State | null; readyCalls: number }> {
  const { storage } = fakeStorage(backing);
  let readyCalls = 0;
  const es = doEventSourcedStore<State, Msg, typeof ctx>(
    storage,
    counter(),
    ctx,
    { snapshotEvery, onReady: () => readyCalls++ },
  );
  const raw = await es.store.load();
  const state = es.store.migrate(raw);
  return { state, readyCalls };
}

// Snapshot-only oracle: fold the whole Msg sequence from a fresh init, no
// storage at all. This is what `doStore` would reconstruct.
function snapshotOnlyFold(msgs: readonly Msg[]): State {
  return replay(counter(), { msgs, ctx, loaded: null }).state;
}

// ── Arbitraries. ────────────────────────────────────────────────────────────

const msgTable: MsgArbitraryTable<Msg> = {
  inc: fc.record({
    type: fc.constant<"inc">("inc"),
    by: fc.integer({ min: 0, max: 1000 }),
  }),
  dec: fc.record({
    type: fc.constant<"dec">("dec"),
    by: fc.integer({ min: 0, max: 1000 }),
  }),
  reset: fc.constant({ type: "reset" as const }),
  note: fc.record({
    type: fc.constant<"note">("note"),
    text: fc.string(),
  }),
};
const arbMsgs = (max: number) =>
  arbMsgSequence(arbMsg(msgTable), { minLength: 0, maxLength: max });

// ── Property: rebuilt-by-fold == live == snapshot-only. ─────────────────────

describe("doEventSourcedStore — eviction equivalence", () => {
  it("rebuild after eviction equals live and equals snapshot-only fold", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbMsgs(40),
        // snapshotEvery small enough that a 40-long log crosses several
        // snapshot boundaries — exercises the snapshot+tail replay path.
        fc.integer({ min: 1, max: 12 }),
        async (msgs, snapshotEvery) => {
          const backing = new Map<string, string>();
          const live = await liveRun(backing, msgs, snapshotEvery);
          const rebuilt = await rehydrate(backing, snapshotEvery);
          const oracle = snapshotOnlyFold(msgs);

          // (a) rebuilt-by-fold == never-evicted live state
          expect(rebuilt.state).toEqual(live.state);
          // (b) rebuilt-by-fold == snapshot-only fold of the same msgs
          expect(rebuilt.state).toEqual(oracle);
          // ready signal fired exactly once per activation
          expect(live.readyCalls).toBe(1);
          expect(rebuilt.readyCalls).toBe(1);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("rebuild is stable across repeated evictions (idempotent fold)", async () => {
    await fc.assert(
      fc.asyncProperty(arbMsgs(30), async (msgs) => {
        const backing = new Map<string, string>();
        await liveRun(backing, msgs, 5);
        const first = await rehydrate(backing, 5);
        const second = await rehydrate(backing, 5);
        expect(second.state).toEqual(first.state);
        // each activation fires its own single ready signal
        expect(first.readyCalls).toBe(1);
        expect(second.readyCalls).toBe(1);
      }),
      { numRuns: 40 },
    );
  });
});

// ── Coverage: the named boundary cases. ─────────────────────────────────────

describe("doEventSourcedStore — boundary cases", () => {
  it("empty log: fresh actor still fires the ready signal once", async () => {
    const backing = new Map<string, string>();
    const live = await liveRun(backing, [], 10);
    expect(live.state).toEqual({ type: "counting", count: 0, log: [] });
    expect(live.readyCalls).toBe(1);

    // A rehydrate over the (now still effectively empty) store also fires once.
    const rebuilt = await rehydrate(backing, 10);
    expect(rebuilt.readyCalls).toBe(1);
    // No snapshot, no events → fold starts fresh; migrate(null) → null (boot
    // fresh path), which is the snapshot-only oracle for an empty sequence.
    expect(rebuilt.state ?? { type: "counting", count: 0, log: [] }).toEqual({
      type: "counting",
      count: 0,
      log: [],
    });
  });

  it("snapshot+log boundary: log shorter than one interval replays cleanly", async () => {
    // snapshotEvery=10, only 3 events: no snapshot ever taken, pure-log replay.
    const backing = new Map<string, string>();
    const msgs: Msg[] = [
      { type: "inc", by: 5 },
      { type: "note", text: "a" },
      { type: "dec", by: 2 },
    ];
    const live = await liveRun(backing, msgs, 10);
    const rebuilt = await rehydrate(backing, 10);
    expect(rebuilt.state).toEqual(live.state);
    expect(rebuilt.state).toEqual(snapshotOnlyFold(msgs));
    expect(rebuilt.state).toEqual({
      type: "counting",
      count: 3,
      log: ["a"],
    });
    // No snapshot cell was written.
    expect(backing.has("@@es/snapshot")).toBe(false);
  });

  it("log longer than one snapshot interval: snapshot bounds replay tail", async () => {
    // snapshotEvery=4, 13 events: snapshots at seq 4, 8, 12 — recovery folds
    // the latest snapshot (seq 12) + 1 tail event. Result must still match the
    // full fold.
    const backing = new Map<string, string>();
    const msgs: Msg[] = Array.from({ length: 13 }, (_, i) => ({
      type: "inc" as const,
      by: i + 1,
    }));
    const live = await liveRun(backing, msgs, 4);
    const rebuilt = await rehydrate(backing, 4);

    // A snapshot cell exists, and it covers seq 12 (the last 4-boundary).
    const snapRaw = backing.get("@@es/snapshot");
    expect(snapRaw).toBeDefined();
    const snap = JSON.parse(snapRaw as string) as { seq: number };
    expect(snap.seq).toBe(12);

    const expected = 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13; // 91
    expect(live.state.count).toBe(expected);
    expect(rebuilt.state).toEqual(live.state);
    expect(rebuilt.state).toEqual(snapshotOnlyFold(msgs));
  });

  it("snapshotEvery must be a positive integer", () => {
    const { storage } = fakeStorage();
    expect(() =>
      doEventSourcedStore(storage, counter(), ctx, { snapshotEvery: 0 }),
    ).toThrow(/snapshotEvery/);
    expect(() =>
      doEventSourcedStore(storage, counter(), ctx, { snapshotEvery: 1.5 }),
    ).toThrow(/snapshotEvery/);
  });
});

// ── Public log reader: readEvents (the #198 read-side surface). ──────────────
// The CQRS read of the append-only write model: a consumer streams the
// persisted log in seq order, optionally bounded, WITHOUT mirroring the private
// `@@es/evt/` key convention. Backed by the same DI'd fake storage.

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

// A reader-only store over already-persisted bytes — the eviction/replay shape:
// the live actor that wrote the log is gone; a fresh handle reads it back.
function readerOver(backing: Map<string, string>, snapshotEvery = 100) {
  const { storage } = fakeStorage(backing);
  return doEventSourcedStore<State, Msg, typeof ctx>(storage, counter(), ctx, {
    snapshotEvery,
  });
}

// Five distinct events the counter applies, so each lands as one log cell at
// seqs 1..5 in dispatch order.
const sampleMsgs: Msg[] = [
  { type: "inc", by: 1 },
  { type: "inc", by: 2 },
  { type: "note", text: "x" },
  { type: "dec", by: 1 },
  { type: "reset" },
];

describe("doEventSourcedStore — readEvents (public log reader)", () => {
  it("reads every event in seq order, 1-based and gap-free", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, sampleMsgs, 100);

    const rows = await collect(readerOver(backing).readEvents());

    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.event)).toEqual(sampleMsgs);
  });

  it("empty log yields nothing", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, [], 100); // fresh actor, no events appended

    expect(await collect(readerOver(backing).readEvents())).toEqual([]);
    // explicit range over an empty log is also empty
    expect(
      await collect(readerOver(backing).readEvents({ fromSeq: 1, toSeq: 10 })),
    ).toEqual([]);
  });

  it("respects an inclusive fromSeq lower bound", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, sampleMsgs, 100);

    const rows = await collect(readerOver(backing).readEvents({ fromSeq: 3 }));
    expect(rows.map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(rows.map((r) => r.event)).toEqual(sampleMsgs.slice(2));
  });

  it("respects an inclusive toSeq upper bound", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, sampleMsgs, 100);

    const rows = await collect(readerOver(backing).readEvents({ toSeq: 2 }));
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows.map((r) => r.event)).toEqual(sampleMsgs.slice(0, 2));
  });

  it("respects a bounded [fromSeq, toSeq] window (both inclusive)", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, sampleMsgs, 100);

    const rows = await collect(
      readerOver(backing).readEvents({ fromSeq: 2, toSeq: 4 }),
    );
    expect(rows.map((r) => r.seq)).toEqual([2, 3, 4]);
  });

  it("an entirely out-of-range window yields nothing", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, sampleMsgs, 100);

    expect(
      await collect(readerOver(backing).readEvents({ fromSeq: 10 })),
    ).toEqual([]);
    expect(
      await collect(readerOver(backing).readEvents({ fromSeq: 4, toSeq: 2 })),
    ).toEqual([]);
  });

  it("reads across snapshot boundaries — the log is never truncated by snapshotting", async () => {
    // snapshotEvery=4 over 13 events takes snapshots at seq 4, 8, 12; the reader
    // must still surface ALL 13 events (a snapshot bounds replay, not the log).
    const backing = new Map<string, string>();
    const msgs: Msg[] = Array.from({ length: 13 }, (_, i) => ({
      type: "inc" as const,
      by: i + 1,
    }));
    await liveRun(backing, msgs, 4);
    // a snapshot cell exists, proving we crossed a boundary
    expect(backing.has("@@es/snapshot")).toBe(true);

    const rows = await collect(readerOver(backing).readEvents());
    expect(rows.map((r) => r.seq)).toEqual(
      Array.from({ length: 13 }, (_, i) => i + 1),
    );
    expect(rows.map((r) => r.event)).toEqual(msgs);
  });

  it("drops events whose parseEvent returns null (a retired Msg variant)", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, sampleMsgs, 100);

    // A reader that no longer recognizes `reset` (seq 5) drops it, leaving a gap.
    const { storage } = fakeStorage(backing);
    const reader = doEventSourcedStore<State, Msg, typeof ctx>(
      storage,
      counter(),
      ctx,
      {
        parseEvent: (raw) => {
          const m = raw as { type?: unknown };
          if (m?.type === "reset") return null;
          return typeof m?.type === "string" ? (raw as Msg) : null;
        },
      },
    );

    const rows = await collect(reader.readEvents());
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]); // seq 5 (reset) dropped
    expect(rows.some((r) => r.event.type === "reset")).toBe(false);
  });

  it("is read-only — streaming the log mutates no storage", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, sampleMsgs, 100);
    const before = new Map(backing);

    await collect(readerOver(backing).readEvents());
    await collect(readerOver(backing).readEvents({ fromSeq: 2, toSeq: 3 }));

    expect(backing.size).toBe(before.size);
    for (const [k, v] of before) expect(backing.get(k)).toBe(v);
  });
});
