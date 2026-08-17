// PROBE 10: a Cmd payload builder returning the wrong shape for its variant.
// The builder owes exactly what the chart's `cmds` section DECLARED for that
// name — not whatever the author happens to return.
// @expect-error: TS2322

import type { UG, UMsg, UState } from "../__fixtures__/upload";
import type { Cmds } from "../graph";

export const cmds: Pick<Cmds<UG, UState, UMsg>, "verify_object"> = {
  verify_object: (s, m) => ({ key: s.key, etag: m.etag.length }),
};
