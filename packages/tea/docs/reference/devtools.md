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
| `MsgLog` | Function | React component that renders a list of `MsgLogEntry` rows as a message log. |
| `MsgLogEntry` | Type | One row of the `MsgLog`: a timestamp, a category and the text to show. |
| `MsgLogProps` | Interface | Props for `MsgLog`: the rows to render and an optional `className`. |
| `StateChange` | Interface | A single differing leaf value between two states. |
| `StateDiff` | Function | Presentational diff of two states. |
| `StateDiffProps` | Interface | Props for `StateDiff`: the `expected` and `actual` states to compare, and an optional `className`. |
| `StateInspector` | Function | React component that renders a state value as formatted JSON, and flashes when `flashKey` changes. |
| `StateInspectorProps` | Interface | Props for `StateInspector`: the `state` to show, an optional `flashKey`, and an optional `className`. |
| `useMsgHistory` | Function | Wrap a `dispatch` so every Msg it sees lands in a bounded history buffer. |
