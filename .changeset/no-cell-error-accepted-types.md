---
"@demlik/tea": minor
---

Refusals name the accepted set, and `acceptedTypes(machine, state)` lets a caller ask first.

A refusal used to carry `msgType` and `stateName` — what was refused and where — but not what the
state would have taken, so learning that a state accepts nothing at all cost one dispatch per Msg
type. `NoCellError` now also carries `acceptedTypes: readonly string[]`, read at the moment
`lookupCell` makes the selection and the row is in hand, and the message states it: the accepted
types when there are any, and "this state accepts no Msg at all" when there are none. The empty
case is the one a caller acting on a possibly-final state most needs, so it is words rather than an
empty pair of brackets.

`acceptedTypes(machine, state)` answers the same question before anything is dispatched — the
transitions form from the state's own row, the reducer form from the flat table's keys, an empty
array for a state with no cells. `lookupCell`'s miss arm calls that same function, so asking first
and dispatching-and-catching cannot be told different things about one `(machine, state)` pair; a
property test asserts it over ragged tables in both forms. It sits beside `acceptsOf`, which
answers about a `state.type` a tool already named rather than the state value a caller is holding.

**Breaking for direct constructors only:** `new NoCellError(msgType, stateName)` now takes a third
argument, `acceptedTypes`. Every in-package construction site passes it; a caller that only catches
and reads the error is unaffected.
