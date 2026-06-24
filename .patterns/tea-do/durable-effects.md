# Durable effects — the unconfirmed-delivery ledger

Durable *state* and durable *effects* are different problems. An event-sourced actor rebuilds its
state by replaying events, but an outbound side effect — a message to another actor — is fire-and-forget:
if the actor sends it and then crashes before the receiver confirms, the effect is lost, yet nothing in
the replayed state records that it is still owed. Akka's classic `AtLeastOnceDelivery` solves this by
keeping a **ledger of unconfirmed deliveries** as part of the actor's persisted state. Each `deliver`
adds an entry keyed by a monotonic `deliveryId`; each `confirmDelivery` removes it. On recovery the
ledger is rebuilt from the same events, and any entry still present is re-sent. The contract is
at-least-once: a confirmed-but-not-yet-persisted delivery will be re-sent after a crash, so **the
receiver must deduplicate**. (Conceptual gloss for a pure-reducer mapping: the ledger is just state
folded from a `Sent`/`Confirmed` event stream — `deliver` is the event that adds, `confirmDelivery`
the event that removes; the re-send is a side effect derived from the surviving ledger, not stored
separately.)

## Approaches

### Persist the intent, then deliver; persist the confirmation, then confirm

**When to use:** Always, for the classic `AtLeastOnceDelivery` trait. The ledger is never the source of
truth on its own — it is derived from events you persist. The trait holds the unconfirmed map and the
sequence number in memory but **does not persist them itself**; you persist a `Sent` event before
calling `deliver` and a `Confirmed` event before calling `confirmDelivery`, and both methods are
re-invoked from the event handler during replay so the ledger is reconstructed identically.

**Pattern:** (the canonical example — persist drives the ledger; the event handler `updateState` is
the only mutator, so it runs the same on a live command and on replay)

```scala
case class Msg(deliveryId: Long, s: String)
case class Confirm(deliveryId: Long)

sealed trait Evt
case class MsgSent(s: String) extends Evt
case class MsgConfirmed(deliveryId: Long) extends Evt

class MyPersistentActor(destination: ActorSelection) extends PersistentActor with AtLeastOnceDelivery {

  override def persistenceId: String = "persistence-id"

  override def receiveCommand: Receive = {
    case s: String           => persist(MsgSent(s))(updateState)
    case Confirm(deliveryId) => persist(MsgConfirmed(deliveryId))(updateState)
  }

  override def receiveRecover: Receive = {
    case evt: Evt => updateState(evt)
  }

  def updateState(evt: Evt): Unit = evt match {
    case MsgSent(s) =>
      deliver(destination)(deliveryId => Msg(deliveryId, s))

    case MsgConfirmed(deliveryId) => confirmDelivery(deliveryId)
  }
}

class MyDestination extends Actor {
  def receive = {
    case Msg(deliveryId, s) =>
      // ...
      sender() ! Confirm(deliveryId)
  }
}
```

**Gotchas:**
- `deliver` requires a `deliveryIdToMessage` function so the `deliveryId` is embedded in the outbound
  message. The id must do a full round trip: the destination echoes it back, and you pass it to
  `confirmDelivery`. There is no way to use a custom `deliveryId`; if you need a business correlation
  id, carry it alongside and keep a `Map(correlationId -> deliveryId)`.
- During recovery `deliver` does **not** send — it only adds to the ledger. Sends happen after replay
  completes (see re-emit below). If you swap the persist-then-deliver order, a crash between the side
  effect and the persisted intent leaves an effect with no ledger entry to ever confirm or re-send.

### Re-emit unconfirmed entries when replay completes

**When to use:** This is the load-bearing behavior for any actor that hibernates or restarts. You do
not write it — it is built into the trait — but you must understand it: after the journal replay
finishes, every entry still in the ledger is re-sent. This is exactly the moment a passivated actor
"wakes up still owing" its outstanding effects.

**Pattern:** (Akka's own `onReplaySuccess` hook — fires once when recovery ends; if anything is still
unconfirmed it redelivers immediately and starts the periodic redelivery timer)

```scala
override private[akka] def onReplaySuccess(): Unit = {
  if (unconfirmed.nonEmpty) {
    redeliverOverdue()
    startRedeliverTask()
  }
  super.onReplaySuccess()
}
```

```scala
// internalDeliver: during recovery, add to the ledger but do NOT send
val deliveryId = nextDeliverySequenceNr()
val now = if (recoveryRunning) {
  System.nanoTime() - redeliverInterval.toNanos      // mark already-overdue so it fires on first tick
} else System.nanoTime()
val d = Delivery(destination, deliveryIdToMessage(deliveryId), now, attempt = 0)

if (recoveryRunning)
  unconfirmed = unconfirmed.updated(deliveryId, d)    // ledger only
else
  send(deliveryId, d, now)                            // live: send immediately
```

**Gotchas:**
- During recovery each entry's timestamp is set to `now - redeliverInterval`, i.e. already overdue, so
  the first redelivery tick after recovery re-sends it without waiting a full interval. The re-emit on
  recovery is the *whole point* — replay reconstructs the ledger, recovery-end flushes it.
