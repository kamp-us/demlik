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

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { build } from "vite";
import { describe, expect, it, vi } from "vitest";
import { fakeDoStorage as fakeStorage } from "../__fixtures__/do-storage";
import {
  defineMachine,
  type Reducer,
  replay,
  StoreRefusedError,
  type Transitions,
} from "../index";
import { arbMsg, arbMsgSequence, type MsgArbitraryTable } from "../pbt";
import { run } from "../promise";
import {
  doEventLogReader,
  doEventSourcedStore,
  RestoreInterruptedError,
} from "./index";

// ── A tiny counter machine with a few Msg variants. ─────────────────────────
// State folds every Msg, so an arbitrary Msg sequence exercises a real fold
// (not a no-op log). This counter chooses passive restored initialization.

interface State {
  readonly _tag: "counting";
  readonly count: number;
  readonly log: readonly string[];
}

type Msg =
  | { _tag: "inc"; by: number }
  | { _tag: "dec"; by: number }
  | { _tag: "reset" }
  | { _tag: "note"; text: string };

const update: Reducer<State, Msg, never> = {
  inc: (s, m) => [{ ...s, count: s.count + m.by }, []],
  dec: (s, m) => [{ ...s, count: s.count - m.by }, []],
  reset: (s) => [{ ...s, count: 0 }, []],
  note: (s, m) => [{ ...s, log: [...s.log, m.text] }, []],
};

function counter() {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      ctx: {} as Record<string, never>,
    },
    init: (loaded) => [loaded ?? { _tag: "counting", count: 0, log: [] }, []],
    update,
  });
}

const ctx: Record<string, never> = {};

it("restores snapshot plus log before calling active init once at runtime boot", async () => {
  const backing = new Map<string, string>();
  await liveRun(
    backing,
    [
      { _tag: "inc", by: 1 },
      { _tag: "inc", by: 2 },
      { _tag: "inc", by: 3 },
    ],
    2,
  );
  const init = vi.fn(
    (loaded: State | null): readonly [State, readonly never[]] => {
      if (loaded === null) throw new Error("expected recovered snapshot");
      return [{ ...loaded, count: loaded.count + 100 }, []];
    },
  );
  const machine = { ...counter(), init };
  const { storage } = fakeStorage(backing);
  const es = doEventSourcedStore(storage, machine, ctx);
  const rt = await run(machine, { ctx, store: es.store }).ready;
  try {
    expect(rt.getState().count).toBe(106);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0]?.[0]?.count).toBe(6);
  } finally {
    await rt.stop();
  }
});

// The `DurableObjectStorage` fake is `src/__fixtures__/do-storage.ts`. Its
// backing Map is the retained storage: a SECOND store over the SAME bytes is the
// eviction/rehydrate simulation (the isolate dies, the storage survives).

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
  // The store appends each applied msg from `save`, before the dispatch settles.
  for (const m of msgs) await runtime.dispatch(m);
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

// Drive a runtime that snapshots on a TIME/TICK cadence (#190): the count-based
// trigger is effectively disabled (`snapshotEvery` huge), and `es.snapshotNow()`
// is called after every `tickEvery` applied msgs — the grain-driven, clock-free
// trigger. This simulates "snapshot every N derived ticks", isolating the new
// path from the count-based one. Returns the live final state + how many
// snapshots `snapshotNow()` actually wrote (it no-ops when nothing is new).
async function liveRunTickSnapshots(
  backing: Map<string, string>,
  msgs: readonly Msg[],
  tickEvery: number,
): Promise<{ state: State; snapshotsWritten: number }> {
  const { storage } = fakeStorage(backing);
  const es = doEventSourcedStore<State, Msg, typeof ctx>(
    storage,
    counter(),
    ctx,
    // Count trigger never fires; only snapshotNow() drives retention here.
    { snapshotEvery: 1_000_000 },
  );
  const runtime = await run(counter(), { ctx, store: es.store }).ready;
  let snapshotsWritten = 0;
  let applied = 0;
  for (const m of msgs) {
    await runtime.dispatch(m);
    applied++;
    if (applied % tickEvery === 0 && (await es.snapshotNow())) {
      snapshotsWritten++;
    }
  }
  const state = runtime.getState();
  await runtime.stop();
  return { state, snapshotsWritten };
}

// ── Arbitraries. ────────────────────────────────────────────────────────────

