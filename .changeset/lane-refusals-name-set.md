---
"@demlik/tea": patch
---

The lane structure refusals name the set that was supplied, audited against the compiler's principle.

`LaneShapeError` is the lane's whole refusal surface and the one a second consumer of the workflow
importer meets first. Every refusal it raises — across the authoring door (`defineLane` /
`lowerRegion`) and the imported/runtime door (`runLane` / its load-and-boot `check`) — was read for
whether it has a set worth naming, the same audit the compiler refusals (#20/#22) went through.

Where a refusal admits a set, it now names it through the compiler's own `suppliedClause`, so the two
doors' phrasing cannot drift: a missing or duplicated `initial: true` names the states the chart
declares (or which ones carry the marker); a chart with no final names its states; a persisted leaf
naming a task the lane does not run names the tasks it does; and a leaf or its `was` standing in a
state the chart does not declare names the declared states — the lane twin of `NoCellError` naming
its accepted set. A hand missing for a task names the hands that were supplied, the empty case in
words rather than as `[]`.

Where a refusal admits no set — a non-object state, an edge delegating its target to a cell, two
terminals spelled alike, a dotted task-id or event name, a foreign event, a missing leaf, a phase-less
lane, a `maxRetries` that contradicts the budget — the reason is recorded in the source beside the
throw, so the next reader inherits the finding rather than re-deriving it. The dispatch-time
"no cell" refusal is recorded as out of this shape audit's scope: it fires on a well-formed lane, so
its accepted set belongs to the `acceptedTypes` family (#20/#21), not this helper's compiler register.

Each message's pre-existing text is kept verbatim as a prefix, so a caller matching on it keeps
matching.
