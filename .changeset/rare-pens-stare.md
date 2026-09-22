---
"@demlik/tea": minor
---

`mountResilientCall` — mount a resilient-call knob with a spread instead of
eight hand-spliced wiring points.

Splicing `createJevAsk` or `createLlmCall` into a machine meant writing `init`,
the attempt cell, `succeed`, `fail`, `onTimer`, `subs`, `subscribe` and
`interpret` by hand, and three of those failed only at runtime: folding the
result before the inherited verb wedged the slice at `running`, a dispatching
interpret handler settled one invoke and stalled the loop, and an omitted
`subscribe: { deadline: subscribeDeadline }` meant a backed-off retry never
fired.

`mountResilientCall(knob, { slice, attempt, onOk, onErr, onDeadline })` returns
`{ init, update, subscriptions, subscribe, interpret }` fragments a consumer
spreads into `defineMachine`. The settle cells run the inherited verb and hand
the already-settled model to the fold, so the ordering bug is not expressible;
`subscribe` and `interpret` ride on the fragments, so neither can be forgotten.

There are three folds rather than two because there are three settle paths. A
call that exhausts its deadline settles `failed` inside the slice and emits no
settle Msg, so it reaches no `onErr`; `onDeadline` is that failure class's fold,
handed the key and the slice's own error. Omit it and only the slice advances,
exactly as omitting `onOk` / `onErr` does.

The two settle cells are keyed off the knob's own Msg names, so a knob built
`createResilientCall<I, R, "jev">({ name: "jev" })` mounts into `jev_ok` /
`jev_err` and two named knobs spread into four distinct cells. An unnamed knob
is `resilient`, so the keys read `resilient_ok` / `resilient_err` as before. The
knob itself now carries that `name` as a readable field.

Per ADR 0015 it hides assembly and nothing else: the resilience slice stays a
plain readable Model field, and every verb the mount calls is still exported and
callable by hand.

New on `@demlik/tea/resilience` (and re-exported from `@demlik/tea/jev`):
`mountResilientCall`, plus the types `DeadlineSettled`, `MountableKnob`,
`MountConfig`, `MountedCell`, `MountedResilientCall`, `Settle` and
`SettleFold`.
