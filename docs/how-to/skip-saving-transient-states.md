# Skip saving short-lived states

`run` saves the Model after every transition. For a machine that streams an
agent reply one token at a time, that is one write per token. The in-between
states are not worth keeping: the next token replaces each one.

tea has no option for this, and needs none. Wrap your `Store` so its `save`
does nothing while the state is short-lived. The wrapper is a plain function
over a `Store`, so the same one works on both engines.

## 1. Write the wrapper beside the machine

The machine below streams a reply. `isStreaming` says which states are
short-lived, and `skipSaving` wraps any `Store` so it only writes the others:

```ts
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
```

## 2. Hand the wrapped store to `run`

On the Promise engine:

```ts
import type { Store } from "@demlik/tea";
import { run } from "@demlik/tea/promise";
import {
  isStreaming,
  type ReplyState,
  reply,
  skipSaving,
} from "./streaming-reply";

/** Stream one reply on the Promise engine. Only lasting states are saved. */
export async function streamReply(
  store: Store<ReplyState>,
  tokens: readonly string[],
) {
  const runtime = await run(reply, {
    store: skipSaving(store, isStreaming),
  }).ready;
  try {
    await runtime.dispatch({ type: "start" });
    for (const text of tokens) await runtime.dispatch({ type: "token", text });
    await runtime.dispatch({ type: "finish" });
    return runtime.getState();
  } finally {
    await runtime.stop();
  }
}
```

On the Effect engine, the wrapper is the same call:

```ts
import type { Store } from "@demlik/tea";
import { run } from "@demlik/tea/effect";
import { Effect } from "effect";
import {
  isStreaming,
  type ReplyState,
  reply,
  skipSaving,
} from "./streaming-reply";

/** Stream one reply on the Effect engine. Only lasting states are saved. */
export const streamReply = (
  store: Store<ReplyState>,
  tokens: readonly string[],
) =>
  Effect.gen(function* () {
    const handle = yield* run(reply, {
      store: skipSaving(store, isStreaming),
    });
    const runtime = yield* Effect.promise(() => handle.ready);
    yield* Effect.promise(async () => {
      await runtime.dispatch({ type: "start" });
      for (const text of tokens) {
        await runtime.dispatch({ type: "token", text });
      }
      await runtime.dispatch({ type: "finish" });
    });
    return runtime.getState();
  }).pipe(Effect.scoped);
```

Stream three tokens and the store sees three writes: `idle` at boot, `done` at
`finish`, and `done` again when the run stops. No `streaming` state reaches it,
and `load` returns the finished reply.

## What a skipped save means

- **A crash mid-stream resumes from the last saved state.** Here that is
  `idle`, so the reply starts over. That is the point: a half-streamed reply
  was never worth resuming.
- **A skipped state's Cmds still run.** Skipping the save does not skip the
  effects. After a crash, the run replays from the older state and may issue
  those Cmds again. Keep Cmds that must happen once out of short-lived states,
  or make their handlers safe to repeat.
- **`stop()` goes through the wrapper too.** If the run stops mid-stream, the
  final flush is skipped and the store keeps the last lasting state.
- **The wrapper drops fencing.** It returns a plain `Store`, so a fenced store
  (`{ fenced: true }`) loses its second-writer check once wrapped. Do not
  spread the inner store (`{ ...store, save }`) to keep it: `run` would then
  call the inner store's own fenced save and skip your filter.

The page's three files are `examples/streaming-reply.ts`,
`examples/streaming-reply-promise.ts` and `examples/streaming-reply-effect.ts`.
