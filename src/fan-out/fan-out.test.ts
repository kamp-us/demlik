import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  __resetPortRegistry,
  type Cmd,
  defineMachine,
  definePort,
  type Runtime,
  run,
} from "../index";
import { bindMachine } from "../testing";
import {
  createFanOut,
  type FanOutState,
  initFanOut,
  isComplete,
} from "./index";

// === Fixtures ===
//
// Inputs are plain strings; ids ARE the string (identity `idOf`) so an item's
// id is human-readable in assertions. The per-item effect is a `crawl` Cmd
// carrying the item; results are uppercased strings so OK results are
// distinguishable from inputs at a glance.
type Item = string;
type Result = string;
type Crawl = Cmd<"crawl"> & { item: Item };
type ReportDone = Cmd<"report_done"> & { results: readonly Result[] };

const baseConfig = {
  concurrency: 2,
  idOf: (item: Item) => item,
  of: (item: Item): Crawl => ({ type: "crawl", item }),
};

const withJoin = {
  ...baseConfig,
  join: (results: readonly Result[]): ReportDone => ({
    type: "report_done",
    results,
  }),
};

/** Drain `pending` + `running` from a slice into a flat id list for set assertions. */
function activeIds(state: FanOutState<Item, Result>): string[] {
  return [...state.pending, ...state.running];
}

describe("initFanOut / isComplete", () => {
  it("starts empty and is NOT complete (no batch to complete)", () => {
    const s = initFanOut<Item, Result>();
    expect(s).toEqual({
      pending: [],
      running: [],
      done: [],
      failed: [],
      items: [],
      waveDoneFrom: 0,
      waveFailedFrom: 0,
      joined: false,
    });
    expect(isComplete(s)).toBe(false);
  });

  it("a fully-drained non-empty batch reads complete", () => {
    const fan = createFanOut(baseConfig);
    const [s0] = fan.scatter(initFanOut<Item, Result>(), ["a"]);
    expect(isComplete(s0)).toBe(false); // "a" is running
    const [s1] = fan.itemOk(s0, "a", "A");
    expect(isComplete(s1)).toBe(true);
  });
});

describe("scatter — launch up to concurrency", () => {
  it("launches exactly `concurrency` items, holds the rest pending", () => {
    const fan = createFanOut(baseConfig); // concurrency 2
    const [state, cmds] = fan.scatter(initFanOut<Item, Result>(), [
      "a",
      "b",
      "c",
      "d",
    ]);

    expect(state.running).toEqual(["a", "b"]);
    expect(state.pending).toEqual(["c", "d"]);
    // One launch Cmd per running item, in launch order.
    expect(cmds).toEqual([
      { type: "crawl", item: "a" },
      { type: "crawl", item: "b" },
    ]);
    // The ledger flipped the launched two to running, the rest stay pending.
    expect(
      state.items.filter((i) => i.status === "running").map((i) => i.id),
    ).toEqual(["a", "b"]);
    expect(
      state.items.filter((i) => i.status === "pending").map((i) => i.id),
    ).toEqual(["c", "d"]);
  });

  it("launches all when the batch is smaller than concurrency", () => {
    const fan = createFanOut(baseConfig);
    const [state, cmds] = fan.scatter(initFanOut<Item, Result>(), ["only"]);
    expect(state.running).toEqual(["only"]);
    expect(state.pending).toEqual([]);
    expect(cmds).toEqual([{ type: "crawl", item: "only" }]);
  });

  it("clamps concurrency < 1 to a serial budget of 1 (never deadlocks)", () => {
    const fan = createFanOut({ ...baseConfig, concurrency: 0 });
    const [state, cmds] = fan.scatter(initFanOut<Item, Result>(), ["a", "b"]);
    expect(state.running).toEqual(["a"]);
    expect(state.pending).toEqual(["b"]);
    expect(cmds).toEqual([{ type: "crawl", item: "a" }]);
  });

  it("does not mutate the input slice", () => {
    const fan = createFanOut(baseConfig);
    const before = initFanOut<Item, Result>();
    const frozen = Object.freeze({ ...before });
    const [after] = fan.scatter(frozen, ["a"]);
    expect(frozen.running).toEqual([]);
    expect(after).not.toBe(frozen);
  });

  it("scatter never fires join (a batch can't complete on the transition it starts)", () => {
    const fan = createFanOut(withJoin);
    const [, cmds] = fan.scatter(initFanOut<Item, Result>(), ["a"]);
    expect(cmds).toEqual([{ type: "crawl", item: "a" }]);
  });
});

