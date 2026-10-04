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
  Provider: (
    props: {
      children: ReactNode;
      opts: UseBackgroundRuntimeOpts<S>;
    },
  ) => ReactNode;
  useDispatch: () => (msg: M) => Promise<void>;
  useRuntime: () => UseBackgroundRuntimeResult<S, M>;
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
  dispatch(msg: M): Promise<void>;
  getSnapshot(): S | null;
  hydrate(): Promise<S | null>;
  subscribe(listener: (msg: M | null, state: S) => void): () => void;
}
```

<a id="BridgeClientOpts"></a>

### `BridgeClientOpts`

```ts
interface BridgeClientOpts<S, M> {
  channel: string;
  parseMsg: (raw: unknown) => M | null;
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
  historySize?: number;
  parseMsg: (raw: unknown) => M | null;
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
  parseMsg: (raw: unknown) => M | null;
  parseState: (raw: unknown) => S | null;
  tabId: number;
}
```

<a id="ChromeMessageOpts"></a>

### `ChromeMessageOpts`

```ts
interface ChromeMessageOpts<S extends Sub, M> {
  filter?: (message: unknown) => boolean;
  msgFn: (message: unknown, sender: MessageSender, sub: S) => M | null;
}
```

<a id="ChromeStorageChangeOpts"></a>

### `ChromeStorageChangeOpts`

```ts
interface ChromeStorageChangeOpts<S extends Sub, M> {
  area: AreaName;
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
  __test: {
    addTab(tabId: number): void;
    fireAlarm(name: string): void;
    fireTabActivated(info: OnActivatedInfo): void;
    fireTabRemoved(tabId: number, removeInfo: OnRemovedInfo): void;
    fireTabUpdated(tabId: number, changeInfo: OnUpdatedInfo, tab: Tab): void;
    getAlarms(): readonly string[];
    removeTab(tabId: number): void;
    sendFromTab(tabId: number, message: unknown): Promise<unknown>;
  };
  alarms: {
    onAlarm: {
      addListener(listener: AlarmListener): void;
      hasListener(listener: AlarmListener): boolean;
      hasListeners(): boolean;
      removeListener(listener: AlarmListener): void;
    };
    clear(name: string): Promise<boolean>;
    create(name: string, alarmInfo: AlarmCreateInfo): void;
    get(name: string): Promise<Alarm | undefined>;
  };
  runtime: {
    onMessage: Event<(
      message: any,
      sender: MessageSender,
      sendResponse: (response?: any) => void,
    ) => void>;
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
    onChanged: {
      addListener(listener: StorageChangeListener): void;
      hasListener(listener: StorageChangeListener): boolean;
      hasListeners(): boolean;
      removeListener(listener: StorageChangeListener): void;
    };
  };
  tabs: {
    onActivated: {
      addListener(listener: TabActivatedListener): void;
      hasListener(listener: TabActivatedListener): boolean;
      hasListeners(): boolean;
      removeListener(listener: TabActivatedListener): void;
    };
    onRemoved: {
      addListener(listener: TabRemovedListener): void;
      hasListener(listener: TabRemovedListener): boolean;
      hasListeners(): boolean;
      removeListener(listener: TabRemovedListener): void;
    };
    onUpdated: {
      addListener(listener: TabUpdatedListener): void;
      hasListener(listener: TabUpdatedListener): boolean;
      hasListeners(): boolean;
      removeListener(listener: TabUpdatedListener): void;
    };
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
  parseState: (raw: unknown) => S | null;
}
```

<a id="UseBackgroundRuntimeResult"></a>

### `UseBackgroundRuntimeResult`

```ts
interface UseBackgroundRuntimeResult<S, M> {
  state: S | null;
  dispatch(msg: M): Promise<void>;
}
```
