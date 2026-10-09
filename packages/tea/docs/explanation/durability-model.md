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

`init(loaded)` returns `[loaded, []]`. It restores state without issuing
commands. A boot message handled by `update` derives the commands still needed;
subscriptions are reconciled from the restored state.

`agent.run` sends that resume message automatically for a run caught mid-flight.
A custom machine needs its own boot/resume handler. Durable Object hosts can use
[`bootResume`](../reference/do.md#bootResume) with a typed resume port.
An agent's saved retry counters survive too; restarting does not reset its attempt budget.

Stopping the host and cancelling the run have different meanings. A killed
process leaves its last saved phase in place. An agent cancellation records a
terminal outcome, so reopening that store does not continue the cancelled run.
A completed agent likewise stays completed.

## Event-log replay

The optional [`doEventSourcedStore`](../reference/do.md#doEventSourcedStore)
recovers differently. It loads the latest snapshot and folds persisted messages
after that snapshot through the reducer. With no snapshot, it folds the full log.
Commands produced during this fold are data; their handlers are not executed.
Pending work still needs the resume path after recovery.

This mode requires applied-message append wiring as well as the store. Changing
the store alone does not record the message log.

[`replay` and `replayTrace`](../how-to/replay-in-a-test.md) also fold messages
without effects. They support tests and debugging; normal snapshot restore does
not call them.

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

`fileStore`, `doStore`, and `memoryStore` support `{ fenced: true }`.
`chromeStorageStore` has no atomic compare-and-swap and stays unfenced.
The [durability how-to](../how-to/make-durable.md#4-refuse-a-second-writer-if-two-processes-can-reach-the-storage)
shows the setup; [ADR 0017](../../../../.decisions/0017-fencing-is-an-optional-store-widening.md)
records the design.

## Forgetting a run: `delete()`

`fileStore`, `memoryStore`, and `doStore` expose `delete()`. Removing the saved
state lets the next runtime boot fresh. A custom `Store` need not expose deletion.

A live unfenced runtime can save again and recreate the state. Deleting a fenced
store also removes its version, so the old writer is refused at its next save.
Deletion therefore belongs after the current runtime has stopped.

## What a resumed agent run keeps: the prompt it started with

An agent stores `instructions` in its Model at initialization. Later model
calls read that saved prompt. Redeploying with a different prompt changes new
runs; an existing run continues with its original instructions.

Compaction changes the conversation, not the stored instructions. Using a new
prompt requires a new run. See [ADR 0004](../../../../.decisions/0004-agent-context-compaction.md).

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
