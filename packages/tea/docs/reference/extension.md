# @demlik/tea/extension

> Chrome service-worker host adapter for @demlik/tea.

Tier: `stable`

```ts
import { … } from "@demlik/tea/extension";
```

## Exports (24)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`BackgroundRuntimeContext`](#BackgroundRuntimeContext) | Interface | stable | What `createBackgroundRuntimeContext` returns: a `Provider`, plus the `useState`, `useDispatch` and `useRuntime` hooks that read from it. |
| [`bridgeClient`](#bridgeClient) | Function | stable | Create a `BridgeClient` for a popup, side panel or content script, which talks to the background runtime over `chrome.runtime` messages. |
| [`BridgeClient`](#BridgeClient) | Interface | stable | A surface's handle on the background runtime: hydrate the current state, dispatch Msgs, and subscribe to state broadcasts. |
| [`BridgeClientOpts`](#BridgeClientOpts) | Interface | stable | Options for `bridgeClient`: the `channel` name and the required parsers for inbound state and Msgs. |
| [`bridgeRuntime`](#bridgeRuntime) | Function | stable | Install the bridge for a runtime. |
| [`BridgeRuntimeOpts`](#BridgeRuntimeOpts) | Interface | stable | Options for `bridgeRuntime`: the `channel` name, the required `parseMsg` for inbound Msgs, and an optional `serialize` for the state sent to surfaces. |
| [`bridgeTabClient`](#bridgeTabClient) | Function | stable | SW-side client of a `bridgeRuntime` hosted in a content script. |
| [`BridgeTabClientOpts`](#BridgeTabClientOpts) | Interface | stable | Options for `bridgeTabClient`: the target `tabId`, the `channel` name, and the required parsers. |
| [`ChromeMessageOpts`](#ChromeMessageOpts) | Interface | stable | Options for `fromChromeMessage`: an optional `filter`, and the `msgFn` that maps a runtime message to a Msg. |
| [`ChromeStorageChangeOpts`](#ChromeStorageChangeOpts) | Interface | stable | Options for `fromChromeStorageChange`: the storage `area`, an optional `keys` filter, and the `msgFn` that maps the changes to a Msg. |
| [`chromeStorageStore`](#chromeStorageStore) | Function | stable | `Store<S>` backed by `chrome.storage.local` (or any compatible `StorageArea`). |
| [`ChromeTabsEventOpts`](#ChromeTabsEventOpts) | Interface | stable | Options for `fromChromeTabsEvent`: which tab `events` to listen to, whether to fire once on mount, and the `msgFn` that builds the Msg. |
| [`createBackgroundRuntimeContext`](#createBackgroundRuntimeContext) | Function | stable | Create a React context that shares one background-runtime connection across a component tree. |
| [`fakeChrome`](#fakeChrome) | Function | stable | Create an in-memory fake of the `chrome` APIs this adapter uses. |
| [`FakeChrome`](#FakeChrome) | Interface | stable | The in-memory `chrome` stand-in `fakeChrome` returns, with `__test.fire*` helpers that drive its events from a test. |
| [`fromChromeAlarm`](#fromChromeAlarm) | Function | stable | Build a Sub runner that dispatches `msgFn(alarm, sub)` when the `chrome.alarms` alarm named `sub.deps.alarmName` fires. |
| [`fromChromeMessage`](#fromChromeMessage) | Function | stable | Build a Sub runner that dispatches a Msg for each `chrome.runtime.onMessage` message that passes the filter. |
| [`fromChromeStorageChange`](#fromChromeStorageChange) | Function | stable | Build a Sub runner that dispatches a Msg when keys change in a `chrome.storage` area. |
| [`fromChromeTabsEvent`](#fromChromeTabsEvent) | Function | stable | Build a Sub runner that dispatches `msgFn(sub)` whenever one of the chosen `chrome.tabs` events fires. |
| [`passThroughMsg`](#passThroughMsg) | Function | stable | The explicit opt-out of inbound msg parsing: an identity pass-through that casts the raw `unknown` to `M`. |
| [`TabsEventName`](#TabsEventName) | Type | stable | The `chrome.tabs` events `fromChromeTabsEvent` can listen to. |
| [`useBackgroundRuntime`](#useBackgroundRuntime) | Function | stable | React hook for an extension surface: it subscribes to the background runtime's state and returns it with a `dispatch`. |
| [`UseBackgroundRuntimeOpts`](#UseBackgroundRuntimeOpts) | Interface | stable | Options for `useBackgroundRuntime`: the `channel` name and the required `parseState`. |
| [`UseBackgroundRuntimeResult`](#UseBackgroundRuntimeResult) | Interface | stable | What `useBackgroundRuntime` returns: the latest `state`, which is `null` until the first one arrives, and `dispatch`. |

## Declarations

<a id="BackgroundRuntimeContext"></a>

### `BackgroundRuntimeContext`

```ts
interface BackgroundRuntimeContext<S, M> {
  /**
   * Wrap a subtree to share a single background-runtime bridge client.
   * `opts` is forwarded verbatim to `useBackgroundRuntime` — same channel,
   * same parse contract.
   */
  Provider: (
    props: {
      children: ReactNode;
      opts: UseBackgroundRuntimeOpts<S>;
    },
  ) => ReactNode;
  /**
   * Returns the dispatch function bound to this Provider's bridge client.
   * Reference is stable across renders (per `useBackgroundRuntime`'s
   * `useCallback`), so passing it to memoized children won't churn them.
   */
  useDispatch: () => (msg: M) => Promise<void>;
  /**
   * Escape hatch — returns the full `{ state, dispatch }` pair as-is.
   * Useful for consumers that want both the snapshot and the dispatch
   * fn in a single hook call (e.g. effects that read state THEN
   * dispatch in response).
   *
   * Not a `@demlik/tea` `Runtime<S, M>` — the bridge surface is a thinner
   * client. This hook returns the same shape as `useBackgroundRuntime`,
   * just sourced from context instead of mounting a fresh client.
   */
  useRuntime: () => UseBackgroundRuntimeResult<S, M>;
  /**
   * Returns a slice of the latest state. `selector` defaults to identity
   * (returns the whole `S | null` snapshot). Selectors run on every state
   * change — surfaces with expensive transforms should memoize the
   * selector at call site.
   *
   * Returns `null` until the first hydrate / broadcast lands when the
   * selector is identity; for non-identity selectors the return type is
   * `T` and the caller's selector decides how to handle the pre-hydrate
   * `null` snapshot.
   */
  useState: {
    (): S | null;
    <T>(selector: (state: S | null) => T): T;
  };
}
```

<a id="bridgeClient"></a>

### `bridgeClient`

```ts
function bridgeClient<S, M extends { type: string }>(
  __namedParameters: BridgeClientOpts<S, M>,
): BridgeClient<S, M>
```

<a id="BridgeClient"></a>

### `BridgeClient`

```ts
interface BridgeClient<S, M> {
  /** Send a dispatch envelope; resolves once the host's dispatch settles. */
  dispatch(msg: M): Promise<void>;
  /**
   * Synchronous accessor for the latest known state, or `null` until the
   * first successful hydrate or broadcast lands. Required reference stability
   * for `useSyncExternalStore`: returns the SAME object reference when the
   * underlying state hasn't changed since the prior call.
   */
  getSnapshot(): S | null;
  /**
   * Send the hydrate request; resolves with the initial snapshot (or null
   * if the host is still booting OR the response failed to parse). Also
   * primes `getSnapshot()` so React's `useSyncExternalStore` sees the
   * hydrated value on the next render.
   */
  hydrate(): Promise<S | null>;
  /**
   * Subscribe to broadcasts. Returns a cleanup function. Broadcasts whose
   * payload fails `parseState` or `parseMsg` are dropped silently — the
   * listener is not called. Each successful broadcast updates
   * `getSnapshot()`.
   */
  subscribe(listener: (msg: M | null, state: S) => void): () => void;
}
```

<a id="BridgeClientOpts"></a>

### `BridgeClientOpts`

```ts
interface BridgeClientOpts<S, M> {
  channel: string;
  /**
   * REQUIRED parse for inbound `msg` payloads on broadcasts. Chrome runtime
   * messages are an `unknown` boundary (Inv 8) just like the `state` payload,
   * so the msg crosses the same JSON serialization seam and must be parsed —
   * never cast. Returning `null` drops the broadcast silently.
   *
   * Surfaces that treat the msg union as advisory and only gate on state opt
   * out EXPLICITLY by passing the passThroughMsg helper — the opt-out
   * is now a visible call-site decision, not a hidden default that lets an
   * unparsed `unknown` reach listeners typed as `M`.
   */
  parseMsg: (raw: unknown) => M | null;
  /**
   * REQUIRED parse for inbound `state` payloads (from `:hydrate` reply AND
   * every broadcast). Chrome runtime messages are an `unknown` boundary
   * (Inv 8) — the surface is the only party that knows the domain type `S`,
   * so it owns the boundary parse. Returning `null` drops the payload
   * silently (subscriber not called; hydrate resolves to `null`). The
   * parser MUST NOT throw — model rejection as `null`.
   */
  parseState: (raw: unknown) => S | null;
}
```

<a id="bridgeRuntime"></a>

### `bridgeRuntime`

```ts
function bridgeRuntime<S, M extends { type: string }, V = S>(
  runtime: Runtime<S, M>,
  __namedParameters: BridgeRuntimeOpts<S, M, V>,
): () => void
```

<a id="BridgeRuntimeOpts"></a>

### `BridgeRuntimeOpts`

```ts
interface BridgeRuntimeOpts<S, M, V = S> {
  channel: string;
  /**
   * If > 0, the bridge composes a `historyTracker(runtime, size)` over the
   * runtime and returns the captured `(msg, state)` backlog in every
   * `:hydrate` reply. Late subscribers receive recent traffic on connect —
   * the inspector then sees prior tool calls / phase transitions instead
   * of just the current state snapshot.
   *
   * Defaults to 0 (no tracker, empty backlog). Composition stays opt-in:
   * the substrate is untouched, the dispatch loop is untouched, and the
   * bridge attaches the tracker only when this opt is set. Cleanup is
   * the bridge's responsibility — the disposer returned by `bridgeRuntime`
   * stops the tracker along with the observer.
   *
   * Memory cost: ~size × (msg + state) bytes, in-memory only, dies with
   * the bridge. Privacy: backlog entries flow to every `:hydrate` reply —
   * any surface that can hydrate sees them. Do not enable on bridges
   * carrying user secrets.
   */
  historySize?: number;
  /**
   * REQUIRED parse for inbound `msg` payloads on `:dispatch` envelopes.
   * Chrome runtime messages are an `unknown` boundary (Inv 8) — the same
   * JSON/chrome serialization seam the symmetric client side parses via
   * `BridgeClientOpts.parseMsg`. An untrusted surface can drive the host
   * reducer with an arbitrary `M`, so the host parses too — never casts. A
   * `msg` that parses to `null` is dropped: the dispatch never reaches the
   * reducer and the surface's `dispatch()` rejects with `{ ok: false }`.
   *
   * Hosts that trust the dispatch channel and treat the msg as opaque opt
   * out EXPLICITLY by passing the passThroughMsg helper — the unsound
   * cast is then a visible call-site decision, not a silent default.
   */
  parseMsg: (raw: unknown) => M | null;
  /**
   * Optional projection from the runtime's live state `S` to a JSON-safe
   * view `V` that goes over the wire (broadcast + hydrate). Required when
   * `S` carries non-serializable values (DOM refs, Map, Date, …).
   *
   * Identity passthrough by default — existing callers with POJO state pass
   * `serialize` unset and `V = S`.
   *
   * Wire shape with `serialize`:
   *   { type: channel, msg, state: serialize(currentState) }   // broadcast
   *   { type: hydrate } → { state: serialize(currentState) }    // hydrate
   *
   * Dispatch is NOT affected — it carries `M` end-to-end. Surfaces parse the
   * `V` they receive (they should pick a type parameter matching the
   * projection).
   */
  serialize?: (state: S) => V;
}
```

<a id="bridgeTabClient"></a>

### `bridgeTabClient`

```ts
function bridgeTabClient<S, M extends { type: string }>(
  __namedParameters: BridgeTabClientOpts<S, M>,
): BridgeClient<S, M>
```

<a id="BridgeTabClientOpts"></a>

### `BridgeTabClientOpts`

```ts
interface BridgeTabClientOpts<S, M> {
  channel: string;
  /**
   * REQUIRED parse for inbound `msg` payloads. See `BridgeClientOpts.parseMsg`
   * — same contract, same rationale. Opt out of msg parsing with
   * passThroughMsg.
   */
  parseMsg: (raw: unknown) => M | null;
  /**
   * REQUIRED parse for inbound `state` payloads. See `BridgeClientOpts.parseState`
   * — same contract, same rationale. Chrome runtime messages from a tab are
   * an `unknown` boundary; the SW client owns the parse.
   */
  parseState: (raw: unknown) => S | null;
  tabId: number;
}
```

<a id="ChromeMessageOpts"></a>

### `ChromeMessageOpts`

```ts
interface ChromeMessageOpts<S extends Sub, M> {
  /**
   * Pre-filter — when provided, the factory only dispatches when this
   * returns `true`. Cheap discriminant checks belong here.
   */
  filter?: (message: unknown) => boolean;
  msgFn: (message: unknown, sender: MessageSender, sub: S) => M | null;
}
```

<a id="ChromeStorageChangeOpts"></a>

### `ChromeStorageChangeOpts`

```ts
interface ChromeStorageChangeOpts<S extends Sub, M> {
  area: AreaName;
  /**
   * If provided, only dispatch when at least one of the changed keys
   * overlaps with this set. Omitting means "any key in the area".
   */
  keys?: readonly string[];
  msgFn: (changes: Record<string, chrome.storage.StorageChange>, sub: S) => M | null;
}
```

<a id="chromeStorageStore"></a>

### `chromeStorageStore`

```ts
function chromeStorageStore<S>(
  key: string,
  parse: (raw: unknown) => Migrated<S>,
  area?: StorageArea,
): Store<S>
```

<a id="ChromeTabsEventOpts"></a>

### `ChromeTabsEventOpts`

```ts
interface ChromeTabsEventOpts<S extends Sub, M> {
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
```

<a id="createBackgroundRuntimeContext"></a>

### `createBackgroundRuntimeContext`

```ts
function createBackgroundRuntimeContext<S, M extends { type: string }>(): BackgroundRuntimeContext<S, M>
```

<a id="fakeChrome"></a>

### `fakeChrome`

```ts
function fakeChrome(): FakeChrome
```

<a id="FakeChrome"></a>

### `FakeChrome`

```ts
interface FakeChrome {
  /**
   * Test helpers — not part of the real chrome surface. Lets tests
   * simulate a content script issuing `chrome.runtime.sendMessage` from
   * inside a specific tab (chrome auto-tags `sender.tab.id` in that
   * direction) and remove a tab so `chrome.tabs.sendMessage` rejects
   * the way real chrome does when the receiver is gone.
   */
  __test: {
    /** Mark a tab as alive (default for any tabId that hasn't been removed). */
    addTab(tabId: number): void;
    /** Fire an alarm — invokes every onAlarm listener with `{ name, ...}`. */
    fireAlarm(name: string): void;
    /** Fire `chrome.tabs.onActivated` — drives every listener. */
    fireTabActivated(info: OnActivatedInfo): void;
    /** Fire `chrome.tabs.onRemoved` — drives every listener. */
    fireTabRemoved(tabId: number, removeInfo: OnRemovedInfo): void;
    /** Fire `chrome.tabs.onUpdated` — drives every listener. */
    fireTabUpdated(tabId: number, changeInfo: OnUpdatedInfo, tab: Tab): void;
    /** Snapshot the alarm registry — tests assert on created/cleared alarms. */
    getAlarms(): readonly string[];
    /** Mark a tab as gone — `chrome.tabs.sendMessage(tabId, …)` will reject. */
    removeTab(tabId: number): void;
    /** Simulate a content-script broadcast tagged with `sender.tab.id`. */
    sendFromTab(tabId: number, message: unknown): Promise<unknown>;
  };
  /**
   * `chrome.alarms` — the MV3 periodic timer primitive. The fake tracks
   * created alarms in a Map keyed by name, models `create` (dedupe by
   * name) + `clear` (remove from map), and exposes `onAlarm` as a
   * standard listener registry. Tests drive fires via
   * `__test.fireAlarm(name)`.
   */
  alarms: {
    onAlarm: {
      addListener(listener: AlarmListener): void;
      hasListener(listener: AlarmListener): boolean;
      hasListeners(): boolean;
      removeListener(listener: AlarmListener): void;
    };
    clear(name: string): Promise<boolean>;
    create(name: string, alarmInfo: AlarmCreateInfo): void;
    /**
     * `chrome.alarms.get(name)` — resolves to the Alarm shape Chrome would
     * return (with `scheduledTime` synthesized at lookup time), or
     * undefined if no alarm with that name exists. Mirrors the contract
     * the `ensureQueueAlarm` SW-module-top-level helper checks ("is this
     * alarm already present with the right period?") — see
     * the extension's background entrypoint.
     */
    get(name: string): Promise<Alarm | undefined>;
  };
  runtime: {
    onMessage: Event<(
      message: any,
      sender: MessageSender,
      sendResponse: (response?: any) => void,
    ) => void>;
    /**
     * Sends a single message to event listeners within your extension or a different extension/app. Similar to runtime.connect but only sends a single message, with an optional response. If sending to your extension, the runtime.onMessage event will be fired in every frame of your extension (except for the sender's frame), or runtime.onMessageExternal, if a different extension. Note that extensions cannot send messages to content scripts using this method. To send messages to content scripts, use tabs.sendMessage.
     *
     * Can return its result via Promise in Manifest V3 or later since Chrome 99.
     */
    sendMessage: {
      <M = any, R = any>(message: M, options?: MessageOptions): Promise<R>;
      <M = any, R = any>(message: M, callback: (response: R) => void): void;
      <M = any, R = any>(
        message: M,
        options: MessageOptions | undefined,
        callback: (response: R) => void,
      ): void;
      <M = any, R = any>(
        extensionId: string | null | undefined,
        message: M,
        options?: MessageOptions,
      ): Promise<R>;
      <M = any, R = any>(
        extensionId: string | null | undefined,
        message: M,
        callback: (response: R) => void,
      ): void;
      <M = any, R = any>(
        extensionId: string | null | undefined,
        message: M,
        options: MessageOptions | undefined,
        callback: (response: R) => void,
      ): void;
    };
  };
  storage: {
    local: StorageArea;
    /**
     * Top-level `chrome.storage.onChanged` event. Fires for ANY area; consumer
     * filters by the `areaName` arg. Real chrome semantics: every `set` /
     * `remove` / `clear` that materially changes a key emits a single
     * `changes` map keyed by the changed keys.
     */
    onChanged: {
      addListener(listener: StorageChangeListener): void;
      hasListener(listener: StorageChangeListener): boolean;
      hasListeners(): boolean;
      removeListener(listener: StorageChangeListener): void;
    };
  };
  tabs: {
    /**
     * `chrome.tabs.onActivated` — fires when the active tab in a window
     * changes. The fake only models the listener registry; tests drive
     * fires via `__test.fireTabActivated(info)`.
     */
    onActivated: {
      addListener(listener: TabActivatedListener): void;
      hasListener(listener: TabActivatedListener): boolean;
      hasListeners(): boolean;
      removeListener(listener: TabActivatedListener): void;
    };
    /**
     * `chrome.tabs.onRemoved` — fires when a tab is closed. Tests drive
     * fires via `__test.fireTabRemoved(...)`.
     */
    onRemoved: {
      addListener(listener: TabRemovedListener): void;
      hasListener(listener: TabRemovedListener): boolean;
      hasListeners(): boolean;
      removeListener(listener: TabRemovedListener): void;
    };
    /**
     * `chrome.tabs.onUpdated` — fires when a tab is updated (url, title,
     * status, etc.). Tests drive fires via `__test.fireTabUpdated(...)`.
     */
    onUpdated: {
      addListener(listener: TabUpdatedListener): void;
      hasListener(listener: TabUpdatedListener): boolean;
      hasListeners(): boolean;
      removeListener(listener: TabUpdatedListener): void;
    };
    /**
     * Sends a single message to the content script(s) in the specified tab. The runtime.onMessage event is fired in each content script running in the specified tab for the current extension.
     *
     * Can return its result via Promise in Manifest V3 or later since Chrome 99.
     */
    sendMessage: {
      <M = any, R = any>(
        tabId: number,
        message: M,
        options?: MessageSendOptions,
      ): Promise<R>;
      <M = any, R = any>(
        tabId: number,
        message: M,
        callback: (response: R) => void,
      ): void;
      <M = any, R = any>(
        tabId: number,
        message: M,
        options: MessageSendOptions | undefined,
        callback: (response: R) => void,
      ): void;
    };
  };
}
```

<a id="fromChromeAlarm"></a>

### `fromChromeAlarm`

```ts
function fromChromeAlarm<S extends Sub<string, AlarmSubData>, M>(
  msgFn: (alarm: Alarm, sub: S) => M | null,
): SubscribeHandler<S, M, unknown>
```

<a id="fromChromeMessage"></a>

### `fromChromeMessage`

```ts
function fromChromeMessage<S extends Sub, M>(
  opts: ChromeMessageOpts<S, M>,
): SubscribeHandler<S, M, unknown>
```

<a id="fromChromeStorageChange"></a>

### `fromChromeStorageChange`

```ts
function fromChromeStorageChange<S extends Sub, M>(
  opts: ChromeStorageChangeOpts<S, M>,
): SubscribeHandler<S, M, unknown>
```

<a id="fromChromeTabsEvent"></a>

### `fromChromeTabsEvent`

```ts
function fromChromeTabsEvent<S extends Sub, M>(
  opts: ChromeTabsEventOpts<S, M>,
): SubscribeHandler<S, M, unknown>
```

<a id="passThroughMsg"></a>

### `passThroughMsg`

```ts
function passThroughMsg<M>(raw: unknown): M | null
```

<a id="TabsEventName"></a>

### `TabsEventName`

```ts
type TabsEventName = "onActivated" | "onUpdated" | "onRemoved"
```

<a id="useBackgroundRuntime"></a>

### `useBackgroundRuntime`

```ts
function useBackgroundRuntime<S, M extends { type: string }>(
  __namedParameters: UseBackgroundRuntimeOpts<S>,
): UseBackgroundRuntimeResult<S, M>
```

<a id="UseBackgroundRuntimeOpts"></a>

### `UseBackgroundRuntimeOpts`

```ts
interface UseBackgroundRuntimeOpts<S> {
  channel: string;
  /**
   * REQUIRED parse for inbound `state` payloads. Forwarded to
   * `bridgeClient` — see `BridgeClientOpts.parseState`. Surfaces own this
   * because the chrome.runtime boundary is `unknown` (Inv 8). Returning
   * `null` drops the payload silently.
   */
  parseState: (raw: unknown) => S | null;
}
```

<a id="UseBackgroundRuntimeResult"></a>

### `UseBackgroundRuntimeResult`

```ts
interface UseBackgroundRuntimeResult<S, M> {
  /**
   * Latest snapshot from the host. `null` until the first hydrate response
   * or the first broadcast arrives. Surfaces SHOULD render a placeholder
   * for the null window.
   */
  state: S | null;
  /**
   * Send a msg to the host runtime. Resolves once the host's dispatch
   * settles.
   */
  dispatch(msg: M): Promise<void>;
}
```
