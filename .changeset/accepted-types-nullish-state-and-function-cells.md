---
"@demlik/tea": patch
---

`acceptedTypes` keeps its "never throws" promise, and reports only cells a dispatch would accept.

Two ways the helper disagreed with the refusal path it is supposed to be one reading with. Under
the transitions form it dereferenced `state.type` unguarded, so a caller trusting the documented
"never throws" and asking about a pre-boot `undefined` or `null` state crashed. And it returned
every key of the state's row, while `lookupCell` admits a cell only on
`typeof cell === "function"` — so a non-function row value, reachable through a cast or from wire
data, was reported as accepted and then refused on dispatch.

A nullish state now answers `[]` in both forms: untagged is a state carrying no discriminant,
nullish is no state at all, and nothing is dispatchable against it. The accept-set reading now
applies `lookupCell`'s own function admission, so the set a caller is handed and the set a
`NoCellError` reports name the same cells. The existing agreement property test is extended with
ragged tables carrying cast-in non-function row values.
