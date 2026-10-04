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
  /** Mermaid layout direction. Default `"TB"` (top-to-bottom). */
  direction?: "TB" | "LR";
  samples?: {
    /** Ctx for `init(null, ctx)` — unlocks the `[*] -->` initial-state edge. */
    ctx?: unknown;
    /** Sample msg per `msg.type` — unlocks RESOLVED edges. */
    msgs?: Partial<Record<string, M>>;
    /** Sample state per `state.type` — unlocks RESOLVED edges + sub annotations. */
    states?: Partial<Record<string, S>>;
  };
  /** Optional diagram title, emitted as a Mermaid front-matter `title:` block. */
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
