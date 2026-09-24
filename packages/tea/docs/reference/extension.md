# @demlik/tea/extension

> Chrome service-worker host adapter for @demlik/tea.

```ts
import { … } from "@demlik/tea/extension";
```

## Exports (24)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `BackgroundRuntimeContext` | Interface |  |
| `bridgeClient` | Function |  |
| `BridgeClient` | Interface |  |
| `BridgeClientOpts` | Interface |  |
| `bridgeRuntime` | Function | Install the bridge for a runtime. |
| `BridgeRuntimeOpts` | Interface |  |
| `bridgeTabClient` | Function | SW-side client of a `bridgeRuntime` hosted in a content script. |
| `BridgeTabClientOpts` | Interface |  |
| `ChromeMessageOpts` | Interface |  |
| `ChromeStorageChangeOpts` | Interface |  |
| `chromeStorageStore` | Function | `Store<S>` backed by `chrome.storage.local` (or any compatible `StorageArea`). |
| `ChromeTabsEventOpts` | Interface |  |
| `createBackgroundRuntimeContext` | Function |  |
| `fakeChrome` | Function |  |
| `FakeChrome` | Interface |  |
| `fromChromeAlarm` | Function |  |
| `fromChromeMessage` | Function |  |
| `fromChromeStorageChange` | Function |  |
| `fromChromeTabsEvent` | Function |  |
| `passThroughMsg` | Function | The explicit opt-out of inbound msg parsing: an identity pass-through that casts the raw `unknown` to `M`. |
| `TabsEventName` | Type |  |
| `useBackgroundRuntime` | Function |  |
| `UseBackgroundRuntimeOpts` | Interface |  |
| `UseBackgroundRuntimeResult` | Interface |  |
