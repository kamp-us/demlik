// PROBE 47: a scope list that names every phase plus "edges" and "all".
//
// `ScopeAt` used to read "a scope that spans the entire universe" as NO scope —
// a proxy for "tsc fell back to the `Chart<C>` constraint because some other
// error defeated inference". The proxy misfired on a scope an author genuinely
// wrote: `MissingPairs<G>` came out `never`, so the TYPE layer called this chart
// total, while `compile`'s `scopeList(…).includes("all")` read the very same
// list as live everywhere and threw `NoCellError` on the first message.
//
// The fallback is now recognised by its SHAPE (a union mixing a string with a
// list — which no literal can produce), so an authored list is read as what it
// says. The diagnostic is therefore the ordinary one, and it is the right one:
// both states owe a decision about PING, named pair by pair.
// @expect-error: TS2322 TS2322
import { defineChart, ty } from "../graph";
export const g = defineChart({
  ctx: ty<{ readonly n: number }>(),
  events: { PING: { scope: ["edges", "all", "p"] } },
  states: { p: { a: { initial: true }, b: {} } },
});
