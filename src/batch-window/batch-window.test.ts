import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addItem,
  type BatchWindow,
  type BatchWindowConfig,
  type BatchWindowExpired,
  batchWindowExpired,
  createBatchWindow,
  initBatchWindow,
  onWindow,
  subscribeBatchWindow,
  subsFor,
} from "./index";

// The Cmd a flush emits in these tests: a plain tagged-data Cmd carrying the
// batch. `flush` is a pure constructor — no I/O, no clock — so the verbs stay
// replayable and the emitted Cmd is inspectable structurally.
type FlushCmd = { type: "flush"; items: readonly number[] };
const flush = (items: readonly number[]): FlushCmd => ({
  type: "flush",
  items,
});

// A small, readable config: a 3-item page or a 1s window, whichever comes
// first. Used across the verb suites so the triggers are observable.
const cfg: BatchWindowConfig<number, FlushCmd> = {
  maxItems: 3,
  maxMs: 1000,
  flush,
};

describe("initBatchWindow", () => {
  it("starts closed: empty buffer, no open instant", () => {
    expect(initBatchWindow<number>()).toEqual({ buffer: [], openedAt: null });
  });
});

describe("addItem — size trigger", () => {
  it("opens the window on the first item, anchoring openedAt to its `at`", () => {
    const [next, cmds] = addItem(cfg, initBatchWindow<number>(), 1, 100);
    expect(next).toEqual({ buffer: [1], openedAt: 100 });
    expect(cmds).toEqual([]);
  });

  it("appends within the window WITHOUT moving openedAt (latency clock runs from item 1)", () => {
    let s: BatchWindow<number> = initBatchWindow();
    [s] = addItem(cfg, s, 1, 100);
    // later `at`, but the window stays anchored at openedAt 100
    const [appended, cmds] = addItem(cfg, s, 2, 250);
    expect(appended).toEqual({ buffer: [1, 2], openedAt: 100 });
    expect(cmds).toEqual([]);
  });

  it("flushes the instant the buffer reaches maxItems, then resets to closed", () => {
    let s: BatchWindow<number> = initBatchWindow();
    [s] = addItem(cfg, s, 1, 100);
    [s] = addItem(cfg, s, 2, 200);
    const [next, cmds] = addItem(cfg, s, 3, 300); // 3rd item hits maxItems
    expect(cmds).toEqual([flush([1, 2, 3])]);
    // Reset: the window is closed again, ready for the next batch.
    expect(next).toEqual({ buffer: [], openedAt: null });
  });

  it("EARLY-FLUSH: a full page ships on maxItems BEFORE the window timer fires", () => {
    // The window opened at 100 with a 1000ms ceiling, so the time trigger would
    // not fire until 1100. But every item arrives much earlier (well inside the
    // window), and the 3rd hits maxItems — so the batch flushes at `at=120`, a
    // full 980ms ahead of the timer. The size trigger pre-empts the clock.
    let s: BatchWindow<number> = initBatchWindow();
    [s] = addItem(cfg, s, 1, 100); // opens; timer would target openedAt+maxMs=1100
    [s] = addItem(cfg, s, 2, 110); // still open, well before 1100
    const [next, cmds] = addItem(cfg, s, 3, 120); // maxItems → early flush at 120
    expect(cmds).toEqual([flush([1, 2, 3])]);
    expect(next).toEqual({ buffer: [], openedAt: null });
    // And the window timer Sub disarms immediately: the reconcile pass that runs
    // on this closed slice returns no deadline Sub, so the 1100 timer Msg never
    // gets armed — the early flush genuinely beat (and cancelled) the clock.
    expect(subsFor(cfg, next)).toEqual([]);
  });

  it("a maxItems<=1 config flushes every item on arrival (degenerate no-batching)", () => {
    const eager: BatchWindowConfig<number, FlushCmd> = { ...cfg, maxItems: 1 };
    const [next, cmds] = addItem(eager, initBatchWindow<number>(), 7, 0);
    expect(cmds).toEqual([flush([7])]);
    expect(next).toEqual({ buffer: [], openedAt: null });
  });

  it("preserves arrival order in the flushed batch", () => {
    let s: BatchWindow<number> = initBatchWindow();
    [s] = addItem(cfg, s, 30, 0);
    [s] = addItem(cfg, s, 10, 1);
    const [, cmds] = addItem(cfg, s, 20, 2);
    expect(cmds).toEqual([flush([30, 10, 20])]); // insertion order, not sorted
  });
});

