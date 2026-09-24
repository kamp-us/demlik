// ---------------------------------------------------------------------------
// fromBroadcastChannel — universal `BroadcastChannel`-shaped Sub factory.
//
// `BroadcastChannel` is a same-origin pub/sub primitive available in
// every modern browser context (window, worker, service worker) AND in
// Cloudflare Workers (with origin scoped to the worker isolate). The
// constructor opens the channel; the `message` event fires whenever
// another participant on the same channel name posts a message; the
// `close()` method releases the OS resource.
//
// The factory reads `channelName` off the Sub's `deps` (not the closure)
// so the same factory instance handles every BroadcastChannel Sub in a
// machine — one Sub per channel, sharing the factory's lifecycle code.
// A renamed channel is a changed deps value, so a new id: the engine
// closes the old channel and opens the new one.
//
// `msgFn` returns `M | null` — same drop-on-null pattern as
// `fromEventTarget`. The MessageEvent's `data` is `unknown` from the
// platform's perspective; the caller decides whether the payload is a
// recognizable shape, and returns `null` to drop unknown messages
// without polluting the reducer with parse-discard cells.
//
// Cleanup calls `channel.close()`, which removes the listener AND
// releases the channel reference — `removeEventListener` alone would
// leak the BroadcastChannel handle. The pair is intentional.
// ---------------------------------------------------------------------------

import type { Sub } from "../index";
import type {
  MinimalBroadcastChannelCtor,
  MinimalMessageEvent,
} from "./platform";
import { dispatchIfPresent, type SubscribeHandler } from "./types";

type BroadcastSubData = { readonly channelName: string };

declare const BroadcastChannel: MinimalBroadcastChannelCtor;

export function fromBroadcastChannel<
  S extends Sub<string, BroadcastSubData>,
  M,
>(
  msgFn: (event: MinimalMessageEvent, sub: S) => M | null,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const channel = new BroadcastChannel(sub.deps.channelName);
    const listener = (event: MinimalMessageEvent): void => {
      dispatchIfPresent(dispatch, msgFn(event, sub));
    };
    channel.addEventListener("message", listener);
    return () => {
      channel.removeEventListener("message", listener);
      channel.close();
    };
  };
}
