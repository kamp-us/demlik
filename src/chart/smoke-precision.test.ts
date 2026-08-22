// Runtime exercise of the two PRECISION closures on the escape hatch:
//
//   1. the PER-SITE cell form — one body per use site, each clamped to that
//      site's own `to`. The walk must route each site to its own entry, and the
//      entries must be reachable in both directions.
//   2. `CellTargetError` — the runtime half of the `to` clamp, which is what
//      the multi-site FUNCTION form has instead of a per-site compile error.
import { expect, it } from "vitest";
import { applyCell, type Cmd } from "../pure/core";
import { pCells, pCellsBySite, picker } from "./assert.test-d";
import { CellTargetError, compile } from "./compile";
import type { CmdOf, MsgIn, MsgOf, StateOf } from "./graph";

type PG = typeof picker;
type PState = StateOf<PG>;
type PCmd = CmdOf<PG>;
type PIn = MsgIn<PG, "q">;

/**
 * One assertion → one vitest test. Everything these files assert is computed at
 * module scope from pure data, so registering the case here (rather than
 * wrapping the whole file in one `it`) keeps a failure pointing at the single
 * claim that broke, exactly as the smoke script's per-line output did.
 *
 * The comparison is stable JSON rather than `toEqual`, which is what the script
 * compared — key order included.
 */
const eq = (label: string, got: unknown, want: unknown): void => {
  it(label, () => {
    expect(JSON.stringify(got), label).toBe(JSON.stringify(want));
  });
};

const step = (
  update: object,
  s: PState,
  m: PIn,
): readonly [PState, readonly PCmd[]] =>
  applyCell<PState, PIn, PCmd>({ update, __form: "transitions" }, s, m);

// ── 1. the PER-SITE form, end to end ───────────────────────────────────────
const bySite = compile<PG, PState, MsgOf<PG>, PCmd, "q">(
  picker,
  { assign: {}, cells: pCellsBySite },
  "q",
);

// site `a.X` — its own entry, its own `to` (["a","b"]), both arms.
eq(
  "per-site: a -X-> b (lo > 0)",
  step(bySite, { type: "a", n: 7 }, { type: "q.X", lo: 1 })[0],
  { type: "b", n: 7 },
);
eq(
  "per-site: a -X-> a (lo <= 0)",
  step(bySite, { type: "a", n: 7 }, { type: "q.X", lo: 0 })[0].type,
  "a",
);
// site `b.Y` — the OTHER entry, reached through the same cell NAME, with its
// own `to` (["a","c"]) and its own cmd.
eq(
  "per-site: b -Y-> c (hi non-empty)",
  step(bySite, { type: "b", n: 3 }, { type: "q.Y", hi: "x" })[0].type,
  "c",
);
eq(
  "per-site: b -Y-> a (hi empty)",
  step(bySite, { type: "b", n: 3 }, { type: "q.Y", hi: "" })[0].type,
  "a",
);
eq(
  "per-site: the b.Y entry emits its own cmd",
  step(bySite, { type: "b", n: 3 }, { type: "q.Y", hi: "x" })[1],
  [{ type: "beep", n: 3 }],
);

// the two forms are OBSERVATIONALLY EQUAL on the same chart — the per-site
// form is a precision dial, not a different machine.
const asFn = compile<PG, PState, MsgOf<PG>, PCmd, "q">(
  picker,
  { assign: {}, cells: pCells },
  "q",
);
eq(
  "the function form and the per-site form agree at a.X",
  step(asFn, { type: "a", n: 7 }, { type: "q.X", lo: 1 }),
  step(bySite, { type: "a", n: 7 }, { type: "q.X", lo: 1 }),
);
eq(
  "…and at b.Y",
  step(asFn, { type: "b", n: 3 }, { type: "q.Y", hi: "x" }),
  step(bySite, { type: "b", n: 3 }, { type: "q.Y", hi: "x" }),
);

