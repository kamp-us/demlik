# Offset tracking & resume

Every event in the source stream carries an `Offset` — its position in the stream. A projection stores
the offset of the last envelope it processed; on restart it resumes the source from that stored offset
instead of replaying from the beginning. This is the single mechanism that makes a projection *durable*
and *restartable*: without it, every restart would reprocess the entire history. The decision surface is
which offset type the source produces and how the stored offset is fed back into the next query.

Conceptual gloss for a `Model → View` reader: the offset is the bookmark in the event log. The view's
durability is "I have folded every event up to offset N"; resume means "re-open the feed starting after
N." The view itself can be reconstructed by clearing it and resetting the offset to the start.

## Approaches

### Sequence offset — monotonic Long position

**When to use:** The journal orders events by a single monotonic sequence number (the common case for
`eventsByTag` on journals that expose a `Long` offset).

**Pattern:**

```scala
// Sequence wraps a Long. The offset is EXCLUSIVE: the event with this exact sequence number is NOT
// re-included, so the stored offset can be handed straight back as the start of the next query.
import akka.persistence.query.{ Offset, Sequence }

val resumeFrom: Offset = Sequence(value = 42L)
// next query starts strictly after sequence 42; event 42 is already folded into the view
```

**Gotchas:**
- Exclusive semantics are the contract — re-querying with the stored offset must not redeliver the last
  processed event. Do not add or subtract 1 yourself.
- `Sequence` is `Ordered`; comparisons are by `value`.

### TimeBasedUUID offset — time-ordered unique id

**When to use:** The journal (e.g. a time-ordered store) identifies position by a version-1 time-based
UUID rather than a plain `Long`.

**Pattern:**

```scala
// TimeBasedUUID wraps a version-1 UUID and is Ordered via UUIDComparator. Like Sequence it is the
// exclusive resume position carried in the EventEnvelope.
import akka.persistence.query.{ Offset, TimeBasedUUID }

val resumeFrom: Offset = TimeBasedUUID(value = someV1Uuid) // throws if not a version-1 UUID
```

**Gotchas:**
- Construction throws `IllegalArgumentException` if the UUID is null or not version 1 — the type refuses
  a non-time-based UUID.
- Ordering is by `UUIDComparator`, not natural UUID ordering.

### NoOffset — start from the beginning

**When to use:** No offset has been stored yet (first run) or the view is being rebuilt from scratch.

**Pattern:**

```scala
// NoOffset means "retrieve all events" — the query starts at the very beginning of the stream.
// The SourceProvider.source is handed `() => Future[Option[Offset]]`; None / NoOffset both mean start.
import akka.persistence.query.{ NoOffset, Offset }

val startFromBeginning: Offset = NoOffset
```

**Gotchas:**
- Resetting a view to `NoOffset` replays the entire history — that is the intended rebuild path, but it
  reprocesses every event, so the handler's load (and its idempotency) matters.
- `TimestampOffset.toTimestampOffset` maps `NoOffset` to `TimestampOffset.Zero` (epoch) for timestamp
  journals.

### The SourceProvider resume contract

**When to use:** Whenever you implement or reason about how the stored offset re-enters the stream.

**Pattern:**

```scala
// The Projection machinery supplies the stored offset back to the source as a thunk returning
// Future[Option[Offset]]. extractOffset pulls the offset out of each processed envelope so the
// machinery knows what to store next.
trait SourceProvider[Offset, Envelope] {
  def source(offset: () => Future[Option[Offset]]): Future[Source[Envelope, NotUsed]]
  def extractOffset(envelope: Envelope): Offset
  def extractCreationTime(envelope: Envelope): Long
}
```

**Gotchas:**
- `source` receives the offset as a *function* (`() => Future[Option[Offset]]`), not a value, because it
  is read lazily at (re)start.
- The envelope carries the offset (`EventEnvelope.offset`); `extractOffset` is how the machinery learns
  the position of what it just processed.

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Journal exposes a `Long` position | `Sequence` | Monotonic, exclusive, directly re-queryable |
| Journal positions by time-based UUID | `TimeBasedUUID` | Time-ordered unique id with its own comparator |
| First run / rebuilding the view | `NoOffset` | Replays from the start of the stream |
| Implementing a custom source | `SourceProvider` contract | `source(offset)` + `extractOffset` close the loop |

## Rules

- The stored offset is **exclusive**: re-querying with it must not redeliver the already-processed event.
- The offset is read at (re)start via the `() => Future[Option[Offset]]` thunk and stored after
  processing via `extractOffset` — that round trip is what makes the projection restartable.
- The offset row is scoped to the `ProjectionId`; resetting it (to `NoOffset`) is the canonical
  view-rebuild operation.
- Offset type is dictated by the source journal, not chosen freely — match the journal's `Offset`.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Adding/subtracting 1 to the stored offset before re-querying | The offset is already exclusive; you skip or duplicate one event |
| Treating `eventsByTag` cross-id order as the offset order | Offsets resume per stream; cross-entity order is not stable |
| Constructing `TimeBasedUUID` from a random (v4) UUID | Throws — only version-1 UUIDs are valid positions |
| Storing the offset before the handler succeeds (at-least-once) | A crash then skips the unprocessed event — see delivery-semantics |

## See also

- [delivery-semantics.md](./delivery-semantics.md) — *when* the offset is stored relative to the handler decides at-least/exactly/at-most-once
- [projections.md](./projections.md) — the `SourceProvider` that produces these offsets
- [recovery.md](./recovery.md) — the write-side analogue: replay-from-position on restart
