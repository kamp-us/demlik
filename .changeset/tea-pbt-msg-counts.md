---
"@demlik/tea": minor
---

A property run (`@demlik/tea/pbt`) can say what its lists reached, so a cut path can't stay green.

- **`failOnNeverActed`, a new option on `propertyTerminates`, `propertyInvariant` and `propertyTrace`.** It fails a run whose laws all held when a Msg type never acted, with a `PropertyFailure` naming each such type. A type never drawn fails it too. Off by default. A deep path needs a `maxLength` well past its depth as well as `size: "max"`. Lists too short to reach a healthy machine's deep state name that healthy path as never acted, in the same report a cut path gives: at the default `maxLength` of 30, a state 20 steps deep on 6 Msg types drawn evenly fails this way. Allow about the depth times the number of Msg types, here `maxLength: 120`. The option stays out of any run given a non-empty `path`, so drop `path` to have it check again. A path with a colon, such as `"0:0"`, replays one shrunk failure. A path with no colon, such as `"3"`, is what a failure with no shrinks reports, and once that failure is gone it draws a full `numRuns` of lists from there, where a cut path reads green. A state `structuralHash` refuses (a `Date`, a `Map`, a class instance) fails the option, saying so, because what acted can't be read there.
- **`PropertyRun.msgCounts`, with a new `MsgCount` type.** A `ReadonlyMap` from Msg type to `{ drawn, acted }`, on a pass and on a failure, with the option on or off. A step acted when its `next` differs from its `prev` by `structuralHash`, or it sent a Cmd. Counts stop at the failing list, so shrinking adds nothing, and a list whose reducer threw adds nothing, though `numRuns` includes it.

**Additive (declaration only):** the option is optional, so an ordinary call needs no editing and no existing seed draws anything new. A variable passed as the options that already holds a `failOnNeverActed` of another type stops compiling.
