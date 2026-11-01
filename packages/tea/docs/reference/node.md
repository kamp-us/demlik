# @demlik/tea/node

> Node host adapter for `@demlik/tea`.

Tier: `stable`

```ts
import { … } from "@demlik/tea/node";
```

## Exports (20)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`fileJournal`](#fileJournal) | Function | experimental | The Node file substrate for the journal (`src/internal/journal/`), beside `fileStore`. |
| [`FileLockBlock`](#FileLockBlock) | Type | stable | Why a writer could not take a lock: - `another-host`: the lock names another host, which may still be writing. |
| [`FileLockTimeoutError`](#FileLockTimeoutError) | Class | stable | A write gave up waiting for a lock file. |
| [`fileStore`](#fileStore) | Function | stable | Persist a machine's state to a JSON file — pass the `path` and a `parse` that validates what comes back, get a `Store<S>` you hand to `run` so the next run resumes where this one stopped. |
| [`FileStoreOptions`](#FileStoreOptions) | Interface | stable | Options for fileStore. |
| [`NodeSignalDeps`](#NodeSignalDeps) | Type | stable | The `deps` of a `node_signal` Sub: `signal` (SIGINT/SIGTERM/…) → `msg`. |
| [`NodeSignalSub`](#NodeSignalSub) | Type | stable | A process-signal sub. |
| [`NodeSub`](#NodeSub) | Type | stable | The union of the Sub types the Node adapter ships runners for: WebSocket, timer and process signal. |
| [`nodeSubscribe`](#nodeSubscribe) | Function | stable | Build the `subscribe` runners for the node Sub types, to hand to `run`: `run(machine, { subscribe: nodeSubscribe<M, Ctx>({ ws: { onMessage } }), ctx })`. |
| [`NodeSubscribeBase`](#NodeSubscribeBase) | Interface | stable | The `node_timer` + `node_signal` runners — what every `nodeSubscribe` returns. |
| [`NodeSubscribeCtx`](#NodeSubscribeCtx) | Interface | stable | The Ctx fields the `node_ws` runner depends on. |
| [`NodeSubscribeOpts`](#NodeSubscribeOpts) | Interface | stable | The options of nodeSubscribe: the `node_ws` handlers, when used. |
| [`NodeSubscribeWithWs`](#NodeSubscribeWithWs) | Interface | stable | The full runner table, with `node_ws` — `nodeSubscribe({ ws })`. |
| [`NodeTimerDeps`](#NodeTimerDeps) | Type | stable | The `deps` of a `node_timer` Sub. |
| [`NodeTimerSub`](#NodeTimerSub) | Type | stable | A node timer sub. |
| [`NodeWsDeps`](#NodeWsDeps) | Type | stable | The `deps` of a `node_ws` Sub: which socket (`key`) and where it connects (`url`). |
| [`NodeWsHandlers`](#NodeWsHandlers) | Interface | stable | What a `node_ws` socket's events become. |
| [`NodeWsRegistry`](#NodeWsRegistry) | Type | stable | The live `node_ws` sockets, keyed by each Sub's `deps.key`. |
| [`NodeWsSub`](#NodeWsSub) | Type | stable | A node WebSocket sub. |
| [`sendToWebSocket`](#sendToWebSocket) | Function | stable | Write a frame to the `node_ws` socket whose `deps.key` is `key`. |

## Declarations

<a id="fileJournal"></a>

### `fileJournal`

```ts
function fileJournal<R>(dir: string, parse: (raw: unknown) => R): Journal<R>
```

<a id="FileLockBlock"></a>

### `FileLockBlock`

```ts
type FileLockBlock = "another-host" | "contended" | "live-holder" | "unreadable" | "unwritten"
```

<a id="FileLockTimeoutError"></a>

### `FileLockTimeoutError`

```ts
class FileLockTimeoutError extends Error {
  constructor(lockPath: string, waitedMs: number, blockedBy: FileLockBlock);
  readonly _tag: "file_lock_timeout";
  readonly blockedBy: FileLockBlock;
  readonly lockPath: string;
  readonly name: "FileLockTimeoutError";
  readonly waitedMs: number;
}
```

<a id="fileStore"></a>

### `fileStore`

```ts
function fileStore<S>(
  path: string,
  parse: (raw: unknown) => Migrated<S>,
): DeletableStore<S>
function fileStore<S>(
  path: string,
  parse: (raw: unknown) => Migrated<S>,
  options: FileStoreOptions & { readonly fenced: true },
): FencedStore<S> & DeletableStore<S>
function fileStore<S>(
  path: string,
  parse: (raw: unknown) => Migrated<S>,
  options?: FileStoreOptions,
): DeletableStore<S> | FencedStore<S> & DeletableStore<S>
```

<a id="FileStoreOptions"></a>

### `FileStoreOptions`

```ts
interface FileStoreOptions {
  /**
   * Refuse a second live writer (#143). With `{ fenced: true }` the returned
   * store is a `FencedStore<S>`: it carries a version stamp beside the state
   * file, and `run` compare-and-swaps against it on every save. A process that
   * boots reads the current version and takes the fence; the older live writer
   * that started from the same version is refused with a `StoreConflictError`
   * at its next save. Omit it and the store is exactly as it was — the last
   * writer wins, and single-writer is the caller's precondition to keep.
   *
   * A run on a fenced store must be given an `onError`, or it does not compile
   * (see `StoreAndOnError`). A lost fence can surface with no caller to reject
   * at, under `"stop-save"` or `"follow-up"`, and the default sink would rethrow
   * it and end the process. Treat a `StoreConflictError` there as this run having
   * moved to another process: stop that run, and leave the others alone.
   *
   * Each save and `delete()` takes a lock file, `<path>.fence.lock`, and a
   * writer that dies holding it leaves it behind. The next write steals a lock
   * whose holder is proven gone: an empty one older than a short grace period,
   * one from an earlier boot of this machine, or one whose process is dead.
   *
   * Any other lock is waited on for up to 10 seconds, and then the write rejects
   * with a FileLockTimeoutError naming the file. That includes a lock
   * from another host, which is never stolen because that host may be live on a
   * shared volume. So a folder restored onto a new machine can need one clear
   * step: once the old machine is known to be gone, delete the file. Hosts are
   * told apart by `os.hostname()`, so give two live hosts on one volume two
   * names.
   */
  readonly fenced?: true;
}
```

<a id="NodeSignalDeps"></a>

### `NodeSignalDeps`

```ts
type NodeSignalDeps<M> = {
  readonly msg: M;
  readonly signal: NodeJS.Signals;
}
```

<a id="NodeSignalSub"></a>

### `NodeSignalSub`

```ts
type NodeSignalSub<M> = Sub<"node_signal", NodeSignalDeps<M>>
```

<a id="NodeSub"></a>

### `NodeSub`

```ts
type NodeSub<M> = NodeWsSub | NodeTimerSub<M> | NodeSignalSub<M>
```

<a id="nodeSubscribe"></a>

### `nodeSubscribe`

```ts
function nodeSubscribe<M>(): NodeSubscribeBase<M>
function nodeSubscribe<M, Ctx extends NodeSubscribeCtx>(
  opts: NodeSubscribeOpts<M>,
): NodeSubscribeWithWs<M, Ctx>
```

<a id="NodeSubscribeBase"></a>

### `NodeSubscribeBase`

```ts
interface NodeSubscribeBase<M> {
  node_signal: (sub: NodeSignalSub<M>, ctx: unknown, dispatch: (msg: M) => void) => Dispose;
  node_timer: (sub: NodeTimerSub<M>, ctx: unknown, dispatch: (msg: M) => void) => Dispose;
}
```

<a id="NodeSubscribeCtx"></a>

### `NodeSubscribeCtx`

```ts
interface NodeSubscribeCtx {
  wsRegistry: NodeWsRegistry;
}
```

<a id="NodeSubscribeOpts"></a>

### `NodeSubscribeOpts`

```ts
interface NodeSubscribeOpts<M> {
  readonly ws: NodeWsHandlers<M>;
}
```

<a id="NodeSubscribeWithWs"></a>

### `NodeSubscribeWithWs`

```ts
interface NodeSubscribeWithWs<M, Ctx extends NodeSubscribeCtx> extends NodeSubscribeBase<M> {
  node_ws: (sub: NodeWsSub, ctx: Ctx, dispatch: (msg: M) => void) => Dispose;
}
```

<a id="NodeTimerDeps"></a>

### `NodeTimerDeps`

```ts
type NodeTimerDeps<M> = {
  readonly delayMs: number;
  readonly msg: M;
  readonly repeat?: boolean;
}
```

<a id="NodeTimerSub"></a>

### `NodeTimerSub`

```ts
type NodeTimerSub<M> = Sub<"node_timer", NodeTimerDeps<M>>
```

<a id="NodeWsDeps"></a>

### `NodeWsDeps`

```ts
type NodeWsDeps = {
  readonly key: string;
  readonly url: string;
}
```

<a id="NodeWsHandlers"></a>

### `NodeWsHandlers`

```ts
interface NodeWsHandlers<M> {
  onClose?(code: number, reason: string, sub: NodeWsSub): M;
  onError?(message: string, sub: NodeWsSub): M;
  onMessage(data: string, sub: NodeWsSub): M | null;
  onOpen?(sub: NodeWsSub): M;
}
```

<a id="NodeWsRegistry"></a>

### `NodeWsRegistry`

```ts
type NodeWsRegistry = Map<string, WebSocket>
```

<a id="NodeWsSub"></a>

### `NodeWsSub`

```ts
type NodeWsSub = Sub<"node_ws", NodeWsDeps>
```

<a id="sendToWebSocket"></a>

### `sendToWebSocket`

```ts
function sendToWebSocket(
  ctx: NodeSubscribeCtx,
  key: string,
  data: string,
): boolean
```
