# Reopen an investigation with retained history

Run the consumer-local retained-case example to keep settled evidence and tool
failures after compaction, completion, and a host restart. It uses deterministic
model and tool fixtures and the existing Node file journal. No provider key is
needed.

Use a repository checkout with dependencies installed and Node 22, as in CI.
The launcher uses the workspace's Vite installation to bundle the example against
the source export map; it does not add a package export.

## 1. Run the investigation

From the repository root, choose a directory for this case:

```sh
node packages/tea/examples/retained-case/run.mjs ./retained-case-data
```

The [fixture](../../examples/retained-case/fixture.ts) runs fourteen model turns,
two context compactions, and thirteen tool calls. Calls 3, 7, and 11 fail; the
other ten settle successfully. It stops the first host, opens a fresh host over
the same files, and checks three disconnect/reconnect cycles before printing
the complete view as JSON.

Check the printed `history` for `Evidence 1`, all three `ToolFailed` entries,
both `ContextCompacted` entries, and the final `RunDone`. `outcome.kind` is
`done`. History entry IDs and source sequence numbers identify and order the
settled evidence independently of the active conversation.

## 2. Reopen the saved case

Run the same command with the same directory. The new process reconstructs the
view from `investigation-593.jsonl`; a completed run issues no new model or tool
calls. It prints the same view and checks the same reconnect cycles. A case
interrupted while still running explicitly resumes its saved pending work.

Keep the directory to keep the case. Stop its host before deleting it. Run only
one live host for a case: the file journal serializes writes, but the example
does not provide a lease between competing hosts.

## 3. Connect a consumer

The [host](../../examples/retained-case/host.ts) exposes `read()` for inspectable
plain state and `source()` for the persisted records. `connect()` returns a
connection whose first `next()` contains a complete current view. Later reads
contain complete committed views. Close the connection when the consumer
disconnects.

For an HTTP host, return `caseResponse(connection)` from your route. It supplies
a pull-driven SSE `Response` with `event: case` and JSON containing `reason`
and `view`. Replace the client's displayed case with each complete view.
Cancellation closes the connection. Every new attachment gets a fresh snapshot;
the adapter does not replay a `Last-Event-ID` cursor.

The queue holds at most two pending views. Overflow discards queued intermediate
views and supplies a current complete view with `reason: "overflow"`. This
contract promises convergence, so do not count frames as individual outcomes.

## 4. Exercise the failure boundaries

From the repository root, run:

```sh
pnpm exec vitest run packages/tea/src/agent/retained-case.test.ts
```

The suite checks an update during attachment, lagging SSE output, a blocked then
failed append, and malformed persisted shape, sequence, and run ownership. It
also kills a child process with `SIGKILL` after the journal rename and before
view publication, then resumes in another process and reopens once more.

An append failure leaves `read()` explicitly `unavailable`, with the last
committed state, and fails existing and new connections. A restore failure
rejects opening without replacing the saved bytes. Recover by opening the
retained source in a fresh host after repairing the storage problem.

Read [Why the case source outlives its active context](../explanation/retained-case-history.md)
for the commit boundary, measured active-state bounds, and limits of this proof.
