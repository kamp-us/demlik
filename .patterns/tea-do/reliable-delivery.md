# Reliable delivery — durable producer queue, dedup, and bounding

The typed reliable-delivery API is the modern successor to classic `AtLeastOnceDelivery`. It splits the
two halves of the problem cleanly: a `ProducerController` drives flow-controlled sends and a
`ConsumerController` confirms processing, and the durable ledger of unconfirmed messages is factored
into a separate `DurableProducerQueue` protocol so the in-memory controller and the durable store are
distinct concerns. As long as nothing crashes, delivery is effectively-once with no business-level
dedup; once the producer can crash, you opt into a `DurableProducerQueue` and the guarantee degrades to
at-least-once, because a message may have been processed and confirmed but the confirmation not yet
stored. This doc covers the durable queue's ledger shape, the seqNr-based confirmation/dedup, and the
knobs that bound the unconfirmed set. (Conceptual gloss for a pure-reducer mapping: `DurableProducerQueue.State`
*is* a reducer state — `addMessageSent` and `confirmed` are pure transitions over a `MessageSent`/
`Confirmed` event stream, and the controller re-reads that state via `LoadState` on startup, exactly
the recovery re-emit step.)

## Approaches

### Durable producer queue: persist the ledger as event-sourced state

**When to use:** When unconfirmed messages must survive a producer-side crash. Without it, in-flight
messages live only in the controller's memory and are lost on a JVM crash. The provided implementation
(`EventSourcedProducerQueue` in `akka-persistence-typed`) stores one event before sending and one event
on confirmation, and replays them to reconstruct the unconfirmed set.

**Pattern:** (the durable queue's state and its two pure transitions — `addMessageSent` appends a sent
entry and bumps the sequence; `confirmed` prunes everything at or below the confirmed seqNr for that
qualifier)

```scala
final case class State[A](
    currentSeqNr: SeqNr,
    highestConfirmedSeqNr: SeqNr,
    confirmedSeqNr: Map[ConfirmationQualifier, (SeqNr, TimestampMillis)],
    unconfirmed: immutable.IndexedSeq[MessageSent[A]])
    extends DeliverySerializable {

  def addMessageSent(sent: MessageSent[A]): State[A] = {
    copy(currentSeqNr = sent.seqNr + 1, unconfirmed = unconfirmed :+ sent)
  }

  def confirmed(
      seqNr: SeqNr,
      confirmationQualifier: ConfirmationQualifier,
      timestampMillis: TimestampMillis): State[A] = {
    val newUnconfirmed = unconfirmed.filterNot { u =>
      u.confirmationQualifier == confirmationQualifier && u.seqNr <= seqNr
    }
    // ...
  }
}
```

```scala
/**
 * [[DurableProducerQueue]] ... implemented with Event Sourcing and stores one
 * event before sending the message to the destination and one event for the confirmation
 * that the message has been delivered and processed.
 *
 * The [[DurableProducerQueue.LoadState]] request is used at startup to retrieve the unconfirmed messages.
 */
```

**Gotchas:**
- A `DurableProducerQueue` "will add a substantial performance overhead" — it is a per-message persist.
  Enable it only where crash-survival of effects is required.
- `EventSourcedProducerQueue` requires a unique `PersistenceId`; the same id must not be used by two
  producers at once. To re-deliver unconfirmed messages after a crash, the producer must be started
  again **with the same `PersistenceId`** — that is what reconnects the new incarnation to its ledger.
- `confirmed` prunes by `seqNr <= seqNr` for a qualifier, i.e. confirmation is cumulative per
  qualifier, not per-individual-message.

### Store-then-send, store-then-confirm — the idempotent ledger protocol

**When to use:** Any custom `DurableProducerQueue` implementation. The store commands are explicitly
designed to be retried, so the store must deduplicate already-processed sequence numbers itself.

**Pattern:** (the two durable commands; both carry the contract in their own doc comment)

