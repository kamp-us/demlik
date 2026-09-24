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
