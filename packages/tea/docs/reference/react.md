# @demlik/tea/react

> React host adapter for `@demlik/tea`.

Tier: `stable`

```ts
import { … } from "@demlik/tea/react";
```

## Exports (5)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`useMachine`](#useMachine) | Function | stable | Build and own a run of `machine` for the lifetime of the component mount, on the engine whose `run` the caller hands in. |
| [`UseMachineOpts`](#UseMachineOpts) | Type | stable | Options passed to `useMachine`. |
| [`useRuntime`](#useRuntime) | Function | stable | Consume a booted run from either engine's `run`, or a hand-built ViewHandle with a Promise-returning `dispatch`. |
| [`UseRuntimeOpts`](#UseRuntimeOpts) | Type | stable | Options for `useRuntime`: the sink for a Msg that never reached the run. |
| [`ViewHandle`](#ViewHandle) | Type | stable | What `useRuntime` reads: a booted run from either engine's `run`, or a hand-built handle. |

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
): [S, (msg: M) => void]
```

<a id="UseMachineOpts"></a>

### `UseMachineOpts`

```ts
type UseMachineOpts<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx> = { ctx: Ctx; run: EngineRun<S, M, C, U, Ctx> } & StoreAndOnError<S> & RunHandlers<M, C, U, Ctx>
```

<a id="useRuntime"></a>

### `useRuntime`

```ts
function useRuntime<S, M extends { type: string }>(
  runtime: ViewHandle<S, M>,
  opts?: UseRuntimeOpts,
): [S, (msg: M) => void]
function useRuntime<S, M extends { type: string }, V>(
  runtime: ViewHandle<S, M>,
  select: (state: S) => V,
  opts?: UseRuntimeOpts,
): [V, (msg: M) => void]
```

<a id="UseRuntimeOpts"></a>

### `UseRuntimeOpts`

```ts
type UseRuntimeOpts = {
  /** Where a send to a stopped run, or a hand-built `dispatch`'s failure, is reported. Default: the default sink. */
  readonly onError?: OnError;
}
```

<a id="ViewHandle"></a>

### `ViewHandle`

```ts
type ViewHandle<S, M extends { type: string }> = {
  getState(): S;
  subscribe(listener: () => void): () => void;
} & SendTarget<S, M>
```