describe("itemOk / itemErr — record + backfill", () => {
  it("records a result, frees the slot, and launches the next pending item", () => {
    const fan = createFanOut(baseConfig); // concurrency 2
    const [s0] = fan.scatter(initFanOut<Item, Result>(), ["a", "b", "c"]);
    // a,b running; c pending.
    const [s1, cmds] = fan.itemOk(s0, "a", "A");

    expect(s1.done).toEqual([{ item: "a", result: "A" }]);
    expect(s1.running).toEqual(["b", "c"]); // b stayed, c backfilled
    expect(s1.pending).toEqual([]);
    // The backfill launched exactly c.
    expect(cmds).toEqual([{ type: "crawl", item: "c" }]);
  });

  it("records an error and backfills symmetrically", () => {
    const fan = createFanOut(baseConfig);
    const [s0] = fan.scatter(initFanOut<Item, Result>(), ["a", "b", "c"]);
    const err = new Error("boom");
    const [s1, cmds] = fan.itemErr(s0, "a", err);

    expect(s1.failed).toEqual([{ item: "a", error: err }]);
    expect(s1.running).toEqual(["b", "c"]);
    expect(cmds).toEqual([{ type: "crawl", item: "c" }]);
  });

  it("a settle for an unknown id is a no-op (no Cmds, slice unchanged)", () => {
    const fan = createFanOut(baseConfig);
    const [s0] = fan.scatter(initFanOut<Item, Result>(), ["a"]);
    const [s1, cmds] = fan.itemOk(s0, "ghost", "X");
    expect(s1).toBe(s0); // returns the same reference unchanged
    expect(cmds).toEqual([]);
  });

  it("a double-settle for the same id is a no-op the second time", () => {
    const fan = createFanOut(baseConfig);
    const [s0] = fan.scatter(initFanOut<Item, Result>(), ["a"]);
    const [s1] = fan.itemOk(s0, "a", "A");
    const [s2, cmds] = fan.itemOk(s1, "a", "AGAIN");
    expect(s2).toBe(s1);
    expect(cmds).toEqual([]);
    expect(s2.done).toEqual([{ item: "a", result: "A" }]); // first result stands
  });

  it("fires join exactly once, at the transition that drains the last item", () => {
    const fan = createFanOut(withJoin);
    const [s0] = fan.scatter(initFanOut<Item, Result>(), ["a", "b"]); // both running
    const [s1, cmds1] = fan.itemOk(s0, "a", "A");
    // Not complete yet — b still running. No join.
    expect(cmds1).toEqual([]);
    const [s2, cmds2] = fan.itemErr(s1, "b", "nope");
    // Now complete. join receives only the OK results.
    expect(isComplete(s2)).toBe(true);
    expect(cmds2).toEqual([{ type: "report_done", results: ["A"] }]);
  });

  it("omitting join → no completion Cmd ever", () => {
    const fan = createFanOut(baseConfig); // no join
    const [s0] = fan.scatter(initFanOut<Item, Result>(), ["a"]);
    const [, cmds] = fan.itemOk(s0, "a", "A");
    expect(cmds).toEqual([]);
  });
});

describe("handlers — out-of-band completion Port", () => {
  it("emits gathered results onto the Port iff the batch just completed", () => {
    __resetPortRegistry();
    const complete = definePort<readonly Result[]>("fan-out.test.complete");
    const fan = createFanOut(baseConfig);
    const h = fan.handlers({ complete });

    const emitted: (readonly Result[])[] = [];
    const emit = <T>(_port: unknown, value: T) => {
      emitted.push(value as readonly Result[]);
    };

    const [s0] = fan.scatter(initFanOut<Item, Result>(), ["a"]);
    h.emitOnComplete(emit, s0); // not complete → no emit
    expect(emitted).toEqual([]);

    const [s1] = fan.itemOk(s0, "a", "A");
    h.emitOnComplete(emit, s1); // complete → emit results
    expect(emitted).toEqual([["A"]]);
  });
});

