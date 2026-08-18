// ═══════════════════════════════════════════════════════════════════════════
// SMOKE — the reducer form, end to end.
//
// Three claims: the compiled thing is a REAL `Reducer` (flat, msg-keyed, and
// `defineMachine` stamps `__form: "reducer"` on it with no cast); the resilient
// fetch port behaves; and per-event namespacing survives the loss of the phase
// dimension, foreign events included.
// ═══════════════════════════════════════════════════════════════════════════
import { expect, it } from "vitest";
import { type Cmd, formOf, msgKeysOf, type Sub } from "../pure/core";
import { defineMachine } from "../runtime-types";
import {
  fetchReducerChart,
  fetchReducerInit,
  fetchReducerRegion,
  fetchReducerSubs,
  fetchReducerUpdate,
  type RFDoFetch,
  type RFMsgIn,
  type RFState,
} from "./__fixtures__/resilient-fetch-reducer";
import {
  CellTargetError,
  compileReducer,
  reducerInitFrom,
  reducerMermaid,
} from "./compile";
import {
  type CmdOf,
  defineReducerChart,
  type MsgOf,
  type RCells,
  type RStateOf,
  ty,
} from "./graph";

/**
 * One assertion → one vitest test, comparing stable JSON — the smoke script's
 * comparison verbatim, so key order still counts.
 */
function ok(what: string, got: unknown, want: unknown): void {
  it(what, () => {
    expect(JSON.stringify(got), what).toBe(JSON.stringify(want));
  });
}

// ── 1. it is a Reducer, not a Transitions ─────────────────────────────────
const keys = Object.keys(fetchReducerUpdate as object).sort();
ok("compiled update is keyed by MSG type, flat", keys, [
  "deadline_exceeded",
  "fetch",
  "fetch_err",
  "fetch_ok",
]);

const machine = defineMachine<
  RFState,
  MsgOf<typeof fetchReducerChart>,
  RFDoFetch,
  Sub<never>,
  Record<never, never>
>({
  // ← DERIVED: the entry state NAME comes from the chart's `initial`.
  init: fetchReducerInit,
  // ← the compiled reducer, verbatim. No `as`, no `satisfies`.
  update: fetchReducerUpdate,
  subscriptions: fetchReducerSubs as unknown as (
    s: RFState,
  ) => readonly Sub<never>[],
  // required by `Machine` whenever the Cmd union is inhabited.
  interpret: { do_fetch: async () => {} },
});
ok("defineMachine detects the reducer form", formOf(machine), "reducer");
ok("msgKeysOf reads the flat keys", [...msgKeysOf(machine)].sort(), keys);

// ── 2. it behaves ─────────────────────────────────────────────────────────
const T0 = 1_000_000;
const U = "u://x";
let s = fetchReducerInit(null)[0];
ok("init → the declared entry state", s.type, "idle");

const step = (m: { type: string; [k: string]: unknown }): readonly Cmd[] => {
  const table = fetchReducerUpdate as unknown as Record<
    string,
    (a: RFState, b: unknown) => readonly [RFState, readonly Cmd[]]
  >;
  // biome-ignore lint/style/noNonNullAssertion: the compiled table is total over the event alphabet by construction — a mapped type tsc cannot see through under noUncheckedIndexedAccess
  const [next, cs] = table[m.type]!(s, m);
  s = next;
  return cs;
};

let cs = step({ type: "fetch", url: U, at: T0 });
ok("idle -fetch-> fetching", s.type, "fetching");
ok("…and the cell emitted the effect", cs, [{ type: "do_fetch", url: U }]);

cs = step({ type: "fetch_ok", url: U, body: "hi", at: T0 + 10 });
ok("the ONE declarative edge lands its fixed target", s.type, "succeeded");
ok("…with the assign's payload", s.body, "hi");
ok("…and no cmds", cs, []);

// a second fetch of the same url is served from cache — same edge, no effect.
cs = step({ type: "fetch", url: U, at: T0 + 20 });
ok("cache hit stays in succeeded", s.type, "succeeded");
ok("…and emits nothing", cs, []);

// the phase-conditioned no-op the chart deliberately does NOT declare.
const before = s.type;
cs = step({ type: "deadline_exceeded", id: "retry", atMs: T0 + 30 });
ok("deadline outside waiting_retry is a no-op", s.type, before);
ok("…emitting nothing", cs, []);

// a url the cache has never seen, so the retry path is genuinely exercised.
step({ type: "fetch", url: "u://y", at: T0 + 40 });
step({ type: "fetch_err", url: "u://y", error: "boom", at: T0 + 50 });
ok("fetch_err schedules a retry", s.type, "waiting_retry");
ok("…and the sub is live exactly there", fetchReducerSubs(s).length, 1);

cs = step({ type: "deadline_exceeded", id: "retry", atMs: s.retryAtMs });
ok("…the timer re-attempts", s.type, "fetching");
ok("…re-emitting the effect", cs, [{ type: "do_fetch", url: "u://y" }]);

// ── 3. namespacing, one dimension down ────────────────────────────────────
const nsA = fetchReducerRegion("A");
ok(
  "namespaced keys, foreign event kept bare",
  Object.keys(nsA as object).sort(),
  ["A.fetch", "A.fetch_err", "A.fetch_ok", "deadline_exceeded"],
);
type NsMsgs = RFMsgIn<"A">["type"];
const nsProof: NsMsgs[] = [
  "A.fetch",
  "A.fetch_ok",
  "A.fetch_err",
  "deadline_exceeded",
];
ok("…and the type-level keys match the runtime ones", nsProof.sort(), [
  "A.fetch",
  "A.fetch_err",
  "A.fetch_ok",
  "deadline_exceeded",
]);