const msgTable: MsgArbitraryTable<Msg> = {
  inc: fc.record({
    _tag: fc.constant<"inc">("inc"),
    by: fc.integer({ min: 0, max: 1000 }),
  }),
  dec: fc.record({
    _tag: fc.constant<"dec">("dec"),
    by: fc.integer({ min: 0, max: 1000 }),
  }),
  reset: fc.constant({ _tag: "reset" as const }),
  note: fc.record({
    _tag: fc.constant<"note">("note"),
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
    expect(live.state).toEqual({ _tag: "counting", count: 0, log: [] });
    expect(live.readyCalls).toBe(1);

    // A rehydrate over the (now still effectively empty) store also fires once.
    const rebuilt = await rehydrate(backing, 10);
    expect(rebuilt.readyCalls).toBe(1);
    // No snapshot, no events → fold starts fresh; migrate(null) → null (boot
    // fresh path), which is the snapshot-only oracle for an empty sequence.
    expect(rebuilt.state ?? { _tag: "counting", count: 0, log: [] }).toEqual({
      _tag: "counting",
      count: 0,
      log: [],
    });
  });

  it("snapshot+log boundary: log shorter than one interval replays cleanly", async () => {
    // snapshotEvery=10, only 3 events: no snapshot ever taken, pure-log replay.
    const backing = new Map<string, string>();
    const msgs: Msg[] = [
      { _tag: "inc", by: 5 },
      { _tag: "note", text: "a" },
      { _tag: "dec", by: 2 },
    ];
    const live = await liveRun(backing, msgs, 10);
    const rebuilt = await rehydrate(backing, 10);
    expect(rebuilt.state).toEqual(live.state);
    expect(rebuilt.state).toEqual(snapshotOnlyFold(msgs));
    expect(rebuilt.state).toEqual({
      _tag: "counting",
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
      _tag: "inc" as const,
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
  { _tag: "inc", by: 1 },
  { _tag: "inc", by: 2 },
  { _tag: "note", text: "x" },
  { _tag: "dec", by: 1 },
  { _tag: "reset" },
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
      _tag: "inc" as const,
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
          const m = raw as { _tag?: unknown };
          if (m?._tag === "reset") return null;
          return typeof m?._tag === "string" ? (raw as Msg) : null;
        },
      },
    );

    const rows = await collect(reader.readEvents());
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]); // seq 5 (reset) dropped
    expect(rows.some((r) => r.event._tag === "reset")).toBe(false);
  });

  it("drops old type-keyed rows with the default parseEvent and reads _tag rows", async () => {
    const backing = new Map<string, string>();
    backing.set("@@es/evt/0000000000000001", JSON.stringify({ type: "inc" }));
    backing.set("@@es/evt/0000000000000002", JSON.stringify({ _tag: "inc" }));
    const { storage } = fakeStorage(backing);
    const reader = doEventSourcedStore(storage, counter(), ctx);

    expect(await collect(reader.readEvents())).toEqual([
      { seq: 2, event: { _tag: "inc" } },
    ]);
  });

  it("a host parseEvent that renames the old key reads type-keyed rows and folds them", async () => {
    const backing = new Map<string, string>();
    backing.set(
      "@@es/evt/0000000000000001",
      JSON.stringify({ type: "inc", by: 2 }),
    );
    backing.set(
      "@@es/evt/0000000000000002",
      JSON.stringify({ _tag: "inc", by: 3 }),
    );
    backing.set("@@es/evt/0000000000000003", JSON.stringify({ type: "reset" }));
    backing.set(
      "@@es/evt/0000000000000004",
      JSON.stringify({ type: "inc", by: 4 }),
    );
    const { storage } = fakeStorage(backing);
    const reader = doEventSourcedStore<State, Msg, typeof ctx>(
      storage,
      counter(),
      ctx,
      {
        parseEvent: (raw) => {
          const { type, ...rest } = raw as { type?: unknown; _tag?: unknown };
          const row = type === undefined ? rest : { _tag: type, ...rest };
          return typeof row._tag === "string" ? (row as Msg) : null;
        },
      },
    );

    expect(await collect(reader.readEvents())).toEqual([
      { seq: 1, event: { _tag: "inc", by: 2 } },
      { seq: 2, event: { _tag: "inc", by: 3 } },
      { seq: 3, event: { _tag: "reset" } },
      { seq: 4, event: { _tag: "inc", by: 4 } },
    ]);
    expect(await reader.store.load()).toEqual({
      _tag: "counting",
      count: 4,
      log: [],
    });
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

// ── The time/tick-based snapshot trigger (#190). ────────────────────────────
// snapshotNow() bounds the replay tail by ELAPSED TIME/TICKS instead of raw
// event count: a grain calls it on its own cadence so a quiet span that never
// trips `snapshotEvery` is still checkpointed. These tests prove (a) it writes
// a snapshot independent of the count trigger, (b) cold-wake replay after such a
// snapshot rebuilds the SAME state as live and as the snapshot-only fold, and
// (c) its no-op contract.

describe("doEventSourcedStore — time/tick-based snapshot trigger (snapshotNow)", () => {
  it("writes a snapshot independent of event count, and cold-wake replay after it rebuilds correctly", async () => {
    // 10 events, count trigger disabled (snapshotEvery 1e6). snapshotNow() fires
    // after ticks 3, 6, 9 — so a snapshot exists even though the count threshold
    // was never crossed. The last one covers seq 9 (highest 3-multiple <= 10).
    const backing = new Map<string, string>();
    const msgs: Msg[] = Array.from({ length: 10 }, (_, i) => ({
      _tag: "inc" as const,
      by: i + 1,
    }));
    const live = await liveRunTickSnapshots(backing, msgs, 3);

    // A snapshot WAS written purely on the tick cadence, not the count trigger.
    expect(live.snapshotsWritten).toBe(3);
    const snapRaw = backing.get("@@es/snapshot");
    expect(snapRaw).toBeDefined();
    const snap = JSON.parse(snapRaw as string) as { seq: number };
    expect(snap.seq).toBe(9);

    // Cold-wake: a fresh store over the same bytes folds (snapshot @ seq 9) + the
    // single tail event (seq 10) and rebuilds the identical state.
    const rebuilt = await rehydrate(backing, 1_000_000);
    expect(rebuilt.state).toEqual(live.state);
    expect(rebuilt.state).toEqual(snapshotOnlyFold(msgs));
    expect(rebuilt.readyCalls).toBe(1);
  });

  it("count-based path still works when snapshotNow is never called (regression)", async () => {
    // Same scenario as the count-based boundary test, untouched by the new API:
    // snapshotEvery=4, 13 events → snapshot at seq 12, replay folds snapshot + 1.
    const backing = new Map<string, string>();
    const msgs: Msg[] = Array.from({ length: 13 }, (_, i) => ({
      _tag: "inc" as const,
      by: i + 1,
    }));
    const live = await liveRun(backing, msgs, 4);
    const rebuilt = await rehydrate(backing, 4);
    const snap = JSON.parse(backing.get("@@es/snapshot") as string) as {
      seq: number;
    };
    expect(snap.seq).toBe(12);
    expect(rebuilt.state).toEqual(live.state);
    expect(rebuilt.state).toEqual(snapshotOnlyFold(msgs));
  });

  it("rebuild after a snapshotNow-driven retention equals live and snapshot-only fold (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbMsgs(40),
        // Snapshot every 1..7 ticks while the count trigger stays disabled, so an
        // arbitrary sequence is snapshotted purely on the tick cadence and the
        // replay tail varies in length across runs.
        fc.integer({ min: 1, max: 7 }),
        async (msgs, tickEvery) => {
          const backing = new Map<string, string>();
          const live = await liveRunTickSnapshots(backing, msgs, tickEvery);
          const rebuilt = await rehydrate(backing, 1_000_000);
          // (a) rebuilt-by-fold == never-evicted live state
          expect(rebuilt.state).toEqual(live.state);
          // (b) rebuilt-by-fold == snapshot-only fold of the same msgs
          expect(rebuilt.state).toEqual(snapshotOnlyFold(msgs));
          expect(rebuilt.readyCalls).toBe(1);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("no-ops on a fresh actor and when nothing new since the last snapshot", async () => {
    const backing = new Map<string, string>();
    const { storage } = fakeStorage(backing);
    const es = doEventSourcedStore<State, Msg, typeof ctx>(
      storage,
      counter(),
      ctx,
      { snapshotEvery: 1_000_000 },
    );
    const runtime = await run(counter(), { ctx, store: es.store }).ready;

    // Fresh actor: nothing applied → no-op, no snapshot cell written.
    expect(await es.snapshotNow()).toBe(false);
    expect(backing.has("@@es/snapshot")).toBe(false);

    // Apply one event, then snapshotNow() writes at seq 1.
    await runtime.dispatch({ _tag: "inc", by: 5 });
    expect(await es.snapshotNow()).toBe(true);
    const snap = JSON.parse(backing.get("@@es/snapshot") as string) as {
      seq: number;
    };
    expect(snap.seq).toBe(1);

    // Immediately again with no new event → no-op (already current).
    expect(await es.snapshotNow()).toBe(false);

    await runtime.stop();
  });

  it("advances the count-based baseline so a manual snapshot defers the next automatic one", async () => {
    // snapshotEvery=5. Apply 3 events, snapshotNow() at seq 3 (manual). Because
    // it moves snapshotSeq to 3, the count trigger now needs seq >= 8 (3+5), not
    // 5, to fire — proving the two triggers share one retention baseline.
    const backing = new Map<string, string>();
    const { storage } = fakeStorage(backing);
    const es = doEventSourcedStore<State, Msg, typeof ctx>(
      storage,
      counter(),
      ctx,
      { snapshotEvery: 5 },
    );
    const runtime = await run(counter(), { ctx, store: es.store }).ready;

    const dispatch = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await runtime.dispatch({ _tag: "inc", by: 1 });
      }
    };

    await dispatch(3);
    expect(await es.snapshotNow()).toBe(true);
    let snap = JSON.parse(backing.get("@@es/snapshot") as string) as {
      seq: number;
    };
    expect(snap.seq).toBe(3);

    // Two more events (seq 5): WITHOUT the rebaselining this would have tripped
    // the seq>=5 count trigger; with it, the baseline is 3 so 5-3=2 < 5 → no new
    // automatic snapshot. The cell still reads seq 3.
    await dispatch(2);
    snap = JSON.parse(backing.get("@@es/snapshot") as string) as {
      seq: number;
    };
    expect(snap.seq).toBe(3);

    // Three more (seq 8): 8-3=5 >= 5 → the count trigger fires at seq 8.
    await dispatch(3);
    snap = JSON.parse(backing.get("@@es/snapshot") as string) as {
      seq: number;
    };
    expect(snap.seq).toBe(8);

    // Cold-wake still rebuilds the right state (8 events of +1 → count 8).
    const rebuilt = await rehydrate(backing, 5);
    expect(rebuilt.state).toEqual(runtime.getState());
    expect(rebuilt.state?.count).toBe(8);

    await runtime.stop();
  });
});

// ── The log is write-ahead: `save(state, msg)` writes before the Cmds run. ──
// The engine awaits `store.save` before it starts a transition's Cmds, so the
// event, its meta cell and any snapshot are in storage when the first handler
// is entered, and nothing but the engine feeds the log.

type WorkCmd = { readonly _tag: "act"; readonly by: number };

// The counter, with an `act` Cmd on every `inc`, so a test can look at storage
// from inside the handler the Msg started.
function worker() {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as WorkCmd,
      ctx: {} as Record<string, never>,
    },
    init: (loaded) => [loaded ?? { _tag: "counting", count: 0, log: [] }, []],
    update: {
      ...update,
      inc: (s, m) => [
        { ...s, count: s.count + m.by },
        [{ _tag: "act", by: m.by }],
      ],
    },
  });
}