// === Machine-level integration ===
//
// Fan-out threaded through a real reducer, asserted with the testing helpers.
// The machine's `update` folds the verbs into a single fan-out slice; `replay`
// reconstructs the same sequence the runtime would, so this pins the knob's
// contract at the machine boundary (durable + replayable).
type Phase = "idle" | "fanning" | "done";
interface MachineState {
  readonly phase: Phase;
  readonly fanOut: FanOutState<Item, Result>;
  readonly report: readonly Result[] | null;
}
type Msg =
  | { type: "start"; items: readonly Item[] }
  | { type: "crawl_ok"; id: string; result: Result }
  | { type: "crawl_err"; id: string; error: string }
  | ReportDone;

const machineFan = createFanOut(withJoin);

const machine = defineMachine<
  MachineState,
  Msg,
  Crawl | ReportDone,
  never,
  undefined
>({
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [
          { phase: "idle", fanOut: initFanOut<Item, Result>(), report: null },
          [],
        ],
  update: {
    start: (s, m) => {
      const [fanOut, cmds] = machineFan.scatter(s.fanOut, m.items);
      return [{ ...s, phase: "fanning", fanOut }, cmds];
    },
    crawl_ok: (s, m) => {
      const [fanOut, cmds] = machineFan.itemOk(s.fanOut, m.id, m.result);
      return [{ ...s, fanOut }, cmds];
    },
    crawl_err: (s, m) => {
      const [fanOut, cmds] = machineFan.itemErr(s.fanOut, m.id, m.error);
      return [{ ...s, fanOut }, cmds];
    },
    report_done: (s, m) => [{ ...s, phase: "done", report: m.results }, []],
  },
  interpret: {
    // The per-item effect + the join Cmd are performed by the consumer; here
    // they are inert (replay never runs interpret). Declared to satisfy the
    // Cmd union's exhaustive interpret map.
    crawl: async () => {},
    report_done: async () => {},
  },
});

describe("machine integration", () => {
  const bound = bindMachine(machine, undefined);

  it("scatter emits one launch Cmd per item up to concurrency", () => {
    bound.expectCmdSequence(
      { msgs: [{ type: "start", items: ["a", "b", "c"] }] },
      [
        { type: "crawl", item: "a" },
        { type: "crawl", item: "b" },
      ],
    );
  });

  it("drives a full batch to `done` and folds results via join", () => {
    const { state, cmds } = bound.replay({
      msgs: [
        { type: "start", items: ["a", "b", "c"] },
        { type: "crawl_ok", id: "a", result: "A" },
        { type: "crawl_ok", id: "b", result: "B" },
        { type: "crawl_ok", id: "c", result: "C" },
        { type: "report_done", results: ["A", "B", "C"] },
      ],
      loaded: null,
    });

    expect(state.phase).toBe("done");
    expect(state.report).toEqual(["A", "B", "C"]);
    expect(state.fanOut.done.map((d) => d.result)).toEqual(["A", "B", "C"]);
    // c was launched as a backfill once a or b settled.
    expect(cmds).toContainEqual({ type: "crawl", item: "c" });
    expect(cmds).toContainEqual({
      type: "report_done",
      results: ["A", "B", "C"],
    });
  });
});

// === Property tests ===
//
// Invariants the verbs must hold across ANY scatter + settle sequence. Items
// are unique strings (ids are the strings), so each settle addresses a real
// distinct item. The model interleaves OK and error settles arbitrarily.

