# Event handler — the fold

The event handler is the other half of an `EventSourcedBehavior`: a function
`(State, Event) => State` that computes the next state from the current state and one persisted
event. It is the *fold* of event sourcing — the single place where state advances. Akka calls it in
two situations with identical semantics: once after each event is successfully persisted (to update
the live state), and once per stored event when the actor starts up to rebuild state from the journal.
Because the same function runs on replay, it must be a pure, total reducer: `state = fold(events)`.
The command handler ([event-sourcing.md](./event-sourcing.md)) decides; the event handler applies.

## Approaches

### Single handler with state-and-event matching

**When to use:** Small to moderate entities. Pattern-match on the state first, then the event,
returning the next immutable state.

**Pattern:**

```scala
// fold(state, event) -> state. Called on persist AND on replay, with the same result.
val eventHandler: (State, Event) => State = { (state, event) =>
  event match {
    case Added(data) => state.copy(history = (data :: state.history).take(5))
    case Cleared     => State(Nil)
  }
}
```

**Gotchas:**
- Return a *new* state for immutable state classes; never reach outside the function.
- The handler is called once per event in a multi-event `persist`, in persist order — the fold is
  left-to-right over the event list.

### Event handler delegated into the state classes

**When to use:** Entities with a real lifecycle (e.g. empty -> opened -> closed). Put `applyEvent`
on each state class so the next-state logic lives with the domain object, and let the top-level
handler delegate.

**Pattern:**

```scala
// State is the domain object; each variant knows how to fold an event into the next state.
sealed trait Account {
  def applyEvent(event: Event): Account
}
case object EmptyAccount extends Account {
  def applyEvent(event: Event): Account = event match {
    case AccountCreated => OpenedAccount(Zero)
    case _ => throw new IllegalStateException(s"unexpected event [$event] in state [EmptyAccount]")
  }
}
case class OpenedAccount(balance: BigDecimal) extends Account {
  require(balance >= Zero, "Account balance can't be negative")
  def applyEvent(event: Event): Account = event match {
    case Deposited(amount) => copy(balance = balance + amount)
    case Withdrawn(amount) => copy(balance = balance - amount)
    case AccountClosed     => ClosedAccount
    case AccountCreated    => throw new IllegalStateException(s"unexpected event in state [OpenedAccount]")
  }
}

// The top-level event handler is one line: it just folds.
private val eventHandler: (Account, Event) => Account = { (state, event) =>
  state.applyEvent(event)
}
```

**Gotchas:**
- An invariant baked into the state (`require(balance >= Zero)`) also runs during replay, so a bad
  event in the journal will fail recovery loudly — which is the intended signal, not a bug to hide.
- Throwing on an `(state, event)` pair the state cannot produce documents that the command handler is
  responsible for never emitting that event in that state.

### Optional initial state

**When to use:** You don't want a dedicated "empty" state class and prefer to model "no state yet".

**Pattern:**

```scala
// emptyState is None; the handler folds the first event into Some(...) and onward.
val eventHandler: (Option[State], Event) => Option[State] = { (state, event) =>
  (state, event) match {
    case (None, Created(v))        => Some(State(v))
    case (Some(s), Updated(v))     => Some(s.update(v))
    case (s, _)                    => s
  }
}
```

**Gotchas:**
- The state parameter is `None` for the very first command and event until the first event creates
  the non-empty state; the command handler must guard for that.

## Decision guide

| Situation | Approach | Why |
|---|---|---|
| Small entity, flat state | Single handler matching state then event | One readable function, no ceremony |
| Real lifecycle with per-state rules | `applyEvent` on each state class | Fold logic lives with the domain object it concerns |
| No natural empty state | `Option[State]` with `None` empty state | Avoids a placeholder state class |
| Mutable state needed | Same handler, mutate-and-return the instance | Supported, but use the mutable-state factory |

## Rules

- The event handler is `(State, Event) => State` and must be **pure and total**: no side effects, no
  I/O, no clock, no randomness — only `(state, event)` in, next state out.
- It must produce the same result every time for the same inputs, because it runs identically on
  persist and on replay. `state = fold(events)` must hold for any prefix of the log.
- Side effects belong in the command handler's `thenRun`/`thenReply` or in the `RecoveryCompleted`
  signal handler — never here (see [recovery.md](./recovery.md)).
- For immutable state, return a new instance; for mutable state, use the mutable-state factory so the
  instance is recreated on a failure restart.
- The state must be fully reconstructable from `emptyState` plus the folded event sequence — nothing
  may live only in the command handler or in a returned behavior.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Sending a message or calling a service inside the event handler | It re-fires on every replay, duplicating the effect for each recovery |
| Reading `System.currentTimeMillis`, a random source, or external state in the fold | Replay produces a different state than the original run — the fold is no longer deterministic |
| Doing command validation in the event handler | Events are facts that already happened; rejecting one here makes recovery fail instead of preventing the bad write |
| Updating state in the command handler and returning the same state from the event handler | The two sources of truth diverge; only the event handler's result survives a restart |
| Silently ignoring an unexpected `(state, event)` pair | Hides a real journal/handler bug; throwing surfaces it as the intended error signal |

## See also

- [event-sourcing.md](./event-sourcing.md) — the command handler that decides which events to persist
- [recovery.md](./recovery.md) — why this same function runs on replay and where post-recovery effects go
- [snapshotting.md](./snapshotting.md) — a snapshot is a cached fold result that bounds how many events replay
