// PROBE 24: a cell edge that ALSO declares `cmd`. A cell returns its own cmd
// list, so a declarative `cmd:` beside it would be a second, silently-ignored
// source of effects. Same rejection for `when`/`otherwise`/`target`/`resume`.
import { defineChart, ty } from "../graph";
export const g = defineChart({
  cmds: { log: ty<{ readonly line: string }>() },
  events: { GO: { scope: "edges" } },
  states: {
    only: {
      a: { on: { GO: { to: ["a", "b"], cell: "pick", cmd: "log" } } },
      b: { end: true },
    },
  },
});
