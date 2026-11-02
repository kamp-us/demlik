# @demlik/tea/pbt

> Property-based testing primitives for `@demlik/tea` machines.

Tier: `stable`

```ts
import { … } from "@demlik/tea/pbt";
```

## Exports (24)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`AnswerCell`](#AnswerCell) | Interface | stable | How one type of Cmd gets answered. |
| [`arbConstantMsg`](#arbConstantMsg) | Function | stable | Build a payload-free Msg variant arbitrary. |
| [`arbGuidedSequence`](#arbGuidedSequence) | Function | stable | Draw Msg lists in which every answer answers a Cmd that was sent and not yet answered, so a law that something must happen can be checked on random lists. |
| [`arbMsg`](#arbMsg) | Function | stable | Build a single `fc.Arbitrary<M>` from a `MsgArbitraryTable<M>`. |
| [`arbMsgSequence`](#arbMsgSequence) | Function | stable | Build an arbitrary of Msg sequences over a per-Msg arbitrary. |
| [`arbRecordMsg`](#arbRecordMsg) | Function | stable | Build a record-shaped Msg variant arbitrary. |
| [`Fold`](#Fold) | Interface | stable | What foldEvents hands back: every state in order, one Step per Msg, the final state, and the Cmds `init` sent. |
| [`foldEvents`](#foldEvents) | Function | stable | Fold a Msg sequence through a machine's pure reducer, returning the per-step trace, every state in order, the final state, and the Cmds `init` sent. |
| [`GuidedCells`](#GuidedCells) | Interface | stable | What arbGuidedSequence draws from. |
| [`LawBreak`](#LawBreak) | Interface | experimental | What a broken law says. |
| [`lawInvariant`](#lawInvariant) | Function | experimental | The law `propertyInvariant` runs: `invariant` holds on every step of the fold. |
| [`lawTerminates`](#lawTerminates) | Function | experimental | The law `propertyTerminates` runs: the fold's final state is one `terminal` accepts. |
| [`lawTrace`](#lawTrace) | Function | experimental | The law `propertyTrace` runs: `predicate` holds on the fold's steps and final state together. |
| [`MsgArbitraryTable`](#MsgArbitraryTable) | Type | stable | Strict per-variant Msg arbitrary table. |
| [`MsgCount`](#MsgCount) | Interface | stable | What a property run's lists did with one Msg type. |
| [`msgTypeKeys`](#msgTypeKeys) | Function | stable | Extract the Msg discriminant set at runtime from a machine. |
| [`PropertyFailure`](#PropertyFailure) | Class | stable | Raised when a property fails. |
| [`propertyInvariant`](#propertyInvariant) | Function | stable | Assert a predicate holds on EVERY transition step in a generated sequence. |
| [`PropertyOpts`](#PropertyOpts) | Interface | stable | What every property runner takes: the saved state to start from, the two checks below, and fast-check's `Parameters` (`numRuns` defaults to 200 here). |
| [`PropertyRun`](#PropertyRun) | Interface | stable | What a property run did. |
| [`propertyTerminates`](#propertyTerminates) | Function | stable | Assert every generated Msg sequence ends in a terminal state. |
| [`propertyTrace`](#propertyTrace) | Function | stable | Assert a predicate over the full trace plus the final state. |
| [`Step`](#Step) | Interface | stable | One unit in a fold trace — the four pieces of data a property invariant typically asserts on. |
| [`stubCtxThrowingProxy`](#stubCtxThrowingProxy) | Function | stable | Build a Ctx value whose every property access throws. |

## Declarations

<a id="AnswerCell"></a>

### `AnswerCell`

```ts
interface AnswerCell<K extends Cmd, V, M> {
  readonly draw: Arbitrary<V>;
  readonly make: (cmd: K, value: V) => NoInfer<M>;
}
```

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
  A extends { readonly [K in string]?: unknown },
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  cells: GuidedCells<M, C, A>,
  opts?: {
    readonly loaded?: NoInfer<S> | null;
    readonly maxLength?: number;
    readonly size?: SizeForArbitrary;
  },
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

<a id="GuidedCells"></a>

### `GuidedCells`

```ts
interface GuidedCells<
  M extends { type: string },
  C extends Cmd,
  A extends { readonly [K in C["type"]]?: unknown },
> {
  readonly answers?: { readonly [K in string | number | symbol]: K extends C["type"] ? AnswerCell<Extract<C, { type: K }>, A[K], M> : never };
  readonly outside?: { readonly [K in string]?: Arbitrary<Extract<M, { type: K }>> };
}
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

<a id="PropertyOpts"></a>

### `PropertyOpts`

```ts
interface PropertyOpts<S> extends Omit<fc.Parameters, "asyncReporter" | "examples" | "plugins" | "reporter" | "timeout"> {
  /**
   * Fail a run whose laws all held when a Msg type never acted, naming each such
   * type, so a cut path can't stay green. Default `false`.
   *
   * A deep path needs a `maxLength` well past its depth as well as `size: "max"`
   * on `arbMsgSequence`. Lists too short to reach a healthy machine's deep state
   * name that healthy path as never acted, in the same report a cut path gives. At
   * the default `maxLength` of 30, a state 20 steps deep on 6 Msg types drawn evenly
   * fails this way, since only one draw in 6 climbs. Allow about the depth times the
   * number of Msg types, here `maxLength: 120`.
   *
   * This stays out of any run with a non-empty `path`, so drop `path` to have it
   * check again. A path with a colon, such as `"0:0"`, replays one shrunk failure. A
   * path with no colon, such as `"3"`, is what a failure with no shrinks reports, and
   * it is no replay once that failure is gone: fast-check draws a full `numRuns` of
   * lists starting from that one, and a cut path reads green. `path: ""` is no path
   * to fast-check, so this applies there.
   *
   * A value `structuralHash` refuses (a `Date`, a `Map`, a class instance) leaves
   * "acted" unreadable when a step's comparison reaches it, so this fails the run
   * saying so. The comparison stops at the first difference and doesn't look inside
   * an object `prev` and `next` share, so a refused value stays unread, and fails
   * nothing, when it sits in a shared object or past a difference. The answer is
   * right either way: a shared object didn't change, and a difference means the
   * step acted. Fields are compared in the order the state's keys were set.
   */
  readonly failOnNeverActed?: boolean;
  /**
   * Fail a run when `init` or a step sends a Cmd whose `type` isn't in
   * `machine.cmds`, naming that Cmd. Default `false`, because tea lets a machine
   * keep a hand-written Cmd beside its defined ones. A machine with no `cmds` field
   * has no list to check against, so this adds nothing there. `cmds: []` is a list
   * with nothing on it, so every Cmd fails.
   *
   * A value with no string `type` is never a Cmd, so it fails with this off too, on
   * every machine.
   */
  readonly failOnUndeclaredCmd?: boolean;
  /**
   * Saved state passed to `machine.init(loaded, ctx)`. Default `null`. An
   * arbitrary draws one per run, and a failure's counterexample shows the drawn
   * state beside the shrunk list. It can draw `null` as well, the nothing storage
   * hands back on a fresh start, which boots the machine fresh.
   */
  readonly loaded?: S | Arbitrary<S | null> | null;
}
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
   * A step counts as acted when its comparison reaches a value `structuralHash`
   * refuses (a `Date`, a `Map`, a class instance). One in an object `prev` and `next`
   * share, or past a difference, is never reached, so it changes no count.
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
