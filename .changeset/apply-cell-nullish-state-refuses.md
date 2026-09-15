---
"@demlik/tea": patch
---

`applyCell` refuses a nullish state with `NoCellError`, in both update forms.

The refusal side of the asymmetry `acceptedTypes` had fixed. Under the transitions form
`lookupCell` dereferenced `state.type` before checking the state existed, so
`applyCell(machine, null, msg)` threw a bare `TypeError` where every other refusal on that path
raises the typed error callers already handle. Under the reducer form it was worse than a crash:
dispatch never consults the state, so a cell RAN against a machine that had not booted, while
`acceptedTypes` answered `[]` for the same pair.

A nullish state now refuses before the form branch, with `acceptedTypes: []` and the state name
`(no state)` — untagged is a state carrying no discriminant, nullish is the absence of one. The
agreement property is extended over the nullish state, so "the helper omits it" and "dispatch
refuses it" stay one reading there too.
