---
"@demlik/tea": minor
---

`arbGuidedSequence` from `@demlik/tea/pbt` now works, where it used to throw "not implemented". It draws Msg lists in which every answer answers a Cmd that was sent and not yet answered, so a law that something must happen can be checked on random lists with `propertyTrace` or `propertyTerminates`.

It draws blind picks and values first, then folds them through the machine to give each pick its meaning, so a shrink can delete any event and the rest still make a valid list. The cells change shape: `outside` holds an arbitrary per Msg type, and `answers` holds `{ draw, make }` per Cmd type, where `make` gets the Cmd really sent. A cell no longer takes the state, because a cell that reads the state can't shrink its value. It needs no `machine.cmds`: what waits is read from what the reducer sent. `AnswerCell` and `GuidedCells` are new type exports.
