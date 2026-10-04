# @demlik/tea/effect

> the Effect engine: `run` boots a machine with Effect handlers and sub runners, the caller's Layers and interruption on stop, and yields an Effect handle: the Promise engine's member names, with Effects that fail with `Stopped`, `StoreFailed` or a cell's declared failure where the Promise engine returns Promises. `spawn`, `stop` and `tell` are for a host that runs child machines under a parent: it keeps its own table of children, and they run the steps that race.

Tier: `stable`

```ts
import { … } from "@demlik/tea/effect";
```

## Exports (17)

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
| [`spawn`](#spawn) | Function | stable | Start a child in a scope forked from `parentScope` and enrol it in the host's table, as one uninterruptible step. |
| [`SpawnSteps`](#SpawnSteps) | Interface | stable | The host's own steps of a spawn. |
| [`stop`](#stop) | Function | stable | Stop one child that `spawn` started. |
| [`Stopped`](#Stopped) | Class | stable | A dispatch the run refused because it is stopping or has stopped. |
| [`StoreFailed`](#StoreFailed) | Class | stable | The run's store failed. |
| [`SubscribeServices`](#SubscribeServices) | Type | stable | The services every runner of a `subscribe` map reads. |
| [`tell`](#tell) | Function | stable | Hand `msg` to a run only when its State has a cell for it, and drop it when the run no longer takes it. |

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
  /**
   * Succeeds with the booted handle once boot completes. Fails with
   * `StoreFailed` when the saved state could not be restored (`"load"`) or the
   * initial save failed (`"save"`), and with a hand-written cell's declared
   * failure when a boot Cmd fails with one.
   */
  readonly ready: Effect<EffectRuntime<S, M, E, Err>, StoreFailed | Err>;
  /**
   * Fold `msg` and run to quiescence, as the Promise engine's `dispatch` does.
   * Fails with `Stopped` once the run is stopping or stopped, `StoreFailed`
   * when the transition's save fails, and a hand-written cell's declared
   * failure when the transition's Cmd fails with one.
   */
  dispatch(
    msg: M,
    opts?: { readonly settle?: DispatchSettle },
  ): Effect<void, Stopped | StoreFailed | Err>;
  /** `dispatch(msg, { settle: "once" })`: one transition, no follow-up drain. */
  dispatchOnce(msg: M): Effect<void, Stopped | StoreFailed | Err>;
  /** Emit a value on a Port from outside a Cmd handler. */
  emitPort<T>(port: Port<T>, value: T): void;
  /** A `(msg, state)` hook, fired after each applied transition. */
  observe(observer: (msg: M, state: S) => void): () => void;
  /** Subscribe to the semantic event of `type` the run's `events` projects. */
  on<K extends string>(
    type: K,
    handler: (event: Extract<E, { type: K }>) => void,
  ): () => void;
  /** Fires once with the initial State — at once if boot already ran. */
  onBoot(handler: (state: S) => void): () => void;
  /**
   * Stop the run: drain in-flight work, stop its Subs, flush the final State.
   * Closing the run's Scope stops the run the same way, and `stop()` leaves
   * that Scope open. So for a child under `spawn` the two differ: `stop()`
   * does not take the child out of the host's table or tell the parent. Stop
   * such a child with the `stop` helper.
   */
  stop(): Effect<void>;
  /** A zero-arg change notifier, fired after each applied transition. */
  subscribe(listener: () => void): () => void;
  /** Subscribe to a typed Port. */
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
  /** Stamps `at` on minted Msgs and telemetry. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** How long `stop()` waits for async teardown. Defaults to 5_000ms. */
  readonly disposeTimeoutMs?: number;
  /** Projects each applied transition to the public events `on` serves. */
  readonly events?: (msg: M, state: S) => readonly E[];
  readonly onError?: OnError;
  readonly store?: Store<S>;
  /** The policy for a reducer throw. Defaults to `"stop"`. */
  readonly supervision?: Supervision<S, M>;
  /** A fire-and-forget sink for every applied transition. */
  readonly telemetry?: TelemetrySink;
  /** The terminal predicate `result()` and `done()` read. */
  readonly terminal?: (state: S) => boolean;
}
```

<a id="EffectRuntime"></a>

### `EffectRuntime`

```ts
interface EffectRuntime<S, M extends { type: string }, E extends { type: string } = never, Err = never> extends EffectBootingRuntime<S, M, E, Err> {
  /**
   * Succeeds with the booted handle once boot completes. Fails with
   * `StoreFailed` when the saved state could not be restored (`"load"`) or the
   * initial save failed (`"save"`), and with a hand-written cell's declared
   * failure when a boot Cmd fails with one.
   */
  readonly ready: Effect<EffectRuntime<S, M, E, Err>, StoreFailed | Err>;
  /** Succeeds with the terminal State the first time the run reaches one. */
  done(): Effect<S>;
  /** The current State. Total. */
  getState(): S;
  /** Succeeds once every dispatched Msg and its follow-ups are processed. */
  idle(): Effect<void>;
  /** The terminal State, or `undefined` while the run is in flight. */
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

<a id="spawn"></a>

### `spawn`

```ts
function spawn<A, E = never, R = never>(
  parentScope: Scope,
  steps: SpawnSteps<A, E, R>,
): Effect<A, E, Exclude<R, Scope>>
```

<a id="SpawnSteps"></a>

### `SpawnSteps`

```ts
interface SpawnSteps<A, E = never, R = never> {
  /** Add the started child to the host's table. */
  readonly enrol: (child: A) => Effect<unknown>;
  /**
   * Say the child stopped, usually a tell to the parent. It runs
   * after `remove`, on a fiber of its own that the closing scope never waits
   * for, so it may wait on the parent.
   */
  readonly notify: Effect<unknown, unknown>;
  /**
   * Take the child out of the host's table. It runs when the child's scope
   * closes, after its run has stopped, whether or not `enrol` ran, so it must
   * be safe on a child the table does not hold.
   */
  readonly remove: Effect<unknown>;
  /**
   * Start the child and return what the host keeps for it. It runs with the
   * child's scope provided, so a `run(machine, opts)` in it belongs to that
   * scope, and so does anything else it acquires. `scope` is the same scope,
   * for a host that keeps it to stop the child with `stop`. A failure
   * closes the child's scope, which runs `remove` and `notify`.
   */
  readonly start: (scope: Closeable) => Effect<A, E, R>;
}
```

<a id="stop"></a>

### `stop`

```ts
function stop(scope: Closeable): Effect<void>
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

<a id="tell"></a>

### `tell`

```ts
function tell<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string } = never,
  Err = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  runtime: EffectRuntime<S, M, E, Err>,
  msg: NoInfer<M>,
): Effect<void, StoreFailed | Err>
```
