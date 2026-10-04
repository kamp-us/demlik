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
  /**
   * The page fetch's deadlines — exactly resilient-call's: a retry timer while
   * the fetch is `waiting_retry`, and (with the `deadline` brick) a per-fetch
   * deadline timer while it is active.
   */
  deadlines: (s: PaginatedWalkState<Cursor, Page>) => readonly DeadlineSub[];
  /**
   * Acknowledge that the consumer finished processing `n` items, lowering the
   * paginator's backpressure gauge (`seen`). PURE — no clock. Delegates to
   * `paginator.drain`: subtracts `n` (floored at 0), leaves the phase untouched.
   *
   * The OTHER half of the backpressure valve `highWaterMark` opens: `recordPage`
   * parks the walk in `paused` once `seen >= highWaterMark`, and `drain` is how a
   * consumer lowers `seen` back below the mark so `resume` can re-open the fetch.
   * Without it `highWaterMark` would be a one-way valve — a walk could pause but
   * never continue. Emits no Cmds: draining only frees headroom; `resume` is the
   * separate, explicit "continue now" decision.
   */
  drain: (
    s: PaginatedWalkState<Cursor, Page>,
    n: number,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  /**
   * The terminal page-fetch failure that stranded the walk, or `undefined` if no
   * page has terminally failed. PURE, read-only. Errors are data: a page that
   * exhausts its retries (or trips the deadline) settles the `PAGE_KEY` resilient
   * slot to `failed` while the paginator stays parked on its cursor — the walk is
   * stuck and will never advance on its own. Without a way to read that phase the
   * failure is unobservable: the walk simply stops emitting fetches with no
   * signal. `failure(s)` surfaces the settled error (the same plain-data sentinel
   * resilient-call records) so a consumer can fire a "walk dead" Cmd, alert, or
   * re-`start` a fresh walk.
   */
  failure: (s: PaginatedWalkState<Cursor, Page>) => unknown;
  /** The page-fetch Cmd def — list it in the machine's `cmds`. */
  fetch: CmdDef<"resilient_run", { readonly input: Cursor; readonly key: string }, Page, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>;
  /** The starting slice: an idle paginator + a fresh resilient-call slice. */
  init: () => PaginatedWalkState<Cursor, Page>;
  /**
   * Whether the walk has finished — the API returned a null next cursor and the
   * paginator is `done`. PURE, read-only. Lets a consumer's reducer fire a
   * "walk complete" Cmd (`if (walk.isDone(s.walk)) …`) without re-checking the
   * paginator phase by hand.
   */
  isComplete: (s: PaginatedWalkState<Cursor, Page>) => boolean;
  /**
   * Whether the walk is STUCK: a page fetch has terminally `failed` yet the
   * paginator is still parked on a cursor (not `done`), so no further fetch will
   * ever be issued without intervention. PURE, read-only.
   *
   * This is the dead-walk predicate the consumer polls (`if (walk.isStuck(s)) …`)
   * to distinguish a healthy finish (`isComplete`) from a silent death. A walk is
   * stuck precisely when the resilient slot settled `failed` AND the paginator
   * has NOT reached `done` — a terminal failure on the final page that also
   * finished the walk is `isComplete`, not stuck. Pairs with `failure(s)`, which
   * hands back the error that stuck it.
   */
  isStuck: (s: PaginatedWalkState<Cursor, Page>) => boolean;
  /**
   * A retry / deadline timer fired. Defers to resilient-call's `onTimer`: a
   * retry timer re-runs the gate for the page-fetch's remembered cursor (re-
   * issuing the SAME page); a deadline timer settles the resilient call failed.
   * The paginator stays parked on its cursor throughout — only `pageOk` advances
   * it. A stale fire is a no-op (inherited). PURE.
   *
   * GUARDED by the paginator phase, for the same reason as `pageErr`. A timer is
   * only meaningful while a page fetch is outstanding (`walk.phase ===
   * "fetching"`). A stray timer that fires after the walk has settled (`done` /
   * `paused` / `idle`) would otherwise re-enter `rc.onTimer` — re-issuing a fetch
   * the paginator no longer wants (a deadline timer could even overwrite the
   * settled `PAGE_KEY` slot with a deadline `failed`). On any non-`fetching`
   * phase the timer is absorbed as a pure no-op.
   */
  onTimer: (
    s: PaginatedWalkState<Cursor, Page>,
    msg: PaginatedWalkTimerMsg,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  /**
   * Record a failed page fetch and back off via resilience. PURE — `at` stamps
   * the breaker trip + the retry-delay base.
   *
   * Defers to the resilient-call `settle` verb: it trips the breaker and either
   * schedules a retry (paginator stays parked on the SAME cursor — no advance)
   * or settles the resilient call `failed` once retries are exhausted. The
   * paginator is deliberately untouched: a failed fetch must NOT advance the
   * cursor or skip a page. When the retry timer later fires, `onTimer` re-issues
   * the same page fetch.
   *
   * GUARDED by the paginator phase, exactly as `pageOk` is guarded by
   * `recordPage`'s `fetching`-only check. A `pageErr` only makes sense while a
   * page fetch is outstanding (`walk.phase === "fetching"`). A stray `pageErr`
   * that arrives after the walk has settled — `done` (exhausted), `paused`
   * (backpressure), or `idle` (not started) — has NO outstanding fetch to fail.
   * Without this guard it would still call `rc.settle`, which trips the SHARED
   * circuit breaker (dinging a healthy upstream) and overwrites the settled
   * `PAGE_KEY` resilient slot with `failed` (clobbering the succeeded result a
   * resume would otherwise observe). So a stray `pageErr` is absorbed as a pure
   * no-op — identity preserved — matching `pageOk`'s "the walk is a coordination
   * aid, not a correctness gate" stance.
   */
  pageErr: (
    s: PaginatedWalkState<Cursor, Page>,
    msg: PageErrMsg,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  /**
   * Record a successfully fetched page (the engine-minted `msg.value`) and
   * decide what comes next. PURE — `msg.at` is the cache / next-fetch clock.
   *
   *   1. Settle the resilient call OK (closes the breaker, fills the cache,
   *      resets the page-fetch retry counter) — inherited from resilient-call.
   *   2. Fold the page through the paginator: add `pageSize(page)` to `seen`,
   *      bump `pages`, and branch on `nextCursor(page)`:
   *        - `null`     → the API is exhausted → paginator goes `done`.
   *        - a cursor   → advance, then either fetch it (backpressure room) or
   *                       park in `paused` (high-water mark reached).
   *   3. Emit the consumer's `onPage(page)` Cmds either way, PLUS the next
   *      page-fetch effect when the paginator stays `fetching`.
   *
   * A `pageOk` that arrives when the paginator is not `fetching` (a late
   * duplicate, a double-dispatch) is absorbed by `recordPage` — the cursor does
   * not advance and `seen` is not double-counted; only the resilient settle +
   * `onPage` Cmds happen. The walk is a coordination aid, not a correctness
   * gate.
   */
  pageOk: (
    s: PaginatedWalkState<Cursor, Page>,
    msg: PageOkMsg<Page>,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  /**
   * Re-open the backpressure valve after a `drain`: if the walk is `paused` and
   * `seen` has dropped below `highWaterMark`, re-arm the parked cursor and issue
   * its page fetch (gated through resilience). PURE — `at` threads into the fetch
   * gate. Delegates the phase decision to `paginator.resume`:
   *
   *   - `paused` AND `seen < highWaterMark` → `fetching(cursor)` → emit the fetch.
   *   - `paused` but still over the mark    → no-op (the valve stays shut until a
   *                                           further `drain` frees real headroom).
   *   - any other phase                     → no-op (nothing to resume).
   *
   * Together with `drain` this completes the valve: `recordPage` shuts it
   * (`paused`), `drain` lowers the gauge, `resume` re-opens it and fires the next
   * page fetch — the same `fetch` helper `start` / `pageOk` use, so a resumed
   * fetch is gated identically (cache / circuit / rate-limit / retry).
   */
  resume: (
    s: PaginatedWalkState<Cursor, Page>,
    at: number,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  /**
   * Begin the walk: arm the paginator's first cursor and issue the first page
   * fetch (gated through resilience). On any non-`idle` paginator phase this is
   * a no-op — re-starting a walk in flight would skip back to page one and
   * double-count, so a stray `start` after launch is absorbed (the paginator's
   * own `start` guard). PURE — `at` threads into the fetch gate.
   */
  start: (
    s: PaginatedWalkState<Cursor, Page>,
    at: number,
  ) => readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]];
  /**
   * The built-in `timer` Sub's deps: resilient-call's `timer` over the fetch's
   * slice. Declare `{ type: "timer", deps: (s) => walk.timer(s.walk) }`.
   */
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
  /** Circuit breaker around the page fetch (one upstream → one breaker). */
  readonly circuit?: CircuitConfig;
  /** Overall wall-clock deadline per individual page fetch. */
  readonly deadline?: DeadlineConfig;
  /**
   * The cursor the walk fetches first. For an offset API this is typically `0`;
   * for a token API, whatever sentinel the API treats as "page one" (often
   * `null` or `""`). Threaded into `paginator`'s `firstCursor`.
   */
  readonly firstPage: Cursor;
  /**
   * Backpressure threshold handed to the paginator. `seen >= highWaterMark`
   * parks the walk in `paused` instead of fetching the next page. Non-positive
   * (the default `0`) disables backpressure — the walk runs flat out until the
   * API exhausts. See `../paginator`'s `highWaterMark` docs.
   */
  readonly highWaterMark?: number;
  /**
   * Extract the next cursor from a just-fetched page. Return a `Cursor` to keep
   * walking, or `null` when the API signalled the end (the walk finishes). PURE
   * + consumer-specific (only the consumer knows the API's pagination shape).
   */
  readonly nextCursor: (page: Page) => Cursor | null;
  /**
   * The Cmds to emit for each successfully fetched page — the consumer's work
   * per page (index, persist, fan out, …). Returns plain-data Cmds; `[]` is a
   * valid "I process the page synchronously elsewhere" answer. PURE.
   */
  readonly onPage: (page: Page) => readonly EmittedCmd[];
  /**
   * How many items a page contributes to the paginator's backpressure gauge
   * (`seen`). Defaults to `1` per page (count pages, not items) when omitted; a
   * consumer that wants per-item backpressure returns `page.items.length`. PURE.
   */
  readonly pageSize?: (page: Page) => number;
  /** Token-bucket rate limit — the "don't 429 the upstream" knob. */
  readonly rateLimit?: RateLimitConfig;
  /** Exponential-backoff retry policy for a transient page-fetch failure. */
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
  /**
   * The cursor the walk fetches first, armed by `start`. For an offset API this
   * is typically `0`; for a token API, `null`-or-empty-meaning-"first page" is
   * the API's call, so pass whatever sentinel the API treats as page one.
   */
  readonly firstCursor: Cursor;
  /**
   * Backpressure threshold: the number of un-drained items at which the walk
   * pauses instead of fetching the next page. `recordPage` parks in `paused`
   * once `seen >= highWaterMark`; `drain` + `resume` re-open the valve.
   *
   * A non-positive value (`<= 0`) disables backpressure — the walk never pauses
   * and runs `fetching → fetching` until the API exhausts. Use that when the
   * consumer processes each page synchronously inside `recordPage` and there is
   * nothing to back up.
   */
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
