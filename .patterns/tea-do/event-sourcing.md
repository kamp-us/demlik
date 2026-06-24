# Event sourcing — the write model

The central decision surface for an event-sourced actor: turning a command into an `Effect` that
describes *what events, if any, to persist*. In Akka Persistence Typed an `EventSourcedBehavior` is
defined by these parts — `persistenceId`, `emptyState`, a `commandHandler` of type
`(State, Command) => Effect[Event, State]`, and an `eventHandler` of type `(State, Event) => State`.
The command handler never mutates state; it only *decides* by returning an `Effect`. The state moves
forward exclusively through events applied by the event handler (covered in
[event-handler.md](./event-handler.md)). Conceptually the command handler is the *decide* half of a
reducer pair: `decide(state, command) -> events`, and the state is always `fold(events)`.

## Approaches

### Persist one or many events

**When to use:** A command is valid against the current state and should change it. Persist the
event(s) that represent that change. Persisting several events with one effect is atomic — all are
stored or none are.

**Pattern:**

```scala
// decide(state, command) -> events. The handler returns a description; it does not mutate.
val commandHandler: (State, Command) => Effect[Event, State] = { (state, command) =>
  command match {
    case Add(data) => Effect.persist(Added(data))          // one event
    case Clear     => Effect.persist(Cleared)
  }
}

// Several events atomically — recovery never sees a partial subset of this list.
Effect.persist(MoneyReserved(id) :: OrderPlaced(id) :: Nil)
```

**Gotchas:**
- Only one primary effect per command — you cannot both `persist` and return `none`/`unhandled`.
- Some journals reject a multi-event `persist`; that surfaces as a `PersistRejected` signal and an
  `EventRejectedException`. The whole batch is rejected, never half-written.
- When multiple events are persisted at once, the event handler is called once per event, in the
  order passed to `persist`.

### No-op effects: `none`, `unhandled`, `stop`

**When to use:** `none` for a read-only or query command that emits no event. `unhandled` when the
command is not valid in the current state but that is not an error. `stop` to terminate the actor.

**Pattern:**

```scala
// Read-only query: reply from current state, persist nothing. fold is unchanged.
private def getBalance(acc: OpenedAccount, cmd: GetBalance): Effect[Event, State] =
  Effect.reply(cmd.replyTo)(CurrentBalance(acc.balance))   // none + a reply

// Command not meaningful in this state — declared unhandled, not an error.
case BlankState =>
  command match {
    case cmd: AddPost => addPost(cmd)
    case _            => Effect.unhandled
  }

// Terminal command. Effect.stop() is sugar for none.thenStop().
case Shutdown => Effect.stop()
```

**Gotchas:**
- `unhandled` is a deliberate "no rule for this command here" — it is distinct from `none`, which
  means "handled, nothing to persist".
- `Effect.stop()` is defined as `none.thenStop()`; the actor stops *after* side effects run.

### Side effects after persist: `thenRun`, `thenReply`, `thenStop`

**When to use:** Any effect on the outside world — replying to the caller, notifying a subscriber,
stopping — that must happen only *after* the events are durably persisted.

**Pattern:**

```scala
// Persist, then reply once the event is confirmed stored. New state passed to the callback.
private def addPost(cmd: AddPost): Effect[Event, State] =
  Effect.persist(PostAdded(cmd.content.postId, cmd.content)).thenRun { newState =>
    cmd.replyTo ! StatusReply.Success(AddPostDone(cmd.content.postId))
  }

// thenReply is the reply-typed convenience over thenRun.
Effect.persist(Deposited(cmd.amount)).thenReply(cmd.replyTo)(_ => StatusReply.Ack)

// Chain: persist, notify subscriber with the folded state, then stop.
Effect.persist(Cleared).thenRun((s: State) => subscriber ! s).thenStop()
```

**Gotchas:**
- The state passed to `thenRun`/`thenReply` is the state *after* all persisted events were folded in.
- Side effects run at-most-once and are skipped if the persist fails — they are not replayed on
  recovery. End-of-recovery side effects belong in the `RecoveryCompleted` signal handler (see
  [recovery.md](./recovery.md)).
- Putting a side effect *before* `persist` (e.g. in the body of the handler) risks running it even
  when the persist later fails.

### Enforced replies

**When to use:** Request-response entities where forgetting to reply is a likely bug. Build the
behavior with `withEnforcedReplies` so the compiler requires every branch to return a `ReplyEffect`.

