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
  /** Visual category — drives the row icon. Defaults to "msg" via CSS. */
  kind?: "msg" | "sub" | "cmd" | "ok" | "fail";
  /** Row text — usually the Msg tag plus a short detail. */
  text: string;
  /** Display timestamp (whatever format you produced). */
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
  /** The value on the `actual` side (`undefined` when `removed`). */
  actual: unknown;
  /** The value on the `expected` side (`undefined` when `added`). */
  expected: unknown;
  /** How the cell differs between the two states. */
  kind: "changed" | "added" | "removed";
  /** Access path from the state root, e.g. `state.items[1].status`. */
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
  /**
   * The "after" state to compare against `expected` — the recomputed or
   * current model.
   */
  actual: unknown;
  /** Optional className appended to the container. Use to override layout. */
  className?: string;
  /**
   * The baseline / "before" state — what you expected. In a regression view
   * this is a trace's recorded `finalState`; in a time-travel view it's the
   * previous model.
   */
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
  /** Optional className appended to the container. Use to override layout. */
  className?: string;
  /**
   * When this number changes, the inspector flashes. Pass `model.msgCount` or
   * any other monotonic counter you already have. Omit to disable flashing.
   */
  flashKey?: number;
  /**
   * The machine state to display. Render-derived shape — pass whatever you
   * want surfaced to the inspector (often a hand-picked subset of the model).
   */
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