// ── 4. a guarded declarative edge — the grid form's `when`/`otherwise`, kept ─
const gate = defineReducerChart({
  ctx: ty<{ readonly n: number }>(),
  states: ["open", "shut"],
  initial: "open",
  cmds: { ping: ty<{ readonly n: number }>() },
  events: { poke: { data: ty<{ readonly by: number }>() } },
  on: {
    poke: {
      target: "shut",
      when: "bigEnough",
      otherwise: "open",
      cmd: "ping",
    },
  },
});
type GG = typeof gate;
const gated = compileReducer(gate, {
  assign: {
    poke: {
      // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
      then: (s, m) => ({ n: s.n + m.by }),
      else: (s) => ({ n: s.n }),
    },
  },
  guards: { bigEnough: (_s, m, _at) => m.by > 10 },
  cmds: { ping: (s) => ({ n: s.n }) },
});
const gInit = reducerInitFrom<GG, RStateOf<GG>, CmdOf<GG>>(gate, () => ({
  n: 0,
}));
ok("guarded edge: init", gInit(null)[0], { n: 0, type: "open" });
ok(
  "guarded edge: guard TRUE arm",
  gated.poke(gInit(null)[0], { type: "poke", by: 11 }),
  [{ n: 11, type: "shut" }, [{ n: 0, type: "ping" }]],
);
ok(
  "guarded edge: guard FALSE arm (no cmd)",
  gated.poke(gInit(null)[0], { type: "poke", by: 1 }),
  [{ n: 0, type: "open" }, []],
);

// ── 5. the drawing ────────────────────────────────────────────────────────
const mmd = reducerMermaid(fetchReducerChart);
ok("mermaid draws the entry edge", mmd.includes("[*] --> idle"), true);
ok(
  "…the cell fan-out",
  mmd.includes("any --> circuit_open : fetch / attempt()"),
  true,
);
ok(
  "…and the declarative edge",
  mmd.includes("any --> succeeded : fetch_ok"),
  true,
);

// ── 6. a cell used at TWO sites still gets the `at` correlator ────────────
const two = defineReducerChart({
  ctx: ty<{ readonly n: number }>(),
  states: ["a", "b"],
  initial: "a",
  events: {
    X: { data: ty<{ readonly lo: number }>() },
    Y: { data: ty<{ readonly hi: string }>() },
  },
  on: {
    X: { to: ["a", "b"], cell: "decide" },
    Y: { to: ["a"], cell: "decide" },
  },
});
type TG = typeof two;
const decide: RCells<TG, RStateOf<TG>, MsgOf<TG>>["decide"] = (s, m, at) => {
  switch (at) {
    case "X":
      return [{ ...s, type: m.lo > 0 ? "b" : "a" }, []];
    case "Y":
      return [{ ...s, type: m.hi === "" ? "a" : "a" }, []];
  }
};
const twoC = compileReducer(two, { assign: {}, cells: { decide } });
ok(
  "two-site cell, site X",
  twoC.X({ n: 1, type: "a" }, { type: "X", lo: 5 })[0].type,
  "b",
);
ok(
  "two-site cell, site Y",
  twoC.Y({ n: 1, type: "b" }, { type: "Y", hi: "z" })[0].type,
  "a",
);

// ── 7. the per-site form and the runtime `to` clamp, in the reducer form ──
// Both fall out of the shared `buildCell`, so the reducer form gets the same
// precision dial and the same net as the grid form, from the same code.
const decideBySite: RCells<TG, RStateOf<TG>, MsgOf<TG>>["decide"] = {
  X: (s, m) => [{ ...s, type: m.lo > 0 ? "b" : "a" }, []],
  Y: (s) => [{ ...s, type: "a" }, []],
};
const bySiteC = compileReducer(two, {
  assign: {},
  cells: { decide: decideBySite },
});
ok(
  "per-site reducer cell, site X",
  bySiteC.X({ n: 1, type: "a" }, { type: "X", lo: 5 })[0].type,
  "b",
);
ok(
  "per-site reducer cell, site Y",
  bySiteC.Y({ n: 1, type: "b" }, { type: "Y", hi: "z" })[0].type,
  "a",
);

// the FUNCTION form's residual hole — `b` is in `X`'s `to`, never in `Y`'s —
// is closed at runtime here exactly as it is in the grid form.
const liar = compileReducer(two, {
  assign: {},
  cells: { decide: ((s: RStateOf<TG>) => [{ ...s, type: "b" }, []]) as never },
});
let caught: unknown = "no throw";
try {
  liar.Y({ n: 1, type: "a" }, { type: "Y", hi: "z" });
} catch (err) {
  caught = err;
}
ok(
  "reducer form throws CellTargetError too",
  caught instanceof CellTargetError,
  true,
);
const ce = caught as CellTargetError;
ok("…naming the event as the edge", ce.at, "Y");
ok("…the cell", ce.cell, "decide");
ok("…what it returned", ce.returned, "b");
ok("…and what that edge declared", ce.declared, ["a"]);
// the SAME cell at the OTHER site is legal — the check is per-EDGE.
ok(
  "…while `b` at site X is fine",
  liar.X({ n: 1, type: "a" }, { type: "X", lo: 5 })[0].type,
  "b",
);
// a per-site bag missing a site fails at compileReducer() with a named message.
let missing = "no throw";
try {
  compileReducer(two, {
    assign: {},
    cells: {
      decide: { X: (s: RStateOf<TG>) => [{ ...s, type: "b" }, []] } as never,
    },
  });
} catch (err) {
  missing = err instanceof Error ? err.message : String(err);
}
ok(
  "a per-site reducer bag missing a site fails at compileReducer()",
  missing.includes('no entry for edge "Y"'),
  true,
);
