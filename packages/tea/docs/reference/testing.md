# @demlik/tea/testing

> test-side ergonomics over @demlik/tea's pure substrate.

Tier: `stable`

```ts
import { … } from "@demlik/tea/testing";
```

## Exports (13)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`bindMachine`](#bindMachine) | Function | stable | Bind a machine + ctx into a small bag of 2-arg helpers. |
| [`BoundMachine`](#BoundMachine) | Interface | stable | The bound testing surface. |
| [`expectActiveSubs`](#expectActiveSubs) | Function | stable | Assert the exact set of subs desired at the final state after replaying `opts.msgs`. |
| [`expectCmdEmitted`](#expectCmdEmitted) | Function | stable | Assert that `cmd` appears at least once in the cmds array produced by replaying `opts.msgs`. |
| [`expectCmdSequence`](#expectCmdSequence) | Function | stable | Assert the exact ordered sequence of cmds emitted by replaying `opts.msgs`. |
| [`expectFinalState`](#expectFinalState) | Function | stable | Assert the final state after replaying `opts.msgs` equals `expected`. |
| [`expectReplayDeterministic`](#expectReplayDeterministic) | Function | stable | Assert that replaying `opts.msgs` is a pure function of the Msg log: the final state and every emitted Cmd come out the same under two different global wall-clocks and RNG seeds. |
| [`noopRuntime`](#noopRuntime) | Function | stable | Construct an inert `Runtime<S, M>` value. |
| [`ReplayOpts`](#ReplayOpts) | Interface | stable | Shared options shape for every test assertion below. |
| [`stateFactory`](#stateFactory) | Function | stable | Build a typed phase-constructor API from per-phase defaults. |
| [`StateFactoryAPI`](#StateFactoryAPI) | Type | stable | The API returned by `stateFactory`. |
| [`StateFactoryDefaults`](#StateFactoryDefaults) | Type | stable | Defaults shape passed to `stateFactory`. |
| [`step`](#step) | Function | stable | Single-msg step helper — feeds `loaded → msg → next state + cmds emitted by that msg`. |

## Declarations

<a id="bindMachine"></a>

### `bindMachine`

```ts
function bindMachine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: Ctx,
): BoundMachine<S, M, C, U, Ctx>
```

<a id="BoundMachine"></a>

### `BoundMachine`

```ts
interface BoundMachine<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx> {
  /**
   * Assert the exact set of subs desired at the final state. Mirrors the
   * free `expectActiveSubs(machine, opts, expected)`.
   */
  expectActiveSubs(opts: BoundOpts<S, M>, expected: readonly NoInfer<U | BuiltinSub<M>>[]): void;
  /**
   * Assert `cmd` appears at least once in the emitted cmd list. Order is
   * not asserted. Mirrors the free `expectCmdEmitted(machine, opts, cmd)`.
   */
  expectCmdEmitted(opts: BoundOpts<S, M>, cmd: NoInfer<C>): void;
  /**
   * Assert the exact ordered sequence of cmds emitted by replaying
   * `opts.msgs`. Mirrors the free `expectCmdSequence(machine, opts, expected)`.
   */
  expectCmdSequence(opts: BoundOpts<S, M>, expected: readonly NoInfer<C>[]): void;
  /**
   * Assert the final state after replaying `opts.msgs` deep-equals
   * `expected`. Mirrors the free `expectFinalState(machine, opts, expected)`.
   */
  expectFinalState(opts: BoundOpts<S, M>, expected: NoInfer<S>): void;
  /**
   * Bound `replay` — returns `{ state, cmds, subs }` for the given opts.
   * Use for the "narrow-then-assert" pattern where the test inspects a
   * specific field after `state.type === "..."` discrimination.
   */
  replay(
    opts: BoundOpts<S, M>,
  ): {
    cmds: readonly C[];
    state: S;
    subs: readonly (U | BuiltinSub<M>)[];
  };
  /**
   * Single-msg step — feeds `loaded → msg → [next state, cmds emitted by
   * that msg]`. Mirrors the free `step(machine, loaded, msg, ctx)`.
   */
  step(loaded: S, msg: M): readonly [S, readonly C[]];
}
```

<a id="expectActiveSubs"></a>

### `expectActiveSubs`

```ts
function expectActiveSubs<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<ReplayOpts<S, M, Ctx>>,
  expected: NoInfer<readonly U[]>,
): void
```

<a id="expectCmdEmitted"></a>

### `expectCmdEmitted`

```ts
function expectCmdEmitted<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<ReplayOpts<S, M, Ctx>>,
  cmd: NoInfer<C>,
): void
```

<a id="expectCmdSequence"></a>

### `expectCmdSequence`

```ts
function expectCmdSequence<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<ReplayOpts<S, M, Ctx>>,
  expected: NoInfer<readonly C[]>,
): void
```

<a id="expectFinalState"></a>

### `expectFinalState`

```ts
function expectFinalState<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<ReplayOpts<S, M, Ctx>>,
  expected: NoInfer<S>,
): void
```

<a id="expectReplayDeterministic"></a>

### `expectReplayDeterministic`

```ts
function expectReplayDeterministic<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<ReplayOpts<S, M, Ctx>>,
): void
```

<a id="noopRuntime"></a>

### `noopRuntime`

```ts
function noopRuntime<S, M extends { type: string }>(
  opts?: {
    /**
     * Optional value returned by `getState()`. Omit
     *   when the test never calls `getState()` on the no-op runtime — most
     *   tests only need the type-level slot filled.
     */
    initialState?: S;
  },
): Runtime<S, M>
```

<a id="ReplayOpts"></a>

### `ReplayOpts`

```ts
interface ReplayOpts<S, M, Ctx> {
  readonly ctx: Ctx;
  readonly loaded?: S | null;
  readonly msgs: readonly M[];
}
```

<a id="stateFactory"></a>

### `stateFactory`

```ts
function stateFactory<S extends { type: string }>(
  defaults: StateFactoryDefaults<S>,
): StateFactoryAPI<S>
```

<a id="StateFactoryAPI"></a>

### `StateFactoryAPI`

```ts
type StateFactoryAPI<S extends { type: string }> = { readonly [K in S["type"]]: (overrides?: Partial<RequiredFields<StateOf<S, K>>>) => StateOf<S, K> }
```

<a id="StateFactoryDefaults"></a>

### `StateFactoryDefaults`

```ts
type StateFactoryDefaults<S extends { type: string }> = { readonly [K in S["type"]]: RequiredFields<StateOf<S, K>> }
```

<a id="step"></a>

### `step`

```ts
function step<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  loaded: NoInfer<S>,
  msg: NoInfer<M>,
  ctx: NoInfer<Ctx>,
): readonly [S, readonly C[]]
```
