# Why the case source outlives its active context

A finished investigation needs two different lifetimes. The agent needs a small
working conversation while reasoning. A reviewer needs earlier settled evidence,
failures, and the final outcome after that conversation has been compacted or
cleared. The retained-case example gives its host a persisted source from which
both the agent Model and a separate review view can be reconstructed.

## One source, two derived values

The authoritative source is the case's Node file-journal stream. Each versioned
record contains one validated agent input message. The run ID selects the
stream; its contiguous sequence numbers order messages. History entry IDs use
the run ID, source sequence, and event index within that transition.

The [consumer machine](../../examples/retained-case/agent.ts) delegates each
message to the existing pure agent reducer. Its parent state carries the agent
Model, applied message, and transition revision so the host's `Store.save` can
persist each transition once. Repeated saves of the same revision, including
the runtime's shutdown save, do not append another message. The reducer performs
no storage, clock reads, or publication.

The [host](../../examples/retained-case/host.ts) derives the review view with
`agentEvents`, retaining settled turns, successful tools, failed tools, and
terminal outcomes. It also records successful context compactions. Started
work and partial tokens are not retained outcomes. `read()` exposes the Model
and view together as plain data; connection handles and file locks belong to
the host.

## Publication follows the source commit

Each save holds the journal's per-stream lock for this sequence:

```text
validate message → await journal append → fold view → publish complete view
```

The example never publishes `runtime.getState()` or archives from an observer.
The runtime can install its next Model before saving finishes, so that Model
alone cannot establish a committed case update.

If the process dies after append but before folding or publishing, the source
already contains the message. A fresh host validates and folds the entire
stream from sequence zero, rebuilding both values without executing replayed
commands. There is no separately persisted projection cursor that can get ahead
of its view. Stable source identities reconstruct the same history entries.
An explicit boot message resumes pending work after reconstruction.

Append failures mark the host `unavailable` and retain its last committed state.
Connections fail instead of receiving the uncommitted candidate. Unreadable
source refuses opening before any boot save can overwrite it. A fresh host is
the recovery boundary, including when a write may have committed before its
caller observed failure.

## Attachment and bounded output share the host boundary

`connect()` registers the connection and supplies its snapshot while holding
the same lock as save. A commit must fall before that snapshot or after
registration; there is no gap between reading the snapshot and observing later
updates.

Each connection queues at most two full views. Overflow replaces its queue with
a current view, and reconnect always starts with a current view. The SSE
adapter pulls with a zero high-water mark so it does not create another eager
queue. A client replaces its displayed state rather than interpreting every
frame as an event that must arrive exactly once.

## Active state and archive have different bounds

In the fourteen-turn fixture, the maximum active conversation contains six
turns and seven tool records. Completion clears `conversation`; the separate
history still contains every settled turn and tool outcome. The fixture has
one tool per nonterminal turn and an explicit `maxTurns: 32` run cap.

The measured tool count does not establish that tool records always fit the
compacted turn count. The current agent stamps new records with cumulative
`turnCount`, while compaction drops and reindexes records against active turn
indices. After repeated compaction those measures differ. This example
preserves that behavior and relies on the finite run cap for the remaining
bound; it does not establish a memory bound for an uncapped agent or arbitrarily
large provider output.

The archive grows with the case. Rebuilding it reads the full source, the file
journal rewrites its JSONL file on append, and sending a complete view costs the
size of the retained history. Two pending views bound queue count, not bytes.

## What the proof establishes

The [lifecycle suite](../../src/agent/retained-case.test.ts) exercises actual
files, a fresh process after `SIGKILL` between source commit and publication,
fresh hosts, reconnects, attachment interleaving, append failure, corrupt
restore, and slow output. The file journal's atomic rename covers this tested
process-crash boundary. No fsync or power-loss guarantee follows from it.

The fixture makes no live-provider or production-host claim. One live host per
case remains a precondition. Replay applies pure transitions without effects;
resume can repeat external work whose result was not committed. Retained
history does not make those effects exactly once. See
[What durability actually promises](./durability-model.md) for that boundary,
and [Reopen an investigation with retained history](../how-to/reopen-a-retained-case.md)
for the runnable recipe.
