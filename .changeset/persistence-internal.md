---
"@demlik/tea": minor
---

The persistence / observability modules and the agent-side leaves move inside the package
(ADR 0015, ADR 0016). Six subpaths leave `exports`; every primitive they published still
exists under `src/internal/`, and none of them is importable from outside the package.

| Removed door | New home |
|---|---|
| `@demlik/tea/recorder` | `src/internal/persistence/recorder` |
| `@demlik/tea/snapshot` | `src/internal/persistence/snapshot` |
| `@demlik/tea/trace-replay` | `src/internal/persistence/trace-replay` |
| `@demlik/tea/journal` | `src/internal/journal` |
| `@demlik/tea/prediction` | `src/internal/prediction` |
| `@demlik/tea/llm-call` | `src/internal/llm-call` |

**`@demlik/tea/machine-viz` stays where it is.** It is a `stable` subpath with real external
callsites, and ADR 0016 (as amended by #83) keeps such a part on its own bare door rather than
folding it into a grouped one — the same shape `@demlik/tea/retry-backoff` takes. `toMermaid`,
`MachineVizOptions`, `safeId` and `safeLabel` are unchanged, and nothing about that door moves.

`fileJournal` stays on `@demlik/tea/node` and the prediction ack primitive (`ack`, `initAck`,
`NO_ACK`, `nextSeq`, `partitionByAck`, `reconcile`, `tagSeq`, and their types) stays on
`@demlik/tea/pure`; those were always the public route, and only the mechanism-named doors
behind them close. `@demlik/tea/agent` keeps re-exporting the `llm-call` types it did.

`snapshot`'s two Cmds — `snapshot_write`, `snapshot_load` — are now built by `Cmd.define`
constructors (`snapshotWriteDef<V>()`, `snapshotLoad`), so each carries its input shape as a
type. The emitted records are unchanged; a checkpoint log written before this release folds
identically. The other moved modules emit no Cmds of their own.

`docs/reference/llm-call.md` goes with its door.
