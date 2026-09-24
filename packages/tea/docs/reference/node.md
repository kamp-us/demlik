# @demlik/tea/node

> Node host adapter for `@demlik/tea`.

```ts
import { … } from "@demlik/tea/node";
```

## Exports (18)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `fileJournal` | Function | The Node file substrate for the journal (`src/internal/journal/`), beside `fileStore`. |
| `fileStore` | Function | Persist a machine's state to a JSON file — pass the `path` and a `parse` that validates what comes back, get a `Store<S>` you hand to `run` so the next run resumes where this one stopped. |
| `FileStoreOptions` | Interface | Options for fileStore. |
| `NodeSignalDeps` | Type | The `deps` of a `node_signal` Sub: `signal` (SIGINT/SIGTERM/…) → `msg`. |
| `NodeSignalSub` | Type | A process-signal sub. |
| `NodeSub` | Type |  |
| `nodeSubscribe` | Function | Build the `subscribe` runners for the node Sub types, to hand to `run`: `run(machine, { subscribe: nodeSubscribe<M, Ctx>({ ws: { onMessage } }), ctx })`. |
| `NodeSubscribeBase` | Interface | The `node_timer` + `node_signal` runners — what every `nodeSubscribe` returns. |
| `NodeSubscribeCtx` | Interface | The Ctx fields the `node_ws` runner depends on. |
| `NodeSubscribeOpts` | Interface | The options of nodeSubscribe: the `node_ws` handlers, when used. |
| `NodeSubscribeWithWs` | Interface | The full runner table, with `node_ws` — `nodeSubscribe({ ws })`. |
| `NodeTimerDeps` | Type | The `deps` of a `node_timer` Sub. |
| `NodeTimerSub` | Type | A node timer sub. |
| `NodeWsDeps` | Type | The `deps` of a `node_ws` Sub: which socket (`key`) and where it connects (`url`). |
| `NodeWsHandlers` | Interface | What a `node_ws` socket's events become. |
| `NodeWsRegistry` | Type | The live `node_ws` sockets, keyed by each Sub's `deps.key`. |
| `NodeWsSub` | Type | A node WebSocket sub. |
| `sendToWebSocket` | Function | Write a frame to the `node_ws` socket whose `deps.key` is `key`. |
