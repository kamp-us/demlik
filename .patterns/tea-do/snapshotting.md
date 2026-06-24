# Snapshotting and retention

As an entity's event log grows, recovery has to fold more events on every start. A snapshot is a
cached copy of the folded state at a known sequence number: on recovery the actor loads the latest
snapshot and replays only the events *after* it, instead of the whole history. This concern is about
deciding *when* to snapshot, *how many* snapshots to keep, and *whether* to delete the now-redundant
older events. Snapshots are an optimization layered on top of the event log — the log remains the
source of truth, and a snapshot is just `fold(events up to N)` materialized. Configuration is done on
the `EventSourcedBehavior` via `withRetention` and `snapshotWhen`.

## Approaches

### Count-based retention: `RetentionCriteria.snapshotEvery`

**When to use:** The default, mechanical strategy. Take a snapshot every N events and keep the last
few, so recovery cost stays bounded regardless of how long the entity lives.

**Pattern:**

```scala
// Snapshot every 100 events; keep 2 snapshots. Recovery replays at most ~100 events.
EventSourcedBehavior[Command, Event, State](persistenceId, emptyState, commandHandler, eventHandler)
  .withRetention(RetentionCriteria.snapshotEvery(numberOfEvents = 100, keepNSnapshots = 2))
```

**Gotchas:**
- `snapshotEvery(numberOfEvents)` defaults `keepNSnapshots` to 1.
- If a single `Effect.persist` writes several events, the snapshot is taken *after* the whole batch,
  so it won't land exactly every N events.
- Snapshots that fall below `snapshot sequenceNr - keepNSnapshots * numberOfEvents` are deleted
  automatically. Deletion is triggered after a new snapshot is successfully saved.

### Predicate-based: `snapshotWhen`

**When to use:** Snapshot at a domain-meaningful moment (e.g. when a particular terminal event is
persisted) rather than on a fixed count.

**Pattern:**

```scala
// Decide to snapshot from (state, event, sequenceNr) after the event is persisted.
EventSourcedBehavior[Command, Event, State](persistenceId, emptyState, commandHandler, eventHandler)
  .snapshotWhen {
    case (state, BookingCompleted(_), sequenceNumber) => true
    case (state, event, sequenceNumber)               => false
  }
```

**Gotchas:**
- The predicate is `(State, Event, Long) => Boolean`, evaluated after the event is successfully
  persisted; for a multi-event persist it fires after all events are stored.
- Snapshots triggered by `snapshotWhen` do **not** trigger deletion of old snapshots or events — only
  count-based `RetentionCriteria.snapshotEvery` does. The two can be combined.

### Event deletion alongside snapshots

**When to use:** You explicitly want to reclaim journal space and accept losing event history below
the snapshot point. Off by default — event sourcing normally keeps the full log.

**Pattern:**

```scala
// Count-based retention that also deletes events under the kept-snapshot window.
EventSourcedBehavior[Command, Event, State](persistenceId, emptyState, commandHandler, eventHandler)
  .withRetention(
    RetentionCriteria.snapshotEvery(numberOfEvents = 100, keepNSnapshots = 2).withDeleteEventsOnSnapshot)

// Or, with the predicate API, opt in via the deleteEventsOnSnapshot flag:
  .snapshotWhen(predicate, deleteEventsOnSnapshot = true)
```

**Gotchas:**
- Events are deleted up to the sequence number covered by the snapshot, minus the kept window; old
  events are deleted before old snapshots. Deletion fires after a new snapshot is saved.
- Deleting events discards history — the main reason to use event sourcing. It must not be combined
  with downstream projections that still need those events; emit a terminal "deleted" event and let a
  background task clean up instead.

### Reacting to snapshot/deletion outcomes via signals

**When to use:** You want to observe or react to snapshot and deletion success/failure.

**Pattern:**

```scala
// Snapshot and deletion outcomes arrive as EventSourcedSignals in receiveSignal.
EventSourcedBehavior[Command, Event, State](persistenceId, emptyState, commandHandler, eventHandler)
  .withRetention(RetentionCriteria.snapshotEvery(numberOfEvents = 100, keepNSnapshots = 2))
  .receiveSignal {
    case (state, _: SnapshotFailed)        => // react to failure
    case (state, _: DeleteSnapshotsFailed) => // react to failure
    case (state, _: DeleteEventsFailed)    => // react to failure
  }
```

**Gotchas:**
- A snapshot failure surfaces as `SnapshotFailed` (success as `SnapshotCompleted`) but does **not**
  stop or restart the actor — failures are logged and operation continues.
- Deletion outcomes are `DeleteSnapshotsCompleted`/`DeleteSnapshotsFailed` and
  `DeleteEventsCompleted`/`DeleteEventsFailed`. Successes log at debug, failures at warning by default.
- A snapshot store must be configured; without one, saving a snapshot fails at the point of the first
  snapshot, not at startup.

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Keep recovery bounded, no domain trigger | `RetentionCriteria.snapshotEvery(n, keepN)` | Mechanical, bounds replayed events to ~n |
| Snapshot at a meaningful event | `snapshotWhen(predicate)` | Aligns snapshots with domain milestones |
| Reclaim journal space | `.withDeleteEventsOnSnapshot` | Deletes events under the kept-snapshot window |
| Predicate snapshot + delete events | `snapshotWhen(predicate, deleteEventsOnSnapshot = true)` | Predicate snapshots don't delete unless asked |
| Observe snapshot/deletion results | `receiveSignal` on the `*Completed`/`*Failed` signals | Snapshot failures don't crash the actor |
| No snapshots at all | Omit `withRetention`/`snapshotWhen` | Retention is disabled by default |

## Rules

- Retention is disabled by default: nothing is snapshotted or deleted unless `withRetention` or
  `snapshotWhen` is configured.
- A snapshot is a materialized fold result, never a substitute for events. The event log stays the
  source of truth.
- Only count-based `RetentionCriteria.snapshotEvery` triggers automatic deletion of old snapshots;
  `snapshotWhen` snapshots never trigger deletion on their own.
- Event deletion is opt-in (`withDeleteEventsOnSnapshot` / `deleteEventsOnSnapshot = true`) and
  irreversibly discards history below the snapshot point.
- The state must be snapshot-serializable, and snapshot serialization format changes must stay
  recoverable (or recovery can fall back to replaying all events).

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Treating a snapshot as the system of record and skipping events | A snapshot is just a cached `fold(events)`; without events you cannot evolve schema or rebuild projections |
| Deleting events while downstream projections still consume them | The projection misses deleted events and silently falls behind |
| Expecting `snapshotWhen` to also prune old snapshots/events | Only count-based retention deletes; predicate snapshots accumulate unless deletion is requested |
| Assuming a snapshot lands exactly every N events when persisting batches | A multi-event persist snapshots after the whole batch, so the count drifts past N |
| Relying on a snapshot store without configuring one | Startup succeeds, but the first snapshot save fails at runtime |

## See also

- [recovery.md](./recovery.md) — how a loaded snapshot bounds the replay that follows it
- [event-handler.md](./event-handler.md) — the fold whose result a snapshot caches
- [event-sourcing.md](./event-sourcing.md) — multi-event persists, which shift snapshot timing
