# @demlik/tea/paginate

> the pagination batteries: the cursor walk as pure state, and the resumable end-to-end traversal built over it.

Tier: `battery`

```ts
import { … } from "@demlik/tea/paginate";
```

## Exports (18)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`createPaginatedWalk`](#createPaginatedWalk) | Function | battery | Build a paginated-walk knob from `config`. |
| [`defaultPaginatorPolicy`](#defaultPaginatorPolicy) | Variable | battery | Sensible defaults: start from a numeric offset of `0`, pause after 1000 un-drained items. |
| [`drain`](#drain) | Function | battery | Acknowledge that the consumer finished processing `n` items, lowering the backpressure gauge. |
| [`FetchPageCmd`](#FetchPageCmd) | Type | battery | The page-fetch effect this knob emits: the inherited `resilient_run` Cmd from resilient-call, whose `input` is the `Cursor` to fetch and whose `key` is the fixed `PAGE_KEY`. |
| [`initPaginator`](#initPaginator) | Function | battery | The starting state: idle, nothing seen, no pages recorded. |
| [`isDone`](#isDone) | Function | battery | Whether the walk has finished (the API returned a null next cursor). |
| [`liftWalk`](#liftWalk) | Function | battery | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.walk`. |
| [`PAGE_KEY`](#PAGE_KEY) | Variable | battery | The single resilient-call key every page fetch runs under. |
| [`PageErrMsg`](#PageErrMsg) | Type | battery | The Msg the engine mints when the page-fetch handler fails. |
| [`PageOkMsg`](#PageOkMsg) | Type | battery | The page-settled Msgs the engine mints from that handler's outcome. |
| [`PaginatedWalkConfig`](#PaginatedWalkConfig) | Interface | battery | The paginated-walk knob. |
| [`PaginatedWalkState`](#PaginatedWalkState) | Interface | battery | The slice. |
| [`PaginatedWalkTimerMsg`](#PaginatedWalkTimerMsg) | Type | battery | The retry / deadline timer Msg — inherited from resilient-call. |
| [`PaginatorPolicy`](#PaginatorPolicy) | Interface | battery | Paginator policy — pure configuration, no mutable state. |
| [`PaginatorState`](#PaginatorState) | Type | battery | The walk's phase. |
| [`recordPage`](#recordPage) | Function | battery | Record the result of the outstanding fetch and decide what comes next. |
| [`resume`](#resume) | Function | battery | Re-open the backpressure valve after a `drain`. |
| [`start`](#start) | Function | battery | Arm the first fetch. |

## Declarations

<a id="createPaginatedWalk"></a>

### `createPaginatedWalk`

```ts
function createPaginatedWalk<Cursor, Page, EmittedCmd extends Cmd = Cmd>(
  config: PaginatedWalkConfig<Cursor, Page, EmittedCmd>,
  rng?: () => number,
): {
  deadlines: (s: PaginatedWalkState<Cursor, Page>) => readonly DeadlineSub[];
  drain: (
    s: PaginatedWalkState<Cursor, Page>,
    n: number,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  failure: (s: PaginatedWalkState<Cursor, Page>) => unknown;
  fetch: CmdDef<"resilient_run", { readonly input: Cursor; readonly key: string }, Page, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>;
  init: () => PaginatedWalkState<Cursor, Page>;
  isComplete: (s: PaginatedWalkState<Cursor, Page>) => boolean;
  isStuck: (s: PaginatedWalkState<Cursor, Page>) => boolean;
  onTimer: (
    s: PaginatedWalkState<Cursor, Page>,
    msg: PaginatedWalkTimerMsg,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  pageErr: (
    s: PaginatedWalkState<Cursor, Page>,
    msg: PageErrMsg,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  pageOk: (
    s: PaginatedWalkState<Cursor, Page>,
    msg: PageOkMsg<Page>,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  resume: (
    s: PaginatedWalkState<Cursor, Page>,
    at: number,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  start: (
    s: PaginatedWalkState<Cursor, Page>,
    at: number,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  timer: (
    s: PaginatedWalkState<Cursor, Page>,
  ) => TimerDeps<ResilientTimerMsg<"resilient">> | null;
}
```

<a id="defaultPaginatorPolicy"></a>

### `defaultPaginatorPolicy`

```ts
const defaultPaginatorPolicy: PaginatorPolicy<number>
```

<a id="drain"></a>

### `drain`

```ts
function drain<Cursor>(
  state: PaginatorState<Cursor>,
  n: number,
): PaginatorState<Cursor>
```

<a id="FetchPageCmd"></a>

### `FetchPageCmd`

```ts
type FetchPageCmd<Cursor> = RunCmd<Cursor>
```

<a id="initPaginator"></a>

### `initPaginator`

```ts
function initPaginator<Cursor>(): PaginatorState<Cursor>
```

<a id="isDone"></a>

### `isDone`

```ts
function isDone<Cursor>(state: PaginatorState<Cursor>): boolean
```

<a id="liftWalk"></a>

### `liftWalk`

```ts
function liftWalk<
  S extends { walk: PaginatedWalkState<Cursor, Page> },
  Cursor,
  Page,
  C extends Cmd,
>(
  state: S,
  __namedParameters: readonly [PaginatedWalkState<Cursor, Page>, readonly C[]],
): readonly [S, readonly C[]]
```

<a id="PAGE_KEY"></a>

### `PAGE_KEY`

```ts
const PAGE_KEY: "page"
```

<a id="PageErrMsg"></a>

### `PageErrMsg`

```ts
type PageErrMsg = FailMsg
```

<a id="PageOkMsg"></a>

### `PageOkMsg`

```ts
type PageOkMsg<Page> = SucceedMsg<Page>
```

<a id="PaginatedWalkConfig"></a>

### `PaginatedWalkConfig`

```ts
interface PaginatedWalkConfig<Cursor, Page, EmittedCmd extends Cmd> {
  readonly circuit?: CircuitConfig;
  readonly deadline?: DeadlineConfig;
  readonly firstPage: Cursor;
  readonly highWaterMark?: number;
  readonly nextCursor: (page: Page) => Cursor | null;
  readonly onPage: (page: Page) => readonly EmittedCmd[];
  readonly pageSize?: (page: Page) => number;
  readonly rateLimit?: RateLimitConfig;
  readonly retry?: RetryPolicy;
}
```

<a id="PaginatedWalkState"></a>

### `PaginatedWalkState`

```ts
interface PaginatedWalkState<Cursor, Page> {
  readonly resilience: ResilientState<Cursor, Page>;
  readonly walk: PaginatorState<Cursor>;
}
```

<a id="PaginatedWalkTimerMsg"></a>

### `PaginatedWalkTimerMsg`

```ts
type PaginatedWalkTimerMsg = ResilientTimerMsg
```

<a id="PaginatorPolicy"></a>

### `PaginatorPolicy`

```ts
interface PaginatorPolicy<Cursor> {
  readonly firstCursor: Cursor;
  readonly highWaterMark: number;
}
```

<a id="PaginatorState"></a>

### `PaginatorState`

```ts
type PaginatorState<Cursor> =
  | {
    readonly pages: number;
    readonly phase: "idle";
    readonly seen: number;
  }
  | {
    readonly cursor: Cursor;
    readonly pages: number;
    readonly phase: "fetching";
    readonly seen: number;
  }
  | {
    readonly cursor: Cursor;
    readonly pages: number;
    readonly phase: "paused";
    readonly seen: number;
  }
  | {
    readonly pages: number;
    readonly phase: "done";
    readonly seen: number;
  }
```

<a id="recordPage"></a>

### `recordPage`

```ts
function recordPage<Cursor>(
  state: PaginatorState<Cursor>,
  count: number,
  next: Cursor | null | undefined,
  policy: PaginatorPolicy<Cursor>,
): PaginatorState<Cursor>
```

<a id="resume"></a>

### `resume`

```ts
function resume<Cursor>(
  state: PaginatorState<Cursor>,
  policy: PaginatorPolicy<Cursor>,
): PaginatorState<Cursor>
```

<a id="start"></a>

### `start`

```ts
function start<Cursor>(
  state: PaginatorState<Cursor>,
  policy: PaginatorPolicy<Cursor>,
): PaginatorState<Cursor>
```
