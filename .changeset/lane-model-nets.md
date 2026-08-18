---
"@demlik/tea": minor
---

**`@demlik/tea/chart/lane` + `/chart/report`** — the nets under a typed lane, and
the one thing a run and a report of that run must never do.

The module's stated contract is that a run and a report of that run cannot
drift. Three ways they could are closed here, plus the type-layer gate the lane
had been missing and the diagnostics that named the wrong thing.

**A run and a fold now refuse the same pairs.** tea's runtime has always had
three answers to `(state, event)` — routed, refused, unreplayable — and the
lowered chart could carry two. So an event a state accepts and drops (its
`ignore` names it, or it is broadcast to another phase) made `runLane` self-loop
and `foldLane` throw `UnreplayableLogError`: a report calling a run unreplayable
when the run had replayed it, on the shape of our own shipped lane fixture. The
refusal set is now computed once at lowering and carried as
`ImportedChart.refusals` — on the chart rather than on the node, because
`ImportedNode` is a mirror of what fabrika's own compiler emits and the golden
test compares the two. **It is a no-op at the imported door by construction**: a
`workflow.json`'s events are `scope: "edges"` and its states carry no `ignore`,
so nothing there can produce a refusal, lowering an imported chart is still the
identity, and an imported log naming an unrouted event is refused exactly as
before.

**A guarded edge a lane cannot fold is refused at the door.** The fold walks
every guarded edge with one inline predicate, `retries < maxRetries`, because
that is the only guard a `workflow.json` can mean — the two-arm array IS the
retry guard. Applied unstated to a `defineChart` literal it invents an answer: a
chart guarded on `amount < 100`, driven with `amount: 5000`, RAN to `declined`
and FOLDED to `captured`, so the report called a tripped run complete and
printed a `retries: 1/2` on a chart with no retry concept. Carrying the real
predicate is not available — a guard's BODY lives in `Parts`, which `defineLane`
never sees — so a region whose `ctx` does not carry the budget the fold reads is
now refused by `__laneRegionGuardsOnSomethingOtherThanTheRetryBudget`.

**A numeric task id is a task id.** fabrika's task ids are GitHub issue numbers,
so `defineLane({ phases: [{ tasks: { 5729: coder } }] })` is the obvious
spelling, and `Extract<keyof …, string>` annihilated it: `LaneTaskId`, `LaneMsg`
and `LaneHands` all read back `never`, zero hands were demanded and the CORRECT
hand was rejected. Every alphabet now normalises a key the way the log, the
`${task}.${event}` wire key and `Object.entries` already spell one.

**The lane has its own literal-alphabet gate**, mirroring `graph.ts`'s. A
computed phase or task key, or a `terminals` object hoisted without `as const`,
degraded the lane's alphabets to `string` — no hand required, any invented task
id accepted, `__laneHandNamesAnUnknownTask` dead — and with two phases it
accused the author of `__taskDeclaredInTwoPhases` for a task declared exactly
once. The gate is ordered ahead of the duplicate check so the accusation is
true, and its markers name the fix (`…MustBeLiteralsAddAsConst`).

**Also refused at the `defineLane` door**, each with a probe: a region marking
two states `initial: true` (zero was caught and two was not — and two SPLIT, the
shape reading the last and the fold the first); a region that never went through
`defineChart`, so `Strict`/`Total` never ran and a typo'd target parked the task
in a state that does not exist; and a dot in a task id or an event name, which
re-partitions the `${task}.${event}` key space so one task's event becomes
unreachable and a message addressed to `a` moves `a.b`.

**Diagnostics.** The no-cell defect names the task (useless on a twelve-task
lane otherwise). Every unknown task in a log is collected, not just the first,
as `parseEventsJsonl` already did. `laneShape` reads the FIRST `initial: true`,
which is the one `initialOf` and the fold take.

**Export surface.** `chart/lane`'s `PhaseStanding` is renamed **`PhaseAtRest`**
and is now `Exclude<PhaseStanding, "active">` over `chart/report`'s — the two
entry points exported different types under one name, so which one a reader got
depended on which module they imported. `ImportedChart` gains optional
`refusals`; `WorkflowImportOptions` gains optional `strictFrom`, which refuses a
`from` key naming no event the document routes (opt-in, because a consumer's
cast legitimately spans several templates) — the cross-check `eventAlphabet` was
written for and nothing was calling.
