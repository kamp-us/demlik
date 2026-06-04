// ---------------------------------------------------------------------------
// fromChromeStorageChange — universal `chrome.storage.onChanged`-shaped Sub
// factory.
//
// `chrome.storage.onChanged` is the top-level event that fires for every
// area (`local`, `sync`, `session`, `managed`) — the listener receives
// `(changes, areaName)`. Consumers typically care about ONE area and often
// only a subset of keys; without a filter, every listener wakes for every
// change anywhere in the extension's storage. The factory absorbs the
// addListener/removeListener pair PLUS the standard area/key filter.
//
// Shape choices:
//
//   - `area: chrome.storage.AreaName` — required. Chrome's typing covers
//     "local" | "sync" | "session" | "managed". The factory drops every
//     fire where `areaName !== opts.area`.
//
//   - `keys?: readonly string[]` — optional intersection filter. When
//     provided, the factory drops fires where none of the changed keys
//     overlaps with the requested set. Omitting means "any key in the
//     area". The filter is `O(keys × changes)` per fire — acceptable for
//     small key lists (typical: 1-5 keys per Sub).
//
//   - `msgFn` may return `null` — drops the dispatch even after the
//     area/keys filters pass. Gives the caller a final hook for
//     state-aware filtering (e.g. "only when the new value is
//     truthy").
//
// Strengthens invariant 9 (named, small surface) and invariant 2 (the
// reducer never sees chrome.storage; the factory owns the wiring).
// ---------------------------------------------------------------------------

import type { Sub } from "../../index";
import type { SubscribeHandler } from "../../subs/index";

export interface ChromeStorageChangeOpts<S extends Sub, M> {
  area: chrome.storage.AreaName;
  /**
   * If provided, only dispatch when at least one of the changed keys
   * overlaps with this set. Omitting means "any key in the area".
   */
  keys?: readonly string[];
  msgFn: (
    changes: Record<string, chrome.storage.StorageChange>,
    sub: S,
  ) => M | null;
}

export function fromChromeStorageChange<S extends Sub, M>(
  opts: ChromeStorageChangeOpts<S, M>,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: chrome.storage.AreaName,
    ): void => {
      if (areaName !== opts.area) return;
      if (opts.keys !== undefined) {
        // Intersect — at least one changed key must be in opts.keys.
        // Using a small list scan over Object.keys(changes) avoids
        // allocating a Set per fire for the typical 1-5 key case.
        const changedKeys = Object.keys(changes);
        let overlap = false;
        for (const k of opts.keys) {
          if (changedKeys.includes(k)) {
            overlap = true;
            break;
          }
        }
        if (!overlap) return;
      }
      const msg = opts.msgFn(changes, sub);
      if (msg !== null) dispatch(msg);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  };
}
