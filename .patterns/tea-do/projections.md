# Building a projection

A projection consumes a stream of events from a single write model and folds them into a separate
read-optimized representation — a named view. This is the read side of CQRS: one write model emits
events; many projections each shape those same events into a view tuned for one query. The decision
surface here is *assembly*: a `SourceProvider` defines the event stream, a `Handler` defines what each
event does to the view, and a `ProjectionId` names the running instance. Get the assembly wrong and the
view either reads the wrong stream or cannot be parallelized.

Conceptual gloss for a `Model → View` reader: the `SourceProvider` is the ordered event feed, the
`Handler.process` is the per-event reducer step that mutates one view, and the whole projection is one
`(events) → view` fold that runs forever and resumes where it left off.

## Approaches

### SourceProvider by tag — one logical stream per tag

**When to use:** A view is built from a bounded, named subset of events (one aggregate's events, or all
events of one type) and a single consumer can keep up with that subset.

**Pattern:**

```scala
// The SourceProvider is the event feed. `eventsByTag` returns every event the write model
// tagged with "carts-1", in offset order, as EventEnvelope[Event]. The same plugin that the
// write side persists with is the one the read side queries.
import akka.projection.eventsourced.EventEnvelope
import akka.persistence.cassandra.query.scaladsl.CassandraReadJournal
import akka.persistence.query.Offset
import akka.projection.eventsourced.scaladsl.EventSourcedProvider
import akka.projection.scaladsl.SourceProvider

val sourceProvider: SourceProvider[Offset, EventEnvelope[ShoppingCart.Event]] =
  EventSourcedProvider
    .eventsByTag[ShoppingCart.Event](
      system,
      readJournalPluginId = CassandraReadJournal.Identifier,
      tag = "carts-1")
```

**Gotchas:**
- The `tag` must have been assigned on the write side; a projection cannot tag events itself.
- Across persistence ids the order in which tagged events appear "rarely is guaranteed (or stable
  between materializations)" — never assume cross-entity ordering, only per-entity offset order.
- A single tag is a single stream; you scale by partitioning into multiple tags, not by adding consumers
  to one tag.

### SourceProvider by slice — deterministic partitioning for parallelism

**When to use:** The event volume for an entity type exceeds what one consumer can process, so the
stream is split into slice ranges and one projection instance runs per range.

**Pattern:**

```scala
// A slice is derived deterministically from the persistence id, spreading all ids evenly across
// slices. Each running projection instance owns one [minSlice, maxSlice] range; start as many
// instances as there are ranges to consume every entity's events.
import akka.persistence.query.typed.EventEnvelope
import akka.persistence.query.Offset
import akka.projection.eventsourced.scaladsl.EventSourcedProvider
import akka.projection.scaladsl.SourceProvider

val numberOfSliceRanges: Int = 4
val sliceRanges = EventSourcedProvider.sliceRanges(system, readJournalPluginId, numberOfSliceRanges)
val minSlice: Int = sliceRanges.head.min
val maxSlice: Int = sliceRanges.head.max

val sourceProvider: SourceProvider[Offset, EventEnvelope[ShoppingCart.Event]] =
  EventSourcedProvider
    .eventsBySlices[ShoppingCart.Event](
      system,
      readJournalPluginId,
      entityType = "ShoppingCart",
      minSlice,
      maxSlice)
```

**Gotchas:**
- You must start one instance per slice range; a single instance covering only `sliceRanges.head`
  silently leaves the other ranges' entities unprojected.
- The slice assignment is a property of the persistence id, not of the projection — you cannot
  re-slice without re-deriving from ids.

### Handler — the per-envelope reducer

**When to use:** Always — every projection needs a `Handler[Envelope]` whose `process` advances the
view by one event.

**Pattern:**

```scala
// process is invoked one envelope at a time; the next envelope is not delivered until the returned
// Future completes. Match on the event, apply the change to the view, return Future[Done]. Events
// the view does not care about are skipped by returning Future.successful(Done).
import akka.Done
import akka.projection.eventsourced.EventEnvelope
import akka.projection.scaladsl.Handler

class ItemPopularityProjectionHandler(repo: ItemPopularityProjectionRepository)
    extends Handler[EventEnvelope[ShoppingCartEvents.Event]] {
  import ShoppingCartEvents._

  override def process(envelope: EventEnvelope[Event]): Future[Done] =
    envelope.event match {
      case ItemAdded(_, itemId, quantity)         => repo.update(itemId, quantity)
      case ItemRemoved(_, itemId, oldQuantity)    => repo.update(itemId, 0 - oldQuantity)
      case _: CheckedOut                          => Future.successful(Done) // skip
    }
}
```

**Gotchas:**
- "It can be stateful, with variables and mutable data structures" — visibility between invocations is
  handled by the machinery, so no `volatile`/locks are needed; but never share one handler instance
  across projection instances.
- For non-trivial in-flight state that must reload on restart, extend `StatefulHandler[State, Envelope]`
  (`initialState()` + `process(state, envelope)`) instead of a raw `var`. On a failed `process` it
  re-runs `initialState()` before the next call.

### ProjectionId — name + key identifies a running instance

**When to use:** Always — every projection is wrapped with a `ProjectionId(name, key)`. The `name` is the
view ("user-view"); the `key` distinguishes instances (partitions, shards, slice ranges).

**Pattern:**

```scala
// name is shared across instances of the same view; key must be unique per name. The stored offset
// is scoped to this id, so the key is also what lets two instances of one view track offsets
// independently.
import akka.projection.ProjectionId

val projectionId = ProjectionId("ShoppingCarts", "carts-1") // id == "ShoppingCarts-carts-1"
```

**Gotchas:**
- `name` and `key` must be non-null and non-empty (`require`d in the constructor).
- Two instances sharing a `key` share an offset row and will fight over it — the key is the unit of
  parallelism *and* the unit of offset isolation.

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| One aggregate's events, low volume | `eventsByTag` | A tag is one bounded ordered stream |
| High-volume entity type, needs parallelism | `eventsBySlices` + one instance per range | Slices partition ids deterministically |
| Simple per-event view update | `Handler` | One reducer step per envelope |
| In-flight state must survive restart | `StatefulHandler` | Reloads `initialState()` on start/failure |
| Two parallel instances of one view | same `name`, distinct `key` | Keys isolate offsets |

## Rules

- One write model, many projections: each projection is an independent fold of the *same* events into a
  *different* view. Never make one projection write two unrelated views.
- The read side uses the same persistence plugin the write side persisted with — the projection queries
  the write model's journal.
- `process` returns `Future[Done]`; the next envelope waits for it. Back-pressure is automatic — do not
  fire-and-forget inside `process`.
- A view is rebuildable: deleting the view and resetting the offset replays the events from the start.
- The `key` is both the parallelism unit and the offset-isolation unit; pick keys so they never overlap.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| One `eventsBySlices` instance covering only `sliceRanges.head` | Other ranges' entities are never projected |
| Sharing one `Handler` instance across projection instances | `StatefulHandler` throws `IllegalStateException`; state corrupts |
| Assuming `eventsByTag` order across persistence ids | Cross-entity order is not guaranteed or stable |
| Two instances with the same `ProjectionId` key | They share one offset row and overwrite each other |
| Tagging events inside the projection | Tags are a write-side decision; the read side only queries them |

## See also

- [offset-tracking.md](./offset-tracking.md) — how the stored `Offset` makes a projection durable and restartable
- [delivery-semantics.md](./delivery-semantics.md) — at-least-once vs exactly-once vs at-most-once, and idempotent handlers
- [event-sourcing.md](./event-sourcing.md) — the write model whose events these projections consume
