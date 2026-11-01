# @demlik/tea/promise

> the Promise engine: `run` boots a machine and drives its serial dispatch loop on Promises, `driveToDone` runs one to its terminal state, and `tell` puts a Msg on a run's line without waiting for it.

Tier: `stable`

```ts
import { … } from "@demlik/tea/promise";
```

## Exports (5)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`driveToDone`](#driveToDone) | Function | stable | Drive a machine from `start` to its terminal State in one call, then tear the runtime down. |
| [`DriveToDoneOptions`](#DriveToDoneOptions) | Type | stable | Options for `driveToDone`. |
| [`run`](#run) | Function | stable | Start a machine on the Promise engine and return its runtime. |
| [`tell`](#tell) | Function | stable | Put `msg` on a run's line and return at once. |
| [`TellAnswer`](#TellAnswer) | Type | stable | What `tell` answers, at once, about the Msg it was handed. |

## Declarations

<a id="driveToDone"></a>

### `driveToDone`

```ts
function driveToDone<
  S,
  M extends { type: string },
  E extends { type: string } = never,
>(
  handle: BootingRuntime<S, M, E>,
  start: M | ((booted: S) => M),
  isTerminal: (state: S) => boolean,
  opts?: DriveToDoneOptions<S, M>,
): Promise<S>
```

<a id="DriveToDoneOptions"></a>

### `DriveToDoneOptions`

```ts
type DriveToDoneOptions<S, M extends { type: string } = never> = DriveCancellation<S, M> & {
  /**
   * Marks a terminal State as a FAILURE. A State this holds for ends the drive
   * like any terminal one — the runtime is stopped — but the drive REJECTS with
   * `DriveFailedError` carrying it instead of resolving. A failed State is
   * terminal by definition; it need not also satisfy `isTerminal`. Omit → the
   * drive never rejects on State, only on a runtime error.
   */
  readonly failed?: (state: S) => boolean;
}
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
  E extends { type: string } = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: CtxArg<Ctx> & NoInfer<RunHandlers<M, C, U, Ctx>> & StoreAndOnError<S> & { clock?: (() => number) | undefined; events?: ((msg: M, state: S) => readonly E[]) | undefined; supervision?: Supervision<S, M> | undefined; terminal?: ((state: S) => boolean) | undefined; telemetry?: TelemetrySink | undefined; disposeTimeoutMs?: number | undefined; __idleCap?: number | undefin...,
): BootingRuntime<S, M, E>
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
>(
  machine: Machine<S, M, C, U, Ctx>,
  runtime: Runtime<S, M, E>,
  msg: NoInfer<M>,
): TellAnswer
```

<a id="TellAnswer"></a>

### `TellAnswer`

```ts
type TellAnswer = "no_cell" | "queued" | "stopped"
```
