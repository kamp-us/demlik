import { defineMachine, type Store } from "@demlik/tea";

/** An agent reply that arrives one token at a time. */
export interface ReplyState {
  readonly phase: "idle" | "streaming" | "done";
  readonly text: string;
}

export type ReplyMsg =
  | { readonly type: "start" }
  | { readonly type: "token"; readonly text: string }
  | { readonly type: "finish" };

export const reply = defineMachine({
  types: { model: {} as ReplyState, msg: {} as ReplyMsg },
  init: (loaded) => [loaded ?? { phase: "idle", text: "" }, []],
  update: {
    start: (s) => [{ ...s, phase: "streaming", text: "" }, []],
    token: (s, m) => [{ ...s, text: s.text + m.text }, []],
    finish: (s) => [{ ...s, phase: "done" }, []],
  },
});

/** A reply mid-stream is short-lived: the next token replaces it. */
export const isStreaming = (state: ReplyState) => state.phase === "streaming";

/**
 * Wrap a Store so `save` does nothing while `isTransient(state)` holds.
 * The store keeps the last state worth keeping.
 */
export function skipSaving<S>(
  store: Store<S>,
  isTransient: (state: S) => boolean,
): Store<S> {
  return {
    load: () => store.load(),
    save: (state) =>
      isTransient(state) ? Promise.resolve() : store.save(state),
    migrate: (raw) => store.migrate(raw),
  };
}
