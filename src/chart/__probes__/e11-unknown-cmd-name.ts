// PROBE 9 (bonus): an edge names a Cmd that has no variant in the Cmd union.
// Without the `__noCmdVariantNamed` marker this collapsed to
// `Omit<never, "type">`, which accepts ANY object — a silent hole.
import type { Cmd } from "../../pure/core";
import { type Cmds, type MsgOf, type StateOf, defineGraph } from "../graph";

const g = defineGraph({
  idle: { initial: true, on: { pick: { target: "busy", cmd: "put_objekt" } } },
  busy: {},
});
type S = StateOf<typeof g, { idle: { readonly n: number }; busy: { readonly n: number } }>;
type M = MsgOf<typeof g, { pick: { readonly key: string } }>;
type C = Cmd<"put_object"> & { readonly key: string };

export const cmds: Cmds<typeof g, S, M, C> = {
  put_objekt: (_s, m) => ({ key: m.key }),
};
