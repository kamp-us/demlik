# @demlik/tea/devtools

> presentational inspector for any tea machine.

```ts
import { … } from "@demlik/tea/devtools";
```

## Exports (11)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `diffState` | Function | Deep-walk two states and return EVERY differing leaf value, in deterministic pre-order (the node before its children; children in array-index order, then sorted-union key order for objects). |
| `formatDiff` | Function | Pretty multi-line text for a diffState result. |
| `MsgLog` | Function |  |
| `MsgLogEntry` | Type |  |
| `MsgLogProps` | Interface |  |
| `StateChange` | Interface | A single differing leaf value between two states. |
| `StateDiff` | Function | Presentational diff of two states. |
| `StateDiffProps` | Interface |  |
| `StateInspector` | Function |  |
| `StateInspectorProps` | Interface |  |
| `useMsgHistory` | Function | Wrap a `dispatch` so every Msg it sees lands in a bounded history buffer. |
