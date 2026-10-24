# Paginator and work queue checkpoint

Reference: `75de37ea01a81cd7949e6275b7ee9cfdeb4e312d`, Node
`22.21.1`, V8 `12.4.254.21-node.33`. The TypeScript source is unchanged.

This slice implements the L1 paginator, the pure queue ops and verb adapter,
and the sequential `Store` adapter. The composed `paginated-walk` remains open
until native resilient-call exists. Concurrent resolved-await scheduling is a
measured qualification, described below. This is not a full-port claim.

`PaginatorState<C>` shares cursor references and preserves no-op state identity.
It has no cursor `Clone`, serde, `Send`, runtime, or `'static` requirement for
pure folds. Explicit serialization bounds apply at the wire boundary. The
nullable count and missing/undefined cursor variants retain real JSON restore
behavior, including overflow/NaN counters becoming null and later arithmetic
coercing null to zero. Direct map decoding retains lone UTF-16 cursor values.
Count/time decoders select numbers through PlainData, so valid JSON `1e400`
reaches the model as infinity before any JSON stringify changes it to null.

`Queue<I>` owns a shared array of shared items. Pure operations produce fresh
arrays, including unmatched removes/patches and a reset that changes no item;
untouched items and payload references stay shared. `items()`/`items_mut()` are
explicit borrow guards for the source memory adapter's array alias semantics.
`iter()` takes a snapshot of item handles. Patch callbacks run after the input
array borrow has been released. Payloads can contain borrowed non-Clone,
non-serde values and caller-selected interior mutability.

Item fields are readable through a readonly view. Value-returning patch methods
own optional-property presence and insertion order. Thus an identity patch is
still `changed: true`; reset clears only `startedAt`; retry explicitly clears
`startedAt`, `finishedAt`, `error`, then `output`. JSON omits undefined fields.
Direct decoding preserves extra restored fields, key order, null timestamps,
and lone-surrogate IDs, output tokens, error strings, and nested data.

`QueueClient::with_sources` accepts a `Store<Queue<I>>`, a clock, and an ID
source. `create_queue` supplies integer epoch milliseconds and UUID-v4 IDs
from the native OS RNG. It uses `restore` before every operation, skips saves
only when the source does, and returns typed restore/save errors. Caught
load/migration/save/source panic payloads remain accessible as data. No model
serde/Clone/Send bound or TEA dependency registry was added. `getrandom 0.4.3`
was already locked and cached; it is now an explicit dependency.

Run with the isolated Cargo environment and pinned pnpm Node:

```sh
pnpm --filter @demlik/parity verify:paginate-queue
pnpm --filter @demlik/parity verify:paginate-queue:coverage
pnpm --filter @demlik/parity verify:paginate-queue:mutations
```

Reports are `target/parity/paginate-queue.json`,
`paginate-queue-coverage.json`, and `paginate-queue-mutations.json`. Coverage
checks fresh source signatures and actual compiled `observe!`/`observe_async!`
consumer calls for 37 mappings: 34 owned and 3 existing Store aliases. It also
reads the baseline `target/parity/report.json` for those shared aliases.

The strict corpus covers independent literals, generated transitions, no-op
and item identity, array/payload mutation through loaded aliases, unsafe
integer/numeric edges, JSON restore, FIFO claiming, duplicate IDs, missing IDs,
refusal, failed load/save, preserved raw thrown data, default sources, and
injected fractional clocks. Native tests add borrowed type witnesses, typed
panic/error causes, actual file adapter recovery/refusal, and readonly/output
compile-fail contracts. The TypeScript consumer has matching checked failures.

Open scheduling qualification: Node `Promise.all([enqueue("a"), enqueue("b")])`
with memoryStore reads empty twice and ends with `["b"]`. Native ready futures
under `tokio::join!` currently end with `["a", "b"]`. Rust await does not suspend
a ready future. The coordinating agent requires preserving this concurrency
behavior where a bounded helper suffices; a shared await-boundary policy is the
next bounded experiment. The user explicitly requires a native port rather
than a JavaScript runtime, so arbitrary executor scheduling will be qualified
with an explicit native concurrency contract if it requires a runtime engine.
Raw MemoryStore futures must not independently yield because the native kernel
already inserts turns at its own source awaits. No tolerance or serialization
of callers has been substituted for source behavior.

Native host evidence is macOS/Tokio. Browser/Wasm host execution is not covered
by this checkpoint. Global UTF-8-only names/tags/refusal reasons are unchanged;
the cursor, queue ID, token/error text and payload data here use shared JsText.
