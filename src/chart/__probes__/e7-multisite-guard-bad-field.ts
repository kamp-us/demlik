// PROBE 7: a MULTI-SITE guard body reading a field from the WRONG site, after
// correctly discriminating on `at`. `worthRetrying` is referenced from two
// edges — `fetching.TIMEOUT` and `parsing.CORRUPT` — so its parameters are a
// union of tuples correlated by the third argument. Inside the
// `at === "fetching.TIMEOUT"` branch both `s` and `m` are pinned to that site,
// so `m.offset` (a `CORRUPT` field) and `s.bytes` (a `parsing` field) are each
// rejected against the ONE narrowed member — not against the whole union.
import type { RG, RMsg, RState } from "../assert";
import type { Guards } from "../graph";
export const guards: Guards<RG, RState, RMsg> = {
  worthRetrying: (s, m, at) =>
    at === "fetching.TIMEOUT" ? m.offset >= 0 && s.bytes > 0 : m.offset >= 0,
};
