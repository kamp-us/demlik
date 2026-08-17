// PROBE 7: an edge names a Cmd, but the `cmds` table has no builder for it.
// `Parts` makes `cmds` REQUIRED the moment `CmdName<G>` is non-`never`, and the
// mapped type is total over the names the graph references.
import { compile } from "../compile";
import { type MsgOf, type StateOf, defineGraph } from "../graph";
import type { Cmd } from "../../pure/core";

const g = defineGraph({
  idle: { initial: true, on: { pick: { target: "busy", cmd: ["put_object", "log"] } } },
  busy: {},
});
type S = StateOf<typeof g, { idle: { readonly n: number }; busy: { readonly n: number } }>;
type M = MsgOf<typeof g, { pick: { readonly key: string } }>;
type C = (Cmd<"put_object"> & { readonly key: string }) | (Cmd<"log"> & { readonly line: string });

export const t = compile<typeof g, S, M, C, "x">(g, "x", {
  assign: { "idle.pick": (s) => ({ n: s.n }) },
  cmds: {
    put_object: (_s, m) => ({ key: m.key }),
    // ← `log` is named on the same edge and has NO builder
  },
});
