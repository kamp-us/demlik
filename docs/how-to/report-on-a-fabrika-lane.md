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
  FABRIKA_ORIGINS,               // see "Say who sends what" below
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
  FABRIKA_ORIGINS,
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
- **a "waiting on" line derived from the events**, so it cannot contradict the
  driver and cannot go stale when the driver renames a state: it is the events
  the state routes, grouped by who sends them (`the work \`review\` dispatched —
  \`PASS\`, \`FAIL\` · the operator's \`BLOCKED\``). A final waits on nothing. Say
  nothing about who sends what and it says nothing about who sends what — it
  names the events and stops (`` `review` accepts `PASS`, `BLOCKED`, `FAIL` ``);
- **a retry line, only when a retry has been spent** — `2/2 — spent; one FAIL
  from frozen` is the difference between "in review" and one message from a
  frozen lane;
- **a timeline table** with `from → to` recomputed per step. `lane history`
  deliberately does not store those (they are reconstructible by folding), so
  the report re-folds each prefix to recover them.

## Say who sends what

`workflow.json` records the topology and has never recorded **who sends** a
`WIP` — that fact lives in fabrika's code, not in fabrika's document. So state
it once, at the import boundary, and every reader downstream derives from it:
the report's "waiting on" line, `inspectLane`, and the `from` on each event of
`describeChart`'s alphabet.

```ts
import type { WorkflowImportOptions } from "@demlik/tea/chart/report";

const FABRIKA_ORIGINS: WorkflowImportOptions = {
  from: {
    WIP: { world: "the operator" },
    BLOCKED: { world: "the operator" },
    UNBLOCKED: { world: "a human" },
    DONE: "cmd",
    PASS: "cmd",
    FAIL: "cmd",
  },
};
```

Three origins and no fourth, because in TEA a Msg has three: `"cmd"` (a Cmd's
result — fabrika spawns a shell on entering a working state and the shell
reports back), `"sub"` (a Sub firing), and `{ world: <role> }` (the outside
world, through a role **you** name). The library ships no role names, so a
consumer with a different cast writes a different map and every reader works
unchanged. Keys are the **bare** event name: `ISSUE.WIP` and `PARK_SWEEP.WIP`
are the same `WIP`.

Omit an entry, or the whole map, and nothing is invented — the readers degrade
to naming the events and saying nothing about their sender.

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

## The importer knows your grammar, never your vocabulary

There is no list of event names in this package. The importer enforces what
makes a document *well-formed* — a state routes events to targets, a guarded
edge is a two-arm array, a `history` target means resume, a `final` is terminal,
a machine-level `parallel` is a phase and its `onDone` pair names the terminals
— and reads the *names* off the document. An event a state declares is an event
of that document, whatever it is called, so a lane that grows a seventh event
imports the commit it lands, with no release of ours in between.

Which means you never hard-code the alphabet either — ask for it:

```ts
import { chartFromWorkflow, eventAlphabet } from "@demlik/tea/chart/report";

const lane = chartFromWorkflow(JSON.parse(workflowJson));
eventAlphabet(lane);         // ["WIP", "BLOCKED", "DONE", "PASS", "FAIL", "UNBLOCKED"]
```

That is the list to key your `from` map by (below), and the list to diff when
you want to know whether a workflow revision changed its vocabulary.

Two rules about names *are* grammatical and are still refused: a spelling that
strips to nothing once its namespace is removed (`"ISSUE."`), and one state
spelling one event twice (`"ISSUE.WIP"` and `"WIP"` in the same `on`) — a state
routes each event once.

## What the import does and does not recover

Exact: the edge set (target for target, including both guard arms and the
history edge), the state set with `hist` dropped, the initial state, the finals
**and their polarity** (`end: true` vs `end: "error"`), the phase list, the two
terminals, the retry budget, and the `trigger`.

Not recovered, because the document does not record it: the phase grouping and
the per-event `scope` an author would write by hand. The import puts every state
of a task in one group named after the workflow phase and leaves every event
`scope: "edges"`. Nor the per-event `from` — but that one you can **supply**,
once, through `WorkflowImportOptions` above.

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
