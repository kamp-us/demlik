// PROBE 8: a Cmd payload builder returning the wrong shape for its variant.
// The builder owes `Omit<Extract<C, {type:"verify_object"}>, "type">` — the
// variant the NAME picks out, not whatever the author happens to return.
import type { Cmds } from "../graph";
import type { UCmd, UG, UMsg, UState } from "../upload";

export const cmds: Pick<Cmds<UG, UState, UMsg, UCmd>, "verify_object"> = {
  verify_object: (s, m) => ({ key: s.key, etag: m.etag.length }),
};
