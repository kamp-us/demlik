// PROBE 12: `otherwiseCmd` on an UNGUARDED edge. There is no "otherwise" arm to
// fire it from, so without this check it would sit in the chart looking
// load-bearing and never fire.
import { defineChart, ty } from "../graph";
export const g = defineChart({
  events: { pick: { scope: "edges" } },
  cmds: { log: ty<{ readonly line: string }>() },
  states: {
    only: {
      idle: { initial: true, on: { pick: { target: "busy", otherwiseCmd: "log" } } },
      busy: { end: true },
    },
  },
});
