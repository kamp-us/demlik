// ═══════════════════════════════════════════════════════════════════════════
// SMOKE — the type layer and the walk read the SAME field.
//
// Three of the chart's guarantees were split across two layers that keyed off
// two different conditions and were only correct while those conditions agreed.
// Each is now one condition, and each is checked HERE at runtime as well as by
// a probe, because "the marker fires" and "the shape the marker protects is the
// shape the walk actually builds" are different claims:
//
//   1. a guarded edge — `Cell`/`RCell` and `buildCell` both read `when`, so the
//      `{ then, else }` bag the author writes is the bag the walk calls, on
//      both arms and in both chart forms.
//   2. a resume edge — nothing may sit beside it that would also pick a target,
//      so the walk's resume-first branch is not stepping over live declarations.
//   3. an authored universe-spanning `scope` — the type layer demands a
//      decision at every state (probe 47), and the walk agrees by producing a
//      live cell there rather than a `NoCellError`.
// ═══════════════════════════════════════════════════════════════════════════
import { expect, it } from "vitest";
import { compile, compileReducer } from "./compile";
import { defineChart, defineReducerChart, ty } from "./graph";

// ── 1a. the grid form: both guard arms ────────────────────────────────────
const guarded = defineChart({
  ctx: ty<{ readonly n: number }>(),
  events: { A: { scope: "edges" } },
  states: {
    only: {
      s0: {
        initial: true,
        on: { A: { target: "hit", when: "gate", otherwise: "miss" } },
      },
      hit: {},
      miss: {},
    },
  },
});

const guardedTable = (open: boolean) =>
  compile(guarded, {
    assign: {
      // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
      "s0.A": { then: (s) => ({ n: s.n + 1 }), else: (s) => ({ n: s.n - 1 }) },
    },
    guards: { gate: () => open },
  });

it("a guarded edge takes its `then` arm when the guard holds", () => {
  const [next] = guardedTable(true).s0.A({ type: "s0", n: 1 }, { type: "A" });
  expect(next).toEqual({ type: "hit", n: 2 });
});

it("a guarded edge takes its `else` arm when the guard fails", () => {
  const [next] = guardedTable(false).s0.A({ type: "s0", n: 1 }, { type: "A" });
  expect(next).toEqual({ type: "miss", n: 0 });
});

// an edge naming a guard with no implementation refuses at compile(), naming
// the guards that WERE supplied so a misspelling is legible against them (#22).
it("a missing guard names the guards that were supplied", () => {
  let msg = "no throw";
  try {
    compile(guarded, {
      assign: {
        // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
        "s0.A": { then: (s) => ({ n: s.n }), else: (s) => ({ n: s.n }) },
      },
      guards: { notGate: () => true } as never,
    });
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  // the pre-#22 text is still the prefix, and the new clause names the member.
  expect(msg).toContain('names guard "gate" with no implementation');
  expect(msg).toContain('The guards supplied: "notGate".');
});

// ── 1b. the reducer form: the same edge, one dimension smaller ────────────
const rGuarded = defineReducerChart({
  ctx: ty<{ readonly n: number }>(),
  states: ["idle", "hit", "miss"],
  initial: "idle",
  events: { A: {} },
  on: { A: { target: "hit", when: "gate", otherwise: "miss" } },
});

const rGuardedTable = (open: boolean) =>
  compileReducer(rGuarded, {
    assign: {
      // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
      A: { then: (s) => ({ n: s.n + 1 }), else: (s) => ({ n: s.n - 1 }) },
    },
    guards: { gate: () => open },
  });

it("a guarded reducer edge takes both arms, same as the grid form", () => {
  const [hit] = rGuardedTable(true).A({ type: "idle", n: 1 }, { type: "A" });
  const [miss] = rGuardedTable(false).A({ type: "idle", n: 1 }, { type: "A" });
  expect([hit, miss]).toEqual([
    { type: "hit", n: 2 },
    { type: "miss", n: 0 },
  ]);
});

// ── 2. a resume edge, with nothing beside it to argue with ────────────────
const parking = defineChart({
  ctx: ty<{ readonly n: number }>(),
  events: { PARK: { scope: "edges" }, BACK: { scope: "edges" } },
  states: {
    only: {
      s1: { initial: true, on: { PARK: "hold" } },
      s2: { on: { PARK: "hold" } },
      hold: { on: { BACK: { resume: { fallback: "s1" } } } },
    },
  },
});

const parkingTable = compile(parking, {
  assign: {
    "s1.PARK": (s) => ({ n: s.n }),
    "s2.PARK": (s) => ({ n: s.n }),
    "hold.BACK": (s) => ({ n: s.n }),
  },
});

it("a resume edge lands on `was`, and on its fallback when there is none", () => {
  const parked = parkingTable.s2.PARK(
    { type: "s2", n: 7 },
    { type: "PARK" },
  )[0];
  expect(parked).toEqual({ type: "hold", n: 7, was: "s2" });
  // A `Transitions` cell returns the whole State union by contract, so narrow
  // before feeding it to the next row — the same thing a real caller does.
  if (parked.type !== "hold")
    throw new Error(`expected hold, got ${parked.type}`);
  const back = parkingTable.hold.BACK(parked, { type: "BACK" })[0];
  expect(back).toEqual({ type: "s2", n: 7 });
});

// ── 3. an authored universe-spanning scope is LIVE, in both layers ────────
//
// `ScopeAt` used to read this list as no scope at all, so `MissingPairs<G>` was
// `never` and the type layer called the chart total — while `scopeList(…)
// .includes("all")` read it as live and threw `NoCellError` on the first msg.
// The type layer now demands the decision (probe 47); this is the other half of
// the agreement: once the decision is made, the walk runs it.
const spanning = defineChart({
  ctx: ty<{ readonly n: number }>(),
  events: { PING: { scope: ["edges", "all", "p"] } },
  states: {
    p: { a: { initial: true, on: { PING: "b" } }, b: { ignore: ["PING"] } },
  },
});

it("a universe-spanning scope is live everywhere, and the walk agrees", () => {
  const table = compile(spanning, {
    assign: { "a.PING": (s) => ({ n: s.n }) },
  });
  expect(table.a.PING({ type: "a", n: 3 }, { type: "PING" })[0]).toEqual({
    type: "b",
    n: 3,
  });
  // `b` refused it BY NAME — the refusal is a self-loop, not a throw.
  const same = { type: "b", n: 3 } as const;
  expect(table.b.PING(same, { type: "PING" })[0]).toBe(same);
});
