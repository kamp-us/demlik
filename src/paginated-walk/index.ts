/**
 * @demlik/tea/paginated-walk — traverse a paginated API / sitemap end to end
 * WITHOUT a fake clock, without 429s, and resumable across a Durable-Object
 * eviction. The L2 composition that bolts `../resilient-call`'s resilience onto
 * `../paginator`'s cursor walk: each page is fetched as ONE keyed resilient
 * call (retry + backoff + rate-limit gate), and the cursor advances only once a
 * page settles `ok`.
 *
 * ## The recipe (the two siblings it composes)
 *
 *   - **`../paginator`** owns the walk loop: the opaque `Cursor`, the `seen` /
 *     `pages` counters, and the `idle → fetching → … → done` phase machine.
 *     `paginated-walk` never re-implements cursor advancement — it folds each
 *     settled page through `recordPage`, letting the paginator decide
 *     `done` / `fetching(next)` / `paused`. Backpressure is a TWO-way valve:
 *     `recordPage` parks the walk in `paused` once `seen >= highWaterMark`, and
 *     the `drain` / `resume` verbs (delegating to the paginator's own
 *     `drain` / `resume`) lower the gauge and re-open the parked fetch — without
 *     them `highWaterMark` would be a one-way valve that strands a paused walk.
 *   - **`../resilient-call`** owns the page fetch: the single `resilient_run`
 *     effect per page is gated through that knob's cache → circuit → rate-limit
 *     → retry pipeline. A transient page failure backs off and re-issues the
 *     SAME cursor (idempotent retry); the walk does not advance until the page
 *     genuinely settles.
 *
 * Those are the only two siblings this module calls into. The resilience knobs
 * (`retry` / `circuit` / `rateLimit` / `deadline`) are NOT separate bricks
 * `paginated-walk` composes — they belong to `resilient-call`, which owns the
 * rate-limit gate internally. This module merely passes them through to
 * `createResilientCall` and re-uses two config TYPES at the boundary:
 * `RateLimitConfig` (re-exported by `resilient-call`) and `RetryPolicy` (from
 * `../retry-backoff`). Pass a `rateLimit` and `resilient-call`'s token bucket
 * throttles page fetches ("don't 429 the upstream"); omit it and the walk runs
 * as fast as the upstream answers.
 *
 * Because the page-fetch resilience IS a `resilient-call` slice, this knob
 * **inherits that knob's contract verbatim**: the slice is a flat record, every
 * verb returns `readonly [State, Cmd[]]`, time is always an `at` parameter, and
 * the jitter RNG is injected once at `createPaginatedWalk(config, rng)` — never
 * read inside a verb (per the spec, `paginated-walk` *extends* `resilient-call`).
 *
 * ## The two non-negotiables (canon)
 *
 *   - **Durable** — the slice is plain data: the paginator phase + counters, and
 *     the resilient-call brick states (all JSON-serializable). The cursor lives
 *     in the Model, not a closure, so a walk survives eviction mid-traversal and
 *     resumes from the exact page it was fetching.
 *   - **Replayable** — every transition is a verb returning new state + Cmds.
 *     `nextCursor` / `onPage` are pure config functions applied at the verb
 *     boundary; the Cmds they yield are plain data. `replay` reconstructs the
 *     whole walk exactly.
 *
 * ## Where the clock / RNG live
 *
 * Inside the verbs: nowhere. `at` arrives on `start` / `pageOk` / `pageErr` /
 * `onTimer` and is threaded straight into the underlying resilient-call gate (so
 * a rate-limited or retried page measures backoff from that `at`). The jitter
 * RNG is injected at construction. The only clock read is `Date.now()` inside
 * the resilient-call `handlers` port (the effect boundary), inherited unchanged.
 *
 * ## The fixed fetch key
 *
 * A walk fetches one page at a time, so the resilient-call layer tracks exactly
 * one logical call under the constant key `PAGE_KEY`. The cursor being fetched
 * is the resilient call's `input`, so a post-eviction resume re-issues the same
 * page request. (`resilient-call` is keyed to support N concurrent calls; a walk
 * deliberately uses a single key — the paginator is the sequencer.)
 *
 * ## Typical wiring
 *
 *   const walk = createPaginatedWalk<PageToken, ApiPage>({
 *     firstPage: null,                          // the API's "page one" sentinel
 *     nextCursor: (page) => page.nextToken ?? null,
 *     onPage: (page) => [{ type: "index_rows", rows: page.items }],
 *     rateLimit: { capacity: 10, refillPerSec: 5 },
 *     retry: defaultRetryPolicy,
 *   });
 *
 *   // in the machine:
 *   init: () => [{ walk: walk.init() }, []],
 *   update: {
 *     start:    (s, m)  => lift(s, walk.start(s.walk, m.at)),
 *     page_ok:  (s, m)  => lift(s, walk.pageOk(s.walk, m.result, m.at)),
 *     page_err: (s, m)  => lift(s, walk.pageErr(s.walk, m.error, m.at)),
 *     retry_due:(s, m)  => lift(s, walk.onTimer(s.walk, m)),
 *     drained:  (s, m)  => lift(s, walk.drain(s.walk, m.n)),
 *     resume:   (s, m)  => lift(s, walk.resume(s.walk, m.at)),
 *   },
 *   subscriptions: (s) => walk.subs(s.walk),
 *   subscribe: { deadline: subscribeDeadline },
 *   interpret: walk.handlers({ run: (cursor) => api.fetchPage(cursor) }),
 */

