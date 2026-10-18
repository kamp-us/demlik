---
"@demlik/structure-sweep": minor
---

Add `move apply --plan <file>`: apply a hand-written `{ scope, moves: [{ from, to }] }` plan in the
same two history-keeping commits a Jev manifest gets. Rows carry no Jev fields, a plan with two
rows sharing a `from` or a `to` is refused, and both commits say the moves were hand-planned with a
`Structure-Sweep-Plan` trailer naming the plan's content hash. `--plan` cannot be combined with
`--manifest`. The library exports `HandPlan`, `HandPlanRow`, `parseHandPlan`, `applyHandPlan` and
the `PathMove` type; manifest applies are unchanged.
