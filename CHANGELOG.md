# @demlik/tea

## 0.9.0

### Minor Changes

- 8f21ad1: **`chart/lane/server` — the lane dashboard as something a host can serve.** `chart/lane/react` gives you the components and assumes you have a bundler. A CLI does not, and the consumer this was written for is one: it already knows where its lanes are, how to fold one and how to record an event, and what it lacks is a page. So this ships the page **prebuilt** and asks the host for the three facts only the host can know — where the lanes are, how an event is recorded, and (optionally) who holds a lane. `laneViewer(opts)` returns a `(Request) => Promise<Response>`, so it mounts under Node's `http`, Bun.serve, Hono or a Worker with no per-framework adapter.

  The contract the page speaks is four endpoints: `GET /api/lanes`, `GET /api/stream` (SSE, liveness is the library's problem — it re-asks `lanes()` and pushes on change, so no host writes a watcher), `GET /api/drivers` and `POST /api/transition`.

  **The host stays the only writer.** `transition` is the host's own verb; the page proposes and the host disposes, and a refusal is an answer displayed in the host's own words rather than an error the page invents. Omit `transition` entirely and the dashboard is read-only, which is a real mode and not a degraded one. `drivers` is optional because ownership is not in the lane files at all — absent means UNKNOWN and renders nothing, never "free", because a lane shown free while someone holds it is what starts a second driver on one piece of work.

  `examples/lane-dashboard/serve.ts` is a complete host in ~120 lines, most of it reading two files.

## 0.8.0

### Minor Changes

- 3066c6e: Add `./chart/inspect` and `./chart/inspect/react` (**experimental**): a live debugger for any machine authored with `./chart`, that builds itself out of the chart.

  A hand-built debugger page for a machine types four things out by hand — the list of messages, the state names, which control is disabled when, and what each payload looks like. A chart already carries all four as data, so `<ChartInspector chart={lane} parts={{ assign, guards }} boot={…} samples={…} />` is the whole page: a control per message, a live state panel, a state diagram with the current node lit, and a time-travel scrubber over every transition. There is no prop that restates something the chart already says.

  **Refusals are first-class**, which is the capability the totality property buys and no other inspector can offer. A chart is total over (state × event): a pair is declared, or refused — by the event's `scope`, by the state's `ignore`, or by `end: true` — and there is no third case. So a refused event renders as _visibly refused with the mechanism that refused it_ (`"PASS" is not addressed to phase "working" (scope: edges)`), not as a missing button. The refusal reasons are derived by the same predicate `compile` uses to choose between a self-loop and a `NoCellError`, so the picture and the machine cannot disagree about what is refused.

  **Guard preview.** Given a live state and a sample message the named guard is executed — it is pure, the same thing `replay` may call — and the branch it takes is reported with that arm's target and cmds. Edit a payload and watch the branch flip. Where it cannot be evaluated (no sample, no bag, a throwing body) it degrades to `unknown` carrying the reason, never to a guess. Cell edges show their whole declared `to` fan-out, plus the target the cell actually picks when it can be run purely with samples, clamped to that edge's `to`.

  **What would fire, and what did.** The control row shows the cmds an edge _declares_ — the before question, which a `{ to, cell }` edge answers with an empty list _by declaration_, because the cell builds its cmds inside its body. `captureCmds(machine, { msgs, ctx })` answers the after question: what a recorded run actually emitted, per step, tagged with the message that caused it, cell-built cmds included. It installs no observer — `replay` already returns the cmds a fold emitted, so a step's emissions are the tail past the previous prefix, read off the same pure fold the scrubber uses. A fold that throws truncates the capture and says so (`stoppedAt`) rather than reporting a short list as complete. The React page renders both, as separate panels, with the fired row highlighted at the scrubber's cursor.

  **Reducer-form charts are inspectable, as the thinner thing they are.** `describeReducerChart` + `inspectReducerState` + `<ReducerChartInspector>` describe a `defineReducerChart` chart with the facts it actually has: the flat state list, the entry state, the event alphabet with `foreign`/`from`/payload-ness, per-event routing including a cell edge's whole declared fan-out, and totality over events — which this form enforces _more_ strictly than the grid form, since `on` is a required mapped type rather than a `scope` convention. What it cannot say it refuses to say: `phases`, `refusals` and `scope` each hold an `Unanswerable` carrying the reason ("this chart form has no state dimension — a refusal is a `(state, event)` fact"), never an empty list that would read as _nothing is refused_. The component names all three on screen instead of leaving unexplained gaps, and each describer accepts only its own chart form (a compile error otherwise, probes `e56`/`e57`).

  **Time travel is pure.** The runtime is recorded with `./recorder` and scrubbing re-folds a prefix of the recorded messages through `replay` — `init` + `update` only, never `interpret`, never a Store, never a live subscription — so dragging backwards re-derives history instead of re-performing it.

  `./chart/inspect` is the headless half: `describeChart(C)` returns the phases, states, entry, end/parking flags, the event alphabet with `scope`/`foreign`/`hasPayload`, the cmd/guard/cell alphabets, every edge and every refusal; `inspectState(desc, state, opts)` returns one verdict per event against a live state. It is framework-free and pure, so a script, a test or an Ink TUI gets the useful half. `./chart/inspect/react` is the thin binding, styled the way `./devtools` is (one prefixed stylesheet, consumer design tokens, no new dependency).

  The one thing the author still supplies is `Samples<C>`: `ty<T>()` is `{}` at runtime, so a payload's shape is erased before any runtime code could read it. The bag is typed by the chart all the same — keyed by exactly the events that declare a payload, each value that event's declared type, an event with no payload has no key to write, and a typo'd name is an excess property.

  Additively, `chartMermaid` now takes an optional options bag — `highlight` (light the active node), `phases` (draw phases as Mermaid composite states, which the flat drawing threw away), `polarity` (draw an `end: true` final and an `end: "error"` one apart), `walked` (mark the edges a run actually took, keyed by the exported `edgeKey`), `direction` and `title`. Every default reproduces the drawing it emitted before options existed, so no existing caller and no committed diagram moves. `safeId` / `safeLabel` are now exported from `./machine-viz` and shared by both drawings, so a chart whose state name is not identifier-safe (`human:cp-approval`) draws correctly instead of emitting broken Mermaid.

  It is also the package's ONE chart renderer. `./chart/report`'s `drawTask` was a second implementation of the same drawing, written in parallel against the same Mermaid grammar while this options bag was being added, and the two had diverged before they were folded together: a guarded edge's then-arm was drawn bare here (reading as unconditional beside its `[!guard]` sibling) and labelled there, the highlight had two spellings, and only one side sanitized its ids. `drawTask` is now a translation of `{ current, walked }` onto these options and nothing else, so a report's diagram and a chart's diagram cannot drift again. A guarded then-arm now carries its guard in **both** drawings, and the report's classes are the renderer's own — `teaActive` / `teaTripped` / `teaShipped`.

- 3066c6e: **`from` on an event — where its Msg comes from.** A chart says `WIP: "build"`, an edge from an event to a target; it never said where the event comes from. In TEA a Msg has exactly three origins — a Cmd's result, a Sub firing, the outside world — so `from: "cmd" | "sub" | { world: <role> }` declares which, once, on the event that owns the fact. The taxonomy is closed and the **cast is open**: the world origin carries a role name you choose, so an operator, a shopper, an on-call rota and a webhook are all expressible and none is enumerated by the library. `OriginAt`, `CmdEvent`, `SubEvent`, `WorldEvent` and `WorldRole` derive off it; `describeChart` returns it per event and `EventPreview` carries it to the button row (a refused event has a sender too). Optional throughout — a chart that declares no `from` derives `never` everywhere and behaves exactly as it did — and it composes with `scope`, `data` and `foreign` without touching any of them. A second field inside `{ world }` is a compile error naming the offender (probe 50).
- 3066c6e: **`@demlik/tea/chart/lane` + `/chart/report`** — the nets under a typed lane, and
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

- 3066c6e: **`@demlik/tea/chart/lane` (experimental)** — a lane, as a describable
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

- 3066c6e: **`@demlik/tea/chart/lane` — `runLane`'s doors are checked, and its cmd tag
  moved.** The runtime drove one lane correctly; what it did with the inputs a
  host actually hands it — a persisted state from an older build, a boot that
  disagrees with the lane, a task id with a dot in it — was undefined.

  **Breaking, one shape.** A region's cmd leaves the lane tagged
  `{ lane: { task } }` instead of a flat `task`, so a chart whose cmd payload
  declares its own `task` field keeps its value:

  ```diff
  - interpret: { "issue_5729.spawn_shell": async (cmd) => spawn(cmd.task) }
  + interpret: { "issue_5729.spawn_shell": async (cmd) => spawn(cmd.lane.task) }
  ```

  The flat tag was spread OVER the payload, and `task` is an entirely ordinary
  field for a cmd in a work lane to carry: the author's value was replaced by the
  lane's task id, and the tag narrowed the author's field to that literal, so
  there was no type error either. `lane` is now the one key a region's cmd may not
  declare, and a chart that declares it is a compile error naming the task
  (`__laneRegionCmdDeclaresTheReservedLaneField`). `cmd.type` is unchanged.

  - **One retry budget, not two.** `defineLane({ retries })` lands in
    `lane.context[task].maxRetries` and that is the number `foldLane` replays
    with. `runLane`'s budget used to come only from `boot()`, and nothing
    cross-checked them: booting `maxRetries: 0` under a lane that declares the
    default 2 froze the run where the report of that same log said it retried.
    A `boot()` — or a rehydrated leaf — carrying a budget the lane does not
    declare is now refused, naming the task and both numbers.
  - **Rehydration is validated.** `init(loaded)` is the branch every production
    restart walks; it used to return its argument unread. A persisted state is now
    checked against the lane on the way in — every task present, no task the lane
    does not run, each leaf's `type` a state of that task's chart, and its `was` a
    state too — instead of failing later as a reducer throw inside the host's
    dispatch loop. The leaves are still returned verbatim; the lane's own standing
    is re-derived, since it is a fact derived from those leaves.
  - **`was` is checked at boot, and no longer rewritten on a resume.** The typed
    door refuses a bad `was` in `StateOf`; the imported door had no net at all.
    And a resume now carries `was` through unchanged, which is `stepTask`'s rule —
    the compiled cell re-injects `was` for any landing in a parking state, so with
    two mutually reachable parking states the run and the fold walked the next
    resume to two different STATES. fabrika has one parking state; `runLane` is a
    library.
  - **Dots are refused.** Task `a` + event `b.GO` and task `a.b` + event `GO` both
    register the dispatch key `a.b.GO` — last writer wins and one task's event is
    unreachable for the life of the process — and a dotted task id writes a log
    the replayer re-partitions into a task that does not exist. `runLane` throws,
    naming both. (`Total<C>` already banned the dot in a state name and in a
    foreign event name, for the same reason.)
  - **A task in `phases` with no chart is a defect, not a skip.** It used to get
    no dispatch keys and no boot check — the one input where `runLane`'s closing
    cast asserted something untrue.

  `phases` do not gate dispatch and the module header now says so: a message
  addressed to a phase-2 task moves that region while phase 1 is active, exactly
  as `foldLane` folds the whole log. Phases sequence the lane's STANDING; they are
  not admission control.

- 3066c6e: Add `./chart/lane/react` and `./chart/lane/styles.css` (**experimental**): a real fabrika lane, looked at in a browser rather than only as markdown.

  `<ChartInspector>` takes a live machine — a chart plus the code bodies — and runs it. A fabrika lane is the opposite shape: already-run history, no code bodies anywhere, imported at runtime from a `workflow.json`. So the one thing a real consumer most wants to look at could reach only one of this module's surfaces. Now it reaches both.

  **Two sources, one presentation.** `<LaneView lane log>` is the replay case — the two files a fabrika lane IS, and its scrubber folds a prefix of the real log, which is not an approximation of the state at step k but the definition of it. `<LiveLaneView lane hands>` is a lane running under `runLane`, whose leaves come off the runtime rather than off a fold (a lane boots each region where its sub-issue actually is, so a fold from every chart's `initial: true` would draw a different lane than the one running). Same component underneath, same panels, and neither branches on which source it has.

  **What the source decides is what is OFFERED, and an unavailable control is visibly unavailable with the reason** — never silently absent, which is the rule the refusal rendering has always followed. In replay every control carries an `Unanswerable<"dispatch">` reading _the code bodies that would run an edge do not exist here_; live, they dispatch `${task}.${event}`, the addressed form `compile(chart, parts, taskId)` already keys the table by. The same discipline covers the questions one source cannot answer at all: a recorded tape carries the ORDER of its msgs and no wall-clock, so the timeline's `at` column is an `Unanswerable<"clock">` with the reason rather than a column of invented times, and a region whose state keeps no `retries` gets an `Unanswerable<"retries">` rather than a confident `0/2`.

  **The lane's own structure is the page.** Phases in order with their standings, N task chips per phase, the lane terminal — and _which of twelve things is stuck_ FIRST, because for a real epic that is the first question and a page that answers it fourth answers it too late. Three kinds of stuck, and the third is the one worth having: a task whose retry budget is spent can still move, and the next `FAIL` is the error final rather than a retry.

  **`report.ts`'s editorial rules are applied, not relearned.** A real emitted phase holds eight tasks and six sit untouched at their entry state; a wall of near-identical diagrams is exactly as useless in a browser as in a PR comment. So the active phase expands only the tasks that MOVED (a tripped phase expands the tasks that tripped it), and the rest collapse. The one concession the medium earns is that a collapsed task keeps its whole panel — waiting-on, controls, picture — behind a disclosure instead of losing it, so on a live lane a collapsed region is still dispatchable one click away.

  **The headless half ships too**, on the existing `./chart/lane` subpath: `replayFeed` / `liveFeed` build a `LaneFeed`, and `laneView(feed, cursor)` is the whole lane at one moment as a value a script or a TUI can read with no DOM. `inspectLaneStates` is `inspectLane` from the leaves rather than from a log — the door a running lane comes through — and `walkedEdgeKey` is now one declaration site for "which edge did this step draw", so a folded timeline and a live tape thicken the same edges.

  Tested against the real fabrika artifacts (`workflow.json`, `events.jsonl`, and `lane status`/`lane history` stdout for three lanes driven by the actual binary, including a four-phase epic), with a real `react-dom/client` root under happy-dom. The strongest assertion folds the epic's log and compares all eight of its phase-2 leaves against `fabrika lane status`'s own stdout, which the page never saw.

  No new dependency: the diagram is emitted as `<pre class="mermaid">` for a host renderer, exactly as the chart inspector does, and the stylesheet is standalone (this page renders no devtools component) with the same prefixed-class, consumer-token contract.

- 3066c6e: Add `./chart/report` (**experimental**): import a `kamp-us/phoenix` fabrika
  `workflow.json` into charts, and render a running lane as one markdown block.

  `chartFromWorkflow(document)` mirrors fabrika's own lane compiler structurally
  rather than by name — an `on` string becomes `{ target }`, a two-arm array
  becomes `{ target, when, otherwise }`, a transition targeting a `type: "history"`
  node becomes `{ resume: { fallback } }`, the `hist` node itself is dropped
  (history is an edge property in a chart, not a state), a `type: "final"` becomes
  `end: true`, and a final reached as a guarded array's fallthrough becomes
  `end: "error"`. It refuses a document that does not fit with every defect named,
  never a half-import. The imported charts are runtime-typed (`string` states and
  events); the compile-time guarantees still come from a chart written as a
  literal, and the two are held together by a golden test that asserts the
  importer's edge set against what fabrika's own compiler produces for the two
  committed templates.

  `laneReport({ workflow, entries, status })` returns markdown that works
  unchanged in a terminal, a PR comment and an issue comment: one mermaid block
  per task **in the active phase only** with the current node lit and the walked
  edges marked, one line per future phase, a "where it is" line off `stateValue`,
  a "waiting on" line in fabrika's own vocabulary (the operator's `WIP`, the
  spawned shell, a human's `UNBLOCKED` — and no guess at all for a state nothing
  routes), a retry line when the budget has been spent, and a timeline table whose
  `from → to` is recomputed by prefix-folding, because `lane history` deliberately
  does not store it.

  Two input paths, both supported and asserted to produce identical output:
  `laneFromFiles(workflowJson, eventsJsonl)` off disk, and
  `laneFromCli(workflowJson, statusStdout, historyStdout)` off `fabrika lane
status` / `fabrika lane history`. The second means a standalone inspector can
  shell out to `fabrika` and needs **zero** phoenix changes.

  **`./chart`: `end` widens from `true` to `true | "error"`.** `true` still means
  a success final, so every existing chart is unchanged and this is additive.
  `"error"` declares the failure terminal — the state a guarded edge falls through
  to when its guard is spent — which is the distinction a driver trips a whole run
  off and which a chart previously could not express. Finality itself is blind to
  the polarity: an error final owes no pairs and may declare no edges, exactly as
  a success final does. Three new derivations read it: `EndPolarity<C, S>`,
  `SuccessFinal<C>` and `ErrorFinal<C>`.

  **"Waiting on" is derived, and the importer takes provenance at the boundary.** `waitingOn` used to decide what a lane was waiting on by matching hard-coded state names — `queued`, `build`, `review`, `ship`, `blocked`, `human:*` — copied out of fabrika's `wire/lane-brief.ts`. Those names are fabrika's, so an upstream rename turned the report into a confident liar with nothing failing anywhere. The answer is now the events the state routes, grouped by the `from` each declares, and `./chart/report` holds no state name, no event name and no job title.

  `workflow.json` records topology and has never recorded who sends what, so `chartFromWorkflow(document, { from })` — mirrored on `chartFromWorkflowText`, `laneFromFiles` and `laneFromCli` — takes that map **once, at the import boundary**, and everything downstream derives from it. Omit it and every reader degrades honestly: it names the events a state accepts and refuses to say who sends them, the same refusal an unrouted state used to get. A partial map is not rounded up to a whole one.

  **Breaking:** `SHELL_STATES` and `ShellState` are gone. They were a copy of another repo's vocabulary and there is nothing to replace them with — the fact they encoded now lives on the event. New: `WorkflowImportOptions` and `originOf`.

  **The importer is driven by the document's grammar, not its vocabulary.** `chartFromWorkflow` used to enumerate one consumer's six event names (`WIP`, `DONE`, `BLOCKED`, `PASS`, `FAIL`, `UNBLOCKED`) and refuse any document that used a seventh — so a consumer adding an event took the importer offline for every document, not just theirs. An event name a document declares is now, by definition, an event of that document. Every genuinely structural refusal is unchanged: a guarded arm that is not a two-arm array, a transition targeting an unknown state, a machine-level state that is neither a `parallel` phase nor a `final`, a final no `onDone` pair targets, a non-string `trigger`, text that is not JSON — all still refused, still with **every** defect named. Two grammatical rules about names replace the vocabulary check: a spelling that strips to nothing once its namespace is removed (`"ISSUE."`), and one state spelling one event twice (`"ISSUE.WIP"` and `"WIP"` in the same `on`), which used to be a silent overwrite.

  **Breaking:** `OPERATOR_EVENTS`, `OperatorEvent` and `isOperatorEvent` are gone — one more copy of another repo's vocabulary. New: `eventAlphabet(lane)`, which answers the same question by deriving it from the document.

  A guarded arm the document leaves unlabelled now carries `when: "retries remain"` — a description of what the two-arm array already means — rather than defaulting to one consumer's guard name (`retriesRemaining`). A labelled arm still carries the author's own word, verbatim and undereferenced.

- 3066c6e: **`@demlik/tea/chart/lane`** — a lane can now be **run**. `runLane(lane, hands)`
  returns the `init` and `update` a `Machine` is made of, and `defineMachine`
  takes them with no cast.

  ```ts
  const machine = defineMachine<
    LaneRunState<typeof epic>,
    LaneRunMsg<typeof epic>,
    LaneCmd<typeof epic>,
    Sub<never>,
    Record<never, never>
  >({
    ...runLane(epic, {
      issue_5729: {
        parts,
        boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }),
      },
      // already merged on GitHub — this instance boots where it IS.
      issue_5730: {
        parts,
        boot: () => ({ type: "shipped", retries: 0, maxRetries: 2 }),
      },
    }),
    interpret: {
      "issue_5729.spawn_shell": async (cmd) => spawn(cmd.task) /* … */,
    },
  });
  ```

  - **Routing** reuses the namespacing that was already there. `compile(chart,
parts, ns)` keys a table `${ns}.${event}`; the lane's `ns` is the task id, so
    `{ task, event }` is `${task}.${event}` on the wire and a message reaches that
    task's region and no other. The event stays narrowed to the events **that
    task's** chart declares.
  - **Per-instance boot.** `boot()` says where THIS instance starts, typed to that
    task's own `StateOf<chart>` — an emitted epic boots each child `queued`,
    `landed` or `frozen` depending on its sub-issue, and `initial: true` becomes
    the default rather than the law. The lane's own standing is derived at boot
    too, so a lane whose children all landed before the run started boots straight
    into `complete` or `tripped`.
  - **Phase advancement is the fold's, not a copy of it.** The runtime calls
    `phaseStandings` and the newly-named `laneTerminalReached` — `foldLane`'s own
    functions — so a run and a report of that run cannot drift. `equiv-lane-run
.test.ts` drives one lane through the runtime and through the fold over the
    equivalent event log and diffs every region's state plus the whole derived
    `deriveLaneStatus` output at every step, over two walks that between them
    cover every declared arm of the region chart.
  - **Cmds** leave the lane tagged with the task that emitted them, under the same
    namespace the replies come back in: `issue_5729.spawn_shell`, carrying
    `task: "issue_5729"`.

  New exports: `runLane`, `LaneRuntime`, `LaneRunState`, `LaneRegions`,
  `LaneRunMsg`, `LaneCmd`, `LaneHand`, `LaneHands`, `LaneHandsOf`,
  `LaneRunChecks`; and from `@demlik/tea/chart/report`, `laneTerminalReached` plus
  the `LeafStates` the phase walk now takes (`TaskState` still satisfies it — the
  widening is what lets the runtime call the same function over its own region
  states).

  Three more authoring mistakes are compile errors naming the offender: a hand for
  a task the lane does not declare, an instance booted into a state its own chart
  never declares, and a region whose chart declares a **foreign** event —
  `keyOf` leaves a foreign name bare under a namespace on purpose, and a bare
  event addresses no single region.

- 3066c6e: **`@demlik/tea/chart/lane`** — `defineLane` is now generic over its region
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
    phases: {
      phase1: { issue_5729: { type: "build", retries: 0, maxRetries: 2 } },
    },
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

### Patch Changes

- 3066c6e: **`@demlik/tea/chart/lane/react` (experimental)** — the lane page, read again by a person and fixed where it lied.

  Every item below was found by rendering a real lane in a browser and reading it, not by an assertion. Each now has one that fails without its fix.

  **A live lane no longer dispatches into the present while you are looking at the past.** The scrubber moves the view; the runtime stays where it is. So while the cursor was behind the tape, every control was still enabled, computed its outcome (`→ build`) from the state ON SCREEN, and dispatched into the state that was actually there — a click both mis-stated what it would do and gave no sign it had done it (the only feedback anywhere was `step 3 of 6` becoming `step 3 of 7`). Scrubbing now turns the controls off and says why, through the same "unavailable, with the reason" machinery a replay source has always used.

  **A lane that finished successfully draws its diagrams again.** Only an `active` or `tripped` phase expanded anything, so a lane that ended the way lanes are meant to end rendered zero diagrams — under its own paragraph promising one under every task. The phase a lane ENDED in now expands, by the same rule the active one uses.

  **Why nothing can be dispatched is a fact of the source, and is stated as one.** The sentence used to be scraped back off the first non-refused control; on a finished lane the chart refuses every control, so the page dropped its one explanation exactly where six dead buttons needed it. `LaneViewModel` now carries `noDispatch` and the feed declares it.

  **A refused message is drawn as a step, not as a walk.** A total chart answers everything, so a message nothing routes still lands and still gets a row — rendered `issue_1 DONE review → review` it was indistinguishable from a self-loop the chart declares. `LaneStepView.refused` marks it and the row says "refused, nothing moved".

  **The picture carries polarity.** An error final and a success final were both lit the same blue at the moment one of them was where a task died, while every other surface (chip, badge, stuck panel) said so in red. `stateDiagram-v2` has no per-edge styling, so the lit node wears a class of its own.

  **`"DONE" is not addressed to phase "working" (scope: edges)` is gone.** `scope: "edges"` means the event is live exactly where an edge declares it — it is not a phase name, so the phase test could never pass and the refusal named a phase that had nothing to do with it. `RefusalReason` gains a `no-edge` kind and the sentence is now `"queued" declares no "DONE" edge`. Since `edges` is the default scope, this was most refusals on most charts, and it was the densest jargon on a page that otherwise works hard to teach.

  **Sentences that were wrong when they were said.** A tripped lane is no longer badged `DONE` (that was `deriveLaneStatus`'s internal `done | active` printed raw, one span from the word `tripped`); "N tasks running together" is now the standing's own count, and never says "1 task running together"; a single-phase lane no longer opens "A lane is 1 phase that run in order"; a collapsed task reads "still at `review`" rather than "not started" beside a chip saying `= review`; and a task on an error final speaks of the trip in the tense it happened in.

  **The page reads with no stylesheet at all.** Separators between adjacent inline spans are in the markup, so a bare host gets `5674 · replay · tripped · stopped here` rather than `5674replaytrippeddone`. The stylesheet only makes them quiet.

  **A collapsed diagram is not rendered until it is opened.** All twelve `<pre class="mermaid">` of a twelve-task lane were in the DOM and every mermaid host rendered all twelve; keyed by their own text, one step of the scrubber remounted and re-rendered the lot. The fold now costs what it looks like it costs.

  **`chart/lane/styles.css` is one stylesheet again.** It had been written in two passes, the second re-declaring `.tea-lv`, `.tea-lv-head`, `.tea-lv-panel`, `.tea-lv-stuck`, `.tea-lv-mermaid` and `.tea-lv-steps` wholesale with `.tea-lv-btn` appearing five times — half the first pass was dead by cascade. One authoritative declaration per selector, theme-token fallbacks intact. The cascade had also inverted the page's affordances: the two clickable events rendered as plain text while the four disabled ones kept a dotted box. A button now looks like a button while it can be pressed.

## 0.7.0

### Minor Changes

- 1c71a68: Add `./chart` (**experimental**): author a machine as data — one `defineChart` value holding `ctx`, the event alphabet, the Cmd alphabet and the states grouped by phase — and `compile` it into a real `Transitions` table that drops into `defineMachine` with no cast. The State/Msg/Cmd unions, the entry state, the `was` field on parking states and the mermaid drawing are all derived from that one value, so the types, the runtime table and the diagram cannot drift apart.

  The point is that the config form keeps full narrowing, which is what config-authored machines normally give up. Guards, Cmd builders and cells are typed by scanning the graph for the edges that reference them: a guard used only at `review.FAIL` receives exactly the `review` state and the `FAIL` message, and one used at two sites receives a third `at` argument carrying the site tag, so a single `switch (at)` narrows the state and the message together. Totality is enforced — every (state, event) pair is declared or explicitly refused, with the event's `scope` quantifying the refusal instead of enumerating it — and the diagnostic names the open pair and every way to close it.

  For transitions a declarative edge cannot express, `{ to: [...], cell: "name" }` lets code pick the next state from a set the chart still declares and draws, which is what lets a retry ladder, circuit breaker, cache or rate limiter compose inside a chart. `foreign: true` keeps a library-minted Msg's name bare under namespacing, so N instances of one chart can share a dispatch surface. `defineReducerChart` / `compileReducer` are the flat, msg-keyed form for machines with no phase dimension; they trade away the per-state refusal in the drawing.

  `./chart` itself is a new subpath — experimental tier, no stability promise yet.

  **`./poller` has a TYPE-LEVEL BREAKING CHANGE.** The runtime JS is byte-identical; nothing you can observe at run time changed. But making the poller chart draw 16 edges instead of 30 meant narrowing three verbs' declared return types, and a narrowed `.d.ts` is a break for anyone reading them. On 0.x a `minor` is the correct bump for that, but it is not additive, so here is exactly what breaks and what to do:

  1. **You implement or mock the `Poller` interface.** `start`, `tickResult` and `tickErr` now declare the phases they actually reach (`PollerPolling`, `PollerPolling | PollerDone`, `PollerPolling | PollerGaveUp`) instead of the whole `PollerState` union, so a stub returning the full union no longer satisfies them. _Fix:_ return the narrow arm — every real implementation already did — or import the new `PollerPolling` / `PollerDone` / `PollerGaveUp` types and annotate with those. (`tick` is deliberately NOT narrowed: a generic `tick<S extends PollerState<R>>(state: S) => [S, …]` states an identity no non-generic body can satisfy, and would have made the whole interface unimplementable.)

  2. **You `switch` exhaustively on a `tickResult` / `tickErr` result's `phase`.** The arm that can no longer occur — `gave_up` after `tickResult`, `done` after `tickErr` — is now a hard `TS2678` ("type is not comparable"), not a dead-code hint. _Fix:_ delete the impossible arm. It was already unreachable; the signature just says so now.

  3. **You spell a type as `ReturnType<Poller<R>["tickErr"]>` (or `["start"]` / `["tickResult"]`) and use it as a target type.** That alias is now narrower, so assigning a full-union value into it fails. _Fix:_ widen the annotation to `PollerState<R>` where you genuinely hold the union, or narrow the producer.

  If none of those three describe your code — you call the poller verbs and read `phase` — this release is additive for you.

- 1c71a68: Three kernel primitives for callers that drive a machine themselves instead of through `run`.

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

## 0.6.0

### Minor Changes

- 1f5ee80: Export `applyCellChecked` and `foldUpdates` from the root, and `routeWorkflowMsg` from `./workflow`.

  All three already existed internally and were reachable only by re-implementing them. `applyCellChecked` is the DEV-checked twin of `applyCell`, for a consumer driving its own fold rather than `run`. `foldUpdates` is the fold beneath `foldMsgs` and returns `{ state, cmds }` rather than state alone, which is what a caller folding a log needs when it must also act on the emitted Cmds. `routeWorkflowMsg` is the single `WorkflowMsg` → verb routing table, so a consumer driving a workflow from its own host no longer re-derives the mapping by hand — where a fifth Msg variant would have broken it silently instead of at compile time.

  Additive only; no existing behaviour changes.

## 0.5.1

### Patch Changes

- 7a947bc: Republish from the package's new home, `kamp-us/demlik`.

  `@demlik/tea` was extracted out of a private monorepo into its own public repo.
  No runtime behavior changes. What does change in the published artifact:

  - `repository` now points at `kamp-us/demlik`, so the npm page links to the code.
  - `bugs` gains an issue-tracker URL.
  - Doc comments that referenced private consumer codebases, incident numbers and
    issue numbers are genericized. Those comments ship in the `.d.ts` files and the
    sourcemaps, so this is a visible change to the tarball even though no code moved.

## 0.5.0

### Minor Changes

- e469edb: Close eight silent-failure paths in the kernel: `structuralHash` collisions, the
  teardown dispatch, and the identity drop

  An adversarial review of 0.3.0/0.4.0 reproduced eight defects with runnable
  tests. All eight are fixed, each with the reproduction ported into the suite.

  **`structuralHash` collapsed every non-plain object onto one id (F1).** The
  `typeof value === "object"` branch walked `Object.keys`, which reports no own
  enumerable property on a `Date`, `Map`, `Set`, `Error`, or class instance — so
  all of them, and `{}`, hashed to `"{}"`. Three call sites already documented
  this as impossible ("non-JSON keys throw loudly"); the code never reached the
  throw. Three proven consequences fall out of the one bug: the `Identity` filter
  compared a foreign run's identity as EQUAL and applied its message (corruption
  with the guard switched on), a dep-keyed Sub keyed on a slice containing a
  `Date` never re-armed (it presented as the no-churn success case), and
  `defineManagedResource`'s handle table returned the previous key's handle.

  The walk now rejects any object whose prototype is neither `Object.prototype`
  nor `null`, naming the constructor. **This is a behaviour change:** a `deps`
  slice, an `Identity` projection, or a battery key that previously hashed
  silently now THROWS. That is the point — the previous behaviour was a collision,
  not a wrong-looking key — and with no known adopters of these primitives it is
  the right moment to make it loud. Project such a value to plain data first
  (`startedAt.toISOString()`). The guard is on the prototype rather than a list of
  known classes, so a user-defined key class is caught by the same rule. Rendering
  `Date`/`Map`/`Set` structurally was considered and rejected: `Map`/`Set`
  iteration is insertion-ordered, so any faithful rendering re-introduces the
  churn the hash exists to prevent.

  **A Sub dispatching during teardown produced an unhandled rejection (F2).**
  Dep-keyed sources and `subscribe[type]` handlers were handed the raw
  `enqueueDispatch`, whose promise rejects while the stop gate is shut — so a
  Sub firing during `stop()`'s drain bypassed `onError` entirely and surfaced as
  an `unhandledRejection` on the host. Both now receive the same wrapped
  `(msg) => void` interpret handlers get, so the rejection lands on the sink with
  its phase derived from the error class (`DispatchDiscardedError` → `"discard"`).

  **`fromTransport` leaked a socket per failed wiring (F3).** `live.set` ran
  BEFORE `onMessage`/`onClose` were wired, so an adapter over an already-CLOSING
  socket left the transport in the handle table with no sub registered: no cleanup
  ever ran, `send` wrote into a half-wired seam, and every reconcile opened
  another one. Wiring now happens first and the table is written last; a throw
  detaches what it wired, closes the transport, and rethrows — the
  acquire-as-success-value discipline `defineManagedResource` already followed.

  **The identity drop is now observable (F4).** A message addressed to another
  instance was dropped by a bare `return`: the dispatch RESOLVED, so the caller
  could not tell applied from discarded, and a reusable Durable Object serving run
  A then run B lost run B while reporting success. The drop now reports a new
  `IdentityDropNotice` (a `RuntimeDiscardNotice` — warn by default, never fatal)
  under the new `RuntimeErrorPhase` member `"identity-drop"`.

  **`stop()` waits for async teardown (F5).** `defineManagedResource` fired an
  async `release` and only attached `.catch`, and `stop()` returned without
  awaiting it — so a host doing `await runtime.stop(); env.evict()` dropped the
  isolate mid-release, which is the leak the battery exists to prevent, relocated
  to shutdown. The cleanup now RETURNS the release promise, the runtime tracks
  every async disposal (from `stop()` and from mid-run reconciles alike), and
  `stop()` drains them before resolving. Bounded by the new
  `run({ disposeTimeoutMs })` (default 5000ms) so a release that never settles
  cannot hang the host; on expiry `stop()` reports a `DisposeTimeoutNotice` and
  resolves anyway. A rejected teardown now reaches `onError` under
  `phase: "sub-cleanup"` instead of a `console.warn` at the battery.

  **The identity projection is supervised like the reducer (F6).** It ran ABOVE
  the `try` around the reducer, so a throwing `ofMsg` / `ofState` was neither
  reported nor supervised while an identical throw one line later was both — and
  since `structuralHash` throws on a bigint, a snowflake-style run id put EVERY
  dispatch on that unprotected path. Both halves of the transition's synchronous
  user code are now inside one `try`.

  **A throwing `deps` no longer strands its siblings (F7).** `reconcileDepSubs`
  guarded `entry.source` but not `entry.deps`, so one bad projection stranded
  every later dep-keyed entry and the manual `subscriptions` aggregate, which is
  only reached after the loop. `deps` and the hash are now collected into the same
  `firstError` the source path uses.

  **A nullish `deps` gates the Sub off (F8).** The gate was `deps === null`, so
  `(s) => s.optionalRunId` — the natural projection over an optional field —
  returned `undefined`, hashed to `"undefined"`, and ARMED the Sub, acquiring a
  resource under one shared key in a state that meant inactive. The gate is now
  `depsInactive` (nullish), single-sourced between the runtime's reconcile and
  `replay`'s desired-set projection.

  `Dispose` and the `Subscribe` cleanup are now typed `() => void | Promise<void>`
  (source-compatible: every existing `() => void` cleanup still fits).

## 0.4.0

### Minor Changes

- a82bec2: Loud on discard: `stop()` now reports a runtime torn down with Cmds in flight

  A runtime stopped while `interpret` handlers were still awaiting used to go
  quiet — `stop()` drains the tail, but every consumer of the resulting
  transitions is being torn down with it, so those Cmds' results reached nobody
  and nothing said so. The shape that bites is `@demlik/tea/react`'s `useMachine`,
  memoized on `[machine, ctx, store]`: a `ctx` re-derived mid-flight replaces the
  runtime, the in-flight mutation's response arrives for a runtime the UI no
  longer renders, and the visible state silently rewinds.

  `stop()` now samples the in-flight Cmd count before draining and, when it is
  non-zero, reports `new RuntimeDiscardedError(pendingCmds)` through the existing
  `OnError` sink under the new `RuntimeErrorPhase` member `"discard"`.

  The teardown is loud end to end, not just at its first instant. A Msg that
  arrives while `stop()` is draining — an in-flight Cmd's follow-up, a detached
  handler's terminal Msg, a Sub that is still live — is refused (the stop barrier
  is absolute, and refusing is what makes the drain terminate) and reported as
  `DispatchDiscardedError` under the same `"discard"` phase. The same refusal
  AFTER `stop()` has returned stays a loud error: that is a consumer dispatching
  into a runtime it already retired. The distinction is the runtime's own state at
  refusal time, so it never depends on reading an error message.

  Additive and non-fatal. A discard is a lifecycle report, not a contract failure
  — tearing a runtime down mid-flight is legal — so the default sink
  `console.warn`s the new `RuntimeDiscardNotice` errors instead of rethrowing on a
  macrotask the way it does for everything else; a consumer who never configured
  `onError` gains a warning, never a crash, for the whole teardown. A configured
  sink sees `"discard"` like any other phase and may route or ignore it. The
  default sink decides fatality from the ERROR CLASS rather than the phase, so a
  consumer sink that itself throws while handling a discard report still surfaces
  to the host instead of being demoted to a warning.

