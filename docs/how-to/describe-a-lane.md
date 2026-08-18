# Describe and run a lane of parallel charts

**Goal:** describe a workload that is *not* one machine — N chart instances
running side by side, grouped into phases that run in order — then fold a run
into its compound state, draw it, answer "which phase is running, what is each
task waiting on, what is stuck", and **run** it as a real `Machine`.

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

It describes, folds, draws **and runs** a lane. What it still does not own is
the effect boundary: `interpret` is yours, because a lane knows nothing about
the shells its cmds run in. Supervision and the event log stay with the driver
(`kamp-us/phoenix`'s `fabrika`) too — [step 7](#step-7--run-it) hands you an
`init` and an `update`, not a process.

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

The charts keep their types. `coderChart` is a `defineChart` literal, so the
lane knows which states `issue_5729` can stand in and which events it answers —
see [step 2](#step-2--the-compound-state-and-the-lane-message).

**Imported**, when the topology arrives at runtime as a `workflow.json`:

```ts
import { chartFromWorkflow } from "@demlik/tea/chart/report";

const lane = chartFromWorkflow(JSON.parse(workflowJson));
```

## Step 2 — the compound state, and the lane message

Two derivations off the lane, both narrowed **per task**:

```ts
import type { LaneMsg, LaneState } from "@demlik/tea/chart/lane";

const state: LaneState<typeof lane> = {
  phases: {
    phase1: { issue_5729: { type: "build", retries: 0, maxRetries: 2 },
              issue_5730: { type: "queued", retries: 0, maxRetries: 2 } },
    phase2: "waiting",           // not reached yet — a standing, not a task map
  },
  lane: "running",               // or "complete" / "tripped", the lane's own
};

const msg: LaneMsg<typeof lane> = { task: "issue_5730", event: "PASS" };
```

Every leaf is that task's **own** `StateOf<chart>`, and `event` is narrowed to
the events **that task's** chart declares — not to a union across the lane. In a
phase running two different templates, sending the reviewer's event to the
builder's task is exactly as wrong as sending an event nothing declares, and
fails the same way:

```ts
const wrong: LaneMsg<typeof lane> = { task: "issue_5730", event: "APPROVE" };
//                                                        ~~~~~~~~~~~~~~~~
// Type '"APPROVE"' is not assignable to type
//   '"WIP" | "DONE" | "BLOCKED" | "PASS" | "FAIL" | "UNBLOCKED"'.
```

An **imported** lane carries no spec, so the same derivations run over
`Chart<unknown>` and read back as `string` throughout — which is exactly what
that door knows. One formula, two doors.

## Step 3 — read the structure back

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

## Step 4 — fold a run

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

## Step 5 — draw it

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

## Step 6 — inspect it headlessly

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

## Step 7 — run it

`runLane(lane, hands)` returns the two halves of a `Machine` a lane can derive.
`hands` is what the lane cannot: one entry per task, each carrying that task's
`parts` (the assigns, guards, cmd builders and cells its chart demands) and a
`boot()` saying where **that instance** starts.

```ts
import { defineMachine } from "@demlik/tea";
import { type LaneHands, runLane } from "@demlik/tea/chart/lane";

const hands = {
  // the ordinary case: this child starts where the chart starts.
  issue_5729: { parts: coderParts, boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }) },
  // …and this one is already merged on GitHub, so it boots where it IS.
  issue_5730: { parts: coderParts, boot: () => ({ type: "shipped", retries: 0, maxRetries: 2 }) },
  issue_5731: { parts: coderParts, boot: () => ({ type: "queued", retries: 0, maxRetries: 5 }) },
} satisfies LaneHands<typeof lane>;

const machine = defineMachine<
  LaneRunState<typeof lane>,
  LaneRunMsg<typeof lane>,
  LaneCmd<typeof lane>,
  Sub<never>,
  Record<never, never>
>({
  ...runLane(lane, hands),
  interpret: {
    "issue_5729.spawn_shell": async (cmd) => spawn(cmd.task, cmd.step),
    "issue_5730.spawn_shell": async (cmd) => spawn(cmd.task, cmd.step),
    "issue_5731.spawn_shell": async (cmd) => spawn(cmd.task, cmd.step),
  },
});
```

Write `satisfies LaneHands<typeof lane>` on a hoisted `hands` object: it is what
gives `boot`'s body a contextual type, so `{ type: "queued" }` stays the literal
instead of widening to `string`. Written inline at the call, the parameter does
the same job.

**Routing.** The machine's messages are `${task}.${event}` — the `{ task, event }`
pair of `LaneMsg<L>`, spelled by the same `keyOf` that namespaces a compiled
chart's table. Dispatch `{ type: "issue_5729.DONE", at: Date.now() }` and it
reaches `issue_5729`'s region and no other. The event is narrowed to the events
**that task's** chart declares, so the reviewer's event sent to the builder is
as much a compile error as an event nothing declares.

**Boot.** `boot()` is typed to that task's own `StateOf<chart>`, so a state name
its chart does not declare is a compile error at that task. The lane's own
standing is derived at boot as well as after every step — a lane whose children
all landed before the run started boots straight into `complete` or `tripped`
rather than pretending to be running.

**Advancement.** When every region of the active phase reaches a final, the lane
moves on; when it runs out of phases it lands on `complete`, and a completed
phase holding an `end: "error"` final lands it on `tripped` instead.
`state.lane` is `"running"` or the terminal it reached.

**Cmds.** A region's cmds leave the lane under the same namespace its messages
arrive in — `issue_5729.spawn_shell`, carrying `task: "issue_5729"` — so an
interpreter routes the reply back without a side table.

**One advancement rule, not two.** The runtime does not re-implement the phase
walk: it calls `phaseStandings` and `laneTerminalReached`, which are the fold's
own functions. A run and a report of that run therefore cannot drift, and the
suite proves it rather than asserting it — `equiv-lane-run.test.ts` drives the
same lane through the runtime and through `foldLane` over the equivalent event
log, diffing every region's state and the whole derived status at every step.

Three things stay outside a lane's reach and one of them is not obvious:

- `interpret`, as above.
- A region whose chart declares a **foreign** event. `keyOf` leaves a foreign
  name bare under a namespace, deliberately — it is the same event for every
  instance — and a bare event addresses no single region. Refused, naming the
  task.
- Sending an event to a region already sitting in a final. The chart declares
  that a refusal (a self-loop with no cmds) and the runtime honours it; the
  **fold** throws instead, because a log that records it is a log that does not
  replay. Do not build one.

## What the types catch, and what they cannot

`defineLane` rejects seven authoring mistakes at compile time, and `runLane`
three more, each naming the offender in the diagnostic.

Four are about the **lane's own shape** and hold at either door: a task declared
in two phases, a phase with no tasks, a terminal that collides with a phase
name, and a retry budget naming a task that does not exist.

Three are about the **charts it was handed**, and hold wherever the chart is a
`defineChart` literal: a region that marks no `initial: true`, a region that
declares no final in either polarity, and a region that hands a transition to a
`{ to, cell }` (nothing here runs a cell, so a lane cannot hold that edge).

`runLane` adds three about the **code**: a hand for a task the lane does not
declare, an instance booted into a state its own chart never declares, and a
region whose chart declares a foreign event.

Those same three chart-shaped ones stand **down** at the imported door: an imported chart's states
are `string` by construction, so the question cannot be asked, and `defineLane`
refuses at runtime instead (`LaneShapeError`, with every defect listed). Where a
guarantee cannot be had, it throws rather than pretending.

## See also

- [Report on a fabrika lane](./report-on-a-fabrika-lane.md) — the two input
  paths (the files on disk, or the CLI's stdout).
- [Inspect a chart live](./inspect-a-chart-live.md) — the single-chart debugger
  this composes.
