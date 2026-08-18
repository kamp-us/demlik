---
"@demlik/tea": minor
---

**`@demlik/tea/chart/lane`** — `defineLane` is now generic over its region
charts, so a lane built from `defineChart` literals keeps their types.

`phases` took an `ImportedChart` — `Chart<unknown>` by construction, because the
imported door reads a `workflow.json` this repo has never compiled — so a lane
assembled from typed charts erased every literal type the chart module exists to
preserve, and authoring a typed lane needed a cast. It no longer does:

```ts
const lane = defineLane({
  phases: { phase1: { issue_5729: coderChart, issue_5730: coderChart } },
  terminals: { complete: "complete", tripped: "tripped" },
});

const state: LaneState<typeof lane> = {
  phases: { phase1: { issue_5729: { type: "build", retries: 0, maxRetries: 2 } } },
  lane: "running",
};
const msg: LaneMsg<typeof lane> = { task: "issue_5729", event: "PASS" };
```

- `LaneState<L>` — the compound state, per phase, per task, each leaf that
  task's **own** `StateOf<chart>`, narrowed; plus the phase standing and the
  lane's terminal.
- `LaneMsg<L>` — `{ task, event }` with both narrowed, and the event narrowed to
  the events **that task's** chart declares, not to a union across the lane's
  charts.
- `LanePhaseName`, `LaneTaskId`, `LaneTasksIn`, `LaneTaskChart`, `LanePhaseOf`,
  `LaneSiblings`, `LaneInitial`, `LaneSuccessFinals`, `LaneErrorFinals`,
  `LaneTerminal`, `PhaseStanding`, `LaneRegion`, `Lane` are exported alongside.

Three new authoring mistakes are compile errors naming the offending task: a
region that marks no `initial: true`, a region that declares no final in either
polarity, and a region that hands a transition to a `{ to, cell }` (nothing in
this subpath runs a cell). All three stand down at the imported door, where an
imported chart's states are `string` and the question cannot be asked —
`defineLane` still refuses those at runtime with `LaneShapeError`.

**Two doors, one representation** is unchanged and now literal: `defineLane`
lowers whichever chart it was handed to the single `ImportedChart`
representation, so `foldLane`, `laneReport` and `inspectLane` take an authored
lane and an imported one through the same code path. `chartFromWorkflow` is
untouched and still reads back as `Chart<unknown>` — the same derivations, at a
weaker instantiation.