describe("onWindow — time trigger", () => {
  it("flushes the buffered items and resets when a window is open", () => {
    let s: BatchWindow<number> = initBatchWindow();
    [s] = addItem(cfg, s, 1, 100);
    [s] = addItem(cfg, s, 2, 200);
    const [next, cmds] = onWindow(cfg, s, 1100); // window's maxMs elapsed
    expect(cmds).toEqual([flush([1, 2])]);
    expect(next).toEqual({ buffer: [], openedAt: null });
  });

  it("is a no-op on a closed window — never ships an empty batch", () => {
    const [next, cmds] = onWindow(cfg, initBatchWindow<number>(), 1100);
    expect(cmds).toEqual([]);
    expect(next).toEqual({ buffer: [], openedAt: null });
  });

  it("ignores a stale timer Msg that lands AFTER a size-flush already emptied the window", () => {
    // Race: the size trigger flushed at item 3 and reset the slice; the time
    // Sub's Msg arrives later against the now-closed window. It must not emit.
    let s: BatchWindow<number> = initBatchWindow();
    [s] = addItem(cfg, s, 1, 0);
    [s] = addItem(cfg, s, 2, 0);
    [s] = addItem(cfg, s, 3, 0); // size-flush → s is now closed
    expect(s).toEqual({ buffer: [], openedAt: null });
    const [next, cmds] = onWindow(cfg, s, 1000); // stale timer Msg
    expect(cmds).toEqual([]);
    expect(next).toEqual({ buffer: [], openedAt: null });
  });
});

describe("immutability (verbs never mutate their input)", () => {
  it("addItem leaves the input slice untouched", () => {
    const s = Object.freeze({
      buffer: Object.freeze([1, 2]),
      openedAt: 100,
    }) as BatchWindow<number>;
    const before: BatchWindow<number> = { buffer: [1, 2], openedAt: 100 };
    addItem(cfg, s, 3, 300); // this also size-flushes; input must survive
    expect(s).toEqual(before);
  });

  it("onWindow leaves the input slice untouched", () => {
    const s = Object.freeze({
      buffer: Object.freeze([1, 2]),
      openedAt: 100,
    }) as BatchWindow<number>;
    const before: BatchWindow<number> = { buffer: [1, 2], openedAt: 100 };
    onWindow(cfg, s, 1100);
    expect(s).toEqual(before);
  });
});

describe("subsFor — window timer arms only while open", () => {
  it("emits no Sub for a closed window", () => {
    expect(subsFor(cfg, initBatchWindow<number>())).toEqual([]);
  });

  it("emits a deadline Sub targeting openedAt + maxMs while open", () => {
    let s: BatchWindow<number> = initBatchWindow();
    [s] = addItem(cfg, s, 1, 100);
    const subs = subsFor(cfg, s);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ type: "deadline", atMs: 1100 });
  });

  it("disarms (returns []) after a flush empties the buffer", () => {
    let s: BatchWindow<number> = initBatchWindow();
    [s] = addItem(cfg, s, 1, 100);
    [s] = addItem(cfg, s, 2, 200);
    [s] = addItem(cfg, s, 3, 300); // size-flush resets to closed
    expect(subsFor(cfg, s)).toEqual([]);
  });

  it("routes by id so several windows on one machine stay distinct", () => {
    let s: BatchWindow<number> = initBatchWindow();
    [s] = addItem(cfg, s, 1, 0);
    const a = subsFor(cfg, s, "logs");
    const b = subsFor(cfg, s, "metrics");
    expect(a[0]?.id).toBe("logs");
    expect(b[0]?.id).toBe("metrics");
    expect(a[0]?.id).not.toBe(b[0]?.id);
  });
});

describe("batchWindowExpired", () => {
  it("constructs the deadline-shaped Msg the consumer handles via onWindow", () => {
    expect(batchWindowExpired("logs", 1100)).toEqual({
      type: "deadline_exceeded",
      id: "logs",
      atMs: 1100,
    });
  });
});

