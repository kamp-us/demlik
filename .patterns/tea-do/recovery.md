# Recovery — rebuilding state by replay

An event-sourced actor holds no durable state of its own; on every start and restart it rebuilds
state by replaying its journaled events through the event handler. This is the read side of the same
fold the write model uses: `state = fold(emptyState, events)`. This concern covers what happens during
that replay — that the event handler runs but side effects do not, how snapshots bound the replay,
how to observe completion via `RecoveryCompleted`, what fails recovery, and the rare strategies for
narrowing or disabling recovery. Recovery is configured on the `EventSourcedBehavior` via
`receiveSignal` and `withRecovery`.

## Approaches

### Default recovery (snapshot + events) and `RecoveryCompleted`

**When to use:** Almost always. The actor loads the latest snapshot (if any) and replays the events
after it. Hook `RecoveryCompleted` to run end-of-recovery side effects safely.

**Pattern:**

```scala
// The event handler folds every replayed event; then RecoveryCompleted fires once with current state.
EventSourcedBehavior[Command, Event, State](persistenceId, emptyState, commandHandler, eventHandler)
  .receiveSignal {
    case (state, RecoveryCompleted) =>
      // Safe place for side effects that thenRun skipped during replay.
  }
```

**Gotchas:**
- `RecoveryCompleted` always fires — even for a brand-new `persistenceId` with no events and an empty
  snapshot store — and carries the current `State`.
- Commands sent during recovery are stashed and delivered only after recovery completes; replayed
  events never interleave with new commands.
- The number of concurrent recoveries across the system is bounded
  (`akka.persistence.max-concurrent-recoveries`) so replay doesn't overload the data store.

### The TEA mapping — `init` purity + `bootResume` (`@demlik/tea/do`)

**When to use:** Every DO-hosted `@demlik/tea/do` machine. This is the concrete
`@demlik/tea` shape of the two rules above: keep boot effects out of the replay
fold, and run the one post-recovery resume effect through a single hook.

- **`init` is the pure rehydrate boundary.** On cold wake the runtime calls
  `init(loaded)`; when `loaded !== null` it MUST return `[loaded, []]` — zero
  Cmds (Invariant 2, enforced by `replay` in `packages/tea/src/index.ts`, which
  throws on a non-empty Cmd list). That is the `@demlik/tea` analogue of "the
  event handler runs on replay but side effects must not": no effect re-fires
  from boot.
- **`bootResume` is the `RecoveryCompleted` analogue.** The state-conditional
  resume — "after `runtime.ready`, if the rehydrated State is mid-loop, dispatch
  the single resume Msg that re-derives the next step" — lives in `bootResume`
  (`packages/tea/src/do/host.ts`, exported from `@demlik/tea/do`). It derives one
  resume Msg from the loaded State via a caller-supplied `ResumePort` (an
  `isResumable` predicate + a TYPED resume-Msg constructor) and dispatches it
  exactly once; on a fresh DO it is a no-op. The agent host's `autoBoot` is the
  agent specialization of it (predicate `agentIsResumable`, port `agentBootMsg`,
  issue #60); a non-agent grain supplies its own port. Use `bootResume` rather
  than re-hand-rolling the "after ready, if resumable, dispatch the resume Msg"
  boilerplate — the two easy mistakes (emit a Cmd from `init`; forget the resume
  dispatch) each silently break resume with no failure at boot.

### Suppressing side effects during replay

**When to use:** This is automatic, not a choice — but it dictates *where* you put side effects. The
event handler runs on replay, so any effect inside it re-fires for every recovery. Side effects must
live elsewhere.

**Pattern:**

```scala
// Event handler stays pure — runs on persist AND replay.
val eventHandler: (State, Event) => State = (state, event) => state.applyEvent(event)

// Post-persist side effects: thenRun (not replayed).
Effect.persist(Deposited(amt)).thenReply(replyTo)(_ => StatusReply.Ack)

// Post-recovery side effects: RecoveryCompleted (runs once, after replay).
.receiveSignal { case (state, RecoveryCompleted) => reconcileUnacknowledged(state) }
```

**Gotchas:**
- `thenRun`/`thenReply` callbacks are *not* run during recovery; they only run after a live persist.
- Effects done at `RecoveryCompleted` may run more than once across the actor's lifetime (once per
  recovery), so make them idempotent or check what's already acknowledged.

### Snapshot-bounded replay

**When to use:** Long-lived entities where replaying the full log is slow. A snapshot lets recovery
start from a cached fold result and replay only the events after it.

**Pattern:**

```scala
// Default selection uses the latest snapshot. Override selection if needed:
import akka.persistence.typed.SnapshotSelectionCriteria

EventSourcedBehavior[Command, Event, State](persistenceId, emptyState, commandHandler, eventHandler)
  .withRecovery(Recovery.withSnapshotSelectionCriteria(SnapshotSelectionCriteria.none))
// SnapshotSelectionCriteria.none => skip snapshots, replay all events (e.g. snapshot format changed).
```

