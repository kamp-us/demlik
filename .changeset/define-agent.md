---
"@demlik/tea": minor
---

`defineAgent({ model, tools, instructions })` on `@demlik/tea/agent` (experimental tier) —
the lid over `createAgent`. Three intents in, `{ run(input), machine(input) }` out: the
single-stage wiring (`stages`, `turnOf`, `schemas`) is defaulted, the tool cells derive from
`toolRouter`, the prompt renders off the Model, and the drive loop is `driveToDone`. It hides
wiring, never state (ADR 0015): the Model has the same slice keys as a hand-wired
`createAgent` machine, and `machine(input)` feeds the raw `run`.

`instructions` is durable. `AgentState` gains an `instructions: string | null` slot on both
paths, set at `init` from the new `createAgent` config field of the same name and never
touched by a compaction fold, so a replay reproduces the exact prompt that ran and a
rehydrated run keeps the prompt it started with (ADR 0004). `payloadOf` receives it as a
third argument. A Model persisted before the slot existed rehydrates with `null`.