const EVENT_PREFIX = "@@es/evt/";
const rowKey = (seq: number, prefix = EVENT_PREFIX) =>
  prefix + String(seq).padStart(16, "0");
const eventRows = (backing: Map<string, string>, prefix = EVENT_PREFIX) =>
  [...backing.keys()].filter((key) => key.startsWith(prefix));
const snapshotCell = (backing: Map<string, string>, key = "@@es/snapshot") =>
  JSON.parse(backing.get(key) ?? "null") as {
    seq: number;
    state: State;
  } | null;

const restoreChildTimeoutMs = 60_000;

async function runRestoreChild(
  fixture: string,
  nodeArgs: readonly string[],
): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "tea-restore-child-"));
  try {
    await build({
      configFile: false,
      logLevel: "error",
      ssr: { noExternal: ["fossil-delta"] },
      build: {
        ssr: fileURLToPath(new URL(fixture, import.meta.url)),
        outDir: work,
        rollupOptions: { output: { entryFileNames: "child.mjs" } },
      },
    });
    const child = spawnSync(
      process.execPath,
      [...nodeArgs, join(work, "child.mjs")],
      { encoding: "utf8", timeout: restoreChildTimeoutMs },
    );
    expect(
      {
        status: child.status,
        signal: child.signal,
        error: child.error?.message,
      },
      child.stderr,
    ).toEqual({ status: 0, signal: null, error: undefined });
    return child.stdout.trim();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

describe("bounded restore", () => {
  it("snapshot restore never fetches preceding events", async () => {
    const backing = new Map<string, string>();
    await liveRun(
      backing,
      Array.from({ length: 100 }, () => ({ _tag: "inc", by: 1 })),
      99,
    );
    const { storage } = fakeStorage(backing);
    const list = vi.spyOn(storage, "list");
    const es = doEventSourcedStore(storage, counter(), ctx);

    expect(await es.store.load()).toEqual({
      _tag: "counting",
      count: 100,
      log: [],
    });
    const fetched = (
      await Promise.all(list.mock.results.map((r) => r.value))
    ).flatMap((rows) => [...rows.keys()]);
    expect(fetched).toEqual([rowKey(100)]);
    expect(
      list.mock.calls.every(([options]) => Number.isInteger(options?.limit)),
    ).toBe(true);
  });

  describe("in a child process", { timeout: restoreChildTimeoutMs }, () => {
    it("replay does not retain historical commands", async () => {
      expect(
        await runRestoreChild("./fixtures/replay-memory-child.ts", [
          "--max-old-space-size=64",
        ]),
      ).toBe("600,600,600");
    });

    it("the load queue releases recovered state after a later save", async () => {
      expect(
        await runRestoreChild("./fixtures/restore-queue-gc-child.ts", [
          "--expose-gc",
        ]),
      ).toBe("collected");
    });
  });

  it("onReady can snapshot recovered state while marker deletion is pending", async () => {
    const backing = new Map<string, string>();
    await liveRun(
      backing,
      [2, 3, 4].map((by) => ({ _tag: "inc", by })),
      2,
    );
    const { storage } = fakeStorage(backing);
    const remove = storage.delete.bind(storage);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const deleting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(storage, "delete").mockImplementation(async (key) => {
      entered();
      await held;
      return remove(key);
    });
    let checkpoint: Promise<boolean> | undefined;
    const es = doEventSourcedStore(storage, counter(), ctx, {
      onReady: () => {
        checkpoint = es.snapshotNow();
      },
    });
    const loading = es.store.load();
    await deleting;
    try {
      expect(backing.has("@@es/meta/restore-attempt")).toBe(true);
      expect(await checkpoint).toBe(true);
      expect(snapshotCell(backing)).toEqual({
        seq: 3,
        state: { _tag: "counting", count: 9, log: [] },
      });
    } finally {
      release();
      await loading;
    }
    expect(await es.snapshotNow()).toBe(false);
  });

  it("failed or interrupted restore never starts a fresh machine", async () => {
    for (const cells of [
      { "@@es/snapshot": "{broken" },
      { "@@es/snapshot": '{"seq":99,"state":null}' },
      {
        "@@es/snapshot":
          '{"seq":"99","state":{"_tag":"counting","count":99,"log":[]}}',
      },
      { "@@es/meta/restore-attempt": '{"attempts":2}' },
    ]) {
      const backing = new Map<string, string>(Object.entries(cells));
      const { storage } = fakeStorage(backing);
      const init = vi.fn(counter().init);
      const act = vi.fn();
      const machine = { ...worker(), init };
      const list = vi.spyOn(storage, "list");
      const es = doEventSourcedStore(storage, machine, ctx);
      const booting = run(machine, {
        ctx,
        store: es.store,
        interpret: { act },
      });
      const failure = await booting.ready.then(
        () => undefined,
        (cause) => cause,
      );
      try {
        expect(failure).toBeInstanceOf(StoreRefusedError);
        expect(failure.cause).toBeInstanceOf(Error);
        if ("@@es/meta/restore-attempt" in cells) {
          expect(failure.cause).toBeInstanceOf(RestoreInterruptedError);
          expect(failure.cause).toMatchObject({
            _tag: "restore_interrupted",
            attempts: 2,
            retryLimit: 1,
          });
        }
        expect(init).not.toHaveBeenCalled();
        expect(act).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
        for (const [key, value] of Object.entries(cells))
          expect(backing.get(key)).toBe(value);
        expect(
          JSON.parse(backing.get("@@es/meta/restore-attempt") ?? "null"),
        ).toEqual({ attempts: "@@es/snapshot" in cells ? 1 : 2 });
      } finally {
        await booting.stop();
      }
    }
  });

  it("one interrupted restore retries once, a second is refused", async () => {
    let backing = new Map<string, string>();
    const interrupt = async () => {
      const { storage } = fakeStorage(backing);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(storage, "get").mockImplementation(async (key) => {
        if (key === "@@es/snapshot") {
          entered();
          return new Promise<never>(() => {});
        }
        return backing.get(key);
      });
      void doEventSourcedStore(storage, counter(), ctx).store.load();
      await started;
      // Only durable bytes survive an activation loss; its pending load cannot settle.
      backing = new Map(backing);
    };
    await interrupt();
    expect(
      JSON.parse(backing.get("@@es/meta/restore-attempt") ?? "null"),
    ).toEqual({ attempts: 1 });
    await interrupt();
    const { storage } = fakeStorage(backing);
    const get = vi.spyOn(storage, "get");
    const list = vi.spyOn(storage, "list");
    for (let activation = 0; activation < 3; activation++) {
      await expect(
        doEventSourcedStore(storage, counter(), ctx).store.load(),
      ).rejects.toMatchObject({
        _tag: "restore_interrupted",
        attempts: 2,
        retryLimit: 1,
      });
    }
    expect(
      get.mock.calls.every(([key]) => key === "@@es/meta/restore-attempt"),
    ).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });

  it("a refused recovered state keeps retry evidence and never reaches runtime init", async () => {
    const backing = new Map<string, string>([
      [
        "@@es/snapshot",
        '{"seq":99,"state":{"_tag":"counting","count":99,"log":[]}}',
      ],
      ["@@es/meta", '{"lastSeq":100}'],
      [rowKey(100), '{"_tag":"inc","by":1}'],
    ]);
    const { storage } = fakeStorage(backing);
    const init = vi.fn(counter().init);
    const machine = { ...counter(), init };
    const es = doEventSourcedStore(storage, machine, ctx, {
      parse: (raw) => ((raw as State).count < 100 ? (raw as State) : null),
    });
    const booting = run(machine, { ctx, store: es.store });
    await expect(booting.ready).rejects.toBeInstanceOf(StoreRefusedError);
    await booting.stop();
    expect(init).not.toHaveBeenCalled();
    expect(backing.get("@@es/meta/restore-attempt")).toBe('{"attempts":1}');
  });

  it("pages an inclusive window and folds each event before decoding the next", async () => {
    const backing = new Map<string, string>();
    for (let seq = 1; seq <= 400; seq++) {
      backing.set(rowKey(seq), JSON.stringify({ _tag: "inc", by: 1 }));
    }
    backing.set("@@es/meta", '{"lastSeq":400}');
    backing.set(
      "@@es/snapshot",
      '{"seq":99,"state":{"_tag":"counting","count":99,"log":[]}}',
    );
    const { storage } = fakeStorage(backing);
    const list = vi.spyOn(storage, "list");
    let decoded = 99;
    const machine = {
      ...counter(),
      update: {
        ...update,
        inc: (state: State, msg: Extract<Msg, { _tag: "inc" }>) => {
          expect(decoded).toBe(state.count + 1);
          return update.inc(state, msg);
        },
      },
    };
    const es = doEventSourcedStore(storage, machine, ctx, {
      parseEvent: (raw) => {
        decoded++;
        return raw as Msg;
      },
    });
    expect(await es.store.load()).toEqual({
      _tag: "counting",
      count: 400,
      log: [],
    });
    expect(list.mock.calls.length).toBeGreaterThan(1);
    const fetched = async () =>
      (await Promise.all(list.mock.results.map((r) => r.value))).flatMap(
        (rows) => [...rows.keys()],
      );
    expect(await fetched()).toEqual(
      Array.from({ length: 301 }, (_, i) => rowKey(i + 100)),
    );
    expect(
      (await Promise.all(list.mock.results.map((r) => r.value))).every(
        (rows) => rows.size <= 128,
      ),
    ).toBe(true);

    list.mockClear();
    const rows = await collect(es.readEvents({ fromSeq: 120, toSeq: 380 }));
    expect(rows.map((r) => r.seq)).toEqual(
      Array.from({ length: 261 }, (_, i) => i + 120),
    );
    expect(await fetched()).toEqual(
      Array.from({ length: 261 }, (_, i) => rowKey(i + 120)),
    );
  });

  it.each([
    0, 2,
  ])("honors retry limit %i and resets its budget only on success", async (restoreRetryLimit) => {
    const backing = new Map<string, string>([["@@es/snapshot", "{broken"]]);
    const { storage } = fakeStorage(backing);
    const es = doEventSourcedStore(storage, counter(), ctx, {
      restoreRetryLimit,
    });
    for (let attempt = 1; attempt <= restoreRetryLimit + 1; attempt++) {
      await expect(es.store.load()).rejects.toBeInstanceOf(SyntaxError);
      expect(
        JSON.parse(backing.get("@@es/meta/restore-attempt") ?? "null"),
      ).toEqual({ attempts: attempt });
    }
    await expect(es.store.load()).rejects.toMatchObject({
      _tag: "restore_interrupted",
      retryLimit: restoreRetryLimit,
    });

    const keys = { meta: "other/meta", restoreAttempt: "other/attempt" };
    backing.delete("@@es/snapshot");
    backing.set(keys.restoreAttempt, '{"attempts":1}');
    const retry = doEventSourcedStore(storage, counter(), ctx, {
      keys,
      restoreRetryLimit: 1,
    });
    await retry.store.load();
    expect(backing.has(keys.restoreAttempt)).toBe(false);
    backing.set("@@es/snapshot", "{broken");
    await expect(retry.store.load()).rejects.toBeInstanceOf(SyntaxError);
    expect(backing.get(keys.restoreAttempt)).toBe('{"attempts":1}');
    for (const limit of [-1, 0.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() =>
        doEventSourcedStore(storage, counter(), ctx, {
          restoreRetryLimit: limit,
        }),
      ).toThrow(/restoreRetryLimit/);
    }
  });

  it("serializes concurrent loads across handles without consuming the retry budget", async () => {
    const { storage, backing } = fakeStorage();
    const get = storage.get.bind(storage);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const attempts: string[] = [];
    vi.spyOn(storage, "get").mockImplementation(async (key) => {
      if (key === "@@es/snapshot") {
        attempts.push(backing.get("@@es/meta/restore-attempt") ?? "missing");
        entered();
        await held;
      }
      return get(key);
    });
    const first = doEventSourcedStore(storage, counter(), ctx);
    const second = doEventSourcedStore(storage, counter(), ctx);
    const pending = [
      first.store.load(),
      first.store.load(),
      second.store.load(),
    ];
    await started;
    expect(attempts).toEqual(['{"attempts":1}']);
    release();
    await Promise.all(pending);
    expect(attempts).toEqual(Array(3).fill('{"attempts":1}'));
    expect(backing.size).toBe(0);
  });

  it("exposes the committed sequence without rescanning and advances it only after a successful save", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, sampleMsgs, 2);
    const faults = fakeStorage(backing);
    const list = vi.spyOn(faults.storage, "list");
    const es = doEventSourcedStore(faults.storage, counter(), ctx);
    expect(await es.getCommittedSeq()).toBe(5);
    expect(list).not.toHaveBeenCalled();
    const state = (await es.store.load()) as State;
    list.mockClear();
    await es.store.save({ ...state, count: 4 }, { _tag: "inc", by: 4 });
    expect(await es.getCommittedSeq()).toBe(6);
    faults.failPut((key) => key.startsWith(EVENT_PREFIX));
    await expect(
      es.store.save({ ...state, count: 9 }, { _tag: "inc", by: 5 }),
    ).rejects.toThrow();
    expect(await es.getCommittedSeq()).toBe(6);
    expect(list).not.toHaveBeenCalled();
    expect(await collect(es.readEvents({ fromSeq: 7 }))).toEqual([]);
    const empty = doEventSourcedStore(fakeStorage().storage, counter(), ctx);
    expect(await empty.getCommittedSeq()).toBe(0);
  });
});

