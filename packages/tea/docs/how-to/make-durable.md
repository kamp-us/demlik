# Make a machine durable and crash-recoverable

Choose the storage seam your database already supports:

- **It can append a batch atomically and read records in order:** write a
  [`Journal`](../reference/persistence.md#Journal) and pass it to
  [`eventSourcedStore`](../reference/persistence.md#eventSourcedStore). This gives
  `run` a crash-safe log; owed work survives and is re-delivered on recovery.
  A plain journal requires one active writer per stream. For competing writers,
  supply a `FencedJournal` and `{ fenced: true }` to `eventSourcedStore`.
  Steps [5](#5-end-each-call-and-return-the-next-alarm) and
  [6](#6-hand-long-work-to-an-external-owner) show the logged path across calls.
- **It only keeps the latest State:** give `run` a persistent `Store`. This
  saves the Model before running commands and loads it on the next boot, with
  no event log. Keep pending work in the Model so a resume handler can
  reconstruct it. Steps 1–4 below demonstrate this snapshot path.

The machine saved here is the download from
[Build and replay your first machine](../tutorial/build-your-first-machine.md).
The blocks on this page are one file, in order, and this is its top:

```ts
import { defineMachine } from "@demlik/tea";

export interface State {
  readonly phase: "idle" | "downloading" | "done";
  readonly received: number;
  readonly total: number;
}

export type Msg =
  | { readonly _tag: "start"; readonly total: number }
  | { readonly _tag: "chunk"; readonly size: number };

/** A download that counts the bytes it has received until it has them all. */
export const downloader = defineMachine({
  types: { model: {} as State, msg: {} as Msg },
  init: (loaded) => [loaded ?? { phase: "idle", received: 0, total: 0 }, []],
  update: {
    start: (s, m) => [
      { ...s, phase: "downloading", received: 0, total: m.total },
      [],
    ],
    chunk: (s, m) => {
      if (s.phase !== "downloading") return [s, []];
      const received = s.received + m.size;
      return received >= s.total
        ? [{ ...s, received: s.total, phase: "done" }, []]
        : [{ ...s, received }, []];
    },
  },
});
```

## 1. Implement the `Store` seam

A `Store<S>` loads an `unknown` value, saves the Model, and uses `migrate`
to validate loaded data. Return `null` for no saved state and `refuse(reason)`
for unreadable data. Step 4 reuses this `parse` function with a file store:

```ts
import { type Migrated, refuse, type Store } from "@demlik/tea";

/** Recognize a saved State, boot fresh on nothing, refuse anything else. */
function parse(raw: unknown): Migrated<State> {
  if (raw === null) return null;
  return typeof raw === "object" && "phase" in raw
    ? (raw as State)
    : refuse("not a saved State");
}

function memStore(box: { snapshot: string | null }): Store<State> {
  return {
    load: () => Promise.resolve(box.snapshot),
    save: (state) => {
      box.snapshot = JSON.stringify(state);
      return Promise.resolve();
    },
    migrate: (raw) => parse(typeof raw === "string" ? JSON.parse(raw) : raw),
  };
}
```

A refusal, or a `load` or `migrate` that throws, stops the run: `ready` rejects
with a `StoreRefusedError` and nothing is written, so the saved bytes are never
overwritten by a fresh boot. To show a "couldn't restore" view instead, see
[Show a "couldn't restore" view](./restore-or-refuse.md).

The in-memory box demonstrates serialization within one process. Use
`fileStore` in step 4 or Cloudflare's `doStore` for storage that survives a
process restart. The optional `doEventSourcedStore` also records each applied
message from `save`, before that transition's commands run; see
[snapshot restore versus replay](../explanation/durability-model.md#event-log-replay).

`save` also receives a third argument, a
[`SaveBoundary`](../reference/tea.md#SaveBoundary), that says which boundary the
save is: `init` for the State `init` produced and the Cmds the engine starts for
it, `step` for an applied Msg's transition and its Cmds, or `stop` for the flush
at `stop()`. A store that keeps a recording reads the State and the Cmds there;
every other store ignores it, as the `memStore` above does.

## 2. Boot with the Store, and let it persist

```ts
import { run } from "@demlik/tea/promise";

const box = { snapshot: null as string | null };

const a = await run(downloader, { store: memStore(box) }).ready;
await a.dispatch({ _tag: "start", total: 3 });
await a.dispatch({ _tag: "chunk", size: 1 }); // phase is now "downloading"
await a.stop(); // box.snapshot now holds the persisted Model
```

Each dispatch has saved its state through the Store. With persistent backing,
those successful writes survive the host stopping.

## 3. Resume from a fresh runtime

A brand-new `run` pointed at the same storage boots straight back to where the
old one stopped. `init(loaded)` receives the migrated Model and returns it
unchanged:

```ts
const b = await run(downloader, { store: memStore(box) }).ready;

const resumed = b.getState(); // phase "downloading", received 1: where A stopped
```

Runtime B loads the saved count; it does not replay the earlier chunk messages.

### Resume pending commands

This downloader counts incoming messages, so it waits for the next chunk after
restore. For a machine waiting on an API call, keep the request id and arguments
in its Model and return the needed Cmds from `init(loaded, ctx)`. Return a State
that marks that work in flight too, so a fast Sub's Msg cannot request it again.
The engine saves that State, opens its Subs, then runs the init Cmds; no host
latch or resume dispatch is needed.

Use [`bootResume`](../reference/do.md#bootResume) only when the host deliberately
needs to supply a Msg after `ready`. Subscriptions are already open then, so it
cannot put resume ahead of their Msgs. `agent.run` still handles its agent boot
message automatically. Do not also dispatch that message for work init resumes.
Handlers must tolerate a repeated attempt if their previous result was not
saved; see [the repeated-effect window](../explanation/durability-model.md#effects-are-at-least-once).

### Wake without running init's Cmds

A host that sleeps and wakes on its next Msg boots on every wake, so `init`'s
Cmds run on every wake. When the host already knows this start is a wake, pass
`boot: "restored"` beside the store. A loaded State still folds through `init`,
but `init`'s Cmds are not run, and nothing is written until a transition
commits, as long as `init` returns the loaded State itself. If `init` returns a
different State, that State is saved at boot and still runs no Cmds. `stop()`
skips its save only while the State is the one the store is known to hold, and a
refused save makes that unknown, because the store may have written before it
failed. With nothing saved, `init(null)` runs
and its Cmds run, because that start is a birth.

A machine whose `init` marks work in flight and relies on its Cmds to finish it
must not use the option: the host that passes it says those Cmds already ran. A
store with a durable log needs no option, because a wake on a log never calls
`init`. The rule is recorded in
[ADR 0039](https://github.com/kamp-us/demlik/blob/main/.decisions/0039-a-request-is-run-with-an-opt-in-restored-boot.md).

## 4. Refuse a second writer, if two processes can reach the storage

A plain `Store` does not refuse anything. Two runtimes pointed at one file both
drive the run to done and every effect fires twice — a retried job, a second
pod, the CLI started twice. When that is reachable, ask the store to fence:

```ts
import type { OnError } from "@demlik/tea";
import { fileStore } from "@demlik/tea/node";

// A fenced run must be given a sink, or it does not compile.
const onError: OnError = (error, { phase }) => {
  console.error(`download run, ${phase}:`, error);
};

const file = process.env.DOWNLOAD_FILE ?? "download.json";
const first = await run(downloader, {
  store: fileStore(file, parse, { fenced: true }),
  onError,
}).ready;
```

The store now carries a version. `run` reads it at boot and compare-and-swaps on
every save. **The newer starter takes the fence, and the older live writer is
the one refused** — at its next save, not at the newer one's boot:

```ts
// Process B starts while A is still running. B reads the CURRENT version at
// boot, so B's own boot save swaps cleanly and B runs.
const second = await run(downloader, {
  store: fileStore(file, parse, { fenced: true }),
  onError,
}).ready; // resolves — B now holds the fence
```

Process A is still holding the version it read before B moved it on, so A's
next save is the one that throws `StoreConflictError`. The guard therefore
belongs around every dispatch, not only around boot: a conflict can surface at
any save, and by then this process has already fired the effects it got to.
Catch it and stop dispatching — another worker owns this run now.

```ts
import { StoreConflictError } from "@demlik/tea";

let takenOver = false;
try {
  await first.dispatch({ _tag: "start", total: 3 }); // A's next save
} catch (err) {
  if (!(err instanceof StoreConflictError)) throw err;
  takenOver = true; // another process owns this run now: stop dispatching
}
```

A conflict at boot is possible too, but only in the narrow race where both
processes read the same version before either wrote. Fencing gives you
**at most one live writer from here on**, not a guarantee that the loser never
started.

Not every conflict has a dispatch to reject. The final save in `stop()` reports
under `"stop-save"`, and a save driven by a Sub or a Cmd's Msg reports under
`"follow-up"`. Both go to `onError`, which is why a fenced store needs one: with
no sink, the default rethrows and ends the process along with every other run in
it. In your sink, treat a `StoreConflictError` as "this run moved": log it and
stop that run, and leave the others alone. A run on a fenced store with no
`onError` does not compile, and if the store's type was widened to plain
`Store<S>`, or the caller is JavaScript, the run is refused at start instead:
the Promise engine's `run` throws, the Effect engine's dies, and nothing is
loaded or saved.
[ADR 0031](https://github.com/kamp-us/demlik/blob/main/.decisions/0031-a-fenced-run-must-pass-on-error.md) records
this.

A fenced `fileStore` takes a lock file beside the state for each save, and a
writer that dies holding it leaves it behind. The next write steals it when the
holder is proven gone. A lock from another host is never stolen, because that
host may still be writing to a shared volume, so restoring a folder onto a new
machine can end the first write in a `FileLockTimeoutError` naming the file. Once
you know the old machine is gone, delete that file and run again.

`doStore` and `memoryStore` take the same `{ fenced: true }`. `chromeStorageStore`
does not — `chrome.storage` cannot compare-and-swap atomically, so it stays
unfenced rather than pretending. Leave fencing off and single-writer is a
precondition you keep yourself; see
[What durability actually promises](../explanation/durability-model.md).

For the full agent version (snapshot mid-pipeline, drop the runtime, resume and
finish across stages), see the `agent-resilient-and-durable` example.

## 5. End each call and return the next alarm

Use the [executable per-call recipe](https://github.com/kamp-us/demlik/blob/main/packages/tea/src/docs/how-to/make-durable.test.ts)
(the `per-call` region) when the host destroys its activation between calls:

1. Keep absolute deadlines in State. Give the feature one `deadlinesFor` selector,
   and use it in both `deadlinesSub(deadlinesFor)` and the host.
2. Open a fresh journal handle over the same retained storage for every call.
   Boot on `eventSourcedStore`. The recipe's `subscribeWith(() => () => {})`
   backing starts no in-isolate timer because the host owns the external alarm.
3. Select deadlines due at the host's current epoch time, and send their existing
   `deadlineExceeded(id, atMs)` messages with stable caller ids. Send the call's
   inputs and await each dispatch at its default quiescent settlement.
4. Await `stop()`, read the earliest absolute `atMs` from
   `deadlinesFor(rt.getState())`, and close the journal handle. Set the platform's
   external alarm to that returned instant, or clear it for `null`. The activation
   can now end. On a wake, repeat with a fresh handle and the current time.

The recipe runs against a real file journal: one call schedules a reminder,
a second preserves the same absolute deadline, and later calls fire it once.
The host sets its platform alarm outside tea; the next deadline comes from
State, not the log's `timers` field.

A Promise handler that has not finished can keep running after `stop()` returns;
tea drops its late result ([ADR 0025](https://github.com/kamp-us/demlik/blob/main/.decisions/0025-stop-gives-up-on-handlers.md)).

## 6. Hand long work to an external owner

Use the [executable handler recipe](https://github.com/kamp-us/demlik/blob/main/packages/tea/src/docs/how-to/make-durable.test.ts)
(the `external-work` region) with a `Cmd.define`d job and a log store:

1. Read `deliveryIdOf(ctx)` in the handler. Send that id and the Cmd to the
   external queue, await its bounded durable acknowledgement, and return `owed()`.
2. Await dispatch and `stop()`, then read
   `logLedger(await store.readLog()).surviving()` for the still-owed Cmds and ids.
   Close the journal; this invocation has ended without producing a result Msg.
3. On a later activation, the handler receives each surviving Cmd with the same
   id. The external receiver uses that id to ignore an already accepted handoff.
4. In the call that receives the worker's reply, use that Cmd's `ok(cmd, value, at)`
   or `err(cmd, declaredError, at)` builder. Dispatch the built Msg with
   `{ answerTo: id }`. Do not combine `answerTo` with a caller `id`.
5. Await dispatch and `stop()`, read the surviving ledger, and close the journal.
   The answer's admission also confirms the delivery in one write. A wake after
   admission replays an unfinished answer and never re-hands that Cmd.

The same [executable recipe](https://github.com/kamp-us/demlik/blob/main/packages/tea/src/docs/how-to/make-durable.test.ts)
has an `external-answer` region. It answers on the third closed call and verifies
that the fourth call has the result without another handoff.

`owed()` requires a logged invocation; otherwise the existing interpret error
sink reports the refusal. On Effect, succeed with `owed()` after enqueueing.
For a new answer, `dispatch(msg, { answerTo: id })` clears the owed entry with
its admission atomically. Repeats of an atomic answer, including different payloads,
write nothing.
If an ordinary canonical handler reply was admitted before a crash left its delivery
owed, that first reply stands: the later call writes one confirmation record and
does not fold another reply. Unknown ids and malformed new answers are refused
before writing; corrected new answers may retry on the same activation. An ordinary
caller `id` deduplicates input and does not confirm a delivery.

Answer-bearing log frames use protocol 3 and require this reader. Ordinary frames
and checkpoints stay on protocol 2. Protocol-2 messages keep their previous meaning:
an extra field named `answerTo` is ignored. Protocol-3 message frames require a
positive safe-integer `answerTo`; older readers refuse these frames.

## 7. Bound replay on a Durable Object

For an existing applied-message journal, use
[`doEventSourcedStore`](../reference/do.md#doEventSourcedStore) with the object's
storage, machine and context. This store replays reducers; keep effects in
command handlers. It is a different persistence mode from the engine-owned
logged store in steps 5–6.

1. Set `snapshotEvery` to the number of applied messages you can afford to
   replay. Await the runtime's `ready` before dispatching. Restore reads the
   latest snapshot and only the events after it, in bounded pages, folding one
   event at a time. A present snapshot that cannot be parsed refuses restore;
   it never triggers a full-history fallback. With no snapshot yet, recovery
   starts from pure initialization and replays the available journal.
2. Catch `StoreRefusedError` from `ready`. Inspect its `cause` for
   [`RestoreInterruptedError`](../reference/do.md#RestoreInterruptedError),
   whose `attempts` and `retryLimit` describe an exhausted restore budget.
   Preserve the refusal and stop this activation. Do not start another runtime
   with an empty store.
3. Choose `restoreRetryLimit` for automatic recovery. The default permits an
   initial attempt and one retry. A failed load and an interrupted activation
   both leave a small JSON attempt record. A second unfinished attempt refuses
   future loads before reading the snapshot or journal. Set the option to `0`
   to refuse on the first activation after an unfinished attempt. Success
   clears the record and resets the budget. Keep the record across activations;
   remove it only as part of an explicit recovery after inspecting the failure.
4. When building a projection from the recovered State, pair that projection
   with `await handle.getCommittedSeq()`. Save the pair together. Resume its
   subsequent event reads with `{ fromSeq: savedSequence + 1 }`; no scan is
   needed to rediscover the sequence. A projection with an older checkpoint
   must resume from its own saved sequence, rather than skipping to the head.

A host that reads an agent's log without loading it — its head, committed
sequence or events in a range — uses
[`doEventLogReader`](../reference/do.md#doEventLogReader) with the store's options.

A log can be written as a recording: a frame per cell instead of a bare Msg, an
`init` frame for each boot and a `step` frame for each applied Msg, each holding
the State after it and the Cmds the engine started for it. `readHead()` says
which format the first cell is (`format`). `readFrames(range, options)` reads
every cell as a [`StoredFrame`](../reference/do.md#StoredFrame) (`message`,
`init`, `step` or `refused`). Pass `{ evidence: true }` to rebuild each frame's
State and Cmds, `{ evidence: "verify" }` to check that they rebuild without
returning them, and `{ reverse: true }` to read from the highest `seq` down. A
range that starts in the middle of a run of deltas reads one bounded page of
earlier frames to find its basis. A frame that cannot be rebuilt comes back
`refused` with its reason (`frame`, `basis` or `checksum`), and a delta after it
is refused `basis`. `readStoredEvents` and `readEvents` still yield Msgs only,
whichever format the log has.

See [`EventSourcedOptions`](../reference/do.md#EventSourcedOptions) for the
restore-attempt key override and parsing options, and
[`EventLogReaderOptions`](../reference/do.md#EventLogReaderOptions) for the
event parse option. Storage values remain JSON
text; command handlers and host recovery actions stay outside the replay fold.