import type { Cmd } from "../index";
import {
  drain as drainWalk,
  initPaginator,
  isDone,
  type PaginatorPolicy,
  type PaginatorState,
  recordPage,
  resume as resumeWalk,
  start as startWalk,
} from "../paginator";
import { MsgType } from "../protocol";
import {
  type CircuitConfig,
  createResilientCall,
  type DeadlineConfig,
  type DeadlineSub,
  deadlineSub,
  type FailMsg,
  type RateLimitConfig,
  type ResilientPorts,
  type ResilientState,
  type ResilientTimerMsg,
  type RunCmd,
  type SucceedMsg,
  subscribeDeadline,
} from "../resilient-call";
import type { RetryPolicy } from "../retry-backoff";

// ===========================================================================
// Config — the knob. `firstPage` / `nextCursor` / `onPage` describe the walk;
// the resilience bricks are inherited from resilient-call (every one optional —
// omit a brick, omit its gate).
// ===========================================================================

/**
 * The paginated-walk knob. Generic in `Cursor` (the opaque page handle the
 * upstream API hands back — offset, page token, "next" URL, …) and `Page` (the
 * shape your fetch port resolves with).
 *
 * `nextCursor` and `onPage` are PURE config functions applied at the verb
 * boundary, never stored in the slice or in a Cmd (invariant 3 — Cmds are
 * plain data, not closures). `nextCursor(page)` extracts the API's next-page
 * handle (or `null` at the end); `onPage(page)` yields the Cmds the consumer
 * wants emitted for each successfully fetched page (index rows, write to R2,
 * dispatch a downstream Msg — whatever; an empty array is fine).
 *
 * The resilience bricks (`retry` / `circuit` / `rateLimit` / `deadline`) are
 * the SAME optional knobs `resilient-call` exposes — paginated-walk extends it.
 * `rateLimit` is the brick that keeps the walk from 429-ing the upstream.
 */
export interface PaginatedWalkConfig<Cursor, Page, EmittedCmd extends Cmd> {
  /**
   * The cursor the walk fetches first. For an offset API this is typically `0`;
   * for a token API, whatever sentinel the API treats as "page one" (often
   * `null` or `""`). Threaded into `paginator`'s `firstCursor`.
   */
  readonly firstPage: Cursor;
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
  /**
   * Backpressure threshold handed to the paginator. `seen >= highWaterMark`
   * parks the walk in `paused` instead of fetching the next page. Non-positive
   * (the default `0`) disables backpressure — the walk runs flat out until the
   * API exhausts. See `../paginator`'s `highWaterMark` docs.
   */
  readonly highWaterMark?: number;

