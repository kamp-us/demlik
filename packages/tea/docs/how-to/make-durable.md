# Make a machine durable and crash-recoverable

Give `run` a persistent `Store`. With `fileStore` or `doStore`, the runtime
saves the Model before running commands and loads it on the next boot.
Keep pending work in the Model so a resume handler can reconstruct it.

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
  | { readonly type: "start"; readonly total: number }
  | { readonly type: "chunk"; readonly size: number };

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
process restart. The optional `doEventSourcedStore` also needs message-log
append wiring; see [snapshot restore versus replay](../explanation/durability-model.md#event-log-replay).

## 2. Boot with the Store, and let it persist

```ts
import { run } from "@demlik/tea/promise";

const box = { snapshot: null as string | null };

const a = await run(downloader, { store: memStore(box) }).ready;
await a.dispatch({ type: "start", total: 3 });
await a.dispatch({ type: "chunk", size: 1 }); // phase is now "downloading"
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
restore. A machine waiting on an API call needs a resume handler as well:
keep the pending request's id and arguments in its Model, then have the host
dispatch a boot message after `ready`. Its `update` cell issues the commands
still needed. Keep `init(loaded)` as `[loaded, []]`.

`agent.run` handles this boot message automatically. Durable Object hosts can
use [`bootResume`](../reference/do.md#bootResume) with their machine's resume port.
Handlers must tolerate a repeated attempt if their previous result was not
saved; see [the repeated-effect window](../explanation/durability-model.md#effects-are-at-least-once).

## 4. Refuse a second writer, if two processes can reach the storage

A plain `Store` does not refuse anything. Two runtimes pointed at one file both
drive the run to done and every effect fires twice — a retried job, a second
pod, the CLI started twice. When that is reachable, ask the store to fence:

```ts
import { fileStore } from "@demlik/tea/node";

const file = process.env.DOWNLOAD_FILE ?? "download.json";
const first = await run(downloader, {
  store: fileStore(file, parse, { fenced: true }),
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
  await first.dispatch({ type: "start", total: 3 }); // A's next save
} catch (err) {
  if (!(err instanceof StoreConflictError)) throw err;
  takenOver = true; // another process owns this run now: stop dispatching
}
```

A conflict at boot is possible too, but only in the narrow race where both
processes read the same version before either wrote. Fencing gives you
**at most one live writer from here on**, not a guarantee that the loser never
started.

`doStore` and `memoryStore` take the same `{ fenced: true }`. `chromeStorageStore`
does not — `chrome.storage` cannot compare-and-swap atomically, so it stays
unfenced rather than pretending. Leave fencing off and single-writer is a
precondition you keep yourself; see
[What durability actually promises](../explanation/durability-model.md).

For the full agent version (snapshot mid-pipeline, drop the runtime, resume and
finish across stages), see the `agent-resilient-and-durable` example.
