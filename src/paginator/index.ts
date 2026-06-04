/**
 * @demlik/tea/paginator — the cursor/offset/page-token walk loop as pure
 * state + ops.
 *
 * Same shape as `@demlik/tea/retry-backoff`, `@demlik/tea/circuit-breaker`,
 * and `@demlik/tea/rate-limit`: a state type plus pure transition functions,
 * host-agnostic by construction. Nothing here reads the clock, the RNG, or any
 * I/O on its own behalf — the consumer fetches a page out-of-band and folds the
 * *result* back in through `recordPage`. That keeps every function inside TEA's
 * invariant 2 (transitions are pure: same inputs → same outputs) so a consumer
 * can thread the walk through `update` and exercise it with `replay` / the pbt
 * fold without a fake network.
 *
 * Every op returns a NEW state value and never mutates its input (invariant 1 —
 * state is a value, not a place). All fields are `readonly` and plain data, so
 * the whole walk is trivially JSON-serializable into a consumer's `Store<S>`
 * and survives a Durable-Object eviction / reload mid-walk: the cursor lives in
 * the Model, not a closure (the durability + replay non-negotiables every TEA
 * knob preserves).
 *
 * ## The cursor is opaque, and the consumer advances it
 *
 * A paginated API hands back a *next cursor* however it likes: an offset
 * (`?offset=40`), a page token (`?pageToken=ey…`), a "next" URL, or `null` at
 * the end. This module is generic in `Cursor` and never inspects it — it only
 * carries it forward. The consumer (who alone knows the API's shape) reads the
 * next cursor off the just-fetched page and passes it to `recordPage`:
 *
 *   const next = page.nextPageToken ?? null;   // consumer-specific extraction
 *   const walk = recordPage(state.walk, page.items.length, next);
 *
 * Passing `next: null` (or a missing `undefined` cursor — the op compares with
 * loose `== null`) means "the API said there is no next page" → the walk
 * finishes (`done`). Passing a `Cursor` means "fetch this one next" → the walk
 * either keeps `fetching` or `pauses` for backpressure (below). Decoupling the
 * extraction from the op is the same discipline `circuit-breaker` uses for the
 * clock: the impure / domain-specific bit (`nextCursor(page)`) lives at the
 * call site; the op stays a pure fold over the extracted value.
 *
 * ## The phase machine
 *
 * Four phases, each a discriminated-union arm carrying ONLY the data that phase
 * needs so impossible states are unrepresentable (pattern 11):
 *
 *   - **idle** — created, not started. No cursor is armed yet; `start` arms the
 *     first one. Carries the running `seen` / `pages` counters (both 0 here, but
 *     present on every phase so a consumer reads them uniformly).
 *
 *   - **fetching** — a page request for `cursor` is outstanding. The walk sits
 *     here while the consumer's fetch is in flight; `recordPage` resolves it.
 *     Carries the `cursor` being fetched so a post-eviction resume re-issues the
 *     SAME request (idempotent retry) rather than skipping a page.
 *
 *   - **paused** — backpressure tripped. The API still has more pages (a non-null
 *     next cursor), but `seen` has reached `highWaterMark` and the consumer has
 *     not drained yet. Carries the `cursor` to resume from. No fetch is
 *     outstanding — the loop is deliberately idle until `resume`. This is the
 *     valve that stops a fast producer (the API) from outrunning a slow consumer
 *     (whatever processes each page) and blowing memory.
 *
 *   - **done** — the API returned a null next cursor; the walk is exhausted. A
 *     terminal phase: `start` / `recordPage` / `resume` are all no-ops on it
 *     (idempotent completion — a late duplicate result can't un-finish a walk).
 *
 * ### Transition table
 *
 * Rows are the current phase; columns are the op. `→` denotes the next phase;
 * `self` means unchanged (a no-op for that (phase × op) pair). `next` is the
 * cursor the consumer extracted from the page; `hwm` is `highWaterMark`.
 *
 * | from \ op   | start          | recordPage(count, next)                                              | resume                         |
 * | ----------- | -------------- | -------------------------------------------------------------------- | ------------------------------ |
 * | idle        | → fetching(c0) | self *(¹)*                                                            | self                           |
 * | fetching    | self           | seen=max(0,seen+count), pages+=1; next==null → done; seen≥hwm → paused(next); else → fetching(next) | self                           |
 * | paused      | self           | self *(¹)*                                                            | seen<hwm → fetching(cursor) *(²)* |
 * | done        | self           | self                                                                  | self                           |
 *
 * *(¹)* `recordPage` only makes sense while `fetching` (a page was outstanding).
 * On any other phase it is a no-op: a result that arrives when no fetch was in
 * flight (a late duplicate, a double-dispatch) must not advance the cursor or
 * double-count `seen`. The walk is a coordination aid, not a correctness gate —
 * it absorbs the stray rather than corrupting the count.
 *
 * *(²)* `resume` re-arms the paused cursor ONLY once `seen` has dropped below
 * `highWaterMark` (the consumer drained, lowering `seen` via `drain`). Calling
 * `resume` while still over the mark is a no-op — the valve stays shut until
 * there is real headroom, so a consumer that resumes optimistically can't
 * defeat the backpressure. Resuming a walk that isn't `paused` is likewise a
 * no-op.
 *
 * ## Backpressure
 *
 * `seen` is the count of items the API has produced that the consumer has not
 * yet acknowledged as processed. `recordPage` adds each page's item count to it;
 * `drain(n)` subtracts what the consumer finished. When `seen` reaches
 * `highWaterMark`, `recordPage` parks the walk in `paused` instead of issuing
 * the next fetch — the producer stops until `drain` + `resume` re-open the
 * valve. A `highWaterMark` of `0` (or any non-positive value) disables
 * backpressure: the comparison `seen >= hwm` is satisfied vacuously only when
 * `hwm <= 0` would pause immediately, so we treat `hwm <= 0` as "unbounded" and
 * never pause. The walk then runs flat-out, `fetching → fetching` until `done`.
 *
 * NOT exported from the package root — reached via the `@demlik/tea/paginator`
 * subpath, same one-shape-per-package rule as `work-queue`, `retry-backoff`,
 * `circuit-breaker`, and `rate-limit`. It is the L1 escape hatch the
 * `paginated-walk` composition builds its walk loop on.
 */