describe("fan-out invariants (property)", () => {
  const uniqueItems = fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
      minLength: 1,
      maxLength: 20,
    })
    .map((items) => items);

  it("running.length never exceeds the (clamped) concurrency budget", () => {
    fc.assert(
      fc.property(
        uniqueItems,
        fc.integer({ min: -2, max: 8 }),
        fc.array(fc.boolean()),
        (items, conc, oks) => {
          const fan = createFanOut({ ...baseConfig, concurrency: conc });
          const budget = conc < 1 ? 1 : Math.floor(conc);
          let [state] = fan.scatter(initFanOut<Item, Result>(), items);
          expect(state.running.length).toBeLessThanOrEqual(budget);

          // Settle running items one at a time (always the head), OK or err per `oks`.
          let i = 0;
          while (state.running.length > 0) {
            const id = state.running[0];
            if (id === undefined) break; // unreachable: the while-guard holds length > 0
            const ok = oks[i % Math.max(1, oks.length)] ?? true;
            [state] = ok
              ? fan.itemOk(state, id, `R:${id}`)
              : fan.itemErr(state, id, "e");
            expect(state.running.length).toBeLessThanOrEqual(budget);
            i++;
          }
          return true;
        },
      ),
    );
  });

  it("every scattered item ends up settled exactly once; done+failed partition the batch", () => {
    fc.assert(
      fc.property(uniqueItems, fc.array(fc.boolean()), (items, oks) => {
        const fan = createFanOut(baseConfig);
        let [state] = fan.scatter(initFanOut<Item, Result>(), items);

        let i = 0;
        while (state.running.length > 0) {
          const id = state.running[0];
          if (id === undefined) break; // unreachable: the while-guard holds length > 0
          const ok = oks[i % Math.max(1, oks.length)] ?? true;
          [state] = ok
            ? fan.itemOk(state, id, `R:${id}`)
            : fan.itemErr(state, id, "e");
          i++;
        }

        // Terminal: nothing left in flight, batch complete.
        expect(activeIds(state)).toEqual([]);
        expect(isComplete(state)).toBe(true);

        // done ∪ failed = the original set, no dups, no extras.
        const settled = [
          ...state.done.map((d) => d.item),
          ...state.failed.map((f) => f.item),
        ];
        expect(settled.slice().sort()).toEqual(items.slice().sort());
        expect(state.done.length + state.failed.length).toBe(items.length);
        return true;
      }),
    );
  });

  it("join fires exactly once across the whole drain and carries every OK result", () => {
    fc.assert(
      fc.property(uniqueItems, fc.array(fc.boolean()), (items, oks) => {
        const fan = createFanOut(withJoin);
        let [state, cmds] = fan.scatter(initFanOut<Item, Result>(), items);
        let joinCount = cmds.filter((c) => c.type === "report_done").length;

        let i = 0;
        const okIds: string[] = [];
        while (state.running.length > 0) {
          const id = state.running[0];
          if (id === undefined) break; // unreachable: the while-guard holds length > 0
          const ok = oks[i % Math.max(1, oks.length)] ?? true;
          let stepCmds: readonly (Crawl | ReportDone)[];
          if (ok) {
            okIds.push(id);
            [state, stepCmds] = fan.itemOk(state, id, `R:${id}`);
          } else {
            [state, stepCmds] = fan.itemErr(state, id, "e");
          }
          joinCount += stepCmds.filter((c) => c.type === "report_done").length;
          i++;
        }

        // Exactly one join Cmd over the whole sequence.
        expect(joinCount).toBe(1);
        // The OK results it would carry equal the recorded done results.
        expect(state.done.map((d) => d.result).sort()).toEqual(
          okIds.map((id) => `R:${id}`).sort(),
        );
        return true;
      }),
    );
  });
});

