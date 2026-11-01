---
"@demlik/tea": minor
---

A property run (`@demlik/tea/pbt`) can say what its lists reached, so a cut path can't stay green.

- **`failOnNeverActed`, a new option on `propertyTerminates`, `propertyInvariant` and `propertyTrace`.** It fails a run whose laws all held when a Msg type never acted, with a `PropertyFailure` naming each such type. A type never drawn fails it too. Off by default. Draw long lists with `size: "max"` when you turn it on, since short ones may never reach a healthy machine's deep states. A run given a `path` is a replay, so the option stays out of it. A state `structuralHash` refuses (a `Date`, a `Map`, a class instance) fails the option, saying so, because what acted can't be read there.
- **`PropertyRun.msgCounts`, with a new `MsgCount` type.** A `ReadonlyMap` from Msg type to `{ drawn, acted }`, on a pass and on a failure, with the option on or off. A step acted when its `next` differs from its `prev` by `structuralHash`, or it sent a Cmd. Counts stop at the failing list, so shrinking adds nothing.

**Breaking (declaration only):** the published signatures of `stable` names changed, so the API ratchet asks for this callout. `PropertyRun` has a new required field, which only matters to code that builds one by hand, such as `new PropertyFailure(report, run)`. No runner call needs editing and no existing seed draws anything new.
