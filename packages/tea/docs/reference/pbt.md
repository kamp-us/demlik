# @demlik/tea/pbt

> Property-based testing primitives for `@demlik/tea` machines.

Tier: `stable`

```ts
import { … } from "@demlik/tea/pbt";
```

## Exports (16)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`arbConstantMsg`](#arbConstantMsg) | Function | stable | Build a payload-free Msg variant arbitrary. |
| [`arbGuidedSequence`](#arbGuidedSequence) | Function | stable | State-aware Msg sequence arbitrary — generates only msgs whose precondition holds in the current state. |
| [`arbMsg`](#arbMsg) | Function | stable | Build a single `fc.Arbitrary<M>` from a `MsgArbitraryTable<M>`. |
| [`arbMsgSequence`](#arbMsgSequence) | Function | stable | Build an arbitrary of Msg sequences over a per-Msg arbitrary. |
| [`arbRecordMsg`](#arbRecordMsg) | Function | stable | Build a record-shaped Msg variant arbitrary. |
| [`foldEvents`](#foldEvents) | Function | stable | Fold a Msg sequence through a machine's pure reducer, returning the per-step trace, every state in order, the final state, and the Cmds `init` sent. |
| [`MsgArbitraryTable`](#MsgArbitraryTable) | Type | stable | Strict per-variant Msg arbitrary table. |
| [`MsgCount`](#MsgCount) | Interface | stable | What a property run's lists did with one Msg type. |
| [`msgTypeKeys`](#msgTypeKeys) | Function | stable | Extract the Msg discriminant set at runtime from a machine. |
| [`PropertyFailure`](#PropertyFailure) | Class | stable | Raised when a property fails. |
| [`propertyInvariant`](#propertyInvariant) | Function | stable | Assert a predicate holds on EVERY transition step in a generated sequence. |
| [`PropertyRun`](#PropertyRun) | Interface | stable | What a property run did. |
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
    /**
     * Forwarded to `fc.array`. Left out, fast-check's default size applies:
     * `"small"` unless `fc.configureGlobal` changed it, which draws at most
     * `2 * minLength + 10` Msgs however large `maxLength` is. So `maxLength: 60`
     * comes out about 10 long, and a state that takes more steps than that is
     * never reached. Pass `"max"` to draw up to `maxLength`.
     */
    readonly size?: SizeForArbitrary;
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
  readonly initCmds: readonly C[];
  readonly states: readonly S[];
  readonly steps: readonly Step<S, M, C>[];
}
```

<a id="MsgArbitraryTable"></a>

### `MsgArbitraryTable`

```ts
type MsgArbitraryTable<M extends { type: string }> = { [K in M["type"]]: fc.Arbitrary<Extract<M, { type: K }>> }
```

<a id="MsgCount"></a>

### `MsgCount`

```ts
interface MsgCount {
  /**
   * How many of those acted: the step's `next` differs from its `prev` by
   * `structuralHash`, or the step sent a Cmd.
   */
  readonly acted: number;
  /** How many of this Msg type the run's lists held. */
  readonly drawn: number;
}
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

<a id="PropertyFailure"></a>

### `PropertyFailure`

```ts
class PropertyFailure extends Error {
  constructor(report: string, run: PropertyRun, options?: ErrorOptions);
  readonly _tag: "PropertyFailure";
  readonly name: "PropertyFailure";
  /** The run that failed. */
  readonly run: PropertyRun;
}
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
  invariant: (
    step: Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>,
    initCmds: readonly NoInfer<C>[],
  ) => string | boolean | null,
  opts?: NoInfer<PropertyOpts<S>>,
): PropertyRun
```

<a id="PropertyRun"></a>

### `PropertyRun`

```ts
interface PropertyRun {
  /**
   * What the run's lists did, per Msg type: every type the machine has a cell for,
   * then any other that was drawn. A type never drawn reads zero. On a failure this
   * stops at the failing list, so shrinking adds nothing, and a list skipped with
   * `fc.pre` adds nothing either. A list whose reducer threw adds nothing as well,
   * though `numRuns` includes it: its fold hands back no steps to count.
   *
   * A state `structuralHash` refuses (a `Date`, a `Map`, a class instance) counts
   * as acted whenever a cell returned a new object.
   */
  readonly msgCounts: ReadonlyMap<string, MsgCount>;
  /** Lists tried. On a failure, this counts up to and including the failing one. */
  readonly numRuns: number;
  /** Shrink steps a failure took. `0` on a pass. */
  readonly numShrinks: number;
  /**
   * Where the shrunk failure sits. Pass it back as `path`, with `seed`, to replay
   * that one failure. `null` when no list failed: on a pass, on an interrupt
   * marked as a failure, when too many `fc.pre` skips fail the run, or when
   * `failOnNeverActed` fails it.
   */
  readonly path: string | null;
  /** The seed this run drew from. Pass it back as `seed` to draw the same lists. */
  readonly seed: number;
}
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
  terminal: (state: NoInfer<S>, initCmds: readonly NoInfer<C>[]) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): PropertyRun
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
    initCmds: readonly NoInfer<C>[],
  ) => string | boolean | null,
  opts?: NoInfer<PropertyOpts<S>>,
): PropertyRun
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
