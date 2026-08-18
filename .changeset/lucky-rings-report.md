---
"@demlik/tea": minor
---

Add `./chart/report` (**experimental**): import a `kamp-us/phoenix` fabrika
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