describe("doEventSourcedStore — write-ahead log", () => {
  it("has the Msg, its meta cell and its snapshot in storage when the Cmd handler starts", async () => {
    const backing = new Map<string, string>();
    const { storage } = fakeStorage(backing);
    const es = doEventSourcedStore(storage, worker(), ctx, {
      snapshotEvery: 1,
    });
    const atEntry: {
      rows: string[];
      meta: string | undefined;
      snapshot: ReturnType<typeof snapshotCell>;
    }[] = [];
    const rt = await run(worker(), {
      ctx,
      store: es.store,
      interpret: {
        act: async () => {
          atEntry.push({
            rows: eventRows(backing).map((key) => backing.get(key) as string),
            meta: backing.get("@@es/meta"),
            snapshot: snapshotCell(backing),
          });
        },
      },
    }).ready;

    await rt.dispatch({ _tag: "inc", by: 2 });
    await rt.dispatch({ _tag: "inc", by: 3 });
    await rt.stop();

    expect(atEntry).toEqual([
      {
        rows: ['{"_tag":"inc","by":2}'],
        meta: '{"lastSeq":1}',
        snapshot: { seq: 1, state: { _tag: "counting", count: 2, log: [] } },
      },
      {
        rows: ['{"_tag":"inc","by":2}', '{"_tag":"inc","by":3}'],
        meta: '{"lastSeq":2}',
        snapshot: { seq: 2, state: { _tag: "counting", count: 5, log: [] } },
      },
    ]);
  });

  it("finds a Msg whose Cmd never returned in the log of the next activation", async () => {
    const backing = new Map<string, string>();
    const es = doEventSourcedStore(fakeStorage(backing).storage, worker(), ctx);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rt = await run(worker(), {
      ctx,
      store: es.store,
      onError: () => {},
      disposeTimeoutMs: 0,
      interpret: {
        act: () => {
          entered();
          return new Promise<never>(() => {});
        },
      },
    }).ready;
    void rt.dispatch({ _tag: "inc", by: 7 }).catch(() => {});
    await started;

    // The activation is lost here, inside the handler: only the bytes remain.
    const next = await rehydrate(new Map(backing), 100);
    expect(next.state).toEqual({ _tag: "counting", count: 7, log: [] });
    await rt.stop();
  });

  it.each([
    [1, 5],
    [2, 4],
    [100, null],
  ])("snapshotEvery %i leaves the snapshot at seq %s after five events, and a new activation rebuilds the live State", async (snapshotEvery, snapshotAt) => {
    const backing = new Map<string, string>();
    const msgs: Msg[] = [1, 2, 3, 4, 5].map((by) => ({ _tag: "inc", by }));
    const live = await liveRun(backing, msgs, snapshotEvery);

    expect(snapshotCell(backing)?.seq ?? null).toBe(snapshotAt);
    expect(eventRows(backing)).toHaveLength(5);
    expect((await rehydrate(backing, snapshotEvery)).state).toEqual(live.state);
  });

  it("numbers three concurrent distinct dispatches 1, 2 and 3, in the order they were queued", async () => {
    const backing = new Map<string, string>();
    const { storage } = fakeStorage(backing);
    const es = doEventSourcedStore(storage, counter(), ctx);
    const rt = await run(counter(), { ctx, store: es.store }).ready;
    const msgs: Msg[] = [
      { _tag: "inc", by: 1 },
      { _tag: "note", text: "b" },
      { _tag: "dec", by: 4 },
    ];

    await Promise.all(msgs.map((m) => rt.dispatch(m)));
    await rt.dispatch({ _tag: "reset" });
    await rt.stop();

    expect(await collect(es.readEvents())).toEqual([
      { seq: 1, event: msgs[0] },
      { seq: 2, event: msgs[1] },
      { seq: 3, event: msgs[2] },
      { seq: 4, event: { _tag: "reset" } },
    ]);
    expect(backing.get("@@es/meta")).toBe('{"lastSeq":4}');
  });

  it("writes nothing at boot or at stop, however many activations come and go", async () => {
    const backing = new Map<string, string>();
    const idle = await run(counter(), {
      ctx,
      store: doEventSourcedStore(fakeStorage(backing).storage, counter(), ctx)
        .store,
    }).ready;
    await idle.stop();
    expect([...backing]).toEqual([]);

    await liveRun(backing, [{ _tag: "inc", by: 4 }], 100);
    const retained = new Map(backing);
    for (let activation = 0; activation < 3; activation++) {
      const es = doEventSourcedStore(
        fakeStorage(backing).storage,
        counter(),
        ctx,
      );
      const rt = await run(counter(), { ctx, store: es.store }).ready;
      await rt.stop();
    }
    expect(backing).toEqual(retained);
  });

  it("logs an applied Msg that leaves the State unchanged, and never one the State refused", async () => {
    type Gate = { readonly _tag: "closed" } | { readonly _tag: "open" };
    type GateMsg = { readonly _tag: "open" } | { readonly _tag: "close" };
    const transitions: Transitions<Gate, GateMsg, never> = {
      closed: { open: () => [{ _tag: "open" }, []] },
      open: { close: () => [{ _tag: "closed" }, []], open: (s) => [s, []] },
    };
    const gate = defineMachine({
      types: { model: {} as Gate, msg: {} as GateMsg },
      init: (loaded) => [loaded ?? { _tag: "closed" }, []],
      update: transitions,
    });
    const backing = new Map<string, string>();
    const es = doEventSourcedStore<Gate, GateMsg, Record<string, never>>(
      fakeStorage(backing).storage,
      gate,
      ctx,
    );
    const rt = await run(gate, { ctx, store: es.store }).ready;

    await expect(rt.dispatch({ _tag: "close" })).rejects.toThrow();
    await rt.dispatch({ _tag: "open" });
    await rt.dispatch({ _tag: "open" });
    await expect(rt.dispatch({ _tag: "close" })).resolves.toBeUndefined();
    await expect(rt.dispatch({ _tag: "close" })).rejects.toThrow();
    await rt.stop();

    expect(
      (await collect(es.readEvents())).map((row) => row.event._tag),
    ).toEqual(["open", "open", "close"]);
  });
});

