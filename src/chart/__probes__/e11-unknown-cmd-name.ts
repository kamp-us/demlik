// PROBE 11: an edge names a Cmd that was never declared in `cmds`. The chart
// owns the effect alphabet, so this is now a name error on the edge itself
// rather than a payload that silently collapsed to `Omit<never, "type">`.
import { defineChart, ty } from "../graph";

export const g = defineChart({
  events: { pick: { data: ty<{ readonly key: string }>(), scope: "edges" } },
  cmds: { put_object: ty<{ readonly key: string }>() },
  states: {
    only: {
      idle: { initial: true, on: { pick: { target: "busy", cmd: "put_objekt" } } },
      busy: { end: true },
    },
  },
});
