---
"@demlik/tea": minor
---

**Breaking (stable tier, `@demlik/tea/pbt`):** the cells of `arbGuidedSequence` change shape, and a cell no longer takes the state. `outside` holds an arbitrary per Msg type, and `answers` holds `{ draw, make }` per Cmd type, where `make` gets the Cmd really sent. A cell that reads the state can't shrink its value. The old shape could only ever throw, so no working call breaks.

`arbGuidedSequence` now works, where it used to throw "not implemented". It draws Msg lists in which every answer answers a Cmd that was sent and not yet answered, so a law that something must happen can be checked on random lists with `propertyTrace` or `propertyTerminates`.

It draws blind picks and values first, then folds them through the machine to give each pick its meaning, so a shrink can delete any event and the rest still make a valid list. An event whose Msg the state at that point refuses is dropped, in either update form, and a Cmd whose answer was refused keeps waiting. It needs no `machine.cmds`: what waits is read from what the reducer sent. `AnswerCell` and `GuidedCells` are new type exports.
