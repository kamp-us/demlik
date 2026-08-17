// PROBE 42: a typo'd TOP-LEVEL key. `cxt` is not `ctx`, and nothing above the
// edge level was policing key names — constraint checking is plain
// assignability and `C` is inferred FROM the literal, so the typo was part of
// the type the literal was checked against and excess-property checking had
// nothing to fire on. The chart then had no `ctx` at all: `CtxOf<C>` fell back
// to `unknown`, `StateOf<C>` collapsed to bare `{ type }` unions, and every
// `assign` builder was left owing nothing. The chart enforced LESS than a
// hand-written table, silently. `KnownChartField` closes the whole class —
// `evnets`, `stats`, `cmd` and `intial` are the same mistake.
// @expect-error: TS2345
import { defineChart, ty } from "../graph";
export const g = defineChart({
  cxt: ty<{ readonly n: number }>(),
  events: { X: { scope: "edges" } },
  states: { only: { a: { initial: true, on: { X: "b" } }, b: {} } },
});
