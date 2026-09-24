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