/**
 * Paginator policy — pure configuration, no mutable state. One policy is shared
 * across the whole walk (often a module-scope const). `PaginatorState` carries
 * the cursor + counters; this carries the knobs they're compared against.
 *
 * Generic in `Cursor` so `firstCursor` matches whatever the API's cursor shape
 * is — an offset `number`, a page-token `string`, a `{ after: string }` record,
 * etc. The module never inspects the cursor; the type just threads through.
 */
export interface PaginatorPolicy<Cursor> {
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

/**
 * Sensible defaults: start from a numeric offset of `0`, pause after 1000
 * un-drained items. Tuned for an offset-paginated REST API whose consumer
 * processes pages asynchronously; override per call site (especially
 * `firstCursor`, which is API-specific) rather than mutating this shared const.
 *
 * Typed as `PaginatorPolicy<number>` because the only honest default cursor is
 * the numeric offset `0`; a token-based API supplies its own `firstCursor` and
 * its own `PaginatorPolicy<string>`.
 */
export const defaultPaginatorPolicy: PaginatorPolicy<number> = {
  firstCursor: 0,
  highWaterMark: 1000,
};

/**
 * The walk's phase. A discriminated union on `phase` so each phase carries ONLY
 * its own data and impossible combinations are unrepresentable (pattern 11):
 * there is no `done` state that still holds a pending cursor, no `idle` state
 * mid-fetch. Every field is `readonly` so the whole value is trivially
 * JSON-serializable into a consumer's `Store<S>` and safe to thread through a
 * pure reducer / a Durable-Object reload.
 *
 * Two counters ride on every phase so a consumer reads them uniformly without
 * narrowing first:
 *   - `seen`  — items produced by the API but not yet drained (backpressure gauge).
 *   - `pages` — total pages recorded so far (progress / observability).
 *
 *   - `idle`     — not started; `start` arms `firstCursor`.
 *   - `fetching` — a page request for `cursor` is outstanding.
 *   - `paused`   — backpressure tripped; `cursor` is the page to resume from.
 *   - `done`     — API exhausted (null next cursor); terminal.
 */
export type PaginatorState<Cursor> =
  | { readonly phase: "idle"; readonly seen: number; readonly pages: number }
  | {
      readonly phase: "fetching";
      readonly cursor: Cursor;
      readonly seen: number;
      readonly pages: number;
    }
  | {
      readonly phase: "paused";
      readonly cursor: Cursor;
      readonly seen: number;
      readonly pages: number;
    }
  | { readonly phase: "done"; readonly seen: number; readonly pages: number };

/** The starting state: idle, nothing seen, no pages recorded. */
export function initPaginator<Cursor>(): PaginatorState<Cursor> {
  return { phase: "idle", seen: 0, pages: 0 };
}

/**
 * Arm the first fetch. PURE — returns a new state; the input is never mutated.
 *
 *   - `idle` → `fetching(firstCursor)`. This is the only phase `start` acts on.
 *   - any other phase → unchanged. Re-arming a walk that has already begun (or
 *     finished) would skip back to page one and double-count; a stray `start`
 *     after launch is absorbed, not honored. Use `initPaginator()` to begin a
 *     genuinely fresh walk.
 */
export function start<Cursor>(
  state: PaginatorState<Cursor>,
  policy: PaginatorPolicy<Cursor>,
): PaginatorState<Cursor> {
  if (state.phase !== "idle") return state;
  return {
    phase: "fetching",
    cursor: policy.firstCursor,
    seen: state.seen,
    pages: state.pages,
  };
}

/**
 * Record the result of the outstanding fetch and decide what comes next. PURE —
 * returns a new state; the input is never mutated.
 *
 * `count` is how many items the just-fetched page yielded (added to `seen` for
 * backpressure accounting). `next` is the cursor the consumer extracted from the
 * page — a `Cursor` to fetch next, or `null`/`undefined` (a missing optional
 * cursor field) if the API signalled the end.
 *
 *   - `fetching` → `seen = max(0, seen + count)`, `pages += 1`, then branch on
 *     `next`:
 *       - `next == null`            → `done` (API exhausted; loose-null so a
 *                                      missing/`undefined` cursor also finishes).
 *       - `seen >= highWaterMark`   → `paused(next)` (backpressure; `hwm <= 0`
 *                                      disables this branch — see policy docs).
 *       - otherwise                 → `fetching(next)` (keep walking).
 *   - any other phase → unchanged. A result with no fetch outstanding (a late
 *     duplicate, a double-dispatch) must not advance the cursor or double-count;
 *     it is absorbed. See the module header's note ¹.
 *
 * `count` is floored into the gauge: a non-finite `count` (`NaN`/`Infinity`) is
 * treated as `0`, and the additive sum is clamped at `0`. A record can only hold
 * or raise `seen`; only `drain` lowers it. This keeps a stray negative or
 * non-finite count from poisoning the `seen >= highWaterMark` comparison and
 * silently defeating backpressure.
 *
 * The new `seen` total — not the pre-page value — is what the backpressure check
 * reads, so a single page large enough to cross the mark pauses immediately
 * rather than fetching one more first.
 */
export function recordPage<Cursor>(
  state: PaginatorState<Cursor>,
  count: number,
  next: Cursor | null | undefined,
  policy: PaginatorPolicy<Cursor>,
): PaginatorState<Cursor> {
  if (state.phase !== "fetching") return state;
  // A page's item count must be a finite, non-negative addition to `seen`. A
  // negative count would drive `seen` down (a record can never lower the gauge —
  // only `drain` does) and a non-finite count (`NaN` / `Infinity`) would poison
  // every later `seen >= highWaterMark` comparison, permanently defeating
  // backpressure (NaN compares false, so the valve never trips). Guard the
  // non-finite case to 0 first (mirroring retry-backoff's `Number.isNaN`
  // discipline at backoffDelay ~:119), then floor the sum at 0 so the additive
  // step can only hold or raise the gauge.
  const safeCount = Number.isFinite(count) ? count : 0;
  const seen = Math.max(0, state.seen + safeCount);
  const pages = state.pages + 1;
  // Loose `== null` so a *missing* next cursor (`undefined`, common for an
  // optional API field the consumer extracted as `page.nextPageToken`) finishes
  // the walk exactly like an explicit `null`. Strict `=== null` would route an
  // `undefined` cursor into the fetching/paused branch and carry a cursor-less
  // (malformed) state forward.
  if (next == null) {
    return { phase: "done", seen, pages };
  }
  // `hwm <= 0` disables backpressure entirely (unbounded walk); only a positive
  // mark can park the loop. `seen >= hwm` is the half-open edge — reaching the
  // mark exactly pauses, matching the `>=` window edges `rate-limit` /
  // `circuit-breaker` use.
  if (policy.highWaterMark > 0 && seen >= policy.highWaterMark) {
    return { phase: "paused", cursor: next, seen, pages };
  }
  return { phase: "fetching", cursor: next, seen, pages };
}

/**
 * Acknowledge that the consumer finished processing `n` items, lowering the
 * backpressure gauge. PURE — returns a new state; the input is never mutated.
 *
 * Subtracts `n` from `seen`, floored at 0 (a consumer that over-acks, or acks a
 * page recorded before a reload, can never drive `seen` negative). `n <= 0` is a
 * no-op on the count. `drain` does NOT change the phase — it only frees
 * headroom; `resume` is the separate, explicit decision to re-issue a fetch once
 * the headroom exists. Splitting "I drained" from "I want to continue" lets a
 * consumer drain in several steps and resume once.
 *
 * Works on every phase: a consumer may drain while still `fetching` (the gauge
 * just drops, no pause was reached) or while `paused` (freeing room for a later
 * `resume`). On `done` the gauge can still be drained for accurate final
 * accounting, though it no longer gates anything.
 */
export function drain<Cursor>(
  state: PaginatorState<Cursor>,
  n: number,
): PaginatorState<Cursor> {
  if (n <= 0) return state;
  const seen = Math.max(0, state.seen - n);
  if (seen === state.seen) return state;
  return { ...state, seen };
}

/**
 * Re-open the backpressure valve after a `drain`. PURE — returns a new state;
 * the input is never mutated.
 *
 *   - `paused` AND `seen < highWaterMark` → `fetching(cursor)`: the consumer has
 *     drained below the mark, so re-issue the parked fetch.
 *   - `paused` but `seen >= highWaterMark` → unchanged. There is still no
 *     headroom; the valve stays shut until a `drain` lowers `seen`. A consumer
 *     that resumes optimistically can't defeat the backpressure. (When `hwm <=
 *     0` backpressure is disabled, so the walk never reaches `paused` and this
 *     branch is unreachable — but the guard reads `< hwm` consistently, and a
 *     non-positive `hwm` makes `seen < hwm` false for any non-negative `seen`,
 *     correctly refusing to resume a state that should never have paused.)
 *   - any other phase → unchanged. Resuming a walk that isn't paused (idle,
 *     fetching, done) is a no-op.
 *
 * See the module header's note ².
 */
export function resume<Cursor>(
  state: PaginatorState<Cursor>,
  policy: PaginatorPolicy<Cursor>,
): PaginatorState<Cursor> {
  if (state.phase !== "paused") return state;
  if (state.seen < policy.highWaterMark) {
    return {
      phase: "fetching",
      cursor: state.cursor,
      seen: state.seen,
      pages: state.pages,
    };
  }
  return state;
}

/**
 * Whether the walk has finished (the API returned a null next cursor). PURE,
 * read-only. A derived predicate so a consumer's reducer can branch
 * (`if (isDone(walk)) return [doneState, [joinCmd]]`) without re-checking the
 * `phase` discriminant by hand at every call site.
 */
export function isDone<Cursor>(state: PaginatorState<Cursor>): boolean {
  return state.phase === "done";
}
