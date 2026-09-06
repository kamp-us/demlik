---
"@demlik/tea": minor
---

The persistence / observability modules and the agent-side leaves move inside the package
(ADR 0015, ADR 0016). Seven subpaths leave `exports`; every primitive they published still
exists, under `src/internal/` or `./devtools`, and six of them are no longer importable from
outside the package.

| Removed door | New home |
|---|---|
| `@demlik/tea/recorder` | `src/internal/persistence/recorder` |
| `@demlik/tea/snapshot` | `src/internal/persistence/snapshot` |
| `@demlik/tea/trace-replay` | `src/internal/persistence/trace-replay` |
| `@demlik/tea/machine-viz` | `@demlik/tea/devtools` — still public, see below |
| `@demlik/tea/journal` | `src/internal/journal` |
| `@demlik/tea/prediction` | `src/internal/prediction` |
| `@demlik/tea/llm-call` | `src/internal/llm-call` |

**Breaking, stable tier:** `@demlik/tea/machine-viz` was a `stable` subpath. Its whole API —
`toMermaid`, `MachineVizOptions`, `safeId`, `safeLabel` — now ships from `@demlik/tea/devtools`,
unchanged. The one migration is the import path:

```diff
- import { toMermaid } from "@demlik/tea/machine-viz";
+ import { toMermaid } from "@demlik/tea/devtools";
```

`fileJournal` stays on `@demlik/tea/node` and the prediction ack primitive (`ack`, `initAck`,
`NO_ACK`, `nextSeq`, `partitionByAck`, `reconcile`, `tagSeq`, and their types) stays on
`@demlik/tea/pure`; those were always the public route, and only the mechanism-named doors
behind them close. `@demlik/tea/agent` keeps re-exporting the `llm-call` types it did.

`snapshot`'s two Cmds — `snapshot_write`, `snapshot_load` — are now built by `Cmd.define`
constructors (`snapshotWriteDef<V>()`, `snapshotLoad`), so each carries its input shape as a
type. The emitted records are unchanged; a checkpoint log written before this release folds
identically. The other moved modules emit no Cmds of their own.

`docs/reference/llm-call.md` goes with its door.
