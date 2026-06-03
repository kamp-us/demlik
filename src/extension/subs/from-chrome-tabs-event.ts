// ---------------------------------------------------------------------------
// fromChromeTabsEvent — universal `chrome.tabs.on*`-shaped Sub factory.
//
// chrome.tabs exposes a small set of lifecycle events (`onActivated`,
// `onUpdated`, `onRemoved`) with different listener signatures but the
// same wiring shape: register listener, dispatch on fire, remove on
// cleanup. Most consumers subscribe to a SET of these events and treat
// every fire the same way (e.g. "tabs changed, please re-query"). The
// recurring ~20-line `addListener` × N + `removeListener` × N + optional
// mount-time refresh is what this factory absorbs.
//
// Three shape choices worth flagging:
//
//   - `events: readonly TabsEventName[]` — a SET (semantically), passed
//     as a tuple so the caller can be terse. The factory registers a
//     single listener per event name. The listener fires `msgFn(sub)`;
//     event-specific payloads (`activeInfo`, `tabId`, `changeInfo`,
//     `removeInfo`) are NOT forwarded — consumers that care about which
//     event fired model that as separate Subs with different ids.
//
//   - `fireOnMount?: boolean` — synthetic immediate dispatch at subscribe
//     time. Most "watch tabs" subscriptions need the first emission to
//     populate state without waiting for the first chrome event; this is
//     the named, opt-in form of the otherwise-recurring `void refresh()`
//     line at the top of every chrome-tabs subscribe cell. Default
//     `false` matches the surprise principle (no synthetic dispatch
//     unless the caller asks for one).
//
//   - `msgFn` may return `null` — drops the dispatch. The event fired,
//     the factory called `msgFn`, the caller decided "this event is not
//     interesting given current state." No dispatch is made; listeners
//     stay armed for the next fire.
//
// Cleanup removes listeners from every event the factory installed —
// not from the full `events` list, since a future edit could expand the
// list mid-Sub. Captured the resolved set at subscribe time.
//
// Strengthens invariant 9 (named, small surface) and invariant 2 (the
// reducer never sees chrome.tabs; the factory owns the wiring).
// ---------------------------------------------------------------------------

import type { Sub } from "../../index";
import type { SubscribeHandler } from "../../subs/index";

export type TabsEventName = "onActivated" | "onUpdated" | "onRemoved";

export interface ChromeTabsEventOpts<S extends Sub, M> {
  events: readonly TabsEventName[];
  /**
   * If `true`, the factory dispatches a synthetic `msgFn(sub)` once at
   * subscribe time — useful for "populate tab list on mount" patterns
   * where the first emission must not wait for chrome to fire an event.
   * Default `false`.
   */
  fireOnMount?: boolean;
  msgFn: (sub: S) => M | null;
}

// The chrome.tabs.on* events have different listener signatures
// (`activeInfo`, `(tabId, changeInfo, tab)`, `(tabId, removeInfo)`). We
// type the listener as accepting unknown args because the factory does
// not forward the event payload — every event collapses to `msgFn(sub)`.
type AnyTabsListener = (...args: unknown[]) => void;

export function fromChromeTabsEvent<S extends Sub, M>(
  opts: ChromeTabsEventOpts<S, M>,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const installed: TabsEventName[] = [];
    const listener: AnyTabsListener = () => {
      const msg = opts.msgFn(sub);
      if (msg !== null) dispatch(msg);
    };

    for (const event of opts.events) {
      // Each chrome.tabs.onX is a typed EventEmitter — addListener takes
      // a callback whose signature matches the event. Cast at the chrome
      // boundary since the factory collapses every payload shape into a
      // single `msgFn(sub)` call.
      const emitter = chrome.tabs[event] as chrome.events.Event<AnyTabsListener>;
      emitter.addListener(listener);
      installed.push(event);
    }

    if (opts.fireOnMount === true) {
      const msg = opts.msgFn(sub);
      if (msg !== null) dispatch(msg);
    }

    return () => {
      for (const event of installed) {
        const emitter = chrome.tabs[event] as chrome.events.Event<AnyTabsListener>;
        emitter.removeListener(listener);
      }
    };
  };
}
