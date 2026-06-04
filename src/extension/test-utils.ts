/**
 * In-memory `chrome.*` mock for tests in this package and any downstream
 * consumer that wants to test against `chromeStorageStore` behavior without
 * a real chrome environment.
 *
 * Currently exposes `chrome.storage.local`, `chrome.runtime` (sendMessage +
 * onMessage), and `chrome.tabs` (sendMessage). The `runtime` and `tabs`
 * surfaces are used by the runtime-bridge tests (`bridge.ts`) to round-trip
 * envelopes between a host runtime and a surface client (sw↔surface) and
 * between a sw client and a per-tab content-script runtime (sw↔content).
 *
 * Extend additional surfaces (alarms, windows, …) only when real consumer
 * tests reach for them — earn each surface through a concrete need.
 */

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors the chrome.runtime.onMessage listener return type (boolean | undefined | void)
) => boolean | undefined | void;

type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: chrome.storage.AreaName,
) => void;

type AlarmListener = (alarm: chrome.alarms.Alarm) => void;

type TabActivatedListener = (info: chrome.tabs.OnActivatedInfo) => void;
type TabUpdatedListener = (
  tabId: number,
  changeInfo: chrome.tabs.OnUpdatedInfo,
  tab: chrome.tabs.Tab,
) => void;
type TabRemovedListener = (
  tabId: number,
  removeInfo: chrome.tabs.OnRemovedInfo,
) => void;

export interface FakeChrome {
  storage: {
    local: chrome.storage.StorageArea;
    /**
     * Top-level `chrome.storage.onChanged` event. Fires for ANY area; consumer
     * filters by the `areaName` arg. Real chrome semantics: every `set` /
     * `remove` / `clear` that materially changes a key emits a single
     * `changes` map keyed by the changed keys.
     */
    onChanged: {
      addListener(listener: StorageChangeListener): void;
      removeListener(listener: StorageChangeListener): void;
      hasListener(listener: StorageChangeListener): boolean;
      hasListeners(): boolean;
    };
  };
  // Subset of `typeof chrome.runtime` covered by the fake — chrome's
  // ambient typings don't export a single `Runtime` interface, so we
  // declare the surface inline. Extend when tests reach for more.
  runtime: {
    sendMessage: typeof chrome.runtime.sendMessage;
    onMessage: typeof chrome.runtime.onMessage;
  };
  tabs: {
    sendMessage: typeof chrome.tabs.sendMessage;
    /**
     * `chrome.tabs.onActivated` — fires when the active tab in a window
     * changes. The fake only models the listener registry; tests drive
     * fires via `__test.fireTabActivated(info)`.
     */
    onActivated: {
      addListener(listener: TabActivatedListener): void;
      removeListener(listener: TabActivatedListener): void;
      hasListener(listener: TabActivatedListener): boolean;
      hasListeners(): boolean;
    };
    /**
     * `chrome.tabs.onUpdated` — fires when a tab is updated (url, title,
     * status, etc.). Tests drive fires via `__test.fireTabUpdated(...)`.
     */
    onUpdated: {
      addListener(listener: TabUpdatedListener): void;
      removeListener(listener: TabUpdatedListener): void;
      hasListener(listener: TabUpdatedListener): boolean;
      hasListeners(): boolean;
    };
    /**
     * `chrome.tabs.onRemoved` — fires when a tab is closed. Tests drive
     * fires via `__test.fireTabRemoved(...)`.
     */
    onRemoved: {
      addListener(listener: TabRemovedListener): void;
      removeListener(listener: TabRemovedListener): void;
      hasListener(listener: TabRemovedListener): boolean;
      hasListeners(): boolean;
    };
  };
  /**
   * `chrome.alarms` — the MV3 periodic timer primitive. The fake tracks
   * created alarms in a Map keyed by name, models `create` (dedupe by
   * name) + `clear` (remove from map), and exposes `onAlarm` as a
   * standard listener registry. Tests drive fires via
   * `__test.fireAlarm(name)`.
   */
  alarms: {
    create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): void;
    /**
     * `chrome.alarms.get(name)` — resolves to the Alarm shape Chrome would
     * return (with `scheduledTime` synthesized at lookup time), or
     * undefined if no alarm with that name exists. Mirrors the contract
     * the `ensureQueueAlarm` SW-module-top-level helper checks ("is this
     * alarm already present with the right period?") — see
     * `apps/extension/extension/entrypoints/background.ts`.
     */
    get(name: string): Promise<chrome.alarms.Alarm | undefined>;
    clear(name: string): Promise<boolean>;
    onAlarm: {
      addListener(listener: AlarmListener): void;
      removeListener(listener: AlarmListener): void;
      hasListener(listener: AlarmListener): boolean;
      hasListeners(): boolean;
    };
  };
  /**
   * Test helpers — not part of the real chrome surface. Lets tests
   * simulate a content script issuing `chrome.runtime.sendMessage` from
   * inside a specific tab (chrome auto-tags `sender.tab.id` in that
   * direction) and remove a tab so `chrome.tabs.sendMessage` rejects
   * the way real chrome does when the receiver is gone.
   */
  __test: {
    /** Simulate a content-script broadcast tagged with `sender.tab.id`. */
    sendFromTab(tabId: number, message: unknown): Promise<unknown>;
    /** Mark a tab as gone — `chrome.tabs.sendMessage(tabId, …)` will reject. */
    removeTab(tabId: number): void;
    /** Mark a tab as alive (default for any tabId that hasn't been removed). */
    addTab(tabId: number): void;
    /** Fire an alarm — invokes every onAlarm listener with `{ name, ...}`. */
    fireAlarm(name: string): void;
    /** Snapshot the alarm registry — tests assert on created/cleared alarms. */
    getAlarms(): readonly string[];
    /** Fire `chrome.tabs.onActivated` — drives every listener. */
    fireTabActivated(info: chrome.tabs.OnActivatedInfo): void;
    /** Fire `chrome.tabs.onUpdated` — drives every listener. */
    fireTabUpdated(
      tabId: number,
      changeInfo: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ): void;
    /** Fire `chrome.tabs.onRemoved` — drives every listener. */
    fireTabRemoved(tabId: number, removeInfo: chrome.tabs.OnRemovedInfo): void;
  };
}

