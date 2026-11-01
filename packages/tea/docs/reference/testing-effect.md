# @demlik/tea/testing/effect

> `drive` for the Effect engine: a machine run against its real Effect `interpret` handlers and its Subs, round by round, until it goes quiet, yielding `{ state, trace }`. The services the handlers read come from the caller's Layers.

Tier: `stable`

```ts
import { … } from "@demlik/tea/testing/effect";
```

## Exports (24)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`arbSchemaGuidedSequence`](#arbSchemaGuidedSequence) | Function | experimental | Draw Msg lists for `Arbitrary.checkEffect` in which every answer answers a Cmd that was sent and not yet answered, and comes from that Cmd's own schema: an `ok` answer is drawn from its `schema.ok`, an `err` answer carries one of its `errTags`. |
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
| [`Fold`](#Fold) | Interface | stable | What foldEvents hands back: every state in order, one Step per Msg, the final state, and the Cmds `init` sent. |
| [`foldEvents`](#foldEvents) | Function | stable | Fold a Msg sequence through a machine's pure reducer, returning the per-step trace, every state in order, the final state, and the Cmds `init` sent. |
| [`LawBreak`](#LawBreak) | Interface | experimental | What a broken law says. |
| [`lawInvariant`](#lawInvariant) | Function | experimental | The law `propertyInvariant` runs: `invariant` holds on every step of the fold. |
| [`lawTerminates`](#lawTerminates) | Function | experimental | The law `propertyTerminates` runs: the fold's final state is one `terminal` accepts. |
| [`lawTrace`](#lawTrace) | Function | experimental | The law `propertyTrace` runs: `predicate` holds on the fold's steps and final state together. |
| [`NoCmdsError`](#NoCmdsError) | Class | experimental | The machine has no `cmds` list, so there is no schema to draw an answer from. |
| [`NotEffectSchemaError`](#NotEffectSchemaError) | Class | experimental | A Cmd's `ok` schema is not an Effect schema, so no answer can be drawn from it. |
| [`NothingToDrawError`](#NothingToDrawError) | Class | experimental | `machine.cmds` is empty and no `outside` Msg was given, so every list drawn would be empty. |
| [`SchemaAnswersError`](#SchemaAnswersError) | Type | experimental | Why arbSchemaGuidedSequence drew no lists. |
| [`SchemaGuidedOptions`](#SchemaGuidedOptions) | Interface | experimental | What arbSchemaGuidedSequence takes beside the machine and its ctx. |
| [`Step`](#Step) | Interface | stable | One unit in a fold trace — the four pieces of data a property invariant typically asserts on. |

## Declarations

<a id="arbSchemaGuidedSequence"></a>

### `arbSchemaGuidedSequence`

```ts
function arbSchemaGuidedSequence<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  opts?: SchemaGuidedOptions<NoInfer<S>, M>,
): Result<Arbitrary<readonly M[]>, SchemaAnswersError>
```

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
  /** The Cmd `type` nothing in the handler record answered. */
  readonly cmdType: string;
  readonly name: "DriveNoHandlerError";
  /** Every Msg folded and Cmd dispatched before the miss. */
  readonly trace: readonly DriveTraceEntry<M, C>[];
}
```

<a id="DriveOptions"></a>

### `DriveOptions`

```ts
type DriveOptions<Ctx> = DriveCtxArg<Ctx> & {
  /**
   * The clock that stamps `at` on a `Cmd.define`d Cmd's minted `_ok` / `_err`
   * Msg — the one `run` takes. Defaults to `Date.now`; pin it for a test that
   * asserts on `at`.
   */
  readonly clock?: () => number;
  /**
   * The round bound. Exceeding it fails the drive with
   * DriveRoundsExceededError; `drive` never returns a half-driven
   * state. Defaults to DEFAULT_MAX_ROUNDS (100).
   */
  readonly maxRounds?: number;
}
```

<a id="DriveResult"></a>

### `DriveResult`

```ts
interface DriveResult<S, M, C> {
  /** The state after the machine went quiet — no Msg pending, no Cmd unperformed. */
  readonly state: S;
  /**
   * Every Msg folded and every Cmd dispatched, in order. Filtering it to its
   * `msg` entries and replaying those through `replay` from the same initial
   * state reproduces DriveResult.state.
   */
  readonly trace: readonly DriveTraceEntry<M, C>[];
}
```

<a id="DriveRoundsExceededError"></a>

### `DriveRoundsExceededError`

```ts
class DriveRoundsExceededError<M, C> extends Error {
  constructor(maxRounds: number, rounds: number, trace: readonly DriveTraceEntry<M, C>[]);
  readonly _tag: "DriveRoundsExceededError";
  /** The bound that was exceeded. */
  readonly maxRounds: number;
  readonly name: "DriveRoundsExceededError";
  /** The round the driver stopped at — always `maxRounds + 1`. */
  readonly rounds: number;
  /** Every Msg folded and Cmd dispatched before the driver gave up. */
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

<a id="Fold"></a>

### `Fold`

```ts
interface Fold<S, M, C> {
  readonly finalState: S;
  readonly initCmds: readonly C[];
  readonly states: readonly S[];
  readonly steps: readonly Step<S, M, C>[];
}
```

<a id="foldEvents"></a>

### `foldEvents`

```ts
function foldEvents<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  loaded: NoInfer<S> | null,
  msgs: readonly NoInfer<M>[],
): Fold<S, M, C>
```

<a id="LawBreak"></a>

### `LawBreak`

```ts
interface LawBreak {
  readonly reason: string | null;
  readonly report: string;
}
```

<a id="lawInvariant"></a>

### `lawInvariant`

```ts
function lawInvariant<S, M, C>(
  fold: Fold<S, M, C>,
  invariant: (
    step: Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>,
    initCmds: readonly NoInfer<C>[],
  ) => string | boolean | null,
): LawBreak | null
```

<a id="lawTerminates"></a>

### `lawTerminates`

```ts
function lawTerminates<S, M, C>(
  fold: Fold<S, M, C>,
  terminal: (state: NoInfer<S>, initCmds: readonly NoInfer<C>[]) => boolean,
): LawBreak | null
```

<a id="lawTrace"></a>

### `lawTrace`

```ts
function lawTrace<S, M, C>(
  fold: Fold<S, M, C>,
  predicate: (
    steps: readonly Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>[],
    finalState: NoInfer<S>,
    initCmds: readonly NoInfer<C>[],
  ) => string | boolean | null,
): LawBreak | null
```

<a id="NoCmdsError"></a>

### `NoCmdsError`

```ts
class NoCmdsError extends YieldableError<this> & {} & Readonly<{ readonly message: string }> {}
```

<a id="NotEffectSchemaError"></a>

### `NotEffectSchemaError`

```ts
class NotEffectSchemaError extends YieldableError<this> & {} & Readonly<{
  readonly cmdType: string;
  readonly message: string;
}> {}
```

<a id="NothingToDrawError"></a>

### `NothingToDrawError`

```ts
class NothingToDrawError extends YieldableError<this> & {} & Readonly<{ readonly message: string }> {}
```

<a id="SchemaAnswersError"></a>

### `SchemaAnswersError`

```ts
type SchemaAnswersError = NoCmdsError | NotEffectSchemaError | NothingToDrawError
```

<a id="SchemaGuidedOptions"></a>

### `SchemaGuidedOptions`

```ts
interface SchemaGuidedOptions<S, M extends { type: string }> {
  /**
   * The saved state the fold starts from. Give `foldEvents` the same one, or it
   * reads the list from a different start. Default `null`.
   */
  readonly loaded?: S | null;
  /**
   * Caps the events drawn. Default 60. `checkEffect` and `sampleEffect` cap a
   * list at their `size` too, which defaults to 10, so pass a `size` of at least
   * this to draw lists this long.
   */
  readonly maxLength?: number;
  /**
   * The Msgs nothing sends a Cmd for, by Msg type: a user's click, a timer. A
   * Msg type here and in no Cmd's answers is drawn only from here.
   */
  readonly outside?: { readonly [K in string]?: Arbitrary<Extract<M, { type: K }>> };
}
```

<a id="Step"></a>

### `Step`

```ts
interface Step<S, M, C> {
  readonly cmds: readonly C[];
  readonly msg: M;
  readonly next: S;
  readonly prev: S;
}
```
