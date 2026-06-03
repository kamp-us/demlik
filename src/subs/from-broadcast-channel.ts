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
// The factory carries `channelName` on the Sub itself (not in the
// closure) so the same factory instance handles every BroadcastChannel
// Sub in a machine — one Sub per channel, named by id, sharing the
// factory's lifecycle code. Renaming a channel requires a new Sub.id
// (the reconcile pass otherwise leaves the existing channel open).
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
import type { MinimalBroadcastChannelCtor, MinimalMessageEvent } from "./platform";
import type { SubscribeHandler } from "./types";

type BroadcastSubData = { channelName: string };

declare const BroadcastChannel: MinimalBroadcastChannelCtor;

export function fromBroadcastChannel<S extends Sub & BroadcastSubData, M>(
  msgFn: (event: MinimalMessageEvent, sub: S) => M | null,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const channel = new BroadcastChannel(sub.channelName);
    const listener = (event: MinimalMessageEvent): void => {
      const msg = msgFn(event, sub);
      if (msg !== null) dispatch(msg);
    };
    channel.addEventListener("message", listener);
    return () => {
      channel.removeEventListener("message", listener);
      channel.close();
    };
  };
}
