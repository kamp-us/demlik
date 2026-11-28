# What durability actually promises

With a persistent `Store`, a restarted machine can recover its saved Model.
The usual `fileStore` and `doStore` path restores a snapshot; it does not replay
all earlier messages. Pending work then resumes from that state.

## Snapshot restore

A transition produces a new Model and commands. The runtime saves the Model
before running those commands:

```text
message → update → save Model → run commands → result message
```

On restart, `load` reads the saved value, `migrate` validates it, and
`init(loaded)` receives the restored Model. Completed work survives as data.
The old process's JavaScript stack and promises do not survive.

For example, suppose A and B have saved results and C is pending. Restarting
keeps A and B completed and attempts C again. Recovery starts from the last
successful store write, so a transition whose save was interrupted may be lost.

A store backed only by memory cannot survive process termination. The new
process must open the same persistent file, storage key, or equivalent backing.

## Restoring state and resuming work

A store saves the Model, not a separate queue of command objects. The machine
must keep enough data to reconstruct pending work: its phase, request ids,
arguments, and any completed results.

`init(loaded, ctx)` may return an updated Model and the commands needed to
resume. The engine saves that Model, reconciles its subscriptions, then runs
the commands. An in-flight phase in the returned Model tells a fast Sub's
message that the work already started.

