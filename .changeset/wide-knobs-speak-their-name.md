---
"@demlik/tea": minor
---

`createResilientCall` accepts an optional `name`, so a knob owns its settle Msgs

A resilient-call knob built with `{ name: "jev" }` emits `jev_run` and settles
through `jev_ok` / `jev_err`, and the settle Msg types are generic in that name.
A machine mounting two knobs of the family under distinct names therefore gets
one `update` cell per knob, each already narrowed to that knob's payload —
replacing the hand-written `key` switch that a single shared cell forced, which
the type checker could not grade. The name leads the retry and deadline Sub ids
as well (`jev:retry:<key>`), so two knobs cannot share one timer on one key.

**`resilient_ok` / `resilient_err` — and `resilient_run`, and the
`resilient:retry:<key>` / `resilient:deadline:<key>` Sub ids — remain the
default for every knob that passes no name.** Nothing changes for an existing
machine, example or doc unless it opts in.

`N` is not inferable from the knob's input and result types, so an opted-in knob
spells all three type arguments:
`createResilientCall<In, Out, "jev">({ name: "jev", ... })`. The `name` field is
typed at `N`, so the value and the type cannot drift apart.
