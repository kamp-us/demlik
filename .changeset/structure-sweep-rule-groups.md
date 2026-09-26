---
"@demlik/structure-sweep": minor
---

Add lowering stages 6 to 8 to structure-sweep, the derived `rederived` label, and a
`structure-sweep groups` command that reads their artifacts back (#428, #429, #431, #458, #461).

- **Stage 6, rule grouping** (`clusterStage`, `confirmStage`). Branches cluster on a canonical key:
  an order-independent atom set plus a normalized outcome, with lexicon concepts in place of the
  identifiers they resolve. The `--graph` JSON's `data` edges add a second candidate signal: the
  functions that touch one binding. Jev confirms each cluster through the gate (`same-rule`,
  `related-different` or `unrelated`, from a question built against a 22-group synthetic gold
  set). Only a confirmed cluster becomes a rule group; the rest go to the human queue. The new
  `deny-outcome` rule makes a `throw` and a `return false` one outcome.
- **Stage 7, owner selection** (`ownerStage`). Picks one owner per rule group from an injected
  layer lookup and fan-in. Jev breaks only the ties those leave, and an abstained owner is
  `unknown`. `deriveRederived` marks every non-owner member `rederived`.
- **Stage 8, the collapse handoff** (`taskSpecs`, `remeasure`, `checkRatchet`). Emits a
  schema'd task spec per settled group and re-measures the post-change tree against its expected
  delta, reporting boundary crossings added or removed through `@demlik/code-graph/boundaries`. A
  rule-group ledger fails a regrown group unless its entry carries a reason.
- **`structure-sweep groups list | show`**. Prints the groups file (`writeGroupsFile`) as
  deterministic JSON: every group and unconfirmed cluster, or one group's members with callers,
  owner candidates, confirm evidence and human-queue entries. No Jev call.
