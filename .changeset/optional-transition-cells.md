---
"@demlik/tea": minor
---

A transitions cell is optional: a missing cell declares that the state does not accept that message.

`Transitions<S, M, C>` required every (state.type × msg.type) cell, so a machine could not say "in
this state, only these messages are valid". A 6-state, 9-message machine was 54 cells, most of them
`(s) => [s, []]`, and `acceptedTypes(machine, state)` had to report every message type for every
state — truthfully, and uselessly for a panel deciding which buttons to light, a test asserting a
phase's surface, or an agent driver deciding what to dispatch. The phase check moved into the cell
as an `if (m.phase !== "paying") return [m, []]`, where a considered refusal and an unfinished case
read identically.

Cells are now optional, the way a statechart's `on` block lists the events a state handles and
XState treats an unlisted event as no transition. What tea does differently is stay loud
(ADR 0011): the runtime half already existed, so dispatching a message with no cell raises
`NoCellError` naming the accepted set, and `tryApplyCell` returns that refusal as data. Nothing is
silently ignored.

The **row** stays required. Adding a member to your State union is still a compile-time obligation
to say what that phase does; a phase that accepts nothing writes the empty row `{}` and means it.

`ExhaustiveTransitions<S, M, C>` is the old floor, opt-in per machine — the same table with every
cell required. Annotate your table with it and hand it to `defineMachine` unchanged; it is an
annotation, not a third update form.

The new explanation page [Which update form, and what a missing cell
means](https://github.com/kamp-us/demlik/blob/main/docs/explanation/pick-an-update-form.md) covers
the choice and what the absence promises.

**Migration: none.** An existing full table typechecks unchanged — optional cells only widen what
is accepted. The reducer form is untouched; it remains the form for machines with no state
discriminant.
