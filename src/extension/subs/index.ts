// ---------------------------------------------------------------------------
// @demlik/tea/extension/subs — Chrome-specific Sub factories.
//
// Companion to @demlik/tea/subs (the universal factories, host-agnostic). The
// factories here depend on `chrome.*` globals: alarms, tabs, storage,
// runtime messaging. They absorb the recurring
// `(sub, ctx, dispatch) => cleanup` shape of every Sub that wraps a chrome
// surface, so call sites in `machine.subscribe[type]` keep the intent
// (which Msg, which alarm/event/area/filter) while the factory owns the
// lifecycle (subscribe + cleanup, plus the standard filters chrome
// requires).
//
// Subpath separation rationale (mirrors `@demlik/tea/subs` and
// `@demlik/tea/testing`): the main `@demlik/tea/extension` entry is the host
// adapter — chromeStorageStore and the bridge runtime — that pure
// substrate tests can import without dragging in factory plumbing.
// Factories that touch the broader chrome.* surface (alarms, tabs,
// runtime messaging, storage events) live behind this subpath; importers
// opt in.
//
// Excluded from v1:
//   - fromChromePort (chrome.runtime.connect) — different lifecycle
//     (connection-oriented) that doesn't fit the same shape; revisit if
//     a consumer reaches for it.
//   - fromChromeAction, fromChromeContextMenus, fromChromeIdle — niche;
//     earn each via a real consumer call site.
//
// Strengthens invariant 9 (the surface for chrome-specific Sub topologies
// is named, small, and exported from one subpath).
// ---------------------------------------------------------------------------

export { fromChromeAlarm } from "./from-chrome-alarm";
export {
  type ChromeMessageOpts,
  fromChromeMessage,
} from "./from-chrome-message";
export {
  type ChromeStorageChangeOpts,
  fromChromeStorageChange,
} from "./from-chrome-storage-change";
export {
  type ChromeTabsEventOpts,
  fromChromeTabsEvent,
  type TabsEventName,
} from "./from-chrome-tabs-event";
