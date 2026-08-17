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