// === DURABILITY GUARD (package-wide invariant) ===
//
// Every reachable TERMINAL slice of this module must round-trip through JSON
// unchanged: a DO eviction + reload must resurrect the exact slice that was
// saved, never a lossy or mutated one. `readonly` fields type-enforce
// immutability; this property enforces SERIALIZABILITY — fan-out carries its
// share of the invariant the work-queue durability guard pins for the package.
//
// The slice holds caller data in three spots: `input` (here a plain string),
// `result` in `done` (a plain string), and `error` in `failed` (typed
// `unknown`). A durable consumer stores PLAIN-DATA errors — the standing rule
// is errors are `{_tag}` sentinels, never `Error` objects (whose
// `JSON.stringify` collapses to `{}`). So this guard settles failures with a
// plain `{ _tag, msg }` sentinel: that is the slice the runtime actually
// persists, and the round-trip is therefore an HONEST assertion of what
// survives a reload. (Sanity: an `Error`-valued `failed` entry would NOT
// round-trip — that is a consumer bug, not a fan-out one, and outside the slice
// fan-out promises to persist.)
describe("durability guard — every reachable slice round-trips through JSON", () => {
  type DErr = { readonly _tag: "crawl_failed"; readonly msg: string };
  const errArb: fc.Arbitrary<DErr> = fc
    .string()
    .map((msg) => ({ _tag: "crawl_failed" as const, msg }));

  // Drive a random scatter+settle sequence to a TERMINAL fixpoint (no pending,
  // no running), asserting the slice survives a JSON save/reload at EVERY step
  // — every intermediate is itself a persisted boundary value — and at the
  // terminal fixpoint. Errors are plain `{_tag}` sentinels (see header).
  it("a slice driven to a terminal fixpoint (and every intermediate) round-trips equal", () => {
    fc.assert(
      fc.property(
        // One or more waves of unique items; concurrency varied incl. the clamp.
        fc.array(
          fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
            minLength: 1,
            maxLength: 6,
          }),
          { minLength: 1, maxLength: 4 },
        ),
        fc.integer({ min: -2, max: 5 }),
        fc.array(fc.boolean()),
        fc.array(errArb, { minLength: 1 }),
        (waves, conc, oks, errs) => {
          const fan = createFanOut<Item, DErr, Crawl>({
            ...baseConfig,
            concurrency: conc,
          });
          let state: FanOutState<Item, DErr> = initFanOut<Item, DErr>();

          const assertRoundTrips = (s: FanOutState<Item, DErr>) => {
            const roundTripped: FanOutState<Item, DErr> = JSON.parse(
              JSON.stringify(s),
            );
            expect(roundTripped).toEqual(s);
          };

          assertRoundTrips(state); // the empty init slice

          let i = 0;
          for (const wave of waves) {
            // Re-scatter into the SAME slice across waves (exercises the wave
            // boundary fields `waveDoneFrom` / `waveFailedFrom` / `joined`).
            [state] = fan.scatter(state, wave);
            assertRoundTrips(state);

            // Drain this wave to a fixpoint, interleaving OK / err settles.
            while (state.running.length > 0) {
              const id = state.running[0];
              if (id === undefined) break; // unreachable: while-guard holds length > 0
              const ok = oks[i % Math.max(1, oks.length)] ?? true;
              [state] = ok
                ? fan.itemOk(state, id, `R:${id}`)
                : fan.itemErr(state, id, errs[i % errs.length]);
              assertRoundTrips(state); // every settle's slice is a save boundary
              i++;
            }
          }

          // Terminal fixpoint: nothing in flight, batch complete, and the whole
          // slice survives a save/reload byte-for-equal.
          expect(state.pending.length).toBe(0);
          expect(state.running.length).toBe(0);
          expect(isComplete(state)).toBe(true);
          assertRoundTrips(state);
          return true;
        },
      ),
    );
  });
});

// === Regression: DUP-ID corruption (Bug 1) ===
//
// When two scattered inputs share an `idOf`, the ledger holds two `running`
// records under one id and `running` holds two inputs. The OLD verbs used
// `running.filter((x) => idOf(x) !== id)` + `items.map(id === ...)`, which
// dropped BOTH running entries on the first settle but recorded only ONE
// result — silently losing a unit of work. A settle must close out EXACTLY ONE
// running entry per id; the duplicate stays running until its own settle Msg.
describe("duplicate ids — settle exactly one running entry per settle", () => {
  type DupItem = { tag: string; n: number };
  // Two distinct inputs that collapse to the SAME id under `idOf`.
  const dupConfig = {
    concurrency: 4,
    idOf: (item: DupItem) => item.tag,
    of: (item: DupItem): Cmd<"crawl"> & { n: number } => ({
      type: "crawl",
      n: item.n,
    }),
  };

  it("a settle for a duplicated id closes ONE running entry, not all of them", () => {
    const fan = createFanOut(dupConfig);
    const [s0] = fan.scatter(initFanOut<DupItem, string>(), [
      { tag: "x", n: 1 },
      { tag: "x", n: 2 },
    ]);
    // Both share id "x" → both running, both ledger records running.
    expect(s0.running.length).toBe(2);
    expect(s0.items.filter((i) => i.status === "running").length).toBe(2);

    // First settle for "x": closes exactly one. One running entry must remain,
    // and exactly one ledger record must still be `running`.
    const [s1] = fan.itemOk(s0, "x", "FIRST");
    expect(s1.running.length).toBe(1); // OLD buggy code dropped BOTH → 0
    expect(s1.done.length).toBe(1);
    expect(s1.items.filter((i) => i.status === "running").length).toBe(1);
    expect(s1.items.filter((i) => i.status === "done").length).toBe(1);
    expect(isComplete(s1)).toBe(false); // batch NOT complete — one still in flight

    // Second settle for "x": now the batch closes. No work was lost.
    const [s2] = fan.itemOk(s1, "x", "SECOND");
    expect(s2.running.length).toBe(0);
    expect(s2.done.length).toBe(2);
    expect(s2.items.filter((i) => i.status === "done").length).toBe(2);
    expect(isComplete(s2)).toBe(true);
    expect(s2.done.map((d) => d.result)).toEqual(["FIRST", "SECOND"]);
  });
});