// ── A write that fails leaves the bytes it started from. ────────────────────

describe("doEventSourcedStore — a refused write", () => {
  const unchanged = async () => {
    const backing = new Map<string, string>();
    const faults = fakeStorage(backing);
    const es = doEventSourcedStore(faults.storage, worker(), ctx, {
      snapshotEvery: 1,
    });
    const acted: number[] = [];
    const rt = await run(worker(), {
      ctx,
      store: es.store,
      interpret: { act: async (cmd) => void acted.push(cmd.by) },
    }).ready;
    await rt.dispatch({ _tag: "inc", by: 1 });
    return { backing, faults, es, rt, acted, before: new Map(backing) };
  };

  it.each([
    ["event", (key: string) => key.startsWith(EVENT_PREFIX)],
    ["meta", (key: string) => key === "@@es/meta"],
    ["snapshot", (key: string) => key === "@@es/snapshot"],
  ])("a refused %s write rejects the save, runs no Cmd, rolls back, and a new activation recovers from the bytes it left", async (_cell, refuses) => {
    const { backing, faults, es, rt, acted, before } = await unchanged();
    faults.failPut(refuses);

    await expect(rt.dispatch({ _tag: "inc", by: 2 })).rejects.toThrow(
      "storage refused the write",
    );

    expect(backing).toEqual(before);
    expect(acted).toEqual([1]);

    faults.healPut();
    const next = await rehydrate(new Map(backing), 1);
    expect(next.state).toEqual({ _tag: "counting", count: 1, log: [] });
    expect((await collect(es.readEvents())).map((row) => row.seq)).toEqual([1]);

    // The failed write did not use up its seq: the next event takes it.
    await es.store.save(
      { _tag: "counting", count: 6, log: [] },
      { _tag: "inc", by: 5 },
    );
    expect((await collect(es.readEvents())).map((row) => row.seq)).toEqual([
      1, 2,
    ]);
    await rt.stop();
  });

  it("checkpoints the State of the last event that was written, never a transition whose write failed", async () => {
    const backing = new Map<string, string>();
    const faults = fakeStorage(backing);
    const es = doEventSourcedStore(faults.storage, counter(), ctx, {
      snapshotEvery: 1_000_000,
    });
    const rt = await run(counter(), { ctx, store: es.store }).ready;
    await rt.dispatch({ _tag: "inc", by: 1 });
    await rt.dispatch({ _tag: "inc", by: 2 });

    faults.failPut((key) => key.startsWith(EVENT_PREFIX));
    await expect(rt.dispatch({ _tag: "inc", by: 4 })).rejects.toThrow();
    faults.healPut();

    expect(await es.snapshotNow()).toBe(true);
    expect(snapshotCell(backing)).toEqual({
      seq: 2,
      state: { _tag: "counting", count: 3, log: [] },
    });
    await rt.stop();
    expect(snapshotCell(backing)?.seq).toBe(2);
    expect((await rehydrate(backing, 100)).state).toEqual({
      _tag: "counting",
      count: 3,
      log: [],
    });
  });
});

