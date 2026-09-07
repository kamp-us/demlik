# @demlik/tea/node

> Node host adapter for `@demlik/tea`.

```ts
import { … } from "@demlik/tea/node";
```

## Exports (11)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `AssertNodeSubIsSub` | Type |  |
| `fileJournal` | Function | The Node file substrate for the journal (`src/internal/journal/`), beside `fileStore`. |
| `fileStore` | Function | Persist a machine's state to a JSON file — pass the `path` and a `parse` that validates what comes back, get a `Store<S>` you hand to `run` so the next run resumes where this one stopped. |
| `NodeSignalSub` | Type | A process-signal sub: `signal` (SIGINT/SIGTERM/…) → `msg`. |
| `NodeSub` | Type |  |
| `nodeSubscribe` | Function | Build the `subscribe` handlers for `node_ws`, `node_timer`, and `node_signal`. |
| `NodeSubscribeCtx` | Interface | The Ctx fields the node Subs depend on. |
| `NodeTimerSub` | Type | A node timer sub. |
| `NodeWsRegistry` | Type |  |
| `NodeWsSub` | Type | A node WebSocket sub. |
| `sendToWebSocket` | Function | Write a frame to a registered `node_ws` socket. |
