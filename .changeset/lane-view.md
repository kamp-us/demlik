---
"@demlik/tea": minor
---

Add `./chart/lane/react` and `./chart/lane/styles.css` (**experimental**): a real fabrika lane, looked at in a browser rather than only as markdown.

`<ChartInspector>` takes a live machine — a chart plus the code bodies — and runs it. A fabrika lane is the opposite shape: already-run history, no code bodies anywhere, imported at runtime from a `workflow.json`. So the one thing a real consumer most wants to look at could reach only one of this module's surfaces. Now it reaches both.

**Two sources, one presentation.** `<LaneView lane log>` is the replay case — the two files a fabrika lane IS, and its scrubber folds a prefix of the real log, which is not an approximation of the state at step k but the definition of it. `<LiveLaneView lane hands>` is a lane running under `runLane`, whose leaves come off the runtime rather than off a fold (a lane boots each region where its sub-issue actually is, so a fold from every chart's `initial: true` would draw a different lane than the one running). Same component underneath, same panels, and neither branches on which source it has.

**What the source decides is what is OFFERED, and an unavailable control is visibly unavailable with the reason** — never silently absent, which is the rule the refusal rendering has always followed. In replay every control carries an `Unanswerable<"dispatch">` reading *the code bodies that would run an edge do not exist here*; live, they dispatch `${task}.${event}`, the addressed form `compile(chart, parts, taskId)` already keys the table by. The same discipline covers the questions one source cannot answer at all: a recorded tape carries the ORDER of its msgs and no wall-clock, so the timeline's `at` column is an `Unanswerable<"clock">` with the reason rather than a column of invented times, and a region whose state keeps no `retries` gets an `Unanswerable<"retries">` rather than a confident `0/2`.

**The lane's own structure is the page.** Phases in order with their standings, N task chips per phase, the lane terminal — and *which of twelve things is stuck* FIRST, because for a real epic that is the first question and a page that answers it fourth answers it too late. Three kinds of stuck, and the third is the one worth having: a task whose retry budget is spent can still move, and the next `FAIL` is the error final rather than a retry.

**`report.ts`'s editorial rules are applied, not relearned.** A real emitted phase holds eight tasks and six sit untouched at their entry state; a wall of near-identical diagrams is exactly as useless in a browser as in a PR comment. So the active phase expands only the tasks that MOVED (a tripped phase expands the tasks that tripped it), and the rest collapse. The one concession the medium earns is that a collapsed task keeps its whole panel — waiting-on, controls, picture — behind a disclosure instead of losing it, so on a live lane a collapsed region is still dispatchable one click away.

**The headless half ships too**, on the existing `./chart/lane` subpath: `replayFeed` / `liveFeed` build a `LaneFeed`, and `laneView(feed, cursor)` is the whole lane at one moment as a value a script or a TUI can read with no DOM. `inspectLaneStates` is `inspectLane` from the leaves rather than from a log — the door a running lane comes through — and `walkedEdgeKey` is now one declaration site for "which edge did this step draw", so a folded timeline and a live tape thicken the same edges.

Tested against the real fabrika artifacts (`workflow.json`, `events.jsonl`, and `lane status`/`lane history` stdout for three lanes driven by the actual binary, including a four-phase epic), with a real `react-dom/client` root under happy-dom. The strongest assertion folds the epic's log and compares all eight of its phase-2 leaves against `fabrika lane status`'s own stdout, which the page never saw.

No new dependency: the diagram is emitted as `<pre class="mermaid">` for a host renderer, exactly as the chart inspector does, and the stylesheet is standalone (this page renders no devtools component) with the same prefixed-class, consumer-token contract.
