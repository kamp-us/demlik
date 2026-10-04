# @demlik/tea/machine-viz

> turn a `Machine` into a Mermaid diagram string.

Tier: `stable`

```ts
import { … } from "@demlik/tea/machine-viz";
```

## Exports (4)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`MachineVizOptions`](#MachineVizOptions) | Interface | stable | Options controlling diagram emission. |
| [`safeId`](#safeId) | Function | stable | Sanitize a discriminant string into a Mermaid-safe node identifier. |
| [`safeLabel`](#safeLabel) | Function | stable | Sanitize text used as a Mermaid edge/transition label (the part after `:`). |
| [`toMermaid`](#toMermaid) | Function | stable | Render a `Machine` as a Mermaid `stateDiagram-v2` string. |

## Declarations

<a id="MachineVizOptions"></a>

### `MachineVizOptions`

```ts
interface MachineVizOptions<S, M> {
  direction?: "TB" | "LR";
  samples?: {
    ctx?: unknown;
    msgs?: Partial<Record<string, M>>;
    states?: Partial<Record<string, S>>;
  };
  title?: string;
}
```

<a id="safeId"></a>

### `safeId`

```ts
function safeId(raw: string): string
```

<a id="safeLabel"></a>

### `safeLabel`

```ts
function safeLabel(raw: string): string
```

<a id="toMermaid"></a>

### `toMermaid`

```ts
function toMermaid<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts?: MachineVizOptions<NoInfer<S>, NoInfer<M>>,
): string
```
