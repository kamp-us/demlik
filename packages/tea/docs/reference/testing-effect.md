# @demlik/tea/testing/effect

> `drive` for the Effect engine: a machine run against its real Effect `interpret` handlers and its Subs, round by round, until it goes quiet, yielding `{ state, trace }`. The services the handlers read come from the caller's Layers.

Tier: `stable`

```ts
import { … } from "@demlik/tea/testing/effect";
```

## Exports (11)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`DEFAULT_MAX_ROUNDS`](#DEFAULT_MAX_ROUNDS) | Variable | stable | The default round bound when `opts.maxRounds` is omitted: **100**. |
| [`drive`](#drive) | Function | stable | Drive `machine` from `initial` through `msg` against the REAL Effect `interpret` map — the one a host hands the Effect engine's `run` — and the Subs the machine wants, feeding every Msg back until the machine goes quiet. |
| [`DriveCtxArg`](#DriveCtxArg) | Type | stable | `drive`'s `ctx` field. |
| [`DriveNoHandlerError`](#DriveNoHandlerError) | Class | stable | Raised when a Cmd reaches `drive` with no handler for its `type` in the handler record. |
| [`DriveOptions`](#DriveOptions) | Type | stable | The options both `drive`s take. |
| [`DriveResult`](#DriveResult) | Interface | stable | What a settled `drive` hands back. |
| [`DriveRoundsExceededError`](#DriveRoundsExceededError) | Class | stable | Raised when a driven machine is still emitting work after `maxRounds` rounds. |
| [`DriveTraceEntry`](#DriveTraceEntry) | Type | stable | One entry of a driven run's history, in dispatch order. |
| [`driveTraceOf`](#driveTraceOf) | Function | stable | Read back the partial trace `drive` attached to an error a handler failed with. |
| [`EffectDriveError`](#EffectDriveError) | Type | stable | The failures a drive ends with: the loop's own, and a hand-written cell's. |
| [`EffectDriveOptions`](#EffectDriveOptions) | Type | stable | The Effect `drive`'s options: the Promise `drive`'s, plus `subscribe` — the runners the engine's `run` takes, required exactly when `run` requires them. |

## Declarations

<a id="DEFAULT_MAX_ROUNDS"></a>

### `DEFAULT_MAX_ROUNDS`

```ts
const DEFAULT_MAX_ROUNDS: 100
```

<a id="drive"></a>

### `drive`

```ts
function drive<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  I extends EffectInterpret<M, C> = EffectInterpret<M, C, never>,
  B extends EffectSubscribe<M, U> = EffectSubscribe<M, U, never>,
>(
  machine: Machine<S, M, C, U, Ctx>,
  initial: S,
  msg: M,
  interpret: I,
  ...__namedParameters: Record<never, never> extends EffectDriveOptions<U, Ctx, B> ? [opts?: EffectDriveOptions<U, Ctx, B>] : [opts: EffectDriveOptions<U, Ctx, B>],
): Effect<DriveResult<S, M, C>, EffectDriveError<M, C, I>, InterpretServices<I> | SubscribeServices<B>>
```

<a id="DriveCtxArg"></a>

### `DriveCtxArg`

```ts
type DriveCtxArg<Ctx> = [undefined] extends [Ctx] ? { readonly ctx?: Ctx } : CtxArg<Ctx>
```

<a id="DriveNoHandlerError"></a>

### `DriveNoHandlerError`

```ts
class DriveNoHandlerError<M, C> extends Error {
  constructor(cmdType: string, trace: readonly DriveTraceEntry<M, C>[]);
  readonly _tag: "DriveNoHandlerError";
  readonly cmdType: string;
  readonly name: "DriveNoHandlerError";
  readonly trace: readonly DriveTraceEntry<M, C>[];
}
```

<a id="DriveOptions"></a>

### `DriveOptions`

```ts
type DriveOptions<Ctx> = DriveCtxArg<Ctx> & {
  readonly clock?: () => number;
  readonly maxRounds?: number;
}
```

<a id="DriveResult"></a>

### `DriveResult`

```ts
interface DriveResult<S, M, C> {
  readonly state: S;
  readonly trace: readonly DriveTraceEntry<M, C>[];
}
```

<a id="DriveRoundsExceededError"></a>

### `DriveRoundsExceededError`

```ts
class DriveRoundsExceededError<M, C> extends Error {
  constructor(maxRounds: number, rounds: number, trace: readonly DriveTraceEntry<M, C>[]);
  readonly _tag: "DriveRoundsExceededError";
  readonly maxRounds: number;
  readonly name: "DriveRoundsExceededError";
  readonly rounds: number;
  readonly trace: readonly DriveTraceEntry<M, C>[];
}
```

<a id="DriveTraceEntry"></a>

### `DriveTraceEntry`

```ts
type DriveTraceEntry<M, C> =
  | { readonly kind: "msg"; readonly msg: M }
  | { readonly cmd: C; readonly kind: "cmd" }
```

<a id="driveTraceOf"></a>

### `driveTraceOf`

```ts
function driveTraceOf<M, C>(
  err: unknown,
): readonly DriveTraceEntry<M, C>[] | undefined
```

<a id="EffectDriveError"></a>

### `EffectDriveError`

```ts
type EffectDriveError<M, C extends Cmd, I> = DriveRoundsExceededError<M, C> | DriveNoHandlerError<M, C> | CellErrors<C, I>
```

<a id="EffectDriveOptions"></a>

### `EffectDriveOptions`

```ts
type EffectDriveOptions<U extends Sub, Ctx, B> = DriveOptions<Ctx> & SubscribeOption<U, B>
```