describe("subscribeBatchWindow — the window timer fires", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const BASE = 1_000_000;

  it("dispatches batchWindowExpired once after (atMs - now), then never again", () => {
    vi.setSystemTime(BASE);
    const dispatched: BatchWindowExpired[] = [];
    const sub = { id: "logs", type: "deadline", atMs: BASE + 1000 } as const;

    subscribeBatchWindow(sub, undefined, (m) => dispatched.push(m));

    vi.advanceTimersByTime(999);
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dispatched).toEqual([batchWindowExpired("logs", BASE + 1000)]);

    // One-shot — no re-fire.
    vi.advanceTimersByTime(10_000);
    expect(dispatched).toHaveLength(1);
  });

  it("cleanup cancels the pending timer (disarm-on-flush path)", () => {
    vi.setSystemTime(BASE);
    const dispatched: BatchWindowExpired[] = [];
    const sub = { id: "logs", type: "deadline", atMs: BASE + 1000 } as const;

    const cleanup = subscribeBatchWindow(sub, undefined, (m) =>
      dispatched.push(m),
    );
    cleanup(); // the substrate calls this when subsFor drops the Sub after a flush
    vi.advanceTimersByTime(10_000);
    expect(dispatched).toEqual([]);
  });
});

describe("createBatchWindow — combinator knob shape", () => {
  it("init returns the closed slice", () => {
    const bw = createBatchWindow(cfg);
    expect(bw.init()).toEqual({ buffer: [], openedAt: null });
  });

  it("add / onWindow delegate to the pure verbs with the bound config", () => {
    const bw = createBatchWindow(cfg);
    let s = bw.init();
    let cmds: readonly FlushCmd[];
    [s, cmds] = bw.add(s, 1, 100);
    expect(cmds).toEqual([]);
    [s, cmds] = bw.add(s, 2, 200);
    expect(cmds).toEqual([]);
    [s, cmds] = bw.onWindow(s, 1100);
    expect(cmds).toEqual([flush([1, 2])]);
    expect(s).toEqual({ buffer: [], openedAt: null });
  });

  it("subs / handlers wire the window timer", () => {
    const bw = createBatchWindow(cfg);
    let s = bw.init();
    expect(bw.subs(s)).toEqual([]); // closed → no timer
    [s] = bw.add(s, 1, 100);
    expect(bw.subs(s, "logs")[0]).toMatchObject({ id: "logs", atMs: 1100 });
    // The subscribe map is keyed "deadline" and reuses deadline's handler.
    expect(bw.handlers().deadline).toBe(subscribeBatchWindow);
  });
});