`agent.run` retains its host boot-message protocol. A custom machine can instead
own resume in init. [`bootResume`](../reference/do.md#bootResume) remains an
option for a host message after `ready`, when Subs are already open; combining
both resume paths for the same work can repeat it.
An agent's saved retry counters survive too; restarting does not reset its attempt budget.

An agent's `runId` is the identity of its run, and the saved State holds it. A
start for the `runId` the State already holds, in any phase, returns that State
and issues no command, so a request retried or sent twice does not issue the
first model call again, reset the run's usage or clear a finished run's output.
Only a State with no run, or a start for a different `runId`, begins a new run
and resets them. A host that wants a second run on the same State passes a new
`runId`.

A host that sleeps and wakes on its next Msg boots on every wake, so `init`'s
Cmds run on every wake. Passing `boot: "restored"` to `run` says this start is a
wake: with a loaded State, `init` still folds it, but none of its Cmds run, and
the run writes nothing until a transition commits, as long as `init` returns the
loaded State itself. A different State from `init` is saved at boot and still
runs no Cmds. `stop()` skips its save only while the State is the one the store
is known to hold, and a refused save makes that unknown, because the store may
have written before it failed. With nothing saved, `init(null)` runs and its
Cmds run.
A machine whose `init` marks work in
flight and relies on its Cmds to finish it must not use the option, and a log
store already never calls `init` on a wake
([ADR 0039](https://github.com/kamp-us/demlik/blob/main/.decisions/0039-a-request-is-run-with-an-opt-in-restored-boot.md)).

Stopping the host and cancelling the run have different meanings. A killed
process leaves its last saved phase in place. An agent cancellation records a
terminal outcome, so reopening that store does not continue the cancelled run.
A completed agent likewise stays completed.

## Event-log replay

The optional [`doEventSourcedStore`](../reference/do.md#doEventSourcedStore)
recovers differently. It loads the latest snapshot and folds persisted messages
after that snapshot through the reducer. With no snapshot, it folds the full log.
Snapshot recovery folds update directly, without re-running init on that
snapshot. With no snapshot it starts from fresh init. Commands produced during
the fold are data; their handlers are not executed.
Pending work still needs the resume path after recovery.

The store writes the log itself. Each applied message reaches `Store.save` with
its new State, and the store appends the message, advances its counter and takes
a due snapshot in one transaction before `save` resolves. The engine saves before
it starts that transition's commands, so the message is durable before any effect
runs: a run lost in the middle of a model call finds that call's input in the
log, and its wake sees the run `running`, not `idle`. Hand `run` the store and
nothing else. Do not feed the log from `runtime.observe`, which fires after the
commands, and do not append a message by hand before you dispatch it, or it is
recorded twice. The boot save and the flush at `stop()` carry no message and
write no row. A log written by the earlier observer-fed store reads unchanged.

This is replay of an applied-message log. A store with a durable log
(`logged: true`,
[ADR 0038](https://github.com/kamp-us/demlik/blob/main/.decisions/0038-engine-owned-durable-log.md))
works the other way: it admits a message before the reducer runs, keeps committed
State and the deliveries still owed, and on a wake never runs a committed reducer
again. Give a run one or the other, not both.

[`replay` and `replayTrace`](../how-to/replay-in-a-test.md) also fold messages
without effects. They support tests and debugging; normal snapshot restore does
not call them.

### What a recording promises

With `recording`, the same log keeps a frame per boundary: the State after it and
the Cmds it started. Restore reads only the Msgs and the snapshot, so a frame
whose evidence is lost never costs the State. What the evidence promises is
narrower:

- **Numbering.** Every frame sits at the sequence the live run gave it. A
  windowed trace written with `writeTrace` opens an empty log at its moved
  anchor, `skipped + 1`, with a snapshot of the anchor's State there, so its
  steps keep their live numbers and a restore folds only the steps after the
  anchor. The store refuses an offset into a log that already has frames.
- **Size.** A frame over 1,000,000 bytes is written in parts. With `maxRowBytes`,
  a frame over the budget, or one whose put storage rejects with `SQLITE_TOOBIG`,
  is not written. A small marker naming
  its seq and measured bytes stands in its place, and every frame after it is
  still kept. Any other storage failure still fails the save.
- **Read, not resumed.** A marker keeps neither its frame's evidence nor its
  Msg, and nothing is written beside it to stand in for them. So a log with a
  marker is a record to read: loading a State from it is refused with a typed
  `RecordingUnavailableError` naming the marker's seq, while the log still
  takes appends, reads and deletion. Keeping the recording and resuming the
  run are separate promises, and a row budget trades the second for the first.
- **Numbers stay safe.** A seq past `Number.MAX_SAFE_INTEGER` is refused before
  it is written, so two frames never share a key.
- **Replay.** A recording reads back as a whole `Trace` or not at all.
  `readTrace` checks every seq up to the committed head. It reports a missing
  cell, a missing tail, a marker, or any frame it cannot rebuild as unavailable
  at that seq, and never hands back the frames before it as if they were the
  run.

## Effects are at-least-once

An external action and the store write of its result are separate operations.
If a handler finishes its action and the process dies before the result is
saved, the restored Model still says the work is pending. Resume attempts it again.

That can mean a repeated API call, row write, or email. Idempotent operations
leave the same result when repeated. Other operations need a stable key that
the downstream system can deduplicate.

An agent tool's `callId` survives the restart. A `tool()` handler receives
`args`, `ctx`, and `{ ok, fail }`; the id is available as `cmd.callId` in an
interpret wrapper. See [Wrap one tool's interpret cell](../how-to/wrap-one-tool-cell.md).
TEA does not apply external-effect deduplication automatically.
[`idempotency`](../reference/idempotency.md) and
[`idempotentEffect`](../reference/do.md#idempotentEffect) provide helpers;
the host supplies the stable key and wires them into its handlers.

Saving state also does not make an arbitrary reducer idempotent. Custom
machines must recognize already-settled work if duplicate results can arrive.

## One writer per saved run

A plain `Store.save` is unconditional. Two processes sharing a store can race
and issue the same work. Atomic file replacement prevents partial writes;
it does not choose which process owns the run.

A `FencedStore` adds a version check to each save. A stale writer gets
`StoreConflictError`. A later starter can read the current version and take
over; the older process is refused at its next save. Effects already running
can still finish, so fencing does not remove the repeated-effect window.
A `boot: "restored"` run on a fenced store takes no turn at the fence for a start
that changed nothing, because `init` returned the loaded State itself and the
store is known to hold it, so it writes nothing at boot or at `stop()`.

A stopped run can be that stale writer. When `stop()` gives up at
`disposeTimeoutMs`, tea starts no store call after `stop()` has returned, but a
save already under way is not cancelled and can land later. A fenced store
refuses it. So does `doEventSourcedStore`: a `load()` takes the log, and a write
called before a later run loaded it is refused with `StoreConflictError` at its
write point, so a stopped run's save never overwrites what the later run saved.
The check is one generation per log in the isolate. Nothing is written to
storage, so a log written before the check reads unchanged. A custom plain store
that waits between being called and writing takes the late save over what a
newer run saved, and nothing reports it, so it checks at its own write point or
is fenced.
[ADR 0025](https://github.com/kamp-us/demlik/blob/main/.decisions/0025-stop-gives-up-on-handlers.md) records
the limit and
[ADR 0042](https://github.com/kamp-us/demlik/blob/main/.decisions/0042-a-save-abandoned-at-dispose-never-overwrites-a-later-run.md)
the check.

`fileStore`, `doStore`, and `memoryStore` support `{ fenced: true }`.
`chromeStorageStore` has no atomic compare-and-swap and stays unfenced.
A run on a fenced store must be given an `onError`, held by its type and, where
the type was thrown away, by a refusal at start, because a lost fence can
surface with no caller to reject at
([ADR 0031](https://github.com/kamp-us/demlik/blob/main/.decisions/0031-a-fenced-run-must-pass-on-error.md)).
The [durability how-to](../how-to/make-durable.md#4-refuse-a-second-writer-if-two-processes-can-reach-the-storage)
shows the setup; [ADR 0017](https://github.com/kamp-us/demlik/blob/main/.decisions/0017-fencing-is-an-optional-store-widening.md)
records the design.

`rowStore` on `@demlik/tea/persistence` is fenced by construction: the State
lives in the columns of one SQL row, the fence is the row's revision, and a
stateless request runs the machine for one Msg with `boot: "restored"`. For an
existing row, when `init` returns the loaded State itself and storage succeeds,
such a request costs one read, and one write only if a Msg is accepted. A birth
adds an insert, and a refused save can add a read and a final save attempt at
`stop()`. A port bound to the host's transaction makes the save part of it.

## Forgetting a run: `delete()`

`fileStore`, `memoryStore`, `doStore`, and `rowStore` expose `delete()`. Removing the saved
state lets the next runtime boot fresh. A custom `Store` need not expose deletion.

A live unfenced runtime can save again and recreate the state. Deleting a fenced
store also removes its version, so the old writer is refused at its next save
while the state stays gone. After `delete()` a re-created row starts again at
revision 1, so a host that re-creates a deleted id must not let writers from
before the delete continue. Deletion therefore belongs after the current
runtime has stopped.

## What a resumed agent run keeps: the prompt it started with

An agent stores `instructions` in its Model at initialization. Later model
calls read that saved prompt. Redeploying with a different prompt changes new
runs; an existing run continues with its original instructions.

Compaction changes the conversation, not the stored instructions. Using a new
prompt requires a new run. See [ADR 0004](https://github.com/kamp-us/demlik/blob/main/.decisions/0004-agent-context-compaction.md).

## What a finished agent run keeps

At `phase: "done"`, the Model retains the run slice and final `output`.
`conversation` becomes `null`, so the stored Model is not a full transcript archive.

[`transcript()`](../how-to/show-a-run-in-progress.md#4-keep-the-whole-transcript-with-transcript)
collects turns from the event stream. A collector attached after a restart
needs the saved conversation as its seed to include earlier turns.

That seed cannot recover turns removed by compaction or completion, and the
collector excludes failed tools. For a retained review history, see
[Why the case source outlives its active context](./retained-case-history.md)
and its file-journal example.

## Further reading

- [Make a machine durable and crash-recoverable](../how-to/make-durable.md): store and resume setup.
- [Build a durable agent](../tutorial/build-a-durable-agent.md): kill and restart a running agent.
- [Deploy an agent to a Durable Object](../how-to/deploy-an-agent-to-a-durable-object.md): platform-hosted recovery.
- [Why failures are values and bugs are throws](./errors-as-data.md): serializable state and outcomes.
