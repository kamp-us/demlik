// ---------------------------------------------------------------------------
// fromChromeMessage — universal `chrome.runtime.onMessage`-shaped Sub
// factory.
//
// `chrome.runtime.onMessage` is the extension's intra-process message bus:
// the service worker receives broadcasts from popup, options, content
// scripts, and the WebApp's `chrome.runtime.sendMessage` calls. Every
// listener wakes for every message; consumers filter by shape (the message
// is `unknown` to chrome — only the participants share a schema).
//
// Shape choices:
//
//   - `filter?: (message: unknown) => boolean` — optional pre-filter that
//     runs BEFORE `msgFn`. The factory drops the dispatch when `filter`
//     returns false. Use this for cheap discriminant checks (e.g.
//     `message.type === "ping"`) that short-circuit before the more
//     expensive Msg construction.
//
//   - `msgFn(message, sender, sub)` — both the message AND the sender
//     are forwarded. `sender` carries `tab.id` for content-script sends
//     and `id` for cross-extension sends; consumers that route by sender
//     (e.g. "only accept from this tab") need it. Returns `M | null`;
//     null drops the dispatch.
//
// What this factory deliberately does NOT do:
//
//   - It does not call `sendResponse` or return `true` from the listener
//     — that's the request/response shape, not the broadcast shape. A
//     factory that supports both would have to commit to a Promise<M>
//     return path, which couples to async-Cmd plumbing that's not in
//     scope for a Sub. Use a one-shot Cmd handler for request/response.
//
// Strengthens invariant 9 (named, small surface) and invariant 2 (the
// reducer never sees chrome.runtime.onMessage).
// ---------------------------------------------------------------------------

import type { Sub } from "../../index";
import type { SubscribeHandler } from "../../subs/index";

export interface ChromeMessageOpts<S extends Sub, M> {
  /**
   * Pre-filter — when provided, the factory only dispatches when this
   * returns `true`. Cheap discriminant checks belong here.
   */
  filter?: (message: unknown) => boolean;
  msgFn: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sub: S,
  ) => M | null;
}

export function fromChromeMessage<S extends Sub, M>(
  opts: ChromeMessageOpts<S, M>,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const listener = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      _sendResponse: (response: unknown) => void,
    ): void => {
      if (opts.filter !== undefined && !opts.filter(message)) return;
      const msg = opts.msgFn(message, sender, sub);
      if (msg !== null) dispatch(msg);
      // We intentionally do not return `true` here — that's the
      // request/response posture, not the broadcast posture. See the
      // module comment for the rationale.
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  };
}
