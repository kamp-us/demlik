---
"@demlik/tea": minor
---

Three kernel primitives for callers that drive a machine themselves instead of through `run`.

**Fix: `msgKeysOf` under-reported the Msg union for a ragged Transitions table.**
It read `Object.keys(update)[0]` and returned that one row's inner keys, justified by
`Transitions<S, M, C>`'s mapped type making the Msg key set uniform across phases. That
holds for a hand-written TOTAL table, and not for a table built dynamically with the
state/msg discriminants widened to plain `string` — where the mapped type enforces
nothing and the rows are genuinely ragged. It now unions the inner keys across every
row, first-seen order, deduped.

Not cosmetic: all three `withX` wrappers (`withResilience`, `withDeadline`,
`withTelemetry`) build their merged flat Reducer by iterating `msgKeysOf(base)`, so a
Msg that appeared only in a later row got **no cell** in the wrapped machine and threw
`NoCellError` at dispatch for a Msg the base handles fine. `withDeadline`'s
reserved-namespace scan missed a `$deadline:`-prefixed base Msg for the same reason.
The change is a pure widening — for any total table the result is identical (same keys,
same order) — and the O(states × msgs) walk runs once per wrapper construction, never in
the dispatch loop.

**New: `describeMachine(machine)` / `acceptsOf(machine, stateType)`** (`@demlik/tea` and
`@demlik/tea/pure`) — the per-state accept-sets as a public reading, replacing the
`machine.update as Record<string, Record<string, unknown>>` cast a consumer had to write
to recover "which Msgs does each state accept". A derived function over the table, not a
property on the machine: every `withX` wrapper returns a fresh object literal, so a
property would not survive the first wrap. The returned `MachineShape` is discriminated
on `form` — the `transitions` variant carries `states` + `accepts`, the `reducer` variant
carries neither, because a flat reducer has no per-state accept-sets to report.

**New: `tryApplyCell` / `tryFoldMsgs`** (`@demlik/tea`) — `applyCell` and `foldMsgs` with
the missing-cell refusal in the return type instead of thrown, using `better-result` the
same way `tryInterpret` already does. `tryFoldMsgs` reports **which** message failed
(`{ index, msg, error }`), the fact a log-replay validator needs and a bare error cannot
carry. `applyCell` and `tryApplyCell` are both thin skins over one new shared
`lookupCell` selection, so the throwing and `Result` paths can never disagree about which
cell a `(machine, state, msg)` triple picks. A cell that throws from its own body is
still a bug and still propagates — only the absence of a cell is data.