// ── Logs written before the save carried a Msg still read, unchanged. ───────
// The cells below are the bytes the observer-fed store wrote, typed out
// literally: raw JSON per event under a sixteen-digit key, `{lastSeq}` meta and
// a `{seq,state}` snapshot. They are seeded directly, never through the writer.

describe("doEventSourcedStore — logs written by the observer-fed store", () => {
  const oldRows = [
    '{"_tag":"inc","by":1}',
    '{"_tag":"inc","by":2}',
    '{"_tag":"note","text":"x"}',
    '{"_tag":"inc","by":5}',
  ];
  const seeded = (cells: Record<string, string>) =>
    new Map<string, string>(Object.entries(cells));
  const fullLog = () =>
    seeded({
      ...Object.fromEntries(oldRows.map((row, i) => [rowKey(i + 1), row])),
      "@@es/meta": '{"lastSeq":4}',
    });
  const folded: State = { _tag: "counting", count: 8, log: ["x"] };

  it("reads a full log with no snapshot, rewrites nothing, and numbers the next event after the old ones", async () => {
    const backing = fullLog();
    const old = new Map(backing);
    const es = doEventSourcedStore(
      fakeStorage(backing).storage,
      counter(),
      ctx,
    );

    expect(await es.store.load()).toEqual(folded);
    expect(backing).toEqual(old);

    const rt = await run(counter(), { ctx, store: es.store }).ready;
    await rt.dispatch({ _tag: "inc", by: 10 });
    await rt.stop();

    for (const [key, bytes] of old) {
      if (key !== "@@es/meta") expect(backing.get(key)).toBe(bytes);
    }
    expect(backing.get(rowKey(5))).toBe('{"_tag":"inc","by":10}');
    expect(backing.get("@@es/meta")).toBe('{"lastSeq":5}');
    expect((await rehydrate(backing, 100)).state?.count).toBe(18);
  });

  it("reads a snapshot and its tail, rewrites nothing, and keeps counting from the meta cell", async () => {
    const backing = fullLog();
    backing.set(
      "@@es/snapshot",
      '{"seq":2,"state":{"_tag":"counting","count":3,"log":[]}}',
    );
    const old = new Map(backing);
    const es = doEventSourcedStore(
      fakeStorage(backing).storage,
      counter(),
      ctx,
      { snapshotEvery: 3 },
    );

    expect(await es.store.load()).toEqual(folded);
    expect(backing).toEqual(old);
    expect((await collect(es.readEvents())).map((row) => row.seq)).toEqual([
      1, 2, 3, 4,
    ]);

    const rt = await run(counter(), { ctx, store: es.store }).ready;
    await rt.dispatch({ _tag: "inc", by: 1 });
    await rt.stop();

    expect(backing.get(rowKey(5))).toBe('{"_tag":"inc","by":1}');
    expect(snapshotCell(backing)).toEqual({
      seq: 5,
      state: { _tag: "counting", count: 9, log: ["x"] },
    });
  });

  it("reads a log under custom keys and a host parseEvent that renames the old tag", async () => {
    const keys = {
      snapshot: "run-a/snapshot",
      meta: "run-a/meta",
      eventPrefix: "run-a/event/",
    };
    const backing = seeded({
      [rowKey(1, keys.eventPrefix)]: '{"type":"inc","by":2}',
      [rowKey(2, keys.eventPrefix)]: '{"_tag":"inc","by":3}',
      [keys.meta]: '{"lastSeq":2}',
    });
    const old = new Map(backing);
    const es = doEventSourcedStore<State, Msg, typeof ctx>(
      fakeStorage(backing).storage,
      counter(),
      ctx,
      {
        keys,
        parseEvent: (raw) => {
          const { type, ...rest } = raw as { type?: unknown };
          const row = type === undefined ? rest : { _tag: type, ...rest };
          return typeof (row as { _tag?: unknown })._tag === "string"
            ? (row as Msg)
            : null;
        },
      },
    );

    expect(await es.store.load()).toEqual({
      _tag: "counting",
      count: 5,
      log: [],
    });
    expect(backing).toEqual(old);

    const rt = await run(counter(), { ctx, store: es.store }).ready;
    await rt.dispatch({ _tag: "inc", by: 1 });
    await rt.stop();

    expect(backing.get(rowKey(3, keys.eventPrefix))).toBe(
      '{"_tag":"inc","by":1}',
    );
    expect(backing.get(keys.meta)).toBe('{"lastSeq":3}');
    expect(eventRows(backing)).toEqual([]);
  });

  it("decodes a log that recorded the same start twice exactly as it was written", async () => {
    const start = '{"_tag":"agent_start","runId":"run","at":0}';
    const backing = seeded({
      [rowKey(1)]: start,
      [rowKey(2)]: start,
      "@@es/meta": '{"lastSeq":2}',
    });
    const old = new Map(backing);
    const es = doEventSourcedStore(
      fakeStorage(backing).storage,
      counter(),
      ctx,
    );

    expect(await collect(es.readEvents())).toEqual([
      { seq: 1, event: { _tag: "agent_start", runId: "run", at: 0 } },
      { seq: 2, event: { _tag: "agent_start", runId: "run", at: 0 } },
    ]);
    expect(backing).toEqual(old);
  });
});

