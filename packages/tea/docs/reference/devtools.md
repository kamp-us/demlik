# @demlik/tea/devtools

> presentational inspector for any tea machine.

Tier: `stable`

```ts
import { … } from "@demlik/tea/devtools";
```

## Exports (11)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`diffState`](#diffState) | Function | stable | Deep-walk two states and return EVERY differing leaf value, in deterministic pre-order (the node before its children; children in array-index order, then sorted-union key order for objects). |
| [`formatDiff`](#formatDiff) | Function | stable | Pretty multi-line text for a diffState result. |
| [`MsgLog`](#MsgLog) | Function | stable | React component that renders a list of `MsgLogEntry` rows as a message log. |
| [`MsgLogEntry`](#MsgLogEntry) | Type | stable | One row of the `MsgLog`: a timestamp, a category and the text to show. |
| [`MsgLogProps`](#MsgLogProps) | Interface | stable | Props for `MsgLog`: the rows to render and an optional `className`. |
| [`StateChange`](#StateChange) | Interface | stable | A single differing leaf value between two states. |
| [`StateDiff`](#StateDiff) | Function | stable | Presentational diff of two states. |
| [`StateDiffProps`](#StateDiffProps) | Interface | stable | Props for `StateDiff`: the `expected` and `actual` states to compare, and an optional `className`. |
| [`StateInspector`](#StateInspector) | Function | stable | React component that renders a state value as formatted JSON, and flashes when `flashKey` changes. |
| [`StateInspectorProps`](#StateInspectorProps) | Interface | stable | Props for `StateInspector`: the `state` to show, an optional `flashKey`, and an optional `className`. |
| [`useMsgHistory`](#useMsgHistory) | Function | stable | Wrap a `dispatch` so every Msg it sees lands in a bounded history buffer. |

## Declarations

<a id="diffState"></a>

### `diffState`

```ts
function diffState(expected: unknown, actual: unknown): StateChange[]
```

<a id="formatDiff"></a>

### `formatDiff`

```ts
function formatDiff(changes: StateChange[]): string
```

<a id="MsgLog"></a>

### `MsgLog`

```ts
function MsgLog(__namedParameters: MsgLogProps): Element
```

<a id="MsgLogEntry"></a>

### `MsgLogEntry`

```ts
type MsgLogEntry = {
  kind?: "msg" | "sub" | "cmd" | "ok" | "fail";
  text: string;
  ts: string;
}
```

<a id="MsgLogProps"></a>

### `MsgLogProps`

```ts
interface MsgLogProps {
  className?: string;
  history: readonly MsgLogEntry[];
}
```

<a id="StateChange"></a>

### `StateChange`

```ts
interface StateChange {
  actual: unknown;
  expected: unknown;
  kind: "changed" | "added" | "removed";
  path: string;
}
```

<a id="StateDiff"></a>

### `StateDiff`

```ts
function StateDiff(__namedParameters: StateDiffProps): Element
```

<a id="StateDiffProps"></a>

### `StateDiffProps`

```ts
interface StateDiffProps {
  actual: unknown;
  className?: string;
  expected: unknown;
}
```

<a id="StateInspector"></a>

### `StateInspector`

```ts
function StateInspector(__namedParameters: StateInspectorProps): Element
```

<a id="StateInspectorProps"></a>

### `StateInspectorProps`

```ts
interface StateInspectorProps {
  className?: string;
  flashKey?: number;
  state: unknown;
}
```

<a id="useMsgHistory"></a>

### `useMsgHistory`

```ts
function useMsgHistory<M>(
  dispatch: (msg: M) => void | Promise<void>,
  opts?: {
    derive?: (msg: M) => MsgLogEntry;
    max?: number;
    now?: () => string;
  },
): readonly [readonly MsgLogEntry[], (msg: M) => void, () => void]
```