describe("property: the slice invariant (empty buffer IFF openedAt null) always holds", () => {
  it("survives any interleaving of add and onWindow", () => {
    type Op =
      | { kind: "add"; item: number; at: number }
      | { kind: "window"; at: number };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({
        kind: fc.constant<"add">("add"),
        item: fc.integer(),
        at: fc.integer({ min: 0, max: 1_000_000 }),
      }),
      fc.record({
        kind: fc.constant<"window">("window"),
        at: fc.integer({ min: 0, max: 1_000_000 }),
      }),
    );

    fc.assert(
      fc.property(
        // maxItems >= 1 so the size trigger is well-defined; flush stays pure.
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.array(opArb, { maxLength: 50 }),
        (maxItems, maxMs, ops) => {
          const c: BatchWindowConfig<number, FlushCmd> = {
            maxItems,
            maxMs,
            flush,
          };
          let s: BatchWindow<number> = initBatchWindow();
          for (const op of ops) {
            [s] =
              op.kind === "add"
                ? addItem(c, s, op.item, op.at)
                : onWindow(c, s, op.at);
            // The core invariant the window timer arm/disarm depends on.
            expect(s.buffer.length === 0).toBe(s.openedAt === null);
            // The buffer never exceeds maxItems — it flushes AT the cap.
            expect(s.buffer.length).toBeLessThan(Math.max(1, maxItems));
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("property: every buffered item is delivered exactly once across all flushes", () => {
  it("no item is dropped or duplicated, regardless of trigger interleaving", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 40 }),
        (maxItems, items) => {
          const c: BatchWindowConfig<number, FlushCmd> = {
            maxItems,
            maxMs: 1000,
            flush,
          };
          let s: BatchWindow<number> = initBatchWindow();
          const delivered: number[] = [];
          // Feed every item (size-flushes may emit along the way), stamping
          // each `at` with its arrival index...
          for (const [at, item] of items.entries()) {
            let cmds: readonly FlushCmd[];
            [s, cmds] = addItem(c, s, item, at);
            for (const cmd of cmds) delivered.push(...cmd.items);
          }
          // ...then close the trailing window with a time flush.
          const [, tail] = onWindow(c, s, items.length);
          for (const cmd of tail) delivered.push(...cmd.items);
          // Exactly the input, in order: nothing dropped, nothing duplicated.
          expect(delivered).toEqual(items);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ===========================================================================
// DURABILITY GUARD (package-wide invariant). Every reachable TERMINAL slice of
// this module must round-trip through JSON unchanged: a DO eviction + reload
// must resurrect the EXACT slice that was saved, never a lossy or mutated one.
// The two reachable terminal slices are the CLOSED window ({ buffer: [],
// openedAt: null }) and the OPEN window ({ buffer: [...non-empty], openedAt:
// number }); the verbs only ever produce these two. `readonly` fields
// type-enforce immutability — this property enforces serializability. If a verb
// ever folded a non-plain value into the buffer or `openedAt` (a Date, a Map,
// an `Error` — whose `JSON.stringify` is `{}` or an ISO string), it fails.
// ===========================================================================

describe("durability guard — terminal slices round-trip through JSON", () => {
  // A structured payload (not a bare number) so the round-trip genuinely
  // exercises nested + optional fields in the buffer, not just primitives.
  interface LogLine {
    readonly seq: number;
    readonly tag: string;
    readonly meta?: { readonly host: string; readonly retries: number };
  }
  const lineArb: fc.Arbitrary<LogLine> = fc.record(
    {
      seq: fc.integer(),
      tag: fc.string(),
      meta: fc.option(fc.record({ host: fc.string(), retries: fc.nat(10) }), {
        nil: undefined,
      }),
    },
    { requiredKeys: ["seq", "tag"] },
  );

  type FlushLines = { type: "flush"; items: readonly LogLine[] };
  const flushLines = (items: readonly LogLine[]): FlushLines => ({
    type: "flush",
    items,
  });

  // A driver op: each maps to exactly one pure verb, the blessed surface a
  // consumer's reducer cells call.
  type Op =
    | { readonly kind: "add"; readonly item: LogLine; readonly at: number }
    | { readonly kind: "window"; readonly at: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constant("add" as const),
      item: lineArb,
      at: fc.nat(1_000_000),
    }),
    fc.record({ kind: fc.constant("window" as const), at: fc.nat(1_000_000) }),
  );

  function step(
    c: BatchWindowConfig<LogLine, FlushLines>,
    state: BatchWindow<LogLine>,
    op: Op,
  ): BatchWindow<LogLine> {
    return op.kind === "add"
      ? addItem(c, state, op.item, op.at)[0]
      : onWindow(c, state, op.at)[0];
  }

  it("every reachable slice (open or closed, and every intermediate) round-trips equal", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.array(opArb, { maxLength: 50 }),
        (maxItems, maxMs, ops) => {
          const c: BatchWindowConfig<LogLine, FlushLines> = {
            maxItems,
            maxMs,
            flush: flushLines,
          };
          let s: BatchWindow<LogLine> = initBatchWindow();
          for (const op of ops) {
            s = step(c, s, op);
            // Every step's slice — terminal flush-resets AND open intermediates
            // — is a persisted boundary value, so each must survive save/reload.
            const roundTripped: BatchWindow<LogLine> = JSON.parse(
              JSON.stringify(s),
            );
            expect(roundTripped).toEqual(s);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("a slice driven to a terminal fixpoint (closed by a final time flush) round-trips equal", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(opArb, { maxLength: 50 }),
        (maxItems, ops) => {
          const c: BatchWindowConfig<LogLine, FlushLines> = {
            maxItems,
            maxMs: 1000,
            flush: flushLines,
          };
          let s: BatchWindow<LogLine> = initBatchWindow();
          for (const op of ops) s = step(c, s, op);
          // Drive to the closed terminal: a final time flush empties any open
          // window, landing on { buffer: [], openedAt: null }.
          s = onWindow(c, s, 2_000_000)[0];
          expect(s).toEqual({ buffer: [], openedAt: null });
          const roundTripped: BatchWindow<LogLine> = JSON.parse(
            JSON.stringify(s),
          );
          expect(roundTripped).toEqual(s);
        },
      ),
      { numRuns: 500 },
    );
  });
});
