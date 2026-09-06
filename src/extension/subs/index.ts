// ---------------------------------------------------------------------------
// Chrome-specific Sub factories, published on the `@demlik/tea/extension` door,
// which re-exports this barrel (#51: the `/extension/subs` door closed and its
// parts moved up, per ADR 0016).
//
// Companion to the universal, host-agnostic factories in `src/subs/`. The
// factories here depend on `chrome.*` globals: alarms, tabs, storage,
// runtime messaging. They absorb the recurring
// `(sub, ctx, dispatch) => cleanup` shape of every Sub that wraps a chrome
// surface, so call sites in `machine.subscribe[type]` keep the intent
// (which Msg, which alarm/event/area/filter) while the factory owns the
// lifecycle (subscribe + cleanup, plus the standard filters chrome
// requires).
//
// Module separation rationale: the rest of `@demlik/tea/extension` is the host
// adapter — chromeStorageStore and the bridge runtime — and the factories that
// touch the broader chrome.* surface (alarms, tabs, runtime messaging, storage
// events) are kept in this leaf so the two halves stay legible. They now
// publish through the one extension door; a bundle that names no factory shakes
// them out, which is the isolation the second subpath used to buy.
//
// Excluded from v1:
//   - fromChromePort (chrome.runtime.connect) — different lifecycle
//     (connection-oriented) that doesn't fit the same shape; revisit if
//     a consumer reaches for it.
//   - fromChromeAction, fromChromeContextMenus, fromChromeIdle — niche;
//     earn each via a real consumer call site.
//
// Strengthens invariant 9 (the surface for chrome-specific Sub topologies
// is named, small, and exported from one module).
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
