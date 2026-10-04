# @demlik/tea/parity

> the record → replay → normalized-diff go/no-go gate.

Tier: `stable`

```ts
import { … } from "@demlik/tea/parity";
```

## Exports (8)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`goldenReplay`](#goldenReplay) | Function | stable | Reproduce a recording's final state by folding its msgs through the pure `replay` — `init(loaded, ctx)` then `update` per msg, never `interpret`, never a `Store`, never a live subscription. |
| [`normalizeForParity`](#normalizeForParity) | Function | stable | Build a finding-normalizer: a pure `(value) => normalized` that strips the schema's `stripKeys`, recursively sorts object keys, and stable-key-sorts arrays by the schema's `sortKeys`. |
| [`parityEqual`](#parityEqual) | Function | stable | The parity verdict: `true` iff `a` and `b` are structurally equal. |
| [`ParitySchema`](#ParitySchema) | Interface | stable | Configuration for normalizeForParity. |
| [`RecorderOptions`](#RecorderOptions) | Interface | stable | Options for recorder. |
| [`Recording`](#Recording) | Interface | stable | A live parity recording attached to a Runtime — the go/no-go gate's golden artifact. |
| [`recordRun`](#recordRun) | Function | stable | Attach a parity recording to a Runtime, reusing the `recorder`/`historyTracker` capture (the boot observe for `loaded` + every non-null msg in order) rather than a fresh observer path. |
| [`Trace`](#Trace) | Interface | stable | A recorded run, sufficient to reproduce it via `../trace-replay`. |

## Declarations

<a id="goldenReplay"></a>

### `goldenReplay`

```ts
function goldenReplay<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  recording: Recording<S, M> | Trace<S, M>,
  ctx?: Ctx,
): S
```

<a id="normalizeForParity"></a>

### `normalizeForParity`

```ts
function normalizeForParity(schema?: ParitySchema): (value: unknown) => unknown
```

<a id="parityEqual"></a>

### `parityEqual`

```ts
function parityEqual(a: unknown, b: unknown): boolean
```

<a id="ParitySchema"></a>

### `ParitySchema`

```ts
interface ParitySchema {
  readonly sortKeys?: readonly string[];
  readonly stripKeys?: readonly string[];
}
```

<a id="RecorderOptions"></a>

### `RecorderOptions`

```ts
interface RecorderOptions {
  readonly captureSteps?: boolean;
  readonly sampleRate?: number;
}
```

<a id="Recording"></a>

### `Recording`

```ts
interface Recording<S, M> {
  stop(): void;
  toJSONL(): string;
  trace(): Trace<S, M>;
}
```

<a id="recordRun"></a>

### `recordRun`

```ts
function recordRun<S, M extends { type: string }>(
  runtime: BootingRuntime<S, M>,
  opts?: RecorderOptions,
): Recording<S, M>
```

<a id="Trace"></a>

### `Trace`

```ts
interface Trace<S, M> {
  readonly finalState: S;
  readonly loaded: S | null;
  readonly msgs: readonly M[];
  readonly steps?: readonly { readonly msg: M; readonly state: S }[];
}
```
