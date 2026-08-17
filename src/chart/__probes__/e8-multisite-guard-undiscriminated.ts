// PROBE 8: a MULTI-SITE guard body that never discriminates on `at`. Nothing
// has told the compiler which site this call is, so both `s` and `m` are still
// the full union and every site-specific field is rejected. This is the error
// that tells the author "take the third parameter and switch on it" — the
// nested `s.type === "fetching"` test does NOT stand in for it, because
// TypeScript re-narrows sibling parameters only from a discriminant that is a
// direct, literal-typed element of the tuple union.
import type { RG, RMsg, RState } from "../assert";
import type { Guards } from "../graph";
export const guards: Guards<RG, RState, RMsg> = {
  worthRetrying: (s, m) => (s.type === "fetching" ? m.afterMs > 0 : m.offset >= 0),
};
