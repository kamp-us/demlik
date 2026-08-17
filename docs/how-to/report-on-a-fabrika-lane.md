# Report on a fabrika lane

**Goal:** turn a `kamp-us/phoenix` lane — a `workflow.json` plus an append-only
`events.jsonl` — into one markdown block that reads the same in a terminal, a PR
comment and an issue comment: a diagram of where each active task is, what it is
waiting on, and how it got there.

**Subpath:** `@demlik/tea/chart/report`

## Before you start

A lane lives in a directory the CLI owns:

```
.fabrika/lanes/5842/workflow.json     # topology, immutable once written
.fabrika/lanes/5842/events.jsonl      # {task, event, at}, append-only
```

Both are local and gitignored. `workflow.json` is the only source of topology —
`fabrika lane print` looks like the answer and is not, because it emits per
state only the event *names* a cell exists for and never the targets, so no edge
can be drawn from it.

## Path 1 — read the two files

Use this when your tool already runs inside the repo. The lane status is
**derived** here, because there is nothing to be handed.

```ts
import { readFileSync } from "node:fs";
import { laneFromFiles, laneReport, reportInput } from "@demlik/tea/chart/report";

const dir = ".fabrika/lanes/5842";
const source = laneFromFiles(
  readFileSync(`${dir}/workflow.json`, "utf8"),
  readFileSync(`${dir}/events.jsonl`, "utf8"),
);

console.log(laneReport(reportInput(source)).markdown);
```

## Path 2 — shell out to `fabrika`

Use this when you are writing a standalone inspector. It needs **zero phoenix
changes**: both verbs already print JSON on stdout, and the report carries the
CLI's own `status` through rather than re-deciding it.

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { laneFromCli, laneReport, reportInput } from "@demlik/tea/chart/report";

const lane = "5842";
const run = (...args: string[]) =>
  execFileSync("fabrika", args, { encoding: "utf8" });

const source = laneFromCli(
  readFileSync(`.fabrika/lanes/${lane}/workflow.json`, "utf8"),
  run("lane", "status", "--lane", lane),
  run("lane", "history", "--lane", lane),
);

console.log(laneReport(reportInput(source)).markdown);
```

Both paths produce byte-identical markdown for the same lane. That is asserted,
not asserted-in-a-comment: if the derived status could differ from the CLI's,
the derived one is wrong.

## What you get

- **one line saying where it is**, off `status.stateValue`;
- **one mermaid block per task in the active phase**, with the current node lit
  and the edges the log actually walked marked (`»`, `»×2`);
- **one line per future phase** (`phase2: waiting (3 tasks)`) — a comment with
  eight diagrams is a comment nobody reads;
- **a "waiting on" line in fabrika's own vocabulary**, so it never contradicts
  the driver: `queued` waits on the operator's `WIP`; `build`/`review`/`ship`
  wait on the shell `wire/lane-brief.ts` spawns for them; `blocked` and
  `human:*` wait on a human's `UNBLOCKED`; a final waits on nothing. A state
  nothing routes gets no guess — it gets the events it accepts;
- **a retry line, only when a retry has been spent** — `2/2 — spent; one FAIL
  from frozen` is the difference between "in review" and one message from a
  frozen lane;
- **a timeline table** with `from → to` recomputed per step. `lane history`
  deliberately does not store those (they are reconstructible by folding), so
  the report re-folds each prefix to recover them.

## Just the charts

If you want the topology and not the prose — to draw it yourself, or to diff two
workflow documents:

```ts
import { chartFromWorkflow } from "@demlik/tea/chart/report";

const lane = chartFromWorkflow(JSON.parse(workflowJson));
lane.phases;                 // [{ name: "pipeline", tasks: ["issue"] }]
lane.terminals;              // { complete: "complete", tripped: "tripped" }
lane.charts.issue;           // the region as a chart value
```

A document that does not fit throws `WorkflowImportError` with **every** defect
named — never a half-import.

## What the import does and does not recover

Exact: the edge set (target for target, including both guard arms and the
history edge), the state set with `hist` dropped, the initial state, the finals
**and their polarity** (`end: true` vs `end: "error"`), the phase list, the two
terminals, the retry budget, and the `trigger`.

Not recovered, because the document does not record it: the phase grouping and
the per-event `scope` an author would write by hand. The import puts every state
of a task in one group named after the workflow phase and leaves every event
`scope: "edges"`.

Not dereferenced, on purpose: guard and action **names**. The two-arm array *is*
the guard, upstream and here — the name rides along as a label the drawing
prints, so renaming it cannot make the report and the driver disagree.

## Charts are runtime-typed here — and the authored twin is not

`chartFromWorkflow` reads bytes that only exist at run time, so its charts carry
`string` states and `string` events. That is the price of following a document
this repo has never seen.

The compile-time half is a chart written as a literal —
`src/chart/__fixtures__/lane.ts` is the coder lane spelled that way — where
`StateName`, `ResumeTargets`, `Assigns` and the totality obligation are all
real. Neither replaces the other; the golden test is the seam between them, and
it asserts the importer's edge set against what fabrika's own compiler produces
for the same committed template.
