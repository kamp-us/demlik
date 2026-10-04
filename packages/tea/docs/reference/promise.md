# @demlik/tea/promise

> the Promise engine: `run` boots a machine and drives its serial dispatch loop on Promises, and `driveToDone` runs one to its terminal state.

Tier: `stable`

```ts
import { … } from "@demlik/tea/promise";
```

## Exports (3)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`driveToDone`](#driveToDone) | Function | stable | Drive a machine from `start` to its terminal State in one call, then tear the runtime down. |
| [`DriveToDoneOptions`](#DriveToDoneOptions) | Type | stable | Options for `driveToDone`. |
| [`run`](#run) | Function | stable | Start a machine on the Promise engine and return its runtime. |

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
type DriveToDoneOptions<S, M extends { type: string } = never> = DriveCancellation<S, M> & { readonly failed?: (state: S) => boolean }
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
  opts: CtxArg<Ctx> & NoInfer<RunHandlers<M, C, U, Ctx>> & {
    clock?: () => number;
    disposeTimeoutMs?: number;
    events?: (msg: M, state: S) => readonly E[];
    onError?: OnError;
    store?: Store<S>;
    supervision?: Supervision<S, M>;
    telemetry?: TelemetrySink;
    terminal?: (state: S) => boolean;
  },
): BootingRuntime<S, M, E>
```
