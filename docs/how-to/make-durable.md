# Make a machine durable and crash-recoverable

To let a machine survive its host being evicted — a Durable Object hibernating,
a worker restarting — give `run` a `Store`. The substrate saves the Model after
every transition and rehydrates it on the next boot. Your reducer authors none
of it: the Model is plain data, so persistence is a round-trip, not code.

## 1. Implement the `Store` seam

A `Store<S>` has three methods: `load` returns whatever bytes are at the key
(typed `unknown` — storage genuinely doesn't know your `S`), `save` persists the
Model, and `migrate` parses raw bytes back into an `S` or returns `null` to boot
fresh. `migrate` must never throw — an unrecognized shape returns `null`:

```ts
import type { Store } from "@demlik/tea";

function memStore(box: { snapshot: string | null }): Store<State> {
  return {
    load: () => Promise.resolve(box.snapshot),
    save: (state) => {
      box.snapshot = JSON.stringify(state);
      return Promise.resolve();
    },
    migrate: (raw) => {
      if (raw === null || typeof raw !== "string") return null;
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" &&
        parsed !== null &&
        "phase" in parsed
        ? (parsed as State)
        : null;
    },
  };
}
```

On Cloudflare, swap `memStore` for `@demlik/tea/do`'s `doStore` (or
`doEventSourcedStore`), whose `load`/`save` are backed by
`DurableObjectStorage`. The machine code above does not change — only the Store
does.

## 2. Boot with the Store, and let it persist

```ts
const box = { snapshot: null as string | null };

const a = await run(downloader, { ctx: undefined, store: memStore(box) }).ready;
await a.dispatch({ type: "start", total: 3 });
await a.dispatch({ type: "chunk", size: 1 }); // phase is now "downloading"
await a.stop(); // box.snapshot now holds the persisted Model
```

Every dispatch has already written through the Store, so the moment the host is
evicted the last state is safe in storage.

## 3. Resume from a fresh runtime

A brand-new `run` pointed at the same storage boots straight back to where the
old one stopped. `init(loaded)` receives the migrated Model and returns it
unchanged:

```ts
const b = await run(downloader, { ctx: undefined, store: memStore(box) }).ready;

console.log(b.getState().phase); // "downloading" — exactly where A stopped
```

Runtime B never re-ran the earlier chunks; it rehydrated their result. The Model
is serializable data, the `Store` is the one seam that persists it, and the
substrate handles the save-then-boot cycle.

## 4. Refuse a second writer, if two processes can reach the storage

A plain `Store` does not refuse anything. Two runtimes pointed at one file both
drive the run to done and every effect fires twice — a retried job, a second
pod, the CLI started twice. When that is reachable, ask the store to fence:

```ts
import { fileStore } from "@demlik/tea/node";

const store = fileStore("agent.json", parse, { fenced: true });
const a = await run(downloader, { ctx: undefined, store }).ready;
```

The store now carries a version. `run` reads it at boot and compare-and-swaps on
every save. **The newer starter takes the fence, and the older live writer is
the one refused** — at its next save, not at the newer one's boot:

```ts
// Process B starts while A is still running. B reads the CURRENT version at
// boot, so B's own boot save swaps cleanly and B runs.
const second = run(downloader, {
  ctx: undefined,
  store: fileStore("agent.json", parse, { fenced: true }),
});

await second.ready; // resolves — B now holds the fence

// Process A is still holding the version it read before B moved it on. A's
// next save is the one that throws StoreConflictError.
a.dispatch({ type: "chunkDone" }); // A dies here
```

So the guard belongs around the whole run, not only around boot: a conflict can
surface at any save, and by then this process has already fired the effects it
got to. Catch it, stop, and exit — another worker owns this run now.

```ts
import { StoreConflictError } from "@demlik/tea";

try {
  const runtime = await run(downloader, { ctx: undefined, store }).ready;
  await driveToCompletion(runtime); // your dispatch loop
} catch (err) {
  if (err instanceof StoreConflictError) return; // someone else has it now
  throw err;
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
