# @demlik/tea/react

> React host adapter for `@demlik/tea`.

Tier: `stable`

```ts
import { … } from "@demlik/tea/react";
```

## Exports (3)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`useMachine`](#useMachine) | Function | stable | Build and own a run of `machine` for the lifetime of the component mount, on the engine whose `run` the caller hands in. |
| [`UseMachineOpts`](#UseMachineOpts) | Type | stable | Options passed to `useMachine`. |
| [`useRuntime`](#useRuntime) | Function | stable | Lower-level escape hatch: consume an externally-built, booted run — any engine's BootedRunHandle (the Promise engine's `Runtime` is one). |

## Declarations

<a id="useMachine"></a>

### `useMachine`

```ts
function useMachine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<UseMachineOpts<S, M, C, U, Ctx>>,
): [S, (msg: M) => Promise<void>]
```

<a id="UseMachineOpts"></a>

### `UseMachineOpts`

```ts
type UseMachineOpts<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx> = {
  ctx: Ctx;
  run: EngineRun<S, M, C, U, Ctx>;
  store?: Store<S>;
} & RunHandlers<M, C, U, Ctx>
```

<a id="useRuntime"></a>

### `useRuntime`

```ts
function useRuntime<
  S,
  M extends { type: string },
  E extends { type: string } = never,
>(
  runtime: BootedRunHandle<S, M, E>,
): [S, (msg: M) => Promise<void>]
```
