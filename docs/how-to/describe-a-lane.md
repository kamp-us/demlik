# Describe a lane of parallel charts

**Goal:** describe a workload that is *not* one machine — N chart instances
running side by side, grouped into phases that run in order — then fold a run
into its compound state, draw it, and answer "which phase is running, what is
each task waiting on, what is stuck".

**Subpath:** `@demlik/tea/chart/lane`

## When you need this

A chart describes **one** machine. Reach for a lane when all of the following
are true:

- several instances of the same chart run **concurrently**;
- they are grouped into **phases** that run **in order**;
- a phase advances only when **every** instance in it reaches a final;
- the whole thing ends **complete** or **tripped**, and it trips when any
  instance landed on an `end: "error"` final.

The state of that is compound. Not `"build"` but:

```ts
{ phase1: { issue_5729: "build", issue_5730: "queued" }, phase2: "waiting" }
```

Drawing one chart at a time never produces that picture, which is the whole
reason this subpath exists.

## What it does not do

It **describes, folds and draws** a lane. It does not run one — there is no
per-instance boot override, no router turning `ISSUE_5729.DONE` into a message
for region 5729, and nothing that makes a lane dispatchable as a `Machine`.
The driver (`kamp-us/phoenix`'s `fabrika`) folds its own log; this reads the
result.

## Step 1 — get a lane

Two doors, one representation. Both produce the same value, so everything
downstream takes either.

**Authored**, when you own the topology:

```ts
import { defineLane } from "@demlik/tea/chart/lane";

const lane = defineLane({
  id: "epic-5728",
  phases: {
    phase1: { issue_5729: coderChart, issue_5730: coderChart },
    phase2: { issue_5731: coderChart },
    epic: { epic_5728: epicChart },
  },
  terminals: { complete: "complete", tripped: "tripped" },
});
```

The nesting **is** the structure. Nothing states the phase order (it is the key
order), nothing states a phase's task set (it is the keys), and nothing states
which finals are success and which are error (the charts say).

**Imported**, when the topology arrives at runtime as a `workflow.json`:

```ts
import { chartFromWorkflow } from "@demlik/tea/chart/report";

const lane = chartFromWorkflow(JSON.parse(workflowJson));
```

## Step 2 — read the structure back

```ts
import { laneShape } from "@demlik/tea/chart/lane";

const shape = laneShape(lane);

shape.phases;     // [{ name, index, tasks, next }] — `next` is the onDone target
shape.tasks;      // per task: phase, initial, maxRetries, successFinals,
                  //           errorFinals, siblings
shape.cannotTrip; // tasks whose chart declares NO error final
```

Every field is derived. `cannotTrip` is not a defect — a task may legitimately
be unable to fail — but it changes what the lane can do, and it is invisible
otherwise.

## Step 3 — fold a run

```ts
import { foldLane, deriveLaneStatus, parseEventsJsonl } from "@demlik/tea/chart/report";

const entries = parseEventsJsonl(eventsJsonl);
const states = foldLane(lane, entries);
deriveLaneStatus(lane, states);
// { stateValue: { phase2: { issue_5731: "review" }, epic: "waiting" },
//   status: "active", context: { …, errors: [] } }
```

The fold is **pure over a prefix**, so `foldLane(lane, entries.slice(0, k))` is
the exact state after *k* events — time travel costs a `slice`.

`phaseStandings(lane, states)` gives the same walk as a list: per phase,
`"complete" | "tripped" | "active" | "waiting"`, plus which of its tasks
tripped. It is **positional**, not local: everything after the phase that
stopped the lane reads `"waiting"`, whatever its regions happen to contain.

## Step 4 — draw it

```ts
import { laneReport } from "@demlik/tea/chart/report";

console.log(laneReport({ workflow: lane, entries }).markdown);
```

The editorial rule, so you know what to expect: **diagrams for the active
phase's tasks only**; one line each for phases already finished and phases not
yet started. A comment with eight diagrams is a comment nobody reads. A finished
phase's line still carries its leaves, because "complete" alone does not say
which ending each task reached, and a tripped region is marked distinctly from a
complete one — including in the active phase, where a frozen region sits beside
a sibling that is still moving.

## Step 5 — inspect it headlessly

```ts
import { inspectLane } from "@demlik/tea/chart/lane";

const view = inspectLane(lane, entries);

view.activePhase;   // "phase2", or null once the lane has ended
view.terminal;      // the terminal it landed on, or null
view.tripped;       // every task on an error final
view.stuck;         // [{ task, reason }] — what a human has to go and do
view.phases[1]?.tasks[0];
// { state, endPolarity, waitingOn, retries/maxRetries, legal, refusals, events }
```

`events` is the whole alphabet per task — legal entries with their targets,
refused entries with the reason, each carrying the `from` its event declared —
composed from `@demlik/tea/chart/inspect`, so a lane UI and a single-chart
debugger agree about what a refusal is and about who would send what.

`waitingOn` is the same answer as one sentence: the events this state routes,
grouped by who sends them. It is derived, not matched against a list of state
names, so it stays true when the lane's states are renamed. On a lane imported
without a provenance map it degrades to naming the events and says nothing
about their sender — see [Report on a fabrika
lane](./report-on-a-fabrika-lane.md#say-who-sends-what).

`stuck` has three kinds, and the third is the one worth having:

| kind | meaning |
| --- | --- |
| `tripped` | the task landed on an error final |
| `dead-end` | a non-final state that routes nothing |
| `budget-spent` | `retries === maxRetries`: the next guarded event is no longer a retry, it is the error final |

## What the types catch, and what they cannot

`defineLane` rejects four authoring mistakes at compile time: a task declared in
two phases, a phase with no tasks, a terminal that collides with a phase name,
and a retry budget naming a task that does not exist. Each names the offender in
the diagnostic.

Everything about a **chart's insides** — no `initial: true`, no final at all —
is a runtime refusal (`LaneShapeError`, with every defect listed), because a
lane assembled from imported charts is runtime-typed by construction and the
type layer cannot be asked. Where a guarantee cannot be had, it throws rather
than pretending.

## See also

- [Report on a fabrika lane](./report-on-a-fabrika-lane.md) — the two input
  paths (the files on disk, or the CLI's stdout).
- [Inspect a chart live](./inspect-a-chart-live.md) — the single-chart debugger
  this composes.
