// PROBE 9: an edge names a Cmd, but the `cmds` parts bag has no builder for it.
// `Parts` makes `cmds` REQUIRED the moment `CmdName<C>` is non-`never`, and the
// mapped type is total over the names the chart declares.
// @expect-error: TS2741
import { compile } from "../compile";
import { defineChart, ty } from "../graph";

const g = defineChart({
  events: { pick: { data: ty<{ readonly key: string }>(), scope: "edges" } },
  cmds: {
    put_object: ty<{ readonly key: string }>(),
    log: ty<{ readonly line: string }>(),
  },
  states: {
    only: {
      idle: {
        initial: true,
        data: ty<{ readonly n: number }>(),
        on: { pick: { target: "busy", cmd: ["put_object", "log"] } },
      },
      busy: { data: ty<{ readonly n: number }>(), end: true },
    },
  },
});
export const t = compile(
  g,
  {
    assign: { "idle.pick": (s) => ({ n: s.n }) },
    cmds: {
      put_object: (_s, m) => ({ key: m.key }),
      // ← `log` is named on the same edge and has NO builder
    },
  },
  "x",
);
