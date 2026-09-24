---
"@demlik/tea": minor
---

A hand-written (non-`Cmd.define`d) Cmd handler may now return a list of Msgs,
on both engines: `Promise<M | readonly M[] | void>` on the Promise engine and
`Effect<M | readonly M[] | void>` on the Effect engine. The engine dispatches
the list in order as follow-ups, before the next Cmd's handler runs, the way
Elm's `Cmd.batch` answers with several Msgs. `drive` from
`@demlik/tea/testing` folds a returned list the same way. A `Cmd.define`d
handler still returns an outcome (ADR 0021); returning a list from one is an
`OutcomeContractError`, as any non-outcome return already was (#324).
