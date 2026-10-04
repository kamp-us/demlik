---
"@demlik/tea": minor
---

`createJevAsk` from `@demlik/tea/jev` takes an optional `name`. A named knob
gets its own run Cmd (`<name>_run`), its own settle Msgs (`<name>_run_ok`,
`<name>_run_err`) and its own timer Msg (`<name>_deadline`), so a machine can
hold several Jev knobs with different question maps. Each handler and each
settle cell is then typed to one knob's answers, with no cast.

`createJevAsk({ questions, name: "judge" })` infers both type parameters.
`JevAskConfig`, `jevAskCmdDef`, `JevAskCmd`, `JevSucceedMsg`, `JevFailMsg`,
`JevTimerMsg` and `JevCmd` take the name as a type parameter that defaults to
`resilient`.

An unnamed knob is unchanged: it still speaks `resilient_run`,
`resilient_run_ok`, `resilient_run_err` and `deadline_exceeded`, and existing
code compiles as it is.

`docs/how-to/ask-jev-a-typed-question.md` has a new section on two knobs in one
machine.