export function fakeChrome(): FakeChrome {
  const data = new Map<string, unknown>();

  // ─── chrome.storage.onChanged — top-level event ───────────────────────
  //
  // Real chrome emits `changes` keyed by every key that actually changed
  // (oldValue / newValue present). Unchanged keys aren't included. The
  // fake mirrors that: build the change map inside set/remove/clear, fire
  // listeners only if the map is non-empty. AreaName is "local" here —
  // the fake only models storage.local; if a future test reaches for
  // session/sync, add a per-area fake with its own onChanged.
  const storageListeners = new Set<StorageChangeListener>();
  function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object" || a === null || b === null) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function fireStorageChange(
    changes: Record<string, chrome.storage.StorageChange>,
  ): void {
    if (Object.keys(changes).length === 0) return;
    for (const listener of Array.from(storageListeners)) {
      listener(changes, "local");
    }
  }

  const partial = {
    async get(
      keys?: string | string[] | Record<string, unknown> | null,
    ): Promise<Record<string, unknown>> {
      // get()              → all entries
      // get("k")           → { k: v } if present, {} otherwise
      // get(["k1","k2"])   → { k: v } for present keys
      // get({ k: default}) → { k: v ?? default } per key
      if (keys === undefined || keys === null) {
        return Object.fromEntries(data);
      }
      if (typeof keys === "string") {
        const v = data.get(keys);
        return v === undefined ? {} : { [keys]: v };
      }
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys.flatMap((k) => (data.has(k) ? [[k, data.get(k)]] : [])),
        );
      }
      const out: Record<string, unknown> = {};
      for (const [k, def] of Object.entries(keys)) {
        out[k] = data.has(k) ? data.get(k) : def;
      }
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of Object.entries(items)) {
        const prev = data.get(k);
        // Real chrome only fires onChanged when the value actually
        // changes — match that to avoid spurious re-renders in tests.
        if (deepEqual(prev, v)) continue;
        const change: chrome.storage.StorageChange = { newValue: v };
        if (data.has(k)) change.oldValue = prev;
        changes[k] = change;
        data.set(k, v);
      }
      fireStorageChange(changes);
    },
    async remove(keys: string | string[]): Promise<void> {
      const arr = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const k of arr) {
        if (!data.has(k)) continue;
        changes[k] = { oldValue: data.get(k) };
        data.delete(k);
      }
      fireStorageChange(changes);
    },
    async clear(): Promise<void> {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of data) changes[k] = { oldValue: v };
      data.clear();
      fireStorageChange(changes);
    },
  };

  // The full `chrome.storage.StorageArea` contract has more surface
  // (getBytesInUse, getKeys, onChanged event, setAccessLevel) than real
  // consumer tests currently exercise. The cast is local to this test util;
  // src/index.ts never casts. If a test needs more surface, implement it
  // here instead of widening the cast.
  const local = partial as unknown as chrome.storage.StorageArea;

  // ─── chrome.runtime — sendMessage + onMessage round-trip ───────────────
  //
  // The fake mirrors MV3 semantics that matter for the bridge:
  //   - sendMessage delivers to EVERY onMessage listener in arrival order.
  //   - The first listener that returns `true` (or calls sendResponse
  //     synchronously) "wins" — its sendResponse value resolves the
  //     sendMessage promise. Listeners that return false/undefined are
  //     passed over.
  //   - If no listener handles the message, sendMessage rejects with the
  //     same shape chrome uses ("Could not establish connection.
  //     Receiving end does not exist."). The bridge's broadcast path
  //     swallows this.
  const runtimeListeners = new Set<RuntimeListener>();

  // Tracks tabs that are "alive" from `chrome.tabs.sendMessage`'s point of
  // view. Unknown tabIds are treated as alive by default (matches the
  // common test path: assign a number, send to it). Tests can `removeTab`
  // to simulate disconnection.
  const removedTabs = new Set<number>();

  /**
   * Internal dispatch helper. Real chrome distinguishes:
   *   - `chrome.runtime.sendMessage(msg)` — sender is the extension origin,
   *     `sender.tab` is undefined; all `chrome.runtime.onMessage` listeners
   *     hear it.
   *   - `chrome.tabs.sendMessage(tabId, msg)` — sender is the extension
   *     origin (still no `sender.tab` on the receiving end's view here, but
   *     the routing is by tab); only listeners IN that tab receive it. Our
   *     fake collapses to the same listener set since tests run a single
   *     "tab" of listeners at a time. The routing assertion is enforced by
   *     callers reading the envelope/tabId pair they sent.
   *   - Content-script `chrome.runtime.sendMessage(msg)` (the `sendFromTab`
   *     helper) — chrome auto-tags `sender.tab.id`. SW-side listeners use
   *     this to filter cross-tab broadcasts.
   *
   * `sender` controls which sender object the listeners see.
   */
  const dispatch = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      let responded = false;
      const sendResponse = (response: unknown): void => {
        if (responded) return;
        responded = true;
        resolve(response);
      };
      const snapshot = Array.from(runtimeListeners);
      let willRespondAsync = false;
      for (const listener of snapshot) {
        const r = listener(message, sender, sendResponse);
        if (r === true) willRespondAsync = true;
        if (responded) return;
      }
      if (willRespondAsync) return;
      reject(
        new Error(
          "Could not establish connection. Receiving end does not exist.",
        ),
      );
    });
  };

  const extensionSender: chrome.runtime.MessageSender =
    {} as chrome.runtime.MessageSender;

  const runtimePartial = {
    sendMessage(message: unknown): Promise<unknown> {
      return dispatch(message, extensionSender);
    },
    onMessage: {
      addListener(listener: RuntimeListener): void {
        runtimeListeners.add(listener);
      },
      removeListener(listener: RuntimeListener): void {
        runtimeListeners.delete(listener);
      },
      hasListener(listener: RuntimeListener): boolean {
        return runtimeListeners.has(listener);
      },
      hasListeners(): boolean {
        return runtimeListeners.size > 0;
      },
    },
  };

  const runtime = runtimePartial as unknown as FakeChrome["runtime"];

  // ─── chrome.tabs.sendMessage — SW → content-script routing ─────────────
  //
  // Real chrome routes by tabId; the receiving content script's
  // `chrome.runtime.onMessage` fires with `sender` representing the
  // extension (no `sender.tab`). The fake collapses to the shared listener
  // set since tests run one runtime per process, but enforces the
  // "tab gone" reject so consumers can verify their fire-and-forget
  // posture.
  const tabsPartial = {
    sendMessage(tabId: number, message: unknown): Promise<unknown> {
      if (removedTabs.has(tabId)) {
        return Promise.reject(
          new Error(
            `Could not establish connection. Receiving end does not exist. (tabId=${tabId})`,
          ),
        );
      }
      return dispatch(message, extensionSender);
    },
  };

  // ─── chrome.tabs.on{Activated,Updated,Removed} — listener registries ────
  //
  // Tests drive fires via the __test helpers below. Production-code Sub
  // factories register/unregister; the fake only models the registry +
  // dispatch, not the chrome events themselves (no real tabs to observe).
  const tabActivatedListeners = new Set<TabActivatedListener>();
  const tabUpdatedListeners = new Set<TabUpdatedListener>();
  const tabRemovedListeners = new Set<TabRemovedListener>();

  const tabsFull = {
    ...tabsPartial,
    onActivated: {
      addListener(listener: TabActivatedListener): void {
        tabActivatedListeners.add(listener);
      },
      removeListener(listener: TabActivatedListener): void {
        tabActivatedListeners.delete(listener);
      },
      hasListener(listener: TabActivatedListener): boolean {
        return tabActivatedListeners.has(listener);
      },
      hasListeners(): boolean {
        return tabActivatedListeners.size > 0;
      },
    },
    onUpdated: {
      addListener(listener: TabUpdatedListener): void {
        tabUpdatedListeners.add(listener);
      },
      removeListener(listener: TabUpdatedListener): void {
        tabUpdatedListeners.delete(listener);
      },
      hasListener(listener: TabUpdatedListener): boolean {
        return tabUpdatedListeners.has(listener);
      },
      hasListeners(): boolean {
        return tabUpdatedListeners.size > 0;
      },
    },
    onRemoved: {
      addListener(listener: TabRemovedListener): void {
        tabRemovedListeners.add(listener);
      },
      removeListener(listener: TabRemovedListener): void {
        tabRemovedListeners.delete(listener);
      },
      hasListener(listener: TabRemovedListener): boolean {
        return tabRemovedListeners.has(listener);
      },
      hasListeners(): boolean {
        return tabRemovedListeners.size > 0;
      },
    },
  };

  const tabs = tabsFull as unknown as FakeChrome["tabs"];

  // ─── chrome.alarms — listener registry + name-keyed alarm map ─────────
  //
  // create(name, info) stores `info` keyed by name (dedupe on repeat —
  // matches real chrome's behavior of replacing the prior alarm). clear()
  // removes from the map and resolves to `true` if the alarm existed,
  // `false` otherwise (matches real chrome's contract). onAlarm is a
  // standard listener registry. The fake does NOT auto-fire alarms based
  // on `periodInMinutes` — tests drive fires deterministically via
  // `__test.fireAlarm(name)`.
  const alarmMap = new Map<string, chrome.alarms.AlarmCreateInfo>();
  const alarmListeners = new Set<AlarmListener>();

  const alarms: FakeChrome["alarms"] = {
    create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): void {
      alarmMap.set(name, alarmInfo);
    },
    async get(name: string): Promise<chrome.alarms.Alarm | undefined> {
      const info = alarmMap.get(name);
      if (info === undefined) return undefined;
      return {
        name,
        scheduledTime: Date.now(),
        periodInMinutes: info.periodInMinutes,
      };
    },
    async clear(name: string): Promise<boolean> {
      return alarmMap.delete(name);
    },
    onAlarm: {
      addListener(listener: AlarmListener): void {
        alarmListeners.add(listener);
      },
      removeListener(listener: AlarmListener): void {
        alarmListeners.delete(listener);
      },
      hasListener(listener: AlarmListener): boolean {
        return alarmListeners.has(listener);
      },
      hasListeners(): boolean {
        return alarmListeners.size > 0;
      },
    },
  };

  return {
    storage: {
      local,
      onChanged: {
        addListener(listener: StorageChangeListener): void {
          storageListeners.add(listener);
        },
        removeListener(listener: StorageChangeListener): void {
          storageListeners.delete(listener);
        },
        hasListener(listener: StorageChangeListener): boolean {
          return storageListeners.has(listener);
        },
        hasListeners(): boolean {
          return storageListeners.size > 0;
        },
      },
    },
    runtime,
    tabs,
    alarms,
    __test: {
      sendFromTab(tabId: number, message: unknown): Promise<unknown> {
        const taggedSender = {
          tab: { id: tabId },
        } as chrome.runtime.MessageSender;
        return dispatch(message, taggedSender);
      },
      removeTab(tabId: number): void {
        removedTabs.add(tabId);
      },
      addTab(tabId: number): void {
        removedTabs.delete(tabId);
      },
      fireAlarm(name: string): void {
        const info = alarmMap.get(name);
        if (info === undefined) return;
        // Real chrome's Alarm shape carries `name`, `scheduledTime`, and
        // `periodInMinutes`. The fake stamps `scheduledTime` at fire time
        // and forwards the period from the create call.
        const alarm: chrome.alarms.Alarm = {
          name,
          scheduledTime: Date.now(),
          periodInMinutes: info.periodInMinutes,
        };
        for (const listener of Array.from(alarmListeners)) {
          listener(alarm);
        }
      },
      getAlarms(): readonly string[] {
        return Array.from(alarmMap.keys());
      },
      fireTabActivated(info: chrome.tabs.OnActivatedInfo): void {
        for (const listener of Array.from(tabActivatedListeners)) {
          listener(info);
        }
      },
      fireTabUpdated(
        tabId: number,
        changeInfo: chrome.tabs.OnUpdatedInfo,
        tab: chrome.tabs.Tab,
      ): void {
        for (const listener of Array.from(tabUpdatedListeners)) {
          listener(tabId, changeInfo, tab);
        }
      },
      fireTabRemoved(
        tabId: number,
        removeInfo: chrome.tabs.OnRemovedInfo,
      ): void {
        for (const listener of Array.from(tabRemovedListeners)) {
          listener(tabId, removeInfo);
        }
      },
    },
  };
}