```scala
/**
 * Store the fact that a message is to be sent. Replies with [[StoreMessageSentAck]] when
 * the message has been successfully been stored.
 *
 * This command may be retied and the implementation should be idempotent, i.e. deduplicate
 * already processed sequence numbers.
 */
final case class StoreMessageSent[A](sent: MessageSent[A], replyTo: ActorRef[StoreMessageSentAck])
    extends Command[A]

final case class StoreMessageSentAck(storedSeqNr: SeqNr)

/**
 * Store the fact that a message has been confirmed to be delivered and processed.
 *
 * This command may be retied and the implementation should be idempotent, i.e. deduplicate
 * already processed sequence numbers.
 */
final case class StoreMessageConfirmed[A](
    seqNr: SeqNr,
    confirmationQualifier: ConfirmationQualifier,
    timestampMillis: TimestampMillis)
    extends Command[A]
```

**Gotchas:**
- The `seqNr` is the dedup key in the store, mirroring the classic `deliveryId`. A retried
  `StoreMessageSent` for an already-stored seqNr must be a no-op, not a second append.
- `MessageSent` defines `equals`/`hashCode` on its fields (with `hashCode` on `seqNr`), so identical
  re-stores are detectable — but the store still owns the dedup decision.

### Confirm at the consumer; the controller dedups by seqNr

**When to use:** The consumer side of every reliable-delivery flow. The consumer receives each message
wrapped, processes it, and replies confirmed; the next message is not delivered until the previous is
confirmed, and the controllers enforce the ordering and dedup.

**Pattern (prose from the point-to-point semantics):** Messages sent by the producer are wrapped in
`ConsumerController.Delivery` when received by the consumer, and the consumer replies with
`ConsumerController.Confirmed` when it has processed the message. The next message is not delivered
until the previous one is confirmed; messages that arrive while waiting are stashed by the
`ConsumerController` and delivered when the previous one is confirmed. Many unconfirmed messages can be
in flight, but their number is bounded by a flow-control window driven by the consumer side.

**Gotchas:**
- With no durable queue and no crash, this is effectively-once — no business dedup needed. The moment
  you add the durable queue (to survive producer crash) the guarantee is at-least-once: after a
  restart, stored-but-not-confirmed messages are redelivered, possibly to a different worker, and some
  may already have been processed. At that boundary the consumer must tolerate duplicates.
- Producer, `ProducerController`, consumer, and `ConsumerController` must be local to each other —
  enforced by a runtime check. The durable, lossy hop is the producer's journal, not these links.

### Bound and snapshot the unconfirmed set

**When to use:** Whenever the destination can be unavailable long enough for the ledger to grow. The
classic trait exposes the bounding knobs directly; the typed queue bounds replay cost via snapshots.

**Pattern (classic `AtLeastOnceDelivery` knobs):** (overflow protection, a warning escalation, and a
whole-ledger snapshot)

```scala
// Hard cap: deliver refuses once the in-memory ledger is full.
def deliver(...): Unit = {
  if (unconfirmed.size >= maxUnconfirmedMessages)
    throw new MaxUnconfirmedMessagesExceededException(
      s"Too many unconfirmed messages, maximum allowed is [$maxUnconfirmedMessages]")
  // ...
}

// Escalation: after warnAfterNumberOfUnconfirmedAttempts redeliveries, warn self.
//   if (delivery.attempt == warnAfterNumberOfUnconfirmedAttempts)
//     warnings :+= UnconfirmedDelivery(deliveryId, delivery.destination, delivery.message)
//   self ! UnconfirmedWarning(warnings)   // re-sending continues; you may confirmDelivery to cancel
```

```scala
// Snapshot the entire delivery ledger so replay can start from it instead of from event zero.
def getDeliverySnapshot: AtLeastOnceDeliverySnapshot =
  AtLeastOnceDeliverySnapshot(
    deliverySequenceNr,
    unconfirmed.iterator
      .map { case (deliveryId, d) => UnconfirmedDelivery(deliveryId, d.destination, d.message) }
      .to(immutable.IndexedSeq))

def setDeliverySnapshot(snapshot: AtLeastOnceDeliverySnapshot): Unit = {
  deliverySequenceNr = snapshot.currentDeliveryId
  val now = System.nanoTime() - redeliverInterval.toNanos   // restored entries are immediately due
  unconfirmed = scala.collection.immutable.SortedMap.from(
    snapshot.unconfirmedDeliveries.iterator.map(d =>
      d.deliveryId -> Delivery(d.destination, d.message, now, 0)))
}
```