**Pattern:**

```scala
// Command handler is typed (State, Command) => ReplyEffect[Event, State].
def apply(id: String, persistenceId: PersistenceId): Behavior[Command] =
  EventSourcedBehavior.withEnforcedReplies(persistenceId, EmptyAccount, commandHandler, eventHandler)

private def withdraw(acc: OpenedAccount, cmd: Withdraw): ReplyEffect[Event, State] =
  if (acc.canWithdraw(cmd.amount))
    Effect.persist(Withdrawn(cmd.amount)).thenReply(cmd.replyTo)(_ => StatusReply.Ack)
  else
    Effect.reply(cmd.replyTo)(StatusReply.Error(s"Insufficient balance"))  // reject, no event
```

**Gotchas:**
- `Effect.reply`, `Effect.noReply`, `EffectBuilder.thenReply`, and `EffectBuilder.thenNoReply` all
  produce a `ReplyEffect`. `noReply` is the explicit "no reply for this command (yet)" decision.
- Validation failures take the `Effect.reply(...Error...)` branch and persist nothing — invalid
  commands never reach the event log.

### Deferred handling: `stash` / `unstashAll`

**When to use:** A command cannot be processed yet because the actor is waiting on an external
condition. Stash it and process it later, preserving order.

**Pattern:**

```scala
// Defer commands for other tasks until the current task ends, then drain them.
case StartTask(t) if inProgress => Effect.stash()
case EndTask(t)                 => Effect.persist(TaskEnded(t)).thenUnstashAll()
```

**Gotchas:**
- The stash is an in-memory buffer: stashed commands are lost on crash, passivation, or restart
  (unless an `onPersistFailure` backoff strategy is set).
- Commands stashed *during* an `unstashAll` are not drained by that same `unstashAll`; a later
  `unstashAll` must drain them.

## Decision guide

| Situation | Effect | Why |
|---|---|---|
| Valid command changes state | `Effect.persist(event)` | Only persisted events advance the fold |
| Several changes must be all-or-nothing | `Effect.persist(events: Seq)` | Atomic write; recovery never sees a partial subset |
| Read-only / query command | `Effect.none` (often `Effect.reply`) | No state change, so no event |
| Command invalid in this state, not an error | `Effect.unhandled` | Distinct from `none`; declares "no rule here" |
| Reply only after durable persist | `.thenReply` / `.thenRun` | Side effects run post-persist, at-most-once |
| Replies must never be forgotten | `withEnforcedReplies` + `ReplyEffect` | Compiler enforces a reply on every branch |
| Can't handle command yet | `Effect.stash()` then `thenUnstashAll()` | Defer without dropping, preserving order |
| Terminal command | `Effect.stop()` | `none.thenStop()` after side effects |

## Rules

- The command handler is `(State, Command) => Effect[Event, State]` and must be free of state
  mutation — it only returns an `Effect` describing the decision.
- Exactly one primary effect per command. You cannot both persist and return `none`/`unhandled`.
- State changes only through events applied by the event handler — never by returning a new behavior
  and never by mutating in the command handler.
- All side effects go in `thenRun`/`thenReply`/`thenStop`, executed only after a successful persist.
- A multi-event `persist` is atomic: stored in full or not at all.
- Validation belongs in the command handler before persisting; rejected commands persist no event,
  so replayed events can always be applied without failing.

## Anti-patterns

| Don't do this | Why it breaks |
|---|---|
| Mutating `state` inside the command handler | State must advance only via the event handler; the change is lost on replay and during snapshots |
| `Effect.persist(e); doSideEffect()` in the handler body | The side effect runs even if the persist fails; use `.thenRun` |
| Returning `Effect.none` for a command that did change something | The change isn't an event, so it vanishes on recovery |
| Using `unhandled` to mean "handled, nothing persisted" | That is `none`; `unhandled` signals no rule applies and can trigger dead-letter handling |
| Persisting two events with two separate `persist` effects for one atomic change | Each `persist` is its own write; recovery could see one without the other — use one `persist(Seq)` |
| Encoding control flow by switching the returned `Behavior` | Persistent actors forbid this; state must be reconstructable from events alone |

## See also

- [event-handler.md](./event-handler.md) — the `(State, Event) => State` fold that the persisted events drive
- [recovery.md](./recovery.md) — why side effects are suppressed on replay and where end-of-recovery effects go
- [snapshotting.md](./snapshotting.md) — bounding replay cost once the event log grows
