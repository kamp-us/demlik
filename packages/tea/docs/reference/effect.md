# @demlik/tea/effect

> the Effect engine: `run` boots a machine with Effect handlers and sub runners, the caller's Layers and interruption on stop, and yields an Effect handle: the Promise engine's member names, with Effects that fail with `Stopped`, `StoreFailed` or a cell's declared failure where the Promise engine returns Promises. `spawn`, `stop` and `tell` are for a host that runs child machines under a parent: it keeps its own table of children, and they run the steps that race.

Tier: `stable`

```ts
import { … } from "@demlik/tea/effect";
```

## Exports (20)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`CellErrors`](#CellErrors) | Type | stable | The failures a dispatch on the handle can end with from an `interpret` map: the error type of every hand-written Cmd's cell. |
| [`CheckingSchema`](#CheckingSchema) | Type | stable | An Effect schema that checks a value and hands the same type on. |
| [`Cmd`](#Cmd) | Type | stable | A Cmd value, as the core types it. |
| [`Cmd`](#Cmd) | Variable | stable | The helpers for building Cmds on the Effect engine. |
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

<a id="CheckingSchema"></a>

### `CheckingSchema`

```ts
type CheckingSchema<T> = Schema.Codec<T, NoInfer<T>>
```

<a id="Cmd"></a>

### `Cmd`

```ts
type Cmd<T extends string = string, Ok = unknown, E = unknown> = CoreCmd<T, Ok, E>

const Cmd: {
  /**
   * Flat concat of cmd arrays. Use when a cell composes effects from
   * multiple conditional sources:
   *
   *   return [next, Cmd.batch(
   *     Cmd.whenDefined(state.queueItemId, (id) => ({ type: "complete", id })),
   *     Cmd.when(state.windowId !== undefined, { type: "close_window", windowId }),
   *     [{ type: "detach_debugger", tabId: state.tabId }],
   *   )];
   *
   * `<const C>` keeps inline cmd literals' discriminants narrow (same
   * rationale as `when` / `whenDefined` above).
   */
  readonly batch: <const C extends Cmd<string, unknown, unknown>>(
    ...arrs: readonly (readonly C[])[],
  ) => readonly C[];
  /**
   * Declare a typed Cmd constructor from plain Effect schemas. It returns what
   * the core `Cmd.define` returns, with each schema passed through
   * `Schema.toStandardSchemaV1` for you:
   *
   *   const fetchUser = Cmd.define("fetch_user", {
   *     input: Schema.Struct({ id: Schema.String }),
   *     ok: Schema.Struct({ name: Schema.String }),
   *     err: ["not_found"],
   *   });
   *
   * `input` and `ok` take a schema that checks and never translates: both of
   * its sides are one type and decoding needs no service. A transformation, a
   * brand or a schema that needs a service is a compile error.
   *
   * To keep the checks of a transformation or a brand, pass
   * `Schema.toType(schema)`. That is no way through for a schema that needs a
   * service: its check lives in the decode step, and `Schema.toType` drops that
   * step, so the Cmd would compile and never run the check. Run such a check in
   * the handler.
   *
   * A schema whose validation needs a Promise compiles, and is refused with
   * `AsyncSchemaError` when the Cmd settles, as the core's is.
   *
   * It takes Effect schemas only. A zod schema, or any other Standard Schema,
   * goes to `Cmd.define` from `@demlik/tea`.
   */
  define: <
    const Name extends string,
    Input extends CmdInput,
    Ok,
    const Tags extends readonly string[],
  >(
    name: Name,
    spec: {
      readonly err: Tags;
      readonly input: CheckingSchema<Input>;
      readonly ok: CheckingSchema<Ok>;
    },
  ) => CmdDef<Name, Input, Ok, TaggedError<Tags[number]>>;
  /**
   * The empty Cmd array. Typed `readonly never[]` so it's assignable to any
   * `readonly C[]` for any `C extends Cmd`. Use in `init` returns and
   * Transitions cells that emit zero effects:
   *
   *   init: (loaded) => [loaded ?? initial, Cmd.none],
   *   tick: (state) => [state, Cmd.none],
   *
   * Elm's `Cmd.none` analogue. Cultural signal alongside the runtime help:
   * `[state, Cmd.none]` reads as intent ("this transition emits nothing"),
   * `[state, []]` reads as "empty array of what".
   *
   * Frozen at runtime so a downstream consumer can't `.push()` into the
   * shared reference.
   */
  readonly none: readonly never[];
  /**
   * Emit `cmd` wrapped in a single-element array iff `cond` is true.
   * Otherwise return the empty array. Spreads cleanly into the cmds array
   * returned by a Transitions cell.
   *
   * `const C` (TypeScript 5.0+) keeps the inferred `type:` discriminator
   * literal narrow when called with an object literal — so `Cmd.when(b,
   * { type: "x", ... })` infers as `{ type: "x", ... }`, not `{ type:
   * string, ... }`, and stays assignable to a discriminated-union arm
   * without `as const` at the call site.
   */
  readonly when: <const C extends Cmd<string, unknown, unknown>>(
    cond: boolean,
    cmd: C,
  ) => readonly C[];
  /**
   * If `value` is defined, call `build(value)` and emit the resulting cmd
   * wrapped in a single-element array. If `value` is `undefined`, return
   * the empty array. `value` is narrowed to `T` inside `build`.
   *
   * `const C` on the return type keeps the callback's object-literal
   * `type:` field narrow (see `when` above for the full rationale).
   */
  readonly whenDefined: <T, const C extends Cmd<string, unknown, unknown>>(
    value: T | undefined,
    build: (value: T) => C,
  ) => readonly C[];
}
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
   * Stop the run: drain in-flight work, up to `disposeTimeoutMs`, stop its
   * Subs, flush the final State. `stop()` interrupts every handler still in
   * flight, so the limit is reached only by a handler that cannot be
   * interrupted. Closing the run's Scope stops the run the same way, and
   * `stop()` leaves that Scope open. So for a child under `spawn` the two
   * differ: `stop()` does not take the child out of the host's table or tell
   * the parent. Stop such a child with the `stop` helper.
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
  /**
   * How long `stop()` waits for the queue, and then for async teardown,
   * before giving up on each. Defaults to 5_000ms. `stop()` interrupts every
   * handler here, so the first wait ends early unless a handler cannot be
   * interrupted.
   *
   * A store call is not interrupted. tea starts none after `stop()` has
   * returned, but one already under way when `stop()` gave up can finish
   * after it. On a plain store that late save can overwrite what a newer
   * run saved; a fenced store refuses it. So a host that starts a new run on
   * the same store after a `stop()` that gave up needs a fenced store.
   */
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
  /**
   * Succeeds with the terminal State only once it is saved. A failed terminal
   * save fails with `StoreFailed` (`operation: "save"`), for waiting and later
   * callers. Without a store, answers as soon as State is set.
   */
  done(): Effect<S, StoreFailed>;
  /** The current State. Total. */
  getState(): S;
  /** Succeeds once every dispatched Msg and its follow-ups are processed. */
  idle(): Effect<void>;
  /**
   * The saved terminal State, or `undefined` while its save is pending or failed.
   * Without a store, answers as soon as State is set.
   */
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
   *
   * It cannot fail: nothing reads that fiber, so the step itself handles what
   * its notice can fail with, such as the `StoreFailed` of a `tell`. A defect
   * in it is not observed by `spawn` and ends the fiber unseen.
   */
  readonly notify: Effect<unknown>;
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
  readonly operation: "load" | "save";
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
