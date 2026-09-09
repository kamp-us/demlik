---
"@demlik/tea": patch
---

`agent.run(...)` now resolves at the type it always produced. Its promise
resolves only on an ENDED run — `done`, or `cancelled` — and rejects on a
failure, but it was typed as the whole durable Model, which includes the
never-started `idle` arm. `idle` deliberately carries no `runId` (identity is
minted at `start`), so `(await agent.run(input)).run.runId` — a field every
resolved run has at runtime — did not typecheck, and the reader's only moves
were a cast or a `phase` guard that can never fail.

`run` now resolves `DefinedAgentResolvedState<T>`: the same Model with its `run`
slice narrowed to `EndedRun`, the `done` / `cancelled` subset. `final.run.runId`
reads bare. Its type is `string | null`, not `string`, because a run cancelled
through an already-aborted signal ends before `start` mints an identity — that
is a real outcome of this call and stays a distinguishable value.

Nothing widens: the `idle` arm is untouched and still carries no `runId`, and
`DefinedAgentState` — the DURABLE Model, which a `Store` must be able to hold at
`init` — is unchanged. `@demlik/tea/agent` is an experimental door, and this is
a narrowing of what a promise resolves: code reading a field off the resolved
value keeps compiling, while code assigning it to a variable annotated with the
whole `MonitoredRunState` union does not.