// ── doEventLogReader: a host reads the log without loading the agent. ───────

// Wrap a storage so every method a reader calls is recorded by name. A read
// that wrote, deleted, transacted or set an alarm would show up here.
function recording(storage: DurableObjectStorage) {
  const calls: string[] = [];
  const watched = new Proxy(storage, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return value.apply(target, args);
      };
    },
  });
  // The fake has no alarm API; give the reader one to call if it ever tried.
  const setAlarm = vi.fn();
  Object.assign(storage, { setAlarm, getAlarm: vi.fn(), deleteAlarm: vi.fn() });
  return { storage: watched, calls, setAlarm };
}

describe("doEventLogReader — a host reads an agent's history without waking it", () => {
  it("reads head, committed sequence and a range of a multi-page log a live run wrote, twice, writing nothing", async () => {
    const backing = new Map<string, string>();
    const msgs: Msg[] = Array.from({ length: 300 }, (_, i) =>
      i % 3 === 0 ? { _tag: "note", text: `n${i}` } : { _tag: "inc", by: i },
    );
    await liveRun(backing, msgs, 100);
    const before = new Map(backing);
    const { storage, calls, setAlarm } = recording(
      fakeStorage(backing).storage,
    );
    const reader = doEventLogReader<Msg>(storage);

    for (let pass = 0; pass < 2; pass++) {
      expect(await reader.readHead()).toEqual({
        lastSeq: 300,
        snapshot: true,
        format: "messages",
      });
      expect(await reader.readCommittedSeq()).toBe(300);
      const all = await collect(reader.readEvents());
      expect(all.map((e) => e.seq)).toEqual(
        Array.from({ length: 300 }, (_, i) => i + 1),
      );
      expect(all.map((e) => e.event)).toEqual(msgs);
      const window = await collect(
        reader.readEvents({ fromSeq: 120, toSeq: 260 }),
      );
      expect(window.map((e) => e.seq)).toEqual(
        Array.from({ length: 141 }, (_, i) => i + 120),
      );
      expect(window.map((e) => e.event)).toEqual(msgs.slice(119, 260));
    }

    expect(new Set(calls)).toEqual(new Set(["get", "list"]));
    expect(setAlarm).not.toHaveBeenCalled();
    expect(backing).toEqual(before);
    expect(backing.has("@@es/meta/restore-attempt")).toBe(false);
  });

  it("reads the head fresh on every call", async () => {
    const backing = new Map<string, string>();
    const { storage } = fakeStorage(backing);
    const get = vi.spyOn(storage, "get");
    const reader = doEventLogReader<Msg>(storage);
    expect(await reader.readHead()).toBeNull();
    await liveRun(backing, sampleMsgs, 100);
    expect(await reader.readHead()).toEqual({
      lastSeq: 5,
      snapshot: false,
      format: "messages",
    });
    expect(await reader.readCommittedSeq()).toBe(5);
    for (const call of get.mock.calls) {
      expect(call[1]).toEqual({ noCache: true });
    }
  });

  it("absent history reads as null, a committed sequence of 0 and no events", async () => {
    const { storage, calls } = recording(fakeStorage(new Map()).storage);
    const reader = doEventLogReader<Msg>(storage);
    expect(await reader.readHead()).toBeNull();
    expect(await reader.readCommittedSeq()).toBe(0);
    expect(await collect(reader.readEvents())).toEqual([]);
    expect(await collect(reader.readStoredEvents())).toEqual([]);
    expect(new Set(calls)).toEqual(new Set(["get", "list"]));
  });

  it("a snapshot with no meta cell reads as a head at sequence 0", async () => {
    const backing = new Map([
      [
        "@@es/snapshot",
        '{"seq":0,"state":{"_tag":"counting","count":0,"log":[]}}',
      ],
    ]);
    const reader = doEventLogReader<Msg>(fakeStorage(backing).storage);
    expect(await reader.readHead()).toEqual({
      lastSeq: 0,
      snapshot: true,
      format: null,
    });
  });

  it("a range returns only its events", async () => {
    const backing = new Map<string, string>();
    await liveRun(backing, sampleMsgs, 2);
    const reader = doEventLogReader<Msg>(fakeStorage(backing).storage);
    expect(await collect(reader.readEvents({ fromSeq: 2, toSeq: 4 }))).toEqual([
      { seq: 2, event: sampleMsgs[1] },
      { seq: 3, event: sampleMsgs[2] },
      { seq: 4, event: sampleMsgs[3] },
    ]);
    expect(await collect(reader.readEvents({ fromSeq: 6 }))).toEqual([]);
    expect(await collect(reader.readEvents({ fromSeq: 4, toSeq: 3 }))).toEqual(
      [],
    );
    const stored = await collect(
      reader.readStoredEvents({ fromSeq: 3, toSeq: 5 }),
    );
    expect(stored.map((s) => s.seq)).toEqual([3, 4, 5]);
  });

  it("reads a log longer than one page completely, in pages of at most 128 rows with noCache", async () => {
    const backing = new Map<string, string>();
    for (let seq = 1; seq <= 300; seq++) {
      backing.set(rowKey(seq), JSON.stringify({ _tag: "inc", by: seq }));
    }
    backing.set("@@es/meta", '{"lastSeq":300}');
    const { storage } = fakeStorage(backing);
    const list = vi.spyOn(storage, "list");
    const reader = doEventLogReader<Msg>(storage);
    const all = await collect(reader.readEvents());
    expect(all.map((e) => e.seq)).toEqual(
      Array.from({ length: 300 }, (_, i) => i + 1),
    );
    expect(list.mock.calls.length).toBe(3);
    for (const [options] of list.mock.calls) {
      expect(options?.limit).toBeLessThanOrEqual(128);
      expect(options?.noCache).toBe(true);
    }
  });

  it("caps stored cells read with limit, across pages", async () => {
    const backing = new Map<string, string>();
    for (let seq = 1; seq <= 300; seq++) {
      backing.set(rowKey(seq), JSON.stringify({ _tag: "inc", by: seq }));
    }
    const { storage } = fakeStorage(backing);
    const list = vi.spyOn(storage, "list");
    const reader = doEventLogReader<Msg>(storage);
    const capped = await collect(
      reader.readStoredEvents({ fromSeq: 10, limit: 200 }),
    );
    expect(capped.map((s) => s.seq)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 10),
    );
    expect(list.mock.calls.map(([o]) => o?.limit)).toEqual([128, 72]);
    expect(await collect(reader.readStoredEvents({ limit: 0 }))).toEqual([]);
  });

  it("reports undecodable cells as refused instead of throwing", async () => {
    const backing = new Map<string, unknown>([
      [rowKey(1), JSON.stringify({ _tag: "inc", by: 1 })],
      [rowKey(2), "{broken"],
      [rowKey(3), JSON.stringify({ type: "inc" })],
      [rowKey(4), 42],
      [`${EVENT_PREFIX}not-a-seq`, "{}"],
    ]);
    const reader = doEventLogReader<Msg>(fakeDoStorageAny(backing));
    const stored = await collect(reader.readStoredEvents());
    expect(
      stored.map((s) =>
        s._tag === "decoded" ? ["decoded", s.seq] : [s.reason, s.seq],
      ),
    ).toEqual([
      ["decoded", 1],
      ["json", 2],
      ["event", 3],
      ["not-text", 4],
      ["key", null],
    ]);
    expect(stored[0]?.serializedBytes).toBe(
      new TextEncoder().encode(JSON.stringify({ _tag: "inc", by: 1 }))
        .byteLength,
    );
    expect(stored[3]?.serializedBytes).toBe(0);
    await expect(collect(reader.readEvents())).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it("reads under custom keys and a host parseEvent", async () => {
    const keys = { snapshot: "a/snap", meta: "a/meta", eventPrefix: "a/evt/" };
    const backing = new Map<string, string>([
      ["a/meta", '{"lastSeq":2}'],
      [rowKey(1, "a/evt/"), JSON.stringify({ type: "inc", by: 1 })],
      [rowKey(2, "a/evt/"), JSON.stringify({ type: "reset" })],
    ]);
    const reader = doEventLogReader<Msg>(fakeStorage(backing).storage, {
      keys,
      parseEvent: (raw) => {
        const { type, ...rest } = raw as { type: string };
        return { _tag: type, ...rest } as Msg;
      },
    });
    expect(await reader.readHead()).toEqual({
      lastSeq: 2,
      snapshot: false,
      format: "messages",
    });
    expect(await collect(reader.readEvents())).toEqual([
      { seq: 1, event: { _tag: "inc", by: 1 } },
      { seq: 2, event: { _tag: "reset" } },
    ]);
  });

  it("refuses an invalid committed sequence", async () => {
    const reader = doEventLogReader<Msg>(
      fakeStorage(new Map([["@@es/meta", '{"lastSeq":-1}']])).storage,
    );
    await expect(reader.readHead()).rejects.toThrow(/committed sequence/);
    await expect(reader.readCommittedSeq()).rejects.toThrow(
      /committed sequence/,
    );
  });
});

function fakeDoStorageAny(backing: Map<string, unknown>): DurableObjectStorage {
  return fakeStorage<unknown>(backing).storage;
}