// === Regression: CROSS-WAVE join (Bug 2) ===
//
// `done` is append-only and persists across waves. The OLD `finishOrLaunch`
// fired `join` whenever `isComplete` was true and folded the WHOLE cumulative
// `done`. So a SECOND wave scattered into the same slice would, on completion,
// re-fire join AND fold wave-1 + wave-2 results. The fix: a per-wave boundary
// (`waveDoneFrom` + `joined`) so join folds only the current wave and fires
// exactly once per wave.
describe("cross-wave join — fold only the current wave, fire once per wave", () => {
  it("the second wave's join carries only the second wave's results", () => {
    const fan = createFanOut(withJoin);

    // Wave 1: scatter + drain ["a","b"] → join over ["A","B"].
    let [s] = fan.scatter(initFanOut<Item, Result>(), ["a", "b"]);
    let cmds: readonly (Crawl | ReportDone)[];
    [s, cmds] = fan.itemOk(s, "a", "A");
    expect(cmds.filter((c) => c.type === "report_done")).toEqual([]); // not complete
    [s, cmds] = fan.itemOk(s, "b", "B");
    expect(cmds).toContainEqual({ type: "report_done", results: ["A", "B"] });

    // Wave 2: re-scatter into the SAME drained slice + drain ["c","d"].
    [s] = fan.scatter(s, ["c", "d"]);
    [s, cmds] = fan.itemOk(s, "c", "C");
    expect(cmds.filter((c) => c.type === "report_done")).toEqual([]); // not complete
    [s, cmds] = fan.itemOk(s, "d", "D");

    // The wave-2 join must carry ONLY ["C","D"] — NOT the cumulative
    // ["A","B","C","D"] the buggy code folded.
    const joinCmds = cmds.filter((c) => c.type === "report_done");
    expect(joinCmds).toEqual([{ type: "report_done", results: ["C", "D"] }]);
    // `done` still accumulates the full history (it is the public read surface).
    expect(s.done.map((d) => d.result)).toEqual(["A", "B", "C", "D"]);
  });

  it("a stale settle reaching a completed wave does not re-fire join", () => {
    const fan = createFanOut(withJoin);
    let [s] = fan.scatter(initFanOut<Item, Result>(), ["a"]);
    let cmds: readonly (Crawl | ReportDone)[];
    [s, cmds] = fan.itemOk(s, "a", "A");
    expect(cmds).toContainEqual({ type: "report_done", results: ["A"] });
    // A second settle for the now-settled id is a no-op — no re-fire.
    [s, cmds] = fan.itemOk(s, "a", "AGAIN");
    expect(cmds).toEqual([]);
  });
});

