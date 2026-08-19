# demlik domain vocabulary (TERMS)

The repo-owned vocabulary spine. One row per term: the canonical definition, and where a name has
drifted, what the term is **not**. When the code and this file disagree, the code is authoritative
and this file is the doc to fix.

## The chart surface
| Term | Definition | Not |
|---|---|---|
| chart | A state machine rendered as something a person reads — the `stateDiagram-v2` the viewer draws. Compiled from a workflow document, never hand-drawn. | The Machine itself. A chart is a picture of one. |
| origin | Who sends a given event — the cast mapped onto a workflow's transitions (`WorkflowImportOptions.from`). The library ships no default map on purpose: topology is the document's, provenance belongs to whoever's world the lane models. | Part of the workflow document. Origins are supplied beside it, as `origins.json` or by the host. |
| workflow | The topology document (`workflow.json`): the states, the tasks and the transitions between them. It records **shape**, deliberately not provenance. | A run. The document is the map; a lane is one journey across it. |

## The lane surface
| Term | Definition | Not |
|---|---|---|
| attention | The single derived answer to *does this lane need me* — one of seven: `needs-you`, `tripped`, `moving`, `done`, `quiet`, `unstarted`, `unreadable`. Derived on read, never stored, and the fleet's sort key. | A workflow state. Attention is computed *across* a lane's states, not one of them. |
| claim | The marker comment on a board issue that asserts a driver holds a lane. The **earliest** marker wins, tiebroken on the comment's own `created_at` — a timestamp a claimant cannot author. | A label or an assignee. Those are board state; the claim is the marker itself. |
| driver | Who currently holds a lane. Read from GitHub as a third source over the network, because claims live on the board and no claim state is derivable from a fold. Unreadable always answers *unknown*, never *unclaimed* — reporting a held lane as free is the answer that starts a second driver. | The agent that wrote the ledger. The ledger records events; it does not record who was entitled to send them. |
| lane | One run of a workflow, on disk as exactly **two files**: `workflow.json` (the topology) and `events.jsonl` (what has happened). Lanes live under a gitignored `.fabrika/`, so they only ever exist on the machine that ran them. | A branch, a PR or an issue. A lane may be *about* an issue; it is the run, not the work item. |
| ledger | A lane's `events.jsonl` — the append-only log an agent writes to as it drives. It is authoritative; every derived view is a fold over it. | The workflow document. The ledger is what happened, the document is what could. |
