---
"@demlik/tea": minor
---

`NoCellError` names the refusing state's accepted set.

A refusal used to carry `msgType` and `stateName` — what was refused and where — but not what the
state would have taken, so learning that a state accepts nothing at all cost one dispatch per Msg
type. The error now also carries `acceptedTypes: readonly string[]`, read at the moment
`lookupCell` makes the selection and the row is in hand, and the message states it: the accepted
types when there are any, and "this state accepts no Msg at all" when there are none. The empty
case is the one a caller acting on a possibly-final state most needs, so it is words rather than
an empty pair of brackets.

The transitions form answers from the refusing state's own row; the reducer form answers from the
flat table's keys, since dispatch there never consults the state. The pre-existing message text is
kept verbatim as a prefix, so a caller matching on it keeps matching.

**Breaking for direct constructors only:** `new NoCellError(msgType, stateName)` now takes a third
argument, `acceptedTypes`. Every in-package construction site passes it; a caller that only catches
and reads the error is unaffected.
