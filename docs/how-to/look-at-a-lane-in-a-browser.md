# Look at a lane in a browser

**Goal.** Put a real lane on a page — phases in order, every task's state, what
each one is waiting on, which of twelve things is stuck, and a scrubber over the
run — whether the lane already ran or is running right now.

You will use `@demlik/tea/chart/lane/react` for the page and
`@demlik/tea/chart/lane` for the headless model underneath it.

## Which of the two you have

A lane reaches a browser as one of two shapes, and they are genuinely different:

| | Replay | Live |
| --- | --- | --- |
| what you hold | a `workflow.json` and an `events.jsonl` | a lane and the hands `runLane` demands |
| the code bodies | **do not exist** — the document has topology, not functions | exist |
| the scrubber folds | a prefix of the real log | a prefix of the recorded msg tape |
| dispatch | not on offer, and every control says so | on offer |
| the component | `<LaneView>` | `<LiveLaneView>` |

Same panels either way. What the source decides is what is *offered*, never what
is *shown*: an unavailable control keeps its shape, loses its affordance, and
carries the reason as text.

## 1. The replay case — the two files a fabrika lane is

```tsx
"use client";
import { LaneView } from "@demlik/tea/chart/lane/react";
import {
  chartFromWorkflowText,
  parseEventsJsonl,
} from "@demlik/tea/chart/report";
import "@demlik/tea/chart/lane/styles.css";

export function Lane({ workflowJson, eventsJsonl }: {
  workflowJson: string;
  eventsJsonl: string;
}) {
  return (
    <LaneView
      lane={chartFromWorkflowText(workflowJson)}
      log={parseEventsJsonl(eventsJsonl)}
    />
  );
}
```

Two props, and they are the two files. There is no prop for the phases, the
tasks, the states, the standings, the terminal, the retry budgets or what
anything is waiting on — every one of those is derived, and a prop restating one
would be the same fact written twice.

If you shelled out to the CLI instead of reading the files, `parseHistoryJson`
takes `fabrika lane history`'s stdout and gives you the same `log`.

## 2. The live case — a lane under `runLane`

```tsx
"use client";
import { LiveLaneView } from "@demlik/tea/chart/lane/react";
import "@demlik/tea/chart/lane/styles.css";
import { epic, coderParts } from "./epic";

const hands = {
  issue_5729: { parts: coderParts, boot: () => queued(2) },
  // this one is already merged on GitHub — it boots where it IS
  issue_5730: { parts: coderParts, boot: () => shipped(2) },
};

export function RunningEpic() {
  return <LiveLaneView lane={epic} hands={hands} />;
}
```

`hands` is not a restatement of the lane: it is the code the lane deliberately
does not own, plus where each instance boots — which an emitted epic decides per
sub-issue rather than by the chart's `initial: true`. It is the same bag
`runLane` takes, so pass the one you already built.

The component owns the runtime for its lifetime and records it, so the scrubber
time-travels by pure `replay` — `init` + `update` only, never `interpret`.
Dragging backwards cannot re-fire an effect.

## 3. Read the page

**What is stuck, first.** For a twelve-task epic the first question is *which*
of the twelve stopped, so it is the first panel. Three kinds, and they are not
the same news: a task that landed on an error final, a task at a state that
routes nothing, and a task whose **retry budget is spent** — that last one can
still move, and the next `FAIL` is the error final rather than a retry.

**The phases, in order,** each with its standing (`complete`, `active`,
`tripped`, `waiting`) and a chip per task showing the leaf it is in. That strip
is the answer to "where is everything" in one glance.

**One task in full — not eight.** A real emitted phase holds eight tasks and six
of them sit untouched at their entry state; eight near-identical diagrams is a
page nobody reads, exactly as it is a comment nobody reads. So the active phase
expands the tasks that have **moved**, a tripped phase expands the tasks that
tripped it, and everything else collapses to a line. Collapsing keeps the whole
panel behind a disclosure rather than dropping it, which is the one thing a
screen can do that a PR comment cannot — so on a live lane a collapsed region is
still dispatchable, one click of the triangle away.

**The retry line only when it means something.** `0/2` is noise; `2/2 — spent`
is the difference between "in review" and "one `FAIL` from frozen".

## 4. Read what the page will not say

The same discipline the reducer-form inspector follows: a question one source
cannot answer holds an `Unanswerable` with the reason, never an empty value that
would read as an answer.

- **Replay, every control:** *the code bodies that would run an edge do not
  exist here.* The log is the only thing that moves the lane.
- **Live, the timeline's `at` column:** a recorded tape carries the ORDER of its
  msgs and no wall-clock. The column is not rendered and the reason is.
- **Either source, a region whose state keeps no `retries`:** the retry budget is
  a fact of the state a chart chose to keep, and that one keeps none.

## 5. Render the diagram

The page emits each region as `<pre class="mermaid">`, with the current node lit
and the walked edges marked. That is a host's job to render — the same contract
`<ChartInspector>` has, and the reason neither adds a dependency. Run whatever
mermaid you already run over the page; with no renderer at all the text is still
readable.

## Just the data

`@demlik/tea/chart/lane` is the framework-free half, and a script or a TUI gets
all of it:

```ts
import { laneView, replayFeed } from "@demlik/tea/chart/lane";

const feed = replayFeed(lane, log);
const now = laneView(feed, feed.total);
now.stuck;                    // which of twelve, and why
now.phases[1]?.standing;      // "active"
now.phases[1]?.expanded;      // the tasks worth drawing in full
laneView(feed, 3).phases;     // …and the same, exactly three events in
```

## See also

- [Describe and run a lane of parallel charts](./describe-a-lane.md)
- [Report on a fabrika lane](./report-on-a-fabrika-lane.md) — the same core,
  rendered as markdown for a terminal or a PR comment.
- [Inspect a chart live](./inspect-a-chart-live.md) — the one-machine case.