  // --- resilience bricks, inherited from resilient-call (all optional) ---
  /** Exponential-backoff retry policy for a transient page-fetch failure. */
  readonly retry?: RetryPolicy;
  /** Circuit breaker around the page fetch (one upstream → one breaker). */
  readonly circuit?: CircuitConfig;
  /** Token-bucket rate limit — the "don't 429 the upstream" knob. */
  readonly rateLimit?: RateLimitConfig;
  /** Overall wall-clock deadline per individual page fetch. */
  readonly deadline?: DeadlineConfig;
}

// ===========================================================================
// Slice — the Model field this knob owns. The paginator walk state + the
// resilient-call slice for the page fetch. Both are flat plain data.
// ===========================================================================

/**
 * The slice. `walk` is the cursor/phase/counters from `../paginator`;
 * `resilience` is the `../resilient-call` slice that gates the page fetch.
 * Every field is JSON-serializable, so the whole walk survives a reload.
 *
 * The two move in lockstep: `walk` decides WHICH cursor to fetch next, while
 * `resilience` decides HOW that fetch is attempted (gated, retried, backed
 * off). `pageOk` advances `walk`; `pageErr` defers to `resilience` and leaves
 * `walk` parked on the same cursor until the page truly settles.
 */
export interface PaginatedWalkState<Cursor, Page> {
  readonly walk: PaginatorState<Cursor>;
  readonly resilience: ResilientState<Cursor, Page>;
}

// ===========================================================================
// Cmds + Msgs the knob speaks.
// ===========================================================================

/**
 * The page-fetch effect this knob emits: the inherited `resilient_run` Cmd from
 * resilient-call, whose `input` is the `Cursor` to fetch and whose `key` is the
 * fixed `PAGE_KEY`. The consumer's `handlers(ports)` interprets it.
 */
export type FetchPageCmd<Cursor> = RunCmd<Cursor>;

/** Page-settled Msgs the `handlers` port dispatches back (inherited verbatim). */
export type PageOkMsg<Page> = SucceedMsg<Page>;
export type PageErrMsg = FailMsg;

/** The retry / deadline timer Msg — inherited from resilient-call. */
export type PaginatedWalkTimerMsg = ResilientTimerMsg;

/**
 * Ports the consumer supplies to `handlers`. `run(cursor)` fetches ONE page for
 * the given cursor; throwing routes to `pageErr` (and thus the resilience
 * backoff). Same shape as resilient-call's port, specialized to the page fetch.
 */
export interface PaginatedWalkPorts<Cursor, Page>
  extends ResilientPorts<Cursor, Page> {}

// ===========================================================================
// The fixed key. A walk fetches one page at a time → exactly one logical
// resilient call. The paginator is the sequencer; resilient-call's keying is
// pinned to this single key.
// ===========================================================================

/** The single resilient-call key every page fetch runs under. */
export const PAGE_KEY = "page";

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build a paginated-walk knob from `config`. `rng` is injected for the
 * underlying retry jitter — pass a fixed `() => 0` in tests to pin backoff;
 * defaults to `Math.random` (read at the verb boundary inside resilient-call,
 * never in a `paginated-walk` verb). Inherited straight from resilient-call.
 *
 * Returns the uniform L2 knob contract: `init()`, the verbs `start` / `pageOk`
 * / `pageErr` / `onTimer`, `subs(state)`, and `handlers(ports)`. `Cursor` is
 * the page handle, `Page` the fetch result, `EmittedCmd` the consumer's
 * per-page Cmds plus the inherited `FetchPageCmd`.
 */
