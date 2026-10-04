# @demlik/tea/extension

> Chrome service-worker host adapter for @demlik/tea.

```ts
import { … } from "@demlik/tea/extension";
```

## Exports (24)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `BackgroundRuntimeContext` | Interface | What `createBackgroundRuntimeContext` returns: a `Provider`, plus the `useState`, `useDispatch` and `useRuntime` hooks that read from it. |
| `bridgeClient` | Function | Create a `BridgeClient` for a popup, side panel or content script, which talks to the background runtime over `chrome.runtime` messages. |
| `BridgeClient` | Interface | A surface's handle on the background runtime: hydrate the current state, dispatch Msgs, and subscribe to state broadcasts. |
| `BridgeClientOpts` | Interface | Options for `bridgeClient`: the `channel` name and the required parsers for inbound state and Msgs. |
| `bridgeRuntime` | Function | Install the bridge for a runtime. |
| `BridgeRuntimeOpts` | Interface | Options for `bridgeRuntime`: the `channel` name, the required `parseMsg` for inbound Msgs, and an optional `serialize` for the state sent to surfaces. |
| `bridgeTabClient` | Function | SW-side client of a `bridgeRuntime` hosted in a content script. |
| `BridgeTabClientOpts` | Interface | Options for `bridgeTabClient`: the target `tabId`, the `channel` name, and the required parsers. |
| `ChromeMessageOpts` | Interface | Options for `fromChromeMessage`: an optional `filter`, and the `msgFn` that maps a runtime message to a Msg. |
| `ChromeStorageChangeOpts` | Interface | Options for `fromChromeStorageChange`: the storage `area`, an optional `keys` filter, and the `msgFn` that maps the changes to a Msg. |
| `chromeStorageStore` | Function | `Store<S>` backed by `chrome.storage.local` (or any compatible `StorageArea`). |
| `ChromeTabsEventOpts` | Interface | Options for `fromChromeTabsEvent`: which tab `events` to listen to, whether to fire once on mount, and the `msgFn` that builds the Msg. |
| `createBackgroundRuntimeContext` | Function | Create a React context that shares one background-runtime connection across a component tree. |
| `fakeChrome` | Function | Create an in-memory fake of the `chrome` APIs this adapter uses. |
| `FakeChrome` | Interface | The in-memory `chrome` stand-in `fakeChrome` returns, with `__test.fire*` helpers that drive its events from a test. |
| `fromChromeAlarm` | Function | Build a Sub runner that dispatches `msgFn(alarm, sub)` when the `chrome.alarms` alarm named `sub.deps.alarmName` fires. |
| `fromChromeMessage` | Function | Build a Sub runner that dispatches a Msg for each `chrome.runtime.onMessage` message that passes the filter. |
| `fromChromeStorageChange` | Function | Build a Sub runner that dispatches a Msg when keys change in a `chrome.storage` area. |
| `fromChromeTabsEvent` | Function | Build a Sub runner that dispatches `msgFn(sub)` whenever one of the chosen `chrome.tabs` events fires. |
| `passThroughMsg` | Function | The explicit opt-out of inbound msg parsing: an identity pass-through that casts the raw `unknown` to `M`. |
| `TabsEventName` | Type | The `chrome.tabs` events `fromChromeTabsEvent` can listen to. |
| `useBackgroundRuntime` | Function | React hook for an extension surface: it subscribes to the background runtime's state and returns it with a `dispatch`. |
| `UseBackgroundRuntimeOpts` | Interface | Options for `useBackgroundRuntime`: the `channel` name and the required `parseState`. |
| `UseBackgroundRuntimeResult` | Interface | What `useBackgroundRuntime` returns: the latest `state`, which is `null` until the first one arrives, and `dispatch`. |