**Gotchas:**
- By default the latest snapshot is selected and the remaining events are replayed on top of it.
- `SnapshotSelectionCriteria.none` forces a full replay; safe when events are intact, dangerous if
  events below the snapshot were deleted (the state would be wrong).
- The highest sequence number is always recovered regardless of selection, so new events keep
  appending without corrupting the log.

### Recovery failure handling

**When to use:** You must understand the failure modes, not opt into them. A bad journal read fails
recovery; a corrupt snapshot can optionally be tolerated.

**Pattern:**

```scala
// Observe recovery failure; by default the actor is stopped (or restarted with backoff).
.receiveSignal { case (state, RecoveryFailed(cause)) => /* logged by default */ }
```

**Gotchas:**
- `RecoveryFailed` is emitted and the actor is stopped (or restarted if an `onPersistFailure` backoff
  strategy is configured). A failed snapshot *load* is treated the same way by default.
- Snapshot loading can be made optional via snapshot-store config so that a deserialization failure
  falls back to replaying all events — but never enable that if events have been deleted, because the
  recovered state would then be wrong.
- A replay filter (`repair-by-discard-old` / `fail` / `warn` / `off`) guards against corrupt streams
  where multiple writers used the same sequence number — a reason single-writer ownership matters.

### Narrowed or disabled recovery

**When to use:** Rare optimizations. Replay only the last event, or disable recovery entirely. Both
are explicitly non-standard.

**Pattern:**

```scala
// Replay only the last event (no snapshot loaded).
.withRecovery(Recovery.replayOnlyLast)

// Recover neither snapshots nor events.
.withRecovery(Recovery.disabled)
```

**Gotchas:**
- `Recovery.replayOnlyLast` skips snapshots and folds only the last event — only meaningful when the
  last event fully determines the state.
- `Recovery.disabled` is flagged as not-normal behavior: events and snapshots are not used to rebuild
  state. The highest sequence number is still recovered so new events don't corrupt the log.

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Normal startup | Default recovery + `RecoveryCompleted` | Latest snapshot then replay events; signal marks end of replay |
| Run effects after replay | `RecoveryCompleted` signal handler | `thenRun` is suppressed during recovery |
| Long log, slow replay | Configure snapshots, default selection | Replay only events after the latest snapshot |
| Snapshot format changed | `SnapshotSelectionCriteria.none` | Skip snapshots, replay all events — only if events intact |
| Tolerate corrupt snapshot | `snapshot-is-optional = true` (store config) | Falls back to full replay — only if no events deleted |
| Last event determines state | `Recovery.replayOnlyLast` | Avoids replaying the whole log |
| Bypass replay entirely | `Recovery.disabled` | Non-standard; state not rebuilt from journal |

## Rules

- State is always rebuilt by folding events with the same event handler used on persist; recovery is
  `fold(emptyState, events)` and nothing more.
- Side effects must never run during replay: keep them out of the event handler and put end-of-recovery
  effects in the `RecoveryCompleted` signal handler.
- `RecoveryCompleted` always fires once, even for a new or empty `persistenceId`, and carries current
  state.
- A snapshot only bounds *how many* events replay; the fold and its result are unchanged.
- Effects performed at `RecoveryCompleted` may run more than once over the actor's lifetime, so make
  them idempotent.
- Disabling recovery, replaying only the last event, and `SnapshotSelectionCriteria.none` are
  exceptional; the highest sequence number is always recovered so the log stays append-safe.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Performing side effects in the event handler | They re-fire on every recovery, once per replayed event |
| Putting one-time startup effects in `thenRun` | `thenRun` is skipped during recovery; use `RecoveryCompleted` |
| Assuming `RecoveryCompleted` effects run exactly once forever | They run once per recovery; non-idempotent effects double up across restarts |
| Using `SnapshotSelectionCriteria.none` after deleting events | Replay can't reconstruct the deleted prefix, yielding wrong state |
| Running two active instances for one `persistenceId` | Interleaved writes share sequence numbers; replay can no longer be interpreted correctly |
| Relying on `Recovery.disabled` as normal operation | State is never rebuilt from the journal — it defeats event sourcing |

## See also

- [event-handler.md](./event-handler.md) — the pure fold that runs identically on persist and replay
- [snapshotting.md](./snapshotting.md) — how snapshots are created to bound this replay
- [event-sourcing.md](./event-sourcing.md) — where post-persist side effects belong instead of the fold
- `bootResume` (`packages/tea/src/do/host.ts`) — the `@demlik/tea/do` post-recovery resume hook: `init` stays pure, `bootResume` dispatches the one cold-wake resume Msg (issue #231)
