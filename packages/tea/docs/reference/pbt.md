# @demlik/tea/pbt

> Property-based testing primitives for `@demlik/tea` machines.

Tier: `stable`

```ts
import { … } from "@demlik/tea/pbt";
```

## Exports (13)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`arbConstantMsg`](#arbConstantMsg) | Function | stable | Build a payload-free Msg variant arbitrary. |
| [`arbGuidedSequence`](#arbGuidedSequence) | Function | stable | State-aware Msg sequence arbitrary — generates only msgs whose precondition holds in the current state. |
| [`arbMsg`](#arbMsg) | Function | stable | Build a single `fc.Arbitrary<M>` from a `MsgArbitraryTable<M>`. |
| [`arbMsgSequence`](#arbMsgSequence) | Function | stable | Build an arbitrary of Msg sequences over a per-Msg arbitrary. |
| [`arbRecordMsg`](#arbRecordMsg) | Function | stable | Build a record-shaped Msg variant arbitrary. |
| [`foldEvents`](#foldEvents) | Function | stable | Fold a Msg sequence through a machine's pure reducer, returning the per-step trace, every state in order, and the final state. |
| [`MsgArbitraryTable`](#MsgArbitraryTable) | Type | stable | Strict per-variant Msg arbitrary table. |
| [`msgTypeKeys`](#msgTypeKeys) | Function | stable | Extract the Msg discriminant set at runtime from a machine. |
| [`propertyInvariant`](#propertyInvariant) | Function | stable | Assert a predicate holds on EVERY transition step in a generated sequence. |
| [`propertyTerminates`](#propertyTerminates) | Function | stable | Assert every generated Msg sequence ends in a terminal state. |
| [`propertyTrace`](#propertyTrace) | Function | stable | Assert a predicate over the full trace plus the final state. |
| [`Step`](#Step) | Interface | stable | One unit in a fold trace — the four pieces of data a property invariant typically asserts on. |
| [`stubCtxThrowingProxy`](#stubCtxThrowingProxy) | Function | stable | Build a Ctx value whose every property access throws. |

## Declarations

<a id="arbConstantMsg"></a>

### `arbConstantMsg`

```ts
function arbConstantMsg<T extends string>(type: T): Arbitrary<{ type: T }>
```

<a id="arbGuidedSequence"></a>

### `arbGuidedSequence`

```ts
function arbGuidedSequence<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  _machine: Machine<S, M, C, U, Ctx>,
  _ctx: Ctx,
  _cells: { [K in string]?: (state: S) => Arbitrary<Extract<M, { type: K }>> | null },
  _opts?: { maxLength?: number },
): Arbitrary<readonly M[]>
```

<a id="arbMsg"></a>

### `arbMsg`

```ts
function arbMsg<M extends { type: string }>(
  table: MsgArbitraryTable<M>,
  opts?: { weights?: Partial<Record<M["type"], number>> },
): Arbitrary<M>
```

<a id="arbMsgSequence"></a>

### `arbMsgSequence`

```ts
function arbMsgSequence<M extends { type: string }>(
  msgArb: Arbitrary<M>,
  opts?: {
    readonly maxLength?: number;
    readonly minLength?: number;
    readonly prefix?: readonly NoInfer<M>[];
  },
): Arbitrary<readonly M[]>
```

<a id="arbRecordMsg"></a>

### `arbRecordMsg`

```ts
function arbRecordMsg<T extends string, R>(
  type: T,
  fields: { [K in string | number | symbol]: Arbitrary<R[K]> },
): Arbitrary<{ type: T } & R>
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
): {
  readonly finalState: S;
  readonly states: readonly S[];
  readonly steps: readonly Step<S, M, C>[];
}
```

<a id="MsgArbitraryTable"></a>

### `MsgArbitraryTable`

```ts
type MsgArbitraryTable<M extends { type: string }> = { [K in M["type"]]: fc.Arbitrary<Extract<M, { type: K }>> }
```

<a id="msgTypeKeys"></a>

### `msgTypeKeys`

```ts
function msgTypeKeys<S, M extends { type: string }, C extends Cmd>(
  machine: {
    __form?: UpdateForm;
    update: Reducer<S, M, C> | ([S] extends [{ type: string }] ? Transitions<S, M, C> : never);
  },
): readonly string[]
```

<a id="propertyInvariant"></a>

### `propertyInvariant`

```ts
function propertyInvariant<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  seqArb: Arbitrary<readonly NoInfer<M>[]>,
  invariant: (step: Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): void
```

<a id="propertyTerminates"></a>

### `propertyTerminates`

```ts
function propertyTerminates<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  seqArb: Arbitrary<readonly NoInfer<M>[]>,
  terminal: (state: NoInfer<S>) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): void
```

<a id="propertyTrace"></a>

### `propertyTrace`

```ts
function propertyTrace<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  seqArb: Arbitrary<readonly NoInfer<M>[]>,
  predicate: (
    steps: readonly Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>[],
    finalState: NoInfer<S>,
  ) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): void
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

<a id="stubCtxThrowingProxy"></a>

### `stubCtxThrowingProxy`

```ts
function stubCtxThrowingProxy<Ctx>(): Ctx
```
