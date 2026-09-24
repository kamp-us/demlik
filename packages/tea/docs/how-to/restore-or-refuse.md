# Show a "couldn't restore" view when saved state can't be read

A run with a `Store` reads its saved state at boot. When the bytes are there but
can't be read — a corrupt file, a shape your `migrate` does not know yet — `run`
refuses: `ready` rejects with a `StoreRefusedError` and nothing is written. The
saved bytes stay exactly as they were, so a fix to `migrate` can still read them
later.

tea has no "saving is off" mode for this. If your app wants to show something
instead of failing, catch the refusal and start your own run with no store.

## 1. Refuse from `migrate`

`migrate` has three answers. Return the State when you can read it, `null` when
nothing was saved (the run boots fresh), and `refuse(reason)` for saved bytes you
can't read. A `load` or `migrate` that throws is refused the same way.

## 2. Catch the refusal and start a run with no store

The machine below keeps a note list. Its `init` shows the "couldn't restore"
view when the host passes a reason in `ctx`. `openNotes` tries the stored run
first, and on a `StoreRefusedError` starts the same machine with no store:

```ts
import {
  defineMachine,
  type Migrated,
  refuse,
  type Store,
  StoreRefusedError,
} from "@demlik/tea";
import { run } from "@demlik/tea/promise";

/** A note list, or the "couldn't restore" view shown in its place. */
export type NotesState =
  | { readonly phase: "open"; readonly notes: readonly string[] }
  | { readonly phase: "unrestored"; readonly reason: string };

export type NotesMsg = { readonly type: "add"; readonly text: string };

/** `unrestored` is set only on the host's no-store run after a refusal. */
export interface NotesCtx {
  readonly unrestored?: string;
}

export const notes = defineMachine({
  types: { model: {} as NotesState, msg: {} as NotesMsg, ctx: {} as NotesCtx },
  init: (loaded, ctx) => [
    ctx.unrestored === undefined
      ? (loaded ?? { phase: "open", notes: [] })
      : { phase: "unrestored", reason: ctx.unrestored },
    [],
  ],
  update: {
    add: (s, m) => [
      s.phase === "open" ? { ...s, notes: [...s.notes, m.text] } : s,
      [],
    ],
  },
});

/** `null` when nothing was saved; a refusal for bytes that are not notes. */
export function parseNotes(raw: unknown): Migrated<NotesState> {
  if (raw === null) return null;
  const saved = raw as { phase?: unknown; notes?: unknown };
  return saved.phase === "open" && Array.isArray(saved.notes)
    ? { phase: "open", notes: saved.notes.map(String) }
    : refuse("the saved notes are not a note list");
}

/** Open the notes, or the "couldn't restore" view when the store refuses. */
export async function openNotes(store: Store<NotesState>) {
  try {
    return await run(notes, { ctx: {}, store }).ready;
  } catch (err) {
    if (!(err instanceof StoreRefusedError)) throw err;
    // Nothing was written, so the saved bytes are exactly as they were. The
    // view runs with no store, so nothing it does can save over them either.
    return await run(notes, { ctx: { unrestored: err.reason } }).ready;
  }
}
```

Hand it any store, for example `fileStore("notes.json", parseNotes)` from
`@demlik/tea/node`. When the file holds notes, you get them. When it holds
something else, you get `{ phase: "unrestored", reason }` and the file is left
alone.

## 3. Read what went wrong

`err.reason` is the string your `refuse` gave, or a line naming the throw. When
`load` or `migrate` threw, `err.cause` is that throw. Log it, or show it in the
view.

The Effect engine refuses the same way: the handle's `ready` rejects with the
same `StoreRefusedError`, so the same `catch` works there.

See [Make a machine durable](./make-durable.md) for the `Store` seam itself.