- Re-sent messages may arrive out of original order and may duplicate effects the previous incarnation
  already performed (the confirmation may have been sent but not yet persisted before the crash). At-
  least-once never preserves order and never suppresses duplicates on its own.

### Confirm idempotently with a monotonic id; dedup at the receiver

**When to use:** Every delivery. `confirmDelivery` is the ledger's only removal path, and the
`deliveryId` is the dedup key on both ends.

**Pattern:** (`confirmDelivery` removes the entry and reports whether this id was new — the boolean is
itself a dedup signal; a duplicate confirm returns `false`)

```scala
/**
 * @return `true` the first time the `deliveryId` is confirmed, i.e. `false` for duplicate confirm
 */
def confirmDelivery(deliveryId: Long): Boolean = {
  if (unconfirmed.contains(deliveryId)) {
    unconfirmed -= deliveryId
    if (unconfirmed.isEmpty)
      cancelRedeliveryTask()       // nothing left to redeliver → stop the timer
    true
  } else false
}

private def nextDeliverySequenceNr(): Long = {
  deliverySequenceNr += 1          // strictly monotonic, no gaps, shared across all destinations
  deliverySequenceNr
}
```

**Gotchas:**
- The `deliveryId` is a strictly monotonically increasing sequence number **without gaps**, shared
  across all destinations of the actor — so a single destination sees gaps if the actor delivers to
  several. Do not assume per-destination contiguity.
- At-least-once means the receiver *will* see duplicates. The id is the dedup handle: the receiver must
  track processed ids (or make processing idempotent) because the framework guarantees delivery, not
  uniqueness. The returned boolean lets the sender notice a duplicate confirm, but it does not protect
  the receiver — that is the receiver's job.

## Decision guide

| Situation | Do this |
|---|---|
| Outbound effect must survive a crash/passivation | Persist a `Sent` event, then `deliver`; re-invoke `deliver` from the event handler on replay |
| Receiver confirmed an effect | Persist a `Confirmed` event, then `confirmDelivery(deliveryId)` |
| Need to stop re-sending a stuck effect | Call `confirmDelivery(deliveryId)` to abort it (it removes the ledger entry) |
| Receiver may process the same message twice | Dedup at the receiver by `deliveryId`; never rely on the sender for uniqueness |
| Need a business correlation id, not the framework id | Carry it in the message; keep a `Map(correlationId -> deliveryId)` to translate back |

## Rules

- Persist the intent **before** `deliver`, and the confirmation **before** `confirmDelivery`. The
  trait stores nothing durably on its own — the ledger is reconstructed only by re-running these calls
  from the event handler during replay.
- Route `deliver` and `confirmDelivery` exclusively through the event handler (the function the
  `persist` callback invokes), so the exact same code rebuilds the ledger on replay.
- Treat the `deliveryId` as the single correlation key: embed it in the outbound message, require it
  back in the confirmation, pass it to `confirmDelivery`.
- Make the receiver deduplicate by `deliveryId` (or be idempotent). At-least-once guarantees delivery,
  not uniqueness, and re-emit on recovery will resend already-processed effects.
- Let recovery-end drive re-emit: reconstruct the ledger during replay, and the surviving entries are
  re-sent when replay completes — do not send during replay.

## Anti-patterns

| Anti-pattern | Why it's wrong | Instead |
|---|---|---|
| Calling `deliver` before persisting the intent | A crash before the persist leaves an effect with no ledger entry — never re-sent, never confirmable | Persist the `Sent` event first, deliver in its callback |
| Treating the in-memory unconfirmed map as the source of truth | The trait does not persist it; only the events do — the map is rebuilt by replay | Persist `Sent`/`Confirmed` events; rebuild the map from the event handler |
| Sending the outbound message during replay | Replay would re-fire every historical effect | Add to the ledger during recovery; let recovery-end re-emit the survivors |
| Assuming the receiver gets each message exactly once | At-least-once resends on redelivery and on recovery | Dedup at the receiver by `deliveryId` |
| Inventing a custom `deliveryId` | The framework owns the monotonic sequence; correlation needs the round-tripped id | Carry a business id separately and map it to the framework `deliveryId` |

## See also

- [recovery.md](./recovery.md) — recovery-by-replay is exactly when the surviving ledger is re-emitted; the re-send fires at replay completion.
- [event-sourcing.md](./event-sourcing.md) — the `Sent`/`Confirmed` events that drive the ledger are ordinary persisted events; this doc is the side-effect counterpart of that write model.
- [reliable-delivery.md](./reliable-delivery.md) — the modern typed successor, where the ledger becomes a `DurableProducerQueue` and dedup moves to a flow-controlled consumer.
- [snapshotting.md](./snapshotting.md) — the delivery ledger can be snapshotted whole (`getDeliverySnapshot`/`setDeliverySnapshot`) to bound replay; see the bounding approach in reliable-delivery.md.
