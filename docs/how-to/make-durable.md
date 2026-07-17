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

Runtime B never re-ran the earlier chunks; it rehydrated their result. That is
the whole durability story — the Model is serializable data, the `Store` is the
one seam that persists it, and the substrate handles the save-then-boot cycle.
For the full agent version (snapshot mid-pipeline, drop the runtime, resume and
finish across stages), see the `agent-resilient-and-durable` example.
