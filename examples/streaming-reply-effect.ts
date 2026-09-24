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