**Gotchas:**
- `maxUnconfirmedMessages` makes `deliver` throw `MaxUnconfirmedMessagesExceededException` rather than
  silently dropping — overflow is surfaced, not swallowed.
- `redeliverInterval` drives the redelivery cadence; `redeliveryBurstLimit` caps how many overdue
  entries are re-sent per burst (burst frequency is half the redelivery interval) so a long-unavailable
  destination does not produce one giant resend storm.
- `UnconfirmedWarning` does **not** stop redelivery; it is a signal to `self`. Re-sending continues
  until you `confirmDelivery` (which can be used to abort a hopeless delivery).
- The `AtLeastOnceDeliverySnapshot` holds the *full* delivery state including unconfirmed messages; if
  a custom snapshot is kept for the rest of the actor state, it must embed this snapshot inside it.

## Decision guide

| Situation | Do this |
|---|---|
| Producer crash must not lose in-flight effects | Wire a `DurableProducerQueue` (`EventSourcedProducerQueue`) onto the `ProducerController` |
| Re-deliver after a producer restart | Restart the producer with the **same `PersistenceId`**; `LoadState` reconstructs the unconfirmed set |
| Custom durable store | Make `StoreMessageSent`/`StoreMessageConfirmed` idempotent — dedup by `seqNr` |
| Consumer might see a message twice | Only possible once a durable queue is enabled (at-least-once); dedup at the consumer |
| Ledger can grow during an outage | Set `maxUnconfirmedMessages` (overflow throws) and `redeliveryBurstLimit` (bounds resend bursts) |
| Long redelivery history slows restart | Snapshot the delivery state whole and restore it on recovery |

## Rules

- Make the durable store idempotent by `seqNr`: the store commands are explicitly retriable, so a
  re-stored sequence number must be a no-op.
- Re-deliver by reconnecting an incarnation to its ledger: restart the producer with the same
  `PersistenceId` and reload the unconfirmed set at startup; do not try to re-send from memory.
- Bound the unconfirmed set: cap it with `maxUnconfirmedMessages` (which throws on overflow) and limit
  resend bursts with `redeliveryBurstLimit`.
- Treat the enabling of a durable queue as the point the guarantee becomes at-least-once — add consumer
  dedup at that boundary, not before.
- Snapshot the whole delivery state when you snapshot, and embed it inside any custom snapshot.

## Anti-patterns

| Anti-pattern | Why it's wrong | Instead |
|---|---|---|
| Restarting a crashed producer with a fresh `PersistenceId` | The new incarnation cannot find its unconfirmed ledger — effects are orphaned | Restart with the same `PersistenceId` so `LoadState` reloads the ledger |
| A non-idempotent `DurableProducerQueue` | The store commands are retried; a non-idempotent store double-appends | Deduplicate by `seqNr` in the store implementation |
| Letting the unconfirmed set grow unbounded | Memory blows up while the destination is down | Set `maxUnconfirmedMessages` and `redeliveryBurstLimit` |
| Assuming exactly-once after enabling the durable queue | The durable queue makes it at-least-once, not exactly-once | Dedup at the consumer once the durable queue is on |
| Ignoring `UnconfirmedWarning` as if it stopped redelivery | It is only a signal; re-sending continues | Act on the warning — confirm to abort, or fix the destination |

## See also

- [durable-effects.md](./durable-effects.md) — the classic `AtLeastOnceDelivery` trait this API succeeds; the in-line unconfirmed map there becomes the externalized `DurableProducerQueue` here.
- [recovery.md](./recovery.md) — `LoadState` at producer startup is the recovery re-emit step for the durable queue.
- [event-sourcing.md](./event-sourcing.md) — `EventSourcedProducerQueue` is itself an `EventSourcedBehavior`; its `MessageSent`/`Confirmed` events are an instance of the write model.
- [snapshotting.md](./snapshotting.md) — `getDeliverySnapshot`/`setDeliverySnapshot` snapshot the ledger to bound replay cost.
