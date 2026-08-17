# Batch a stream of items into bounded flushes

To stop shipping one write per item, fold `@demlik/tea/batch-window` into your
Model: it buffers arrivals and emits a single flush Cmd when the buffer reaches
`maxItems` or the window's `maxMs` elapses, whichever comes first — and because
the buffer and the window's open instant are plain Model fields, a batch in
flight survives a Durable Object eviction.

## 1. Declare the window

`flush` is a pure Cmd constructor, not a callback: it maps the buffered items to
the ONE Cmd the runtime performs when the window closes. Keeping it
`(items) => Cmd` is what keeps the trigger replayable.

```ts
import { createBatchWindow } from "@demlik/tea/batch-window";

interface LogLine { readonly seq: number; readonly tag: string }
type FlushBatch = { type: "flush_batch"; items: readonly LogLine[] };

const bw = createBatchWindow<LogLine, FlushBatch>({
  maxItems: 100,
  maxMs: 5_000,
  flush: (items) => ({ type: "flush_batch", items }),
});
```

`maxItems` is the "a full page ships now" cutoff; `maxMs` is the latency ceiling
measured from the item that OPENED the window, so nothing waits longer than that
even on a trickle. `maxItems: 1` is the legal degenerate case — every item
flushes on arrival, which makes "batching off" a config flag rather than a
rewiring.

## 2. Hold the window in your Model

```ts
import type { BatchWindow } from "@demlik/tea/batch-window";

interface State {
  readonly batch: BatchWindow<LogLine>;
}

// inside init:
init: (loaded) => (loaded !== null ? [loaded, []] : [{ batch: bw.init(), ... }, []]),
```

The slice is just `{ buffer, openedAt }`, with the invariant that an empty buffer
always has `openedAt === null`. That pair is the single source of truth for "is a
window open, and when must it flush by?" — and it is trivially serializable into
a `Store<S>`.

## 3. Fold arrivals and expiries through two cells

Both verbs take the instant as an argument, so neither reads a clock:

```ts
// inside update:
log_arrived: (s, m) => {
  const [batch, cmds] = bw.add(s.batch, m.line, m.at);
  return [{ ...s, batch }, cmds];
},
deadline_exceeded: (s, m) => {
  const [batch, cmds] = bw.onWindow(s.batch, m.atMs);
  return [{ ...s, batch }, cmds];
},
```

`add` opens a closed window at this item's `at`, appends to an open one without
moving `openedAt`, and — if that brings the buffer to `maxItems` — emits the
flush Cmd and resets to the closed slice. `onWindow` flushes whatever is buffered
and is a no-op on an empty buffer, which is exactly the guard for the race where
a size-flush already shipped the batch before the timer's Msg landed: a stale
expiry never ships an empty batch.

## 4. Wire the window timer — it IS a deadline Sub

There is no bespoke timer here. `subs` returns `@demlik/tea/deadline`'s
`DeadlineSub` targeting `openedAt + maxMs` while a window is open and `[]` while
it is closed, and `handlers()` hands back the deadline subscribe cell verbatim:

```ts
subscriptions: (s) => bw.subs(s.batch),
subscribe: { ...bw.handlers() },
```

The substrate's reconcile pass arms the timer when the Sub appears and clears the
pending `setTimeout` when it disappears — so a size-flush that empties the buffer
auto-cancels the now-irrelevant time trigger on the very next transition. And
because the target is an ABSOLUTE instant, a late subscribe after a rehydrate
recomputes the remaining delay from the current clock and still fires at the
right moment.

## 5. Run several windows on one machine

Pass a distinct id per window; the dispatched `BatchWindowExpired` Msg carries it
back, so route on `m.id`:

```ts
subscriptions: (s) => [...bw.subs(s.logs, "logs"), ...bw.subs(s.metrics, "metrics")],

// inside update:
deadline_exceeded: (s, m) => {
  if (m.id === "logs") {
    const [logs, cmds] = bw.onWindow(s.logs, m.atMs);
    return [{ ...s, logs }, cmds];
  }
  const [metrics, cmds] = bw.onWindow(s.metrics, m.atMs);
  return [{ ...s, metrics }, cmds];
},
```

`batchWindowExpired(id, atMs)` builds the same Msg, so a test can drive an expiry
without waiting on a real timer.

## 6. Meet I/O in the flush handler

The flush Cmd is where the batch leaves the pure world. That handler is yours —
a network POST, an R2 write, or an enqueue onto a `createQueue(store)` from
`@demlik/tea/work-queue`, whose `EnqueueInput<I>` type this module re-exports so
your flush Cmd and your queue agree on the item shape:

```ts
interpret: {
  flush_batch: async (cmd) => {
    await sink.write(cmd.items);
  },
},
```

If the source is bursty — keystrokes, scroll, websocket frames — settle it BEFORE
it becomes an `add` Msg. `debounce` is re-exported from the same import for that,
but it lives at the host, outside `update`:

```ts
import { debounce } from "@demlik/tea/batch-window";

const onKey = debounce((line: LogLine) => dispatch({ type: "log_arrived", line, at: Date.now() }), 150);
```

That is the whole knob: a durable buffer, two pure verbs, and one deadline Sub.
The pure forms `addItem` / `onWindow` / `subsFor` / `initBatchWindow` take the
config explicitly if you would rather not bind a knob. For the timer primitive
underneath see `@demlik/tea/deadline`, for the sink `@demlik/tea/work-queue`, and
for the host-side settler `@demlik/tea/debounce`.
