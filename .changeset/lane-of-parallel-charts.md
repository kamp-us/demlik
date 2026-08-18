---
"@demlik/tea": minor
---

**`@demlik/tea/chart/lane` (experimental)** — a lane, as a describable
structure: N chart instances running in parallel, grouped into phases that
sequence.

`./chart` describes one machine. A lane is not one machine — it has phases that
run in order, each holding N task regions running concurrently, a phase
completes when every region in it reaches a final, and the whole thing ends
`complete` or `tripped` (tripped when any region landed on an `end: "error"`
final). Its state is compound: `{ phase1: { issue_5729: "build" }, phase2:
"waiting" }`.

- `defineLane` — the authoring door. The nesting is the structure; the phase
  order, each phase's task set, and which finals are success vs error are all
  derived. Four authoring mistakes are compile errors that name the offender.
- `laneShape` — read the same facts off any lane, authored or imported.
- `inspectLane` — the headless view a UI needs: the active phase, each task's
  state, what it is waiting on, what is stuck, and — per task — the existing
  per-chart legal-events / refusals inspection.

**`@demlik/tea/chart/report`** grows the multi-phase half: `phaseStandings` and
`trippedTasks` are exported, and `laneReport` draws a multi-phase lane honestly
— diagrams for the active phase, one line each for phases already finished and
phases not yet started, with tripped regions marked distinctly from complete
ones.

**`@demlik/tea/chart/inspect`** — bug fix. `describeChart` read `node.end ===
true`, so a state declared `end: "error"` was described as a non-final: it
re-acquired the totality obligation, and a live event over it came back
`undeclared` rather than refused. Both polarities now read as final, and
`ChartStateInfo` carries `endPolarity` (`false | true | "error"`) beside `end`.
