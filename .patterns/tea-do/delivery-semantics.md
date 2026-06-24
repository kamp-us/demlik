# Delivery semantics & idempotency

Whether the offset is stored *before*, *after*, or *in the same transaction as* the handler's view
write determines what happens to an envelope when the projection crashes and restarts from its last
stored offset. This is the central correctness decision of a projection. The three modes form a trio:
at-least-once (offset after the write — may reprocess), exactly-once (offset and write in one
transaction — never reprocess, never drop), at-most-once (offset before the write — may drop). Grouped
handlers batch envelopes for throughput while keeping the chosen mode.

Conceptual gloss for a `Model → View` reader: restart re-folds from the bookmark. If the bookmark was
saved before the fold step landed, that step re-runs — so the reducer must be idempotent. If bookmark
and fold commit atomically, each event folds exactly once.

## Approaches

### atLeastOnceAsync / atLeastOnce — store the offset after the handler

**When to use:** The view write cannot share a transaction with the offset store (different datastore,
message broker, async target), and the handler can be made idempotent.

**Pattern:**

```scala
// Offset is stored AFTER the handler processes the envelope, batched by a save window (N envelopes or
// a duration, whichever first). On restart, every envelope after the last *saved* offset is replayed —
// so any envelope in the un-saved window can be processed more than once.
val projection: AtLeastOnceProjection[Offset, Envelope] =
  CassandraProjection.atLeastOnce(
    projectionId = ProjectionId("ItemPopularity", "carts-1"),
    sourceProvider,
    handler = () => new ItemPopularityProjectionHandler(repo))
    .withSaveOffset(afterEnvelopes = 100, afterDuration = 500.millis)
```

**Gotchas:**
- The handler **must be idempotent** — reprocessing the same event must not corrupt the view (use
  upserts/conditional writes, not blind increments, unless the metric tolerates drift).
- A wider save window (`withSaveOffset`) means fewer offset writes but a larger replay-on-restart set.
- A counter updated with a non-idempotent increment under at-least-once will over-count on restart;
  that is acceptable only when the value is a rough metric, never for exact accounting.

### exactlyOnce — store the offset in the same transaction as the view write

**When to use:** The view lives in a transactional store (relational DB via JDBC/R2DBC) and you need each
event reflected in the view exactly once, with no idempotency burden on the handler.

**Pattern:**

```scala
// The offset is written in the SAME transaction as the handler's view update. Either both commit or
// both roll back, so on restart the view and the offset can never disagree — no replay, no drop.
val projection: ExactlyOnceProjection[Offset, Envelope] =
  JdbcProjection.exactlyOnce(
    projectionId = ProjectionId("ShoppingCarts", "carts-1"),
    sourceProvider,
    sessionFactory = () => new PlainJdbcSession,
    handler = () => new ShoppingCartHandler(orderRepository))
```

**Gotchas:**
- The handler's write and the offset write must go through the *same* session/transaction the factory
  supplies — writing the view on a different connection breaks the atomicity guarantee.
- Requires a source whose offset type the offset store can persist transactionally; not every source
  supports it.

### atMostOnce — store the offset before the handler

**When to use:** Reprocessing is worse than dropping, and losing an occasional envelope on a crash is
acceptable.

**Pattern:**

```scala
// Offset is stored BEFORE the handler runs. On restart the next envelope is the one after the stored
// offset, so an envelope whose handler had not yet completed at crash time is never re-attempted.
val projection: AtMostOnceProjection[Offset, Envelope] =
  CassandraProjection.atMostOnce(
    projectionId = ProjectionId("ShoppingCarts", "carts-1"),
    sourceProvider,
    handler = () => new ShoppingCartHandler(orderRepository))
```

**Gotchas:**
- An envelope in flight at crash time is silently lost — only use where a gap in the view is tolerable.
- Its recovery strategy is `StrictRecoveryStrategy` (fail/skip), narrower than the retrying strategies
  the other modes allow.

### groupedWithin — batch envelopes, keep at-least-once

**When to use:** The view write amortizes well over a batch (bulk insert/update) and the throughput gain
outweighs a larger replay set.

**Pattern:**

```scala
// The handler receives a Seq[Envelope] grouped within a window (N envelopes or a duration). The offset
// of the whole group is stored immediately after the group is processed — still at-least-once, so the
// previous group may be reprocessed on restart.
val projection: GroupedProjection[Offset, Envelope] =
  CassandraProjection.groupedWithin(
    projectionId = ProjectionId("ItemPopularity", "carts-1"),
    sourceProvider,
    handler = () => new GroupedHandler(repo))
    .withGroup(groupAfterEnvelopes = 20, groupAfterDuration = 500.millis)
```

**Gotchas:**
- Grouping does not change the delivery class — it is at-least-once; the whole previous group can replay.
- `atLeastOnceFlow` (a `FlowWithContext` handler) must not reorder or duplicate envelopes: reordering
  stores offsets out of order and marks unprocessed envelopes complete; duplicating can store the first
  offset and skip the rest on restart.

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Async/non-transactional target, idempotent handler | `atLeastOnceAsync` / `atLeastOnce` | Offset after write; replay is safe when idempotent |
| Transactional store, must be exact | `exactlyOnce` | Offset + view write commit atomically |
| Dropping beats reprocessing | `atMostOnce` | Offset before write; never re-attempts |
| Throughput via batching, replay tolerable | `groupedWithin` | Bulk write, group offset stored once |
| Stateless transform into reactive store | `atLeastOnceFlow` | Offset carried in `FlowWithContext` context |

## Rules

- Under at-least-once (including grouped/flow), the handler **must be idempotent** — restart replays from
  the last saved offset.
- Under exactly-once, the view write and the offset write share one transaction; route both through the
  factory-supplied session.
- Under at-most-once, accept that an in-flight envelope is lost on crash; never use it for exact views.
- The default handler recovery strategy is `fail` (restart from last saved offset); `retryAndFail`,
  `retryAndSkip`, and `skip` are the alternatives, configured `withRecoveryStrategy`.
- Grouping/flow choices change throughput and replay-set size, never the delivery class.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Non-idempotent blind increment under at-least-once | Replayed envelopes over-count the view |
| Writing the view on a different connection under `exactlyOnce` | Breaks atomicity; offset and view can diverge |
| `atMostOnce` for accounting/ledger views | A dropped in-flight envelope leaves a permanent gap |
| Reordering or duplicating envelopes in `atLeastOnceFlow` | Offsets stored out of order mark unprocessed events complete |
| Assuming `groupedWithin` is exactly-once | It is at-least-once; the previous group can replay |

## See also

- [offset-tracking.md](./offset-tracking.md) — *where* the offset is stored; this doc is *when* relative to the write
- [projections.md](./projections.md) — the `Handler` whose idempotency these modes constrain
- [durable-effects.md](./durable-effects.md) — the write-side dedup analogue: surviving a crash and de-duplicating on the receiver
