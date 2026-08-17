// PROBE 10 (bonus): `otherwiseCmd` on an UNGUARDED edge. There is no "otherwise"
// arm to fire it from, so without this check it would sit in the graph looking
// load-bearing and never fire.
import { defineGraph } from "../graph";
export const g = defineGraph({
  idle: { initial: true, on: { pick: { target: "busy", otherwiseCmd: "log" } } },
  busy: {},
});
