# @demlik/tea/effect

> the Effect engine: `run` boots a machine with Effect handlers and sub runners, the caller's Layers and interruption on stop, and yields an Effect handle: the Promise engine's member names, with Effects that fail with `Stopped`, `StoreFailed` or a cell's declared failure where the Promise engine returns Promises.

Tier: `stable`

```ts
import { … } from "@demlik/tea/effect";
```

## Exports (13)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`CellErrors`](#CellErrors) | Type | stable | The failures a dispatch on the handle can end with from an `interpret` map: the error type of every hand-written Cmd's cell. |
| [`EffectBootingRuntime`](#EffectBootingRuntime) | Interface | stable | What the Effect engine's `run` yields while boot is in flight. |
| [`EffectInterpret`](#EffectInterpret) | Type | stable | The Effect engine's `interpret` map: one cell per Cmd variant, each reading services within `R`. |
| [`EffectInterpretCell`](#EffectInterpretCell) | Type | stable | One Effect `interpret` cell. |
| [`EffectRunner`](#EffectRunner) | Type | stable | One Effect sub runner: the Sub in, a `Stream` of Msgs out. |
| [`EffectRunOptions`](#EffectRunOptions) | Type | stable | The options of the Effect engine's `run`. |
| [`EffectRuntime`](#EffectRuntime) | Interface | stable | The Effect engine's booted handle — what `ready` succeeds with. |
| [`EffectSubscribe`](#EffectSubscribe) | Type | stable | The Effect engine's `subscribe` map: a runner for every Sub type the machine declares beyond the built-ins, and optionally one for a built-in, which replaces the engine's own (#270 R2.1). |
| [`InterpretServices`](#InterpretServices) | Type | stable | The services every cell of an `interpret` map reads. |
| [`run`](#run) | Function | stable | Run `machine` on the Effect engine. |
| [`Stopped`](#Stopped) | Class | stable | A dispatch the run refused because it is stopping or has stopped. |
| [`StoreFailed`](#StoreFailed) | Class | stable | The run's store failed. |
| [`SubscribeServices`](#SubscribeServices) | Type | stable | The services every runner of a `subscribe` map reads. |

## Declarations

<a id="CellErrors"></a>

### `CellErrors`

```ts
type CellErrors<C extends Cmd, I> = { [K in keyof I & C["type"]]: unknown extends ErrorsOf<Extract<C, { type: K }>> ? ErrorOfCell<I[K]> : never }[keyof I & C["type"]]
```

<a id="EffectBootingRuntime"></a>

### `EffectBootingRuntime`

```ts
interface EffectBootingRuntime<S, M extends { type: string }, E extends { type: string } = never, Err = never> {
  readonly ready: Effect<EffectRuntime<S, M, E, Err>, StoreFailed | Err>;
  dispatch(
    msg: M,
    opts?: { readonly settle?: DispatchSettle },
  ): Effect<void, Stopped | StoreFailed | Err>;
  dispatchOnce(msg: M): Effect<void, Stopped | StoreFailed | Err>;
  emitPort<T>(port: Port<T>, value: T): void;
  observe(observer: (msg: M, state: S) => void): () => void;
  on<K extends string>(
    type: K,
    handler: (event: Extract<E, { type: K }>) => void,
  ): () => void;
  onBoot(handler: (state: S) => void): () => void;
  stop(): Effect<void>;
  subscribe(listener: () => void): () => void;
  subscribePort<T>(port: Port<T>, listener: (value: T) => void): () => void;
}
```

<a id="EffectInterpret"></a>

### `EffectInterpret`

```ts
type EffectInterpret<M extends { type: string }, C extends Cmd, R = unknown> = { readonly [K in C["type"]]: EffectInterpretCell<M, Extract<C, { type: K }>, R> }
```

<a id="EffectInterpretCell"></a>

### `EffectInterpretCell`

```ts
type EffectInterpretCell<M extends { type: string }, C extends Cmd, R = unknown> = unknown extends ErrorsOf<C> ? (cmd: C) => Effect.Effect<M | readonly M[] | void, unknown, R> : (cmd: C) => Effect.Effect<OkOfCmd<C>, DeclaredErrorsOf<C>, R>
```

<a id="EffectRunner"></a>

### `EffectRunner`

```ts
type EffectRunner<M extends { type: string }, U extends Sub, R = unknown> = (sub: U) => Stream.Stream<M, unknown, R>
```

<a id="EffectRunOptions"></a>

### `EffectRunOptions`

```ts
type EffectRunOptions<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string },
  I,
  B,
> = CtxArg<Ctx> & InterpretOption<C, I> & SubscribeOption<U, B> & {
  readonly clock?: () => number;
  readonly disposeTimeoutMs?: number;
  readonly events?: (msg: M, state: S) => readonly E[];
  readonly onError?: OnError;
  readonly store?: Store<S>;
  readonly supervision?: Supervision<S, M>;
  readonly telemetry?: TelemetrySink;
  readonly terminal?: (state: S) => boolean;
}
```

<a id="EffectRuntime"></a>

### `EffectRuntime`

```ts
interface EffectRuntime<S, M extends { type: string }, E extends { type: string } = never, Err = never> extends EffectBootingRuntime<S, M, E, Err> {
  readonly ready: Effect<EffectRuntime<S, M, E, Err>, StoreFailed | Err>;
  done(): Effect<S>;
  getState(): S;
  idle(): Effect<void>;
  result(): S | undefined;
}
```

<a id="EffectSubscribe"></a>

### `EffectSubscribe`

```ts
type EffectSubscribe<M extends { type: string }, U extends Sub, R = unknown> = { readonly [K in Exclude<U["type"], BuiltinSubType>]: EffectRunner<M, Extract<U, { type: K }>, R> } & { readonly [K in BuiltinSubType]?: EffectRunner<M, Extract<BuiltinSub<M>, { type: K }>, R> }
```

<a id="InterpretServices"></a>

### `InterpretServices`

```ts
type InterpretServices<I> = { [K in keyof I]: ServicesOfCell<I[K]> }[keyof I]
```

<a id="run"></a>

### `run`

```ts
function run<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  I extends EffectInterpret<M, C, unknown> = EffectInterpret<M, C, never>,
  B extends EffectSubscribe<M, U, unknown> = EffectSubscribe<M, U, never>,
  E extends { type: string } = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: EffectRunOptions<S, M, C, U, Ctx, E, I, B>,
): Effect<EffectBootingRuntime<S, M, E, CellErrors<C, I>>, never, Scope | InterpretServices<I> | SubscribeServices<B>>
```

<a id="Stopped"></a>

### `Stopped`

```ts
class Stopped extends YieldableError<this> & {} & Readonly<{
  readonly msgType: string;
  readonly when: "stopping" | "stopped";
}> {
  get message(): string;
}
```

<a id="StoreFailed"></a>

### `StoreFailed`

```ts
class StoreFailed extends YieldableError<this> & {} & Readonly<{
  readonly cause: unknown;
  readonly operation: "save" | "load";
}> {
  get message(): string;
}
```

<a id="SubscribeServices"></a>

### `SubscribeServices`

```ts
type SubscribeServices<B> = { [K in keyof B]-?: ServicesOfRunner<NonNullable<B[K]>> }[keyof B]
```
