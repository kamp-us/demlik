# Akka Persistence Typed — event-sourcing patterns

Per-concern reference for the event-sourcing surface of **Akka Persistence Typed**, the JVM/Scala
reference implementation of event-sourced actors. Each doc captures one decision surface so an
implementer can reproduce the pattern — command-to-`Effect` write model, the pure event-handler fold,
snapshotting/retention, and recovery-by-replay.

Scope: these docs exist as prior art for the upcoming event-sourcing mode of `@demlik/tea/do`
(issue #68, ADR 0003) — that product is named here only as the motivation for extracting this canon.
The docs themselves teach **Akka's** pattern; the mapping to a pure reducer (`state = fold(events)`)
is noted inline as a conceptual gloss, not as product code. Covered: the `EventSourcedBehavior`
`Effect` API, the command/event handlers, `RetentionCriteria`/`snapshotWhen`, `Recovery`, and the
`EventSourcedSignal`s. Excluded: replicated event sourcing, persistence FSM migration, cluster
sharding, serialization internals, and durable-state behaviors. The subject will grow — future
sibling docs cover reentrancy.

The projection docs below are prior art for the first-class CQRS projections of `@demlik/tea/do`
(issue #69, ADR 0003 primitive #3), extracted from **Akka Projections** + **Akka Persistence Query**
(the read side). They teach Akka's projection model; the mapping to a pure `Model → View` fold is an
inline gloss, never product code.

## Index

| Doc | Concern | Read when |
|---|---|---|
| [event-sourcing.md](./event-sourcing.md) | Command handler: command → `Effect` → events | Deciding what to persist, replying, stashing, or stopping |
| [event-handler.md](./event-handler.md) | The fold: `(State, Event) => State` | Writing how state advances from an event |
| [snapshotting.md](./snapshotting.md) | `RetentionCriteria` / `snapshotWhen`, deletion | Bounding recovery cost or reclaiming log space |
| [recovery.md](./recovery.md) | Replay on start, `RecoveryCompleted`, `Recovery` strategies | Reasoning about restart, replay, and post-recovery effects |
| [durable-effects.md](./durable-effects.md) | The unconfirmed-delivery ledger: `deliver`/`confirmDelivery`, monotonic `deliveryId`, re-emit on recovery | An outbound effect must survive a crash/passivation and the receiver must dedup |
| [reliable-delivery.md](./reliable-delivery.md) | Typed successor: `DurableProducerQueue`, seqNr dedup, producer/consumer confirmation, bounding | Externalizing the ledger, flow-controlled delivery, capping the unconfirmed set |
| [projections.md](./projections.md) | The CQRS read side: `SourceProvider` (by tag/slice) → `Handler` → a named view; `ProjectionId` | Building a view from the write model's events; one write model, many projections |
| [offset-tracking.md](./offset-tracking.md) | `Offset` (`Sequence`/`TimeBasedUUID`/`NoOffset`), exclusive resume, `SourceProvider` thunk | Making a projection durable/restartable; resuming from the last processed position |
| [delivery-semantics.md](./delivery-semantics.md) | `atLeastOnce`/`exactlyOnce`/`atMostOnce`, `groupedWithin`, idempotency | Choosing when the offset is stored vs the view write; whether the handler must be idempotent |

## Shared conventions

- Examples are Scala, using Akka's `akka.persistence.typed.scaladsl` API (`EventSourcedBehavior`,
  `Effect`, `RetentionCriteria`, `Recovery`) and `akka.persistence.typed` signals.
- The command handler decides (returns an `Effect`); the event handler applies (folds). State advances
  only through persisted events.
- The event handler is a pure, total reducer — it runs identically on persist and on replay.
- Side effects belong in `thenRun`/`thenReply` (post-persist) or `RecoveryCompleted` (post-replay),
  never in the fold.