export function createPaginatedWalk<Cursor, Page, EmittedCmd extends Cmd = Cmd>(
  config: PaginatedWalkConfig<Cursor, Page, EmittedCmd>,
  rng: () => number = Math.random,
) {
  // The page fetch is a resilient call keyed by Cursor input → Page result.
  // We feed it only the resilience bricks; the walk-loop knobs are ours.
  const rc = createResilientCall<Cursor, Page>(
    {
      retry: config.retry,
      circuit: config.circuit,
      rateLimit: config.rateLimit,
      deadline: config.deadline,
    },
    rng,
  );

  // The paginator policy: our firstPage is the paginator's firstCursor; the
  // high-water mark gates backpressure (0 / omitted → unbounded).
  const paginatorPolicy: PaginatorPolicy<Cursor> = {
    firstCursor: config.firstPage,
    highWaterMark: config.highWaterMark ?? 0,
  };

  // The combined Cmd type the verbs can emit: the inherited page-fetch effect
  // plus whatever `onPage` yields.
  type OutCmd = FetchPageCmd<Cursor> | EmittedCmd;

  /** Replace the resilience slice, leaving `walk` untouched. */
  function withResilience(
    s: PaginatedWalkState<Cursor, Page>,
    resilience: ResilientState<Cursor, Page>,
  ): PaginatedWalkState<Cursor, Page> {
    return { ...s, resilience };
  }

  /** The starting slice: an idle paginator + a fresh resilient-call slice. */
  function init(): PaginatedWalkState<Cursor, Page> {
    return {
      walk: initPaginator<Cursor>(),
      resilience: rc.init(),
    };
  }

  /**
   * Issue a resilient page fetch for `cursor` at `at`. The cursor is the
   * resilient call's `input` (so a retry / resume re-fetches the same page) and
   * `PAGE_KEY` is the fixed key. Returns the advanced resilience slice + the
   * `resilient_run` Cmd (or none, if the gate cached / fast-failed / backed off).
   * PURE — `at` is the only clock. Shared by `start` and `pageOk`'s advance.
   */
  function fetch(
    s: PaginatedWalkState<Cursor, Page>,
    cursor: Cursor,
    at: number,
  ): readonly [
    PaginatedWalkState<Cursor, Page>,
    readonly FetchPageCmd<Cursor>[],
  ] {
    const [resilience, cmds] = rc.attempt(s.resilience, PAGE_KEY, cursor, at);
    return [withResilience(s, resilience), cmds];
  }

  /**
   * Issue the page fetch for a freshly-armed paginator transition, else a pure
   * no-op. `walk` is the result of a paginator verb (`startWalk` / `resumeWalk`)
   * applied to `s.walk`; this states the arm-and-fetch contract ONCE for the two
   * verbs that share it (`start`, `resume`).
   *
   * A paginator verb is a pure no-op on any phase it does not act on — it returns
   * the SAME state object. Reference identity (not phase) is the honest "did the
   * verb arm a fresh fetch?" check: a walk already `fetching` would also satisfy
   * `phase === "fetching"` yet must NOT re-issue a fetch (page-one skip /
   * double-fetch). So we proceed ONLY when the verb produced a fresh state. The
   * `phase === "fetching"` narrow that follows is therefore always true here
   * (both verbs only ever produce a `fetching` arm), and also narrows `.cursor`
   * for the type checker. PURE — `at` threads into the fetch gate.
   */
  function armAndFetch(
    s: PaginatedWalkState<Cursor, Page>,
    walk: PaginatorState<Cursor>,
    at: number,
  ): readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]] {
    if (walk === s.walk || walk.phase !== "fetching") {
      return [s, []];
    }
    return fetch({ ...s, walk }, walk.cursor, at);
  }

  // === Verb: start =========================================================

  /**
   * Begin the walk: arm the paginator's first cursor and issue the first page
   * fetch (gated through resilience). On any non-`idle` paginator phase this is
   * a no-op — re-starting a walk in flight would skip back to page one and
   * double-count, so a stray `start` after launch is absorbed (the paginator's
   * own `start` guard). PURE — `at` threads into the fetch gate.
   */
  function start(
    s: PaginatedWalkState<Cursor, Page>,
    at: number,
  ): readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]] {
    // `startWalk` is a pure no-op on any non-`idle` phase (same reference); a
    // fresh `fetching(firstCursor)` arm → issue the first page fetch.
    return armAndFetch(s, startWalk(s.walk, paginatorPolicy), at);
  }

  // === Verb: pageOk ========================================================

  /**
   * Record a successfully fetched `page` and decide what comes next. PURE —
   * `at` is the cache / next-fetch clock.
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
  function pageOk(
    s: PaginatedWalkState<Cursor, Page>,
    page: Page,
    at: number,
  ): readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]] {
    // 1) Settle the underlying resilient call as a success.
    const [resilience] = rc.succeed(s.resilience, PAGE_KEY, {
      type: MsgType.ResilientOk,
      key: PAGE_KEY,
      result: page,
      at,
    });

    // 2) Advance the paginator with the page's contribution + the next cursor.
    const count = config.pageSize ? config.pageSize(page) : 1;
    const next = config.nextCursor(page);
    const walk = recordPage(s.walk, count, next, paginatorPolicy);

    const advanced: PaginatedWalkState<Cursor, Page> = { walk, resilience };

    // 3) The consumer's per-page work, always emitted on a successful page.
    const pageCmds: readonly EmittedCmd[] = config.onPage(page);

    // If the paginator stayed `fetching`, issue the next page fetch (gated).
    if (walk.phase === "fetching") {
      const [withFetch, fetchCmds] = fetch(advanced, walk.cursor, at);
      return [withFetch, [...pageCmds, ...fetchCmds]];
    }

    // `done` (exhausted) or `paused` (backpressure) → no further fetch now.
    return [advanced, pageCmds];
  }

  // === Verb: pageErr =======================================================

  /**
   * Record a failed page fetch and back off via resilience. PURE — `at` stamps
   * the breaker trip + the retry-delay base.
   *
   * Defers to the resilient-call `fail` verb: it trips the breaker and either
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
   * Without this guard it would still call `rc.fail`, which trips the SHARED
   * circuit breaker (dinging a healthy upstream) and overwrites the settled
   * `PAGE_KEY` resilient slot with `failed` (clobbering the succeeded result a
   * resume would otherwise observe). So a stray `pageErr` is absorbed as a pure
   * no-op — identity preserved — matching `pageOk`'s "the walk is a coordination
   * aid, not a correctness gate" stance.
   */
  function pageErr(
    s: PaginatedWalkState<Cursor, Page>,
    error: unknown,
    at: number,
  ): readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]] {
    // Only a `fetching` paginator has an outstanding page fetch to fail. On any
    // other phase the fail would corrupt shared resilience state for a fetch
    // that is not in flight — absorb it as a pure no-op.
    if (s.walk.phase !== "fetching") {
      return [s, []];
    }
    const [resilience, cmds] = rc.fail(s.resilience, PAGE_KEY, {
      type: MsgType.ResilientErr,
      key: PAGE_KEY,
      error,
      at,
    });
    return [withResilience(s, resilience), cmds];
  }

  // === Verb: onTimer =======================================================

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
  function onTimer(
    s: PaginatedWalkState<Cursor, Page>,
    msg: PaginatedWalkTimerMsg,
  ): readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]] {
    if (s.walk.phase !== "fetching") {
      return [s, []];
    }
    const [resilience, cmds] = rc.onTimer(s.resilience, msg);
    if (resilience === s.resilience) {
      // Inherited no-op identity → keep our slice identity too (pure no-op).
      return [s, []];
    }
    return [withResilience(s, resilience), cmds];
  }

  // === Verb: drain =========================================================

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
  function drain(
    s: PaginatedWalkState<Cursor, Page>,
    n: number,
  ): readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]] {
    const walk = drainWalk(s.walk, n);
    if (walk === s.walk) {
      // Pure no-op identity (n <= 0, or seen already at floor).
      return [s, []];
    }
    return [{ ...s, walk }, []];
  }

  // === Verb: resume ========================================================

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
  function resume(
    s: PaginatedWalkState<Cursor, Page>,
    at: number,
  ): readonly [PaginatedWalkState<Cursor, Page>, readonly OutCmd[]] {
    // `resumeWalk` is a pure no-op (same reference) on any phase but `paused`, or
    // when `seen` is still at/over the mark. Only a fresh `fetching` arm means
    // the valve actually re-opened — issue the page fetch only then.
    return armAndFetch(s, resumeWalk(s.walk, paginatorPolicy), at);
  }

  // === Derived predicates ==================================================

  /**
   * Whether the walk has finished — the API returned a null next cursor and the
   * paginator is `done`. PURE, read-only. Lets a consumer's reducer fire a
   * "walk complete" Cmd (`if (walk.isDone(s.walk)) …`) without re-checking the
   * paginator phase by hand.
   */
  function isComplete(s: PaginatedWalkState<Cursor, Page>): boolean {
    return isDone(s.walk);
  }

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
  function failure(s: PaginatedWalkState<Cursor, Page>): unknown {
    const call = s.resilience.calls[PAGE_KEY];
    return call?.phase === "failed" ? call.error : undefined;
  }

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
  function isStuck(s: PaginatedWalkState<Cursor, Page>): boolean {
    return s.resilience.calls[PAGE_KEY]?.phase === "failed" && !isDone(s.walk);
  }

  // === Subs ================================================================

  /**
   * Pre-wired subscriptions: exactly the resilient-call subs for the page
   * fetch — a retry timer while the fetch is `waiting_retry`, and (with the
   * `deadline` brick) a per-fetch deadline timer while it is active. Reconciled
   * by id, so a phase change cancels the matching timer automatically. Wire
   * `subscribe: { deadline: subscribeDeadline }` (re-exported below).
   */
  function subs(s: PaginatedWalkState<Cursor, Page>): readonly DeadlineSub[] {
    return rc.subs(s.resilience);
  }

  // === Handlers ============================================================

  /**
   * Pre-wired interpret handler for the page-fetch effect. Inherited from
   * resilient-call (`resilient_run`): wraps the consumer's `run(cursor)` port
   * via `tryInterpret` (Railway) — success → `resilient_ok` (handled by
   * `pageOk`), failure → `resilient_err` (handled by `pageErr`), each stamped
   * with `Date.now()` at the effect boundary (the ONE permitted clock read).
   *
   *   interpret: walk.handlers({ run: (cursor) => api.fetchPage(cursor) })
   *
   * The consumer maps the inherited Msg types to their `pageOk` / `pageErr`
   * reducer cells (the wire shape is `resilient_ok` / `resilient_err`).
   */
  function handlers(ports: PaginatedWalkPorts<Cursor, Page>) {
    return rc.handlers(ports);
  }

  return {
    init,
    start,
    pageOk,
    pageErr,
    onTimer,
    drain,
    resume,
    isComplete,
    failure,
    isStuck,
    subs,
    handlers,
  };
}

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice
 * lives at `state.walk`. A convenience for the common single-slice host;
 * consumers with a differently-named field spread by hand. Pure — a thin record
 * rebuild, no clock / RNG.
 */
export function liftWalk<
  S extends { walk: PaginatedWalkState<Cursor, Page> },
  Cursor,
  Page,
  C extends Cmd,
>(
  state: S,
  [slice, cmds]: readonly [PaginatedWalkState<Cursor, Page>, readonly C[]],
): readonly [S, readonly C[]] {
  return [{ ...state, walk: slice }, cmds];
}

/**
 * Re-export the deadline Sub primitives (inherited from resilient-call) so
 * consumers wire one import: `subscribeDeadline` is the `subscribe` cell,
 * `deadlineSub` builds the Sub literal this knob's `subs` emits.
 */
export { subscribeDeadline, deadlineSub };
export type { DeadlineSub };
