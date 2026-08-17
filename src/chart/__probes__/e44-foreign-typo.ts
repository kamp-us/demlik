// PROBE 44: a typo'd EVENT-level key. `foriegn` is not `foreign`, so
// `ForeignEvent<G>` was `never` and the library-minted event got NAMESPACED —
// `MsgIn<G, "ns">["type"]` said `"ns.Z"` and `keyOf` agreed, so the types and
// the runtime were CONSISTENTLY wrong and no inbound `Z` ever matched. That is
// precisely the failure `foreign: true` exists to prevent, defeated by one
// transposition. Same unknown-key rule as the chart and node levels.
// @expect-error: TS2322
import { defineChart } from "../graph";
export const g = defineChart({
  events: { X: { scope: "edges" }, Z: { foriegn: true, scope: "edges" } },
  states: { only: { a: { initial: true, on: { X: "b", Z: "a" } }, b: {} } },
});