// ── 2. `CellTargetError` — the runtime `to` clamp ──────────────────────────
// The multi-site FUNCTION form's return is clamped only to the UNION of both
// sites' `to`, so `c` at `a.X` type-checks. It does NOT run.
const liar = compile<PG, PState, MsgOf<PG>, PCmd, "q">(
  picker,
  {
    assign: {},
    cells: {
      // `c` is in `b.Y`'s `to`, never in `a.X`'s — the residual hole, live.
      decide: (s: PState) => [{ ...s, type: "c" }, []],
    } as never,
  },
  "q",
);

const caught = ((): unknown => {
  try {
    step(liar, { type: "a", n: 1 }, { type: "q.X", lo: 1 });
    return "no throw";
  } catch (err) {
    return err;
  }
})();
eq(
  "out-of-`to` return throws CellTargetError",
  caught instanceof CellTargetError,
  true,
);
const e = caught as CellTargetError;
eq("…naming the edge", e.at, "a.X");
eq("…the cell", e.cell, "decide");
eq("…what it returned", e.returned, "c");
eq("…and what the edge declared", e.declared, ["a", "b"]);
eq(
  "…and the message says all four",
  e.message.includes('cell "decide" at edge "a.X" returned state "c"') &&
    e.message.includes('["a", "b"]'),
  true,
);

// the SAME cell at the OTHER site is fine — `c` really is in `b.Y`'s `to`, so
// the check is per-edge, not a blanket rejection of the cell.
eq(
  "…while the same return at b.Y is legal",
  step(liar, { type: "b", n: 1 }, { type: "q.Y", hi: "x" })[0].type,
  "c",
);

// a per-site bag missing the site the walk needs is a NAMED build-time failure,
// not a bare `undefined is not a function` at dispatch.
const missing = ((): unknown => {
  try {
    compile<PG, PState, MsgOf<PG>, PCmd, "q">(
      picker,
      {
        assign: {},
        cells: {
          decide: { "a.X": (s: PState) => [{ ...s, type: "b" }, []] },
        } as never,
      },
      "q",
    );
    return "no throw";
  } catch (err) {
    return err instanceof Error ? err.message : err;
  }
})();
eq(
  "a per-site bag missing a site fails at compile() with a named message",
  typeof missing === "string" && missing.includes('no entry for edge "b.Y"'),
  true,
);
// …and the refusal names the entries the per-site bag DOES carry, so an author
// reads the omission against what is there (#22).
eq(
  "a per-site miss names the edges the bag does carry",
  typeof missing === "string" && missing.includes('The edges supplied: "a.X".'),
  true,
);

// and a cell NAMED by an edge with no implementation at all still fails the
// same way it always did — the new lookup did not swallow it.
const absent = ((): unknown => {
  try {
    compile<PG, PState, MsgOf<PG>, PCmd, "q">(
      picker,
      { assign: {}, cells: {} as never },
      "q",
    );
    return "no throw";
  } catch (err) {
    return err instanceof Error ? err.message : err;
  }
})();
eq(
  "a cell with no implementation still fails at compile()",
  typeof absent === "string" && absent.includes("with no implementation"),
  true,
);
// the supplied cell set was empty, and an empty set reads as WORDS — a reader
// skimming `[]` sees a formatting artefact, not the dead end it is (#22).
eq(
  "an empty supplied set reads as words, not an empty list",
  typeof absent === "string" && absent.includes("No cells were supplied."),
  true,
);

// a cell named by an edge, absent from a NON-empty bag: the refusal lists the
// cells that were supplied, so a misspelling is legible against them (#22).
const misspelled = ((): unknown => {
  try {
    compile<PG, PState, MsgOf<PG>, PCmd, "q">(
      picker,
      {
        assign: {},
        cells: { notDecide: () => [{ type: "a", n: 0 }, []] } as never,
      },
      "q",
    );
    return "no throw";
  } catch (err) {
    return err instanceof Error ? err.message : err;
  }
})();
eq(
  "a missing cell names the cells that were supplied",
  typeof misspelled === "string" &&
    misspelled.includes('The cells supplied: "notDecide".'),
  true,
);

export type _ = Cmd<never>;