// === WIRED end-to-end machine test (the missing test class) ===
//
// The existing "machine integration" block hand-feeds the `report_done` Msg and
// asserts intermediate Cmds — which is exactly why both bugs shipped green: it
// never re-enters the machine with the join Cmd the verbs actually emit, and it
// never drives a SECOND wave. This builds a REAL runtime via `run()` whose
// `crawl` interpret handler RE-ENTERS the machine (dispatches `crawl_ok` back),
// and whose `report_done` handler lands the join'd results in state. We drive
// two real waves and assert the END STATE — the per-wave `reports` history —
// not any Msg we hand-fed.
describe("wired machine — re-entrant interpret drives the real scatter-gather", () => {
  type WiredMsg =
    | { type: "start"; items: readonly Item[] }
    | { type: "crawl_ok"; id: string; result: Result }
    | ReportDone;

  interface WiredState {
    readonly fanOut: FanOutState<Item, Result>;
    // Every join the machine fires, in order — the END STATE we assert.
    readonly reports: readonly (readonly Result[])[];
  }

  // Ctx carries a late-bound runtime ref so the `crawl` interpret handler can
  // RE-ENTER the machine with the per-item result (the real runtime path the
  // hand-fed test skipped).
  interface WiredCtx {
    runtime: Runtime<WiredState, WiredMsg> | null;
  }

  async function buildWired() {
    const fan = createFanOut(withJoin);
    const ctx: WiredCtx = { runtime: null };

    const machine = defineMachine<
      WiredState,
      WiredMsg,
      Crawl | ReportDone,
      never,
      WiredCtx
    >({
      init: () => [{ fanOut: initFanOut<Item, Result>(), reports: [] }, []],
      update: {
        start: (s, m) => {
          const [fanOut, cmds] = fan.scatter(s.fanOut, m.items);
          return [{ ...s, fanOut }, cmds];
        },
        crawl_ok: (s, m) => {
          const [fanOut, cmds] = fan.itemOk(s.fanOut, m.id, m.result);
          return [{ ...s, fanOut }, cmds];
        },
        report_done: (s, m) => [
          { ...s, reports: [...s.reports, m.results] },
          [],
        ],
      },
      interpret: {
        // The per-item effect: RE-ENTER the machine with the result, the way a
        // real consumer's interpret routes a resolved effect back to itemOk.
        // Result is the uppercased item so it is distinguishable from the input.
        crawl: async (cmd) => {
          ctx.runtime?.dispatch({
            type: "crawl_ok",
            id: cmd.item,
            result: cmd.item.toUpperCase(),
          });
        },
        // `report_done` is the join Cmd. Its interpret RE-ENTERS it as the
        // matching Msg (same `type`) so the reducer lands the results in
        // `reports` — the runtime path that turns the verb's join Cmd into an
        // observable state change.
        report_done: async (cmd) => ({
          type: "report_done" as const,
          results: cmd.results,
        }),
      },
    });

    const runtime = await run(machine, { ctx }).ready;
    ctx.runtime = runtime;
    return runtime;
  }

  /** Spin the microtask/timer queue until `pred(state)` holds (or time out). */
  async function settleUntil(
    runtime: Runtime<WiredState, WiredMsg>,
    pred: (s: WiredState) => boolean,
  ): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      if (pred(runtime.getState())) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error("settleUntil: predicate never held");
  }

  it("drives TWO waves end-to-end; each wave's report carries only its own results", async () => {
    const runtime = await buildWired();

    // Wave 1: scatter 3 items (concurrency 2 → c backfills). The crawl handler
    // re-enters with each result; the verbs fold and fire join once.
    await runtime.dispatch({ type: "start", items: ["a", "b", "c"] });
    await settleUntil(runtime, (s) => s.reports.length === 1);

    // Wave 2: scatter into the SAME runtime/slice and drain.
    await runtime.dispatch({ type: "start", items: ["d", "e"] });
    await settleUntil(runtime, (s) => s.reports.length >= 2);

    const end = runtime.getState();
    // END-STATE assertion: exactly two joins, each scoped to its own wave. The
    // buggy code would re-fold wave 1 into wave 2 — reports[1] would be the
    // cumulative ["A","B","C","D","E"] instead of ["D","E"].
    expect(end.reports.length).toBe(2);
    const [wave1, wave2] = end.reports;
    expect(wave1).toBeDefined();
    expect(wave2).toBeDefined();
    expect([...(wave1 ?? [])].sort()).toEqual(["A", "B", "C"]);
    expect([...(wave2 ?? [])].sort()).toEqual(["D", "E"]);

    // The full batch settled; `done` is the cumulative public read surface.
    expect(isComplete(end.fanOut)).toBe(true);
    expect(end.fanOut.done.map((d) => d.result).sort()).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);

    await runtime.stop();
  });
});