## 0.3.0

### Minor Changes

- f7c2635: Kernel: dep-keyed Subs, the instance-identity filter, `structuralHash`,
  `schemaMigrate`, and the typed detached Cmd→Msg edge — plus a host-pluggable
  timer backing for `@demlik/tea/deadline`.

  Five kernel primitives, all additive and opt-in; every existing machine keeps
  compiling and behaving identically.

  - **`structuralHash(deps)`** — the one deterministic, order-independent id for a
    plain JSON-compatible value. Object keys are sorted, so `{ runId, phase }` and
    `{ phase, runId }` are ONE key; a function / symbol / bigint throws rather than
    producing an unstable id. It replaces the scoped `subKeyString` stand-in the
    `@demlik/tea/subs` batteries carried, so a battery's handle-table key and the
    kernel's Sub identity are one definition instead of two.

  - **`DepKeyedSub` + `Machine.subs`** — a Sub that declares the state slice it
    depends on (`deps`, `null` meaning inactive) and how to open its resource
    (`source`, returning a `Dispose`). The kernel derives BOTH the id
    (`structuralHash(deps)`) and the active-set gate, so the author never writes a
    `subId(...)` and never edits a central `subscriptions(state)` list — a per-Sub
    gate travels with the Sub. Same reconcile pass as the manual path: dispose on
    null, dispose-then-re-arm on change, leave running when unchanged.
    `subscriptions` / `subscribe` stay as the documented escape hatch, and both
    paths feed ONE reconcile. `replay(...)` now also reports `depSubs` (the active
    entries' index + derived id) without starting any source.

  - **`Machine.identity`** — declare `{ ofState, ofMsg }` once and the kernel drops
    a message addressed to a different identity BEFORE `update` runs, at one
    observable point, retiring the per-cell `if (msg.runId !== state.runId)` guard.
    A machine that declares no `identity` skips the filter entirely.

  - **`schemaMigrate(schema, upcast?)`** — build `Store.migrate` from a
    Standard-Schema-shaped `Schema<S>` (structural validation, derived) plus a thin
    explicit `upcast` (version migration, genuine logic). Never throws: an
    unrecognized shape — or a throwing `upcast` — returns `null`, the fresh-boot
    path.

  - **`wrapDetached` + `InterpretDetached`** — the typed Cmd→Msg edge for a handler
    that detaches its work and cannot return its terminal Msg inline. `interpret`
    cells now receive an optional third argument, the kernel-injected `dispatch`;
    `wrapDetached` narrows it to the Cmd's declared result-Msg set, so a wrong
    terminal Msg fails to compile. Leaf handlers that return `Promise<M | void>`
    are unaffected.

  - **`@demlik/tea/deadline`** gains the host-pluggable `ArmTimer` seam —
    `subscribeWith(armTimer)` plus the default `setTimeoutArmTimer()`. A hibernating
    host (a Durable Object backing its deadline with `do_alarm`) can now supply its
    own timer without a second deadline surface: `subscribeDeadline` is exactly
    `subscribeWith(setTimeoutArmTimer())`, unchanged for callers. The Sub still
    carries the ABSOLUTE `atMs`, so every backing arms to the same anchor and a
    deadline re-derived after a rehydrate targets the original instant.

  - The `@demlik/tea/subs` `fromTransport` and `defineManagedResource` batteries
    regain `.depKeyed(when)`, expressing a seam or a managed resource as ONE `subs`
    entry — no `subscriptions` line, no `subscribe` cell, and for managed resources
    no `combineManagedResources` router (each resource owns its own reconcile slot).

- f7c2635: **`retry-backoff`: bound retrying by wall-clock outage duration, not only by attempt count.**

  A retry policy may now declare `maxElapsedMs` — how long the far side may stay
  unreachable before you give up — instead of, or in addition to, `maxAttempts`:

  ```ts
  const policy: DurationRetryPolicy = {
    baseMs: 250,
    factor: 2,
    capMs: 4_000,
    maxElapsedMs: PEER_GIVE_UP_MS, // derived from the peer's own patience
    jitter: "full",
  };

  const retry = recordFailure(state.retry, err, msg.at); // `at` starts the streak clock
  if (!shouldRetry(retry, policy, msg.at))
    return giveUp(retryElapsedMs(retry, msg.at));
  ```

  Why: an attempt count is the wrong bound whenever your ladder nests inside
  somebody else's. Four retries up a 250ms→4s ladder is ~3.75s of patience —
  against a peer that waits minutes before it gives up on you, that is a deploy
  blip finalizing runs that would have resumed. What a count of attempts costs in
  seconds depends on how long each attempt takes, which is the carrier's business,
  not the policy's; "how long do we tolerate an outage" has an answer in seconds,
  so the bound should be denominated in seconds.

  New exports: `DurationRetryPolicy`, `UnboundedRetryPolicy`, `AnyRetryPolicy`,
  `RetryBudget`, `BackoffCurve`, `CountBound`, `DurationBound`, `Unbounded`,
  `TimedRetryState`, `retryElapsedMs`.

  Two shapes are now impossible to write by accident:

  - **A policy with no bound at all.** Forever-retry must be spelled
    `unbounded: true`; a policy declaring neither bound does not type-check.
  - **An outage budget with no clock.** A policy carrying `maxElapsedMs` only
    matches the `shouldRetry` overload that demands both a `TimedRetryState` (minted
    by passing the observation instant to `recordFailure`) and a `nowMs`, so a
    declared bound can never be one that silently never fires.

  When both bounds are declared, retry continues only while **every** declared
  bound still permits it.

  Fully backwards compatible: `RetryPolicy` still means the count-bounded shape,
  `policy.maxAttempts` is still a `number`, and `shouldRetry(state, policy)` still
  takes no clock. Existing call sites compile and behave identically. The module
  still reads no clock and no RNG of its own — time is injected exactly as
  randomness always was.

- f7c2635: **`poller`, `resilient-call` and `with-resilience` now accept a duration-bounded
  retry policy — the outage budget reaches the batteries.**

  `retry-backoff` grew a wall-clock bound (`maxElapsedMs`), but the three wrappers
  most consumers actually import still took the count-bounded `RetryPolicy` and
  called `shouldRetry` with no clock. So the primitive was real, tested, and
  reachable only by a consumer folding the ops by hand. Now the policy flows end
  to end:

  ```ts
  const policy: DurationRetryPolicy = {
    baseMs: 250,
    factor: 2,
    capMs: 4_000,
    maxElapsedMs: PEER_GIVE_UP_MS, // derived from the peer's own patience
    jitter: "full",
  };

  createPoller({ everyMs: 5_000, until, onTick, retry: policy });
  withResilience(base, { target: "do_fetch", retry: policy });
  createResilientCall({ retry: policy });
  ```

  `PollerConfig.retry` and `ResilientConfig.retry` (which `ResilienceConfig`
  extends) widened from `RetryPolicy` to `AnyRetryPolicy` — a count, a wall-clock
  outage budget, or an explicit `unbounded: true`.

  **No new argument, and no clock read.** Every path that records a failure
  already held the instant it was observed as DATA — `poller.tickErr(state,
error, at)`, `resilient-call`'s `fail(…, msg.at)` and the retry timer's `atMs`,
  and `withResilience`'s own `$resilience:err.at` / `$resilience:timer.atMs`,
  stamped at the interpret boundary. That instant is now fed to `recordFailure`
  (minting the streak's `firstFailureAtMs`) and to `shouldRetry`. The reducers
  stay pure; time remains an argument, exactly as randomness always was.

  Consequently `withResilience`'s `config.at` rule is unchanged: a duration-bounded
  retry does NOT make it required, because the cold attempt is not a failure
  observation.

  **Purely additive.** Every existing consumer passing a count-bounded
  `RetryPolicy` compiles untouched and behaves identically — the widened field is
  a parameter position, and `shouldRetry` ignores a streak origin a count bound
  never consults. A success still resets the streak, so an operation that fails
  intermittently never accumulates outage and pays nothing for a wide
  `maxElapsedMs`.

  **The wrong path still fails to compile**, inherited from the overload
  `shouldRetry` already declares: a wrapper holding an `AnyRetryPolicy` cannot
  call it without a `nowMs`, so "declared an outage budget, never fed it a clock"
  is a type error inside the wrappers, not a bound that silently never fires.

- f7c2635: Add three open-ended Sub batteries to `@demlik/tea/subs`. Where the existing
  `from*` factories each bind one concrete platform API, these take the platform
  as a parameter — one call covers a whole topology.

  - **`defineListener`** — listener-as-resource. Give it the imperative
    `add`/`remove` pair and it returns a `SubscribeHandler` whose disposer is
    _derived_, not authored. The listener the substrate builds is the identical
    reference handed to both halves, so the two silent leaks you can hand-roll —
    a no-op cleanup, and a `remove` called with a different function than `add`
    saw — become unrepresentable. Carries the platform's native argument tuple,
    so the listener registers directly with no wrapper.

  - **`fromTransport`** — the duplex seam battery. One call wires the inbound
    frame stream, the transport-close → `*_lost` Msg, and an outbound handle
    table a Cmd handler can `send()` through without a hand-written socket
    registry. Transport-agnostic: pass a workerd `WebSocket` adapter, a
    `MessagePort` adapter, or an in-process stub behind the same `Transport`
    port. Complements `fromWebSocket`, which owns a concrete socket and is
    inbound-only.

  - **`defineManagedResource`** + **`combineManagedResources`** — a Model-gated
    resource with a mandatory `release`. Write `{ name, acquire, release }` and
    the resource's lifetime rides the reconcile pass: acquired when its Sub
    enters `subscriptions(state)`, released when the phase is left or the key
    changes. `release` receives only what `acquire` returned, so an `acquire`
    that throws can never hand teardown a half-built resource. `.get(key)` reads
    the live handle the reconciler holds, and `combineManagedResources` folds N
    gated resources into one `subscribe` cell plus a derived active-sub list, so
    the list and the routing cannot drift apart.

  All three are additive — no existing export changes.

## 0.2.0

### Minor Changes

- a703b7b: feat(tea/do): stepHost gains a working/pending arm + an opt-in defer-resume hook

  `stepHost` was a 2-arm `/step` contract (`{done:false, step}` / `{done:true, output}`)
  that resumed the engine INLINE inside the held request. A non-blocking host cannot
  adopt that — it must answer a pull with an explicit "computing, poll again" instead of
  holding the request across a multi-second step.

  Additive, backward-compatible:

  - New `StepWorking` not-ready arm (`{done:false, working:true, retryAfterMs?}`) — a
    first-class discriminated member, not a hollow `done:false`. Reachable only through
    the opt-in `DeferResumeHook`, so inline adopters keep the byte-identical 2-arm
    `StepResponse`.
  - New `DeferResumeHook<R>` (`enqueue` + `settled`) drives `engine.resume` OUT of the
    held request: the pull settles-and-enqueues and returns `working` promptly; a
    returning activation lands the compute in the durable checkpoint; a later pull reads
    the next step. Selected by an overload — passing `deferResume` widens the response to
    the 3-arm `DeferredStepResponse`; omitting it leaves the inline path unchanged.
  - `runStepLoop` re-polls the working arm (honoring `retryAfterMs`) until a real step
    arrives; an inline host never returns the arm, so its drive is unchanged.

### Patch Changes

- f3d1278: Deprecate `@demlik/tea/resilient-call` in favor of `@demlik/tea/with-resilience`
  (export-consolidation verdict: the two collapse, survivor `with-resilience`). The
  subpath still ships and its API is unchanged, but the module doc and its primary
  entries (`createResilientCall`, `liftResilience`) now carry `@deprecated` JSDoc
  with a migration map — the APIs are not drop-in, so there is no re-export shim.
  Per the "deprecate, don't delete" window, the `./resilient-call` export survives
  one minor release after this deprecation and is then removed.

## 0.1.1

### Patch Changes

- c470364: Ship the `./parity` subpath export to the registry. The export map already declares
  `@demlik/tea/parity` (built to `dist/parity`), but the published `0.1.0` predates it —
  so a cross-repo consumer installing the tarball hard-fails on `import "@demlik/tea/parity"`.
  This changeset bumps the package so trusted publishing republishes a version that actually
  carries the export.
