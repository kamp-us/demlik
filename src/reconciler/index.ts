/**
 * @demlik/tea/reconciler — the desired-vs-actual sync loop (the "fleet-sync /
 * coverage-gap" shape): walk the ACTUAL world end to end, diff it against the
 * DESIRED spec, then apply each resulting `Change` one at a time until the two
 * agree. The control-plane reconcile pattern (Kubernetes controllers, fleet
 * config rollout, accessibility coverage-gap remediation) lifted to the uniform
 * L2 knob contract.
 *
 * ## The recipe (which bricks it composes)
 *
 *   - **`../paginated-walk`** owns the SCAN. The actual world is rarely a single
 *     fetch — it is a paginated list (every node in a fleet, every page of an
 *     audit, every row of a table). `reconciler` does not re-implement that walk:
 *     it embeds a `paginated-walk` slice and lets it sequence the actual-state
 *     fetch (gated, retried, rate-limited, resumable across eviction). The walk's
 *     own `onPage` hook stays empty (`() => []`) — `reconciler` accumulates each
 *     fetched page's items into the running `actual` snapshot inside its OWN
 *     `pageOk` verb, where it holds its slice and so can extend the accumulator
 *     the walk cannot see; when the walk reports `isComplete`, the full actual
 *     snapshot is in hand.
 *   - **`../cache`** owns the APPLIED ledger. Every `Change` that settles is
 *     written into a TTL cache keyed by the change's id, so a re-`applyNext`
 *     after an eviction skips changes already applied (idempotent re-apply — the
 *     reconcile is safe to resume from any point). The cache is the durable
 *     "what have I already done?" memory the apply loop reads before re-issuing.
 *
 * Because the scan IS a `paginated-walk` slice (which itself IS a
 * `resilient-call` slice), this knob **inherits that contract verbatim**: the
 * slice is flat plain data, every verb returns `readonly [State, Cmd[]]`, time
 * is always an `at` parameter, and the jitter RNG is injected once at
 * `createReconciler(config, rng)` — never read inside a verb (the spec:
 * `reconciler` *extends* `paginated-walk`).
 *
 * ## Why the run lifecycle is INLINE (run-tracker not extracted)
 *
 * The reconcile phase union (`idle` / `scanning` / `applying` / `done` /
 * `failed`) and its bookkeeping (`plan`, `appliedCursor`, the `actual`
 * accumulator) live directly on this slice rather than behind a `run-tracker`
 * sub-knob — exactly as `monitored-run` keeps its lifecycle inline. Extraction
 * earns its keep when two independent axes vary; here the lifecycle has one
 * anchoring axis (this reconcile pass). The genuinely independent axes — the
 * paginated SCAN and the applied LEDGER — ARE extracted (`../paginated-walk`,
 * `../cache`). The lifecycle is the glue that sequences scan → plan → apply.
 *
 * ## The two non-negotiables (canon)
 *
 *   - **Durable** — the slice is plain data: the paginated-walk slice, the
 *     accumulated `actual` items, the planned `Change[]`, the applied cursor, and
 *     the applied-ledger cache (all JSON-serializable). A reconcile survives DO
 *     eviction mid-scan or mid-apply and resumes from the exact position.
 *   - **Replayable** — every transition is a verb returning new state + Cmds.
 *     `diff` / `apply` are pure config functions applied at the verb boundary;
 *     the Cmds they yield are plain data. `replay` reconstructs the whole pass
 *     exactly. Nothing here closes over time or RNG.
 *
 * ## Where the clock / RNG live
 *
 * Inside the verbs: nowhere. `at` arrives on `scan` / `pageOk` / `pageErr` /
 * `applied` / `onTimer` and threads into the underlying paginated-walk gate (so a
 * retried / rate-limited page measures backoff from that `at`) and into the
 * applied-ledger cache writes. The jitter RNG is injected at construction. The
 * only clock read is `Date.now()` inside the inherited paginated-walk `handlers`
 * port (the effect boundary).
 *
 * ## Typical wiring
 *
 *   const rec = createReconciler<FleetNode, NodeSpec, Page, SyncChange, ApplyCmd>({
 *     desired: targetSpecs,                          // the spec to converge on
 *     firstPage: null,                               // actual-list page-one sentinel
 *     nextCursor: (page) => page.next ?? null,
 *     itemsOf: (page) => page.nodes,                 // page → actual items
 *     diff: (desired, actual) => planChanges(desired, actual),
 *     apply: (change) => ({ type: "apply_change", change }),
 *     idOf: (change) => change.nodeId,               // applied-ledger key
 *     rateLimit: { capacity: 10, refillPerSec: 5 },
 *     retry: defaultRetryPolicy,
 *   });
 *
 *   // in the machine:
 *   init: () => [{ rec: rec.init() }, []],
 *   update: {
 *     reconcile:   (s, m) => lift(s, rec.scan(s.rec, m.at)),
 *     page_ok:     (s, m) => lift(s, rec.pageOk(s.rec, m.result, m.at)),
 *     page_err:    (s, m) => lift(s, rec.pageErr(s.rec, m.error, m.at)),
 *     change_done: (s, m) => lift(s, rec.applied(s.rec, m.change, m.at)),
 *     retry_due:   (s, m) => lift(s, rec.onTimer(s.rec, m)),
 *   },
 *   subscriptions: (s) => rec.subs(s.rec),
 *   subscribe: { deadline: subscribeDeadline },
 *   interpret: rec.handlers({ run: (cursor) => api.listActual(cursor) }),
 */

import {
  get as cacheGet,
  set as cacheSet,
  initCache,
  type TtlCache,
} from "../cache";
import type { Cmd } from "../index";
import {
  createPaginatedWalk,
  type DeadlineSub,
  deadlineSub,
  type FetchPageCmd,
  PAGE_KEY,
  type PageErrMsg,
  type PageOkMsg,
  type PaginatedWalkState,
  type PaginatedWalkTimerMsg,
  subscribeDeadline,
} from "../paginated-walk";
import type {
  CircuitConfig,
  DeadlineConfig,
  RateLimitConfig,
  ResilientPorts,
} from "../resilient-call";
import type { RetryPolicy } from "../retry-backoff";

// ===========================================================================
// Config — the knob. `desired` / `diff` / `apply` / `idOf` describe the
// reconcile; the SCAN knobs (firstPage / nextCursor / itemsOf) describe how the
// actual world is walked; the resilience bricks are inherited from
// paginated-walk (every one optional — omit a brick, omit its gate).
// ===========================================================================

/**
 * The reconciler knob. Generic in:
 *   - `Actual`  — one item of the ACTUAL world (a fleet node, an audited page, a
 *                 table row). The scan accumulates these.
 *   - `Desired` — the DESIRED spec value the diff converges toward. Opaque to
 *                 this module; only `diff` reads it.
 *   - `Page`    — the shape one actual-list page fetch resolves with.
 *   - `Change`  — one unit of remediation the diff produces and `apply` realizes.
 *   - `ApplyCmd`— the Cmd `apply(change)` yields (the effect that mutates the
 *                 actual world toward desired).
 *
 * `diff` / `apply` / `idOf` / `nextCursor` / `itemsOf` are PURE config functions
 * applied at the verb boundary, never stored in the slice or in a Cmd (Cmds are
 * plain data, not closures). The resilience bricks (`retry` / `circuit` /
 * `rateLimit` / `deadline`) are the SAME optional knobs `paginated-walk` /
 * `resilient-call` expose — reconciler extends them; `rateLimit` keeps the scan
 * from 429-ing the upstream listing API.
 */
export interface ReconcilerConfig<
  Actual,
  Desired,
  Page,
  Change,
  ApplyCmd extends Cmd,
  Cursor = number,
> {
  /**
   * The DESIRED spec to converge on. Held verbatim and handed to `diff` once the
   * scan completes. Any JSON-serializable value — a list of specs, a target map,
   * a single target object — `diff` alone interprets it.
   */
  readonly desired: Desired;
  /**
   * Compute the remediation plan: the ordered `Change[]` that moves `actual` to
   * `desired`. Called once when the scan finishes (the full actual snapshot is in
   * hand). An empty plan means "already in sync — nothing to apply". PURE +
   * consumer-specific (only the consumer knows the domain's reconcile rules).
   */
  readonly diff: (
    desired: Desired,
    actual: readonly Actual[],
  ) => readonly Change[];
  /**
   * Realize one `Change` as the Cmd that mutates the actual world. Returns plain
   * data (a `{ type, ... }` Cmd the consumer's interpret handler performs).
   * PURE — the side effect happens when the runtime performs the emitted Cmd,
   * never here.
   */
  readonly apply: (change: Change) => ApplyCmd;
  /**
   * Stable identity for a `Change` — the applied-ledger cache key. A re-`applyNext`
   * after eviction (or after a re-plan) skips a change whose id is already in the
   * ledger (idempotent re-apply). MUST be a property of the change itself, NOT its
   * position in the plan: the ledger has to survive re-planning. When omitted the
   * default keys by the change's serialized CONTENT (`JSON.stringify(change)`) —
   * a stable per-change identity that is unchanged by where the change sits in the
   * plan. Supply a domain id (the target node id, the resource key) when one
   * exists; it is cheaper than serializing and dedupes two changes that differ
   * only in fields irrelevant to identity. PURE.
   *
   * Why NOT positional: keying by index silently drops changes on the documented
   * re-plan path. After applying the index-0 change, its `"0"` ledger entry would
   * match WHATEVER different, never-applied change lands at index 0 in the next
   * plan — the apply loop skips it as "already done". Identity must be intrinsic
   * to the change so the ledger means "this change settled", not "slot N settled".
   */
  readonly idOf?: (change: Change) => string;

  // --- scan knobs (the actual-world walk), inherited from paginated-walk ---
  /**
   * The cursor the actual-list scan fetches first. For an offset API typically
   * `0`; for a token API whatever sentinel the API treats as page one.
   */
  readonly firstPage: Cursor;
  /**
   * Extract the next scan cursor from a fetched page — a `Cursor` to keep
   * scanning, or `null` when the actual listing is exhausted (scan finishes,
   * plan computed). PURE + consumer-specific.
   */
  readonly nextCursor: (page: Page) => Cursor | null;
  /**
   * Extract the actual items from one fetched page. Each page's items are
   * appended to the running `actual` accumulator. PURE.
   */
  readonly itemsOf: (page: Page) => readonly Actual[];

  // --- resilience bricks, inherited from paginated-walk (all optional) ---
  /** Exponential-backoff retry policy for a transient scan-page failure. */
  readonly retry?: RetryPolicy;
  /** Circuit breaker around the scan fetch (one upstream → one breaker). */
  readonly circuit?: CircuitConfig;
  /** Token-bucket rate limit on the scan — the "don't 429 the listing API" knob. */
  readonly rateLimit?: RateLimitConfig;
  /** Overall wall-clock deadline per individual scan-page fetch. */
  readonly deadline?: DeadlineConfig;
}

// ===========================================================================
// Slice — the Model field this knob owns. The paginated-walk scan slice + the
// accumulated actual snapshot + the inline reconcile lifecycle (plan, applied
// cursor, ledger). All flat plain data.
// ===========================================================================

/**
 * Reconcile lifecycle phase. Discriminated on `phase`:
 *
 *   - `idle`     — created, never scanned. `scan` starts the actual-world walk.
 *   - `scanning` — the paginated-walk is traversing the actual listing; pages
 *                  fold into `actual` as they arrive. The scan owns the `walk`
 *                  sub-slice; this phase ends when the walk finishes.
 *   - `applying` — the scan finished, `diff` produced the `plan`, and changes are
 *                  being applied one at a time. `appliedCursor` is the index of
 *                  the next change to apply.
 *   - `done`     — every planned change applied (or an empty plan: already in
 *                  sync). Terminal.
 *   - `failed`   — the scan failed terminally (the page-fetch retries were
 *                  exhausted / a deadline fired). `error` carries why. Terminal.
 */
export type ReconcilePhase =
  | "idle"
  | "scanning"
  | "applying"
  | "done"
  | "failed";

/**
 * The slice. Plain data end to end:
 *   - `phase`         — the lifecycle discriminant.
 *   - `walk`          — the `../paginated-walk` scan slice (cursor + resilience).
 *                       Drives the actual-world traversal; POSITION survives
 *                       eviction.
 *   - `actual`        — the accumulated actual items, appended page by page during
 *                       the scan. The full snapshot `diff` is computed against.
 *   - `plan`          — the `Change[]` `diff` produced. Empty until the scan
 *                       finishes; the apply loop walks it by `appliedCursor`.
 *   - `appliedCursor` — index of the NEXT change to apply (0 ≤ cursor ≤ plan.length).
 *                       `cursor === plan.length` means every change applied.
 *   - `applied`       — the applied-ledger cache: `idOf(change) → change`, written
 *                       as each change settles. The idempotency memory the apply
 *                       loop reads to skip already-applied changes after eviction.
 */
export interface ReconcilerState<Actual, Change, Page, Cursor = number> {
  readonly phase: ReconcilePhase;
  readonly walk: PaginatedWalkState<Cursor, Page>;
  readonly actual: readonly Actual[];
  readonly plan: readonly Change[];
  readonly appliedCursor: number;
  readonly applied: TtlCache<Change>;
}

// ===========================================================================
// Cmds + Msgs the knob speaks. The scan emits the inherited page-fetch effect;
// the apply loop emits the consumer's `apply(change)` Cmds.
// ===========================================================================

/**
 * The actual-list page-fetch effect: the inherited `resilient_run` Cmd from
 * paginated-walk, whose `input` is the `Cursor` to fetch and whose `key` is the
 * fixed `PAGE_KEY`. The consumer's `handlers(ports)` interprets it.
 */
export type ScanPageCmd<Cursor> = FetchPageCmd<Cursor>;

/** Page-settled Msgs the scan `handlers` port dispatches back (inherited verbatim). */
export type ScanPageOkMsg<Page> = PageOkMsg<Page>;
export type ScanPageErrMsg = PageErrMsg;

/** The scan retry / deadline timer Msg — inherited from paginated-walk. */
export type ReconcilerTimerMsg = PaginatedWalkTimerMsg;

/**
 * Ports the consumer supplies to `handlers`. `run(cursor)` fetches ONE page of
 * the ACTUAL listing for the given cursor; throwing routes to `pageErr` (and
 * thus the scan backoff). Same shape as paginated-walk's port.
 */
export interface ReconcilerPorts<Cursor, Page>
  extends ResilientPorts<Cursor, Page> {}

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build a reconciler knob from `config`. `rng` is injected for the underlying
 * scan-retry jitter — pass a fixed `() => 0` in tests to pin backoff; defaults
 * to `Math.random` (read at the verb boundary inside resilient-call, never in a
 * reconciler verb). Inherited straight from paginated-walk.
 *
 * Returns the uniform L2 knob contract: `init()`, the verbs `scan` / `pageOk` /
 * `pageErr` / `planned` / `applyNext` / `applied` / `onTimer`, the derived
 * `isComplete`, `subs(state)`, and `handlers(ports)`.
 */
export function createReconciler<
  Actual,
  Desired,
  Page,
  Change,
  ApplyCmd extends Cmd = Cmd,
  Cursor = number,
>(
  config: ReconcilerConfig<Actual, Desired, Page, Change, ApplyCmd, Cursor>,
  rng: () => number = Math.random,
) {
  type State = ReconcilerState<Actual, Change, Page, Cursor>;
  // The combined Cmd type the verbs can emit: the inherited scan page-fetch
  // effect plus whatever `apply(change)` yields.
  type OutCmd = ScanPageCmd<Cursor> | ApplyCmd;

  // The scan is a paginated-walk over the actual listing. We feed it the scan
  // cursor knobs + the resilience bricks; `onPage` is OURS — it is a pure marker
  // (we accumulate items in `pageOk` instead, where we hold the reconciler
  // slice). The walk's `Page` payload is the consumer's `Page`; the reconciler
  // slice stores the walk as `PaginatedWalkState<Cursor, unknown>` so its own
  // type does not have to thread `Page` (the page never lands in the slice — only
  // the extracted `actual` items do).
  const walk = createPaginatedWalk<Cursor, Page, never>(
    {
      firstPage: config.firstPage,
      nextCursor: config.nextCursor,
      // The walk's per-page hook emits no Cmds — the reconciler accumulates the
      // page's items itself in `pageOk` (where it holds its own slice), so the
      // walk's onPage stays empty.
      onPage: () => [],
      retry: config.retry,
      circuit: config.circuit,
      rateLimit: config.rateLimit,
      deadline: config.deadline,
    },
    rng,
  );

  /**
   * The applied-ledger key for a change. Custom `idOf` when supplied; otherwise
   * the change's serialized CONTENT — a stable per-change identity. NEVER the
   * positional index: an index-keyed ledger drops a never-applied change that
   * happens to land at a slot a different, already-applied change once occupied
   * (the re-plan defect). Identity is intrinsic to the change, so the ledger
   * means "this change settled", surviving a re-plan that reorders the slots.
   */
  function changeId(change: Change): string {
    return config.idOf ? config.idOf(change) : JSON.stringify(change);
  }

  /** Replace the walk sub-slice, leaving the rest of the reconciler untouched. */
  function withWalk(s: State, w: State["walk"]): State {
    return { ...s, walk: w };
  }

  /** The starting slice: idle, fresh walk + empty accumulator / plan / ledger. */
  function init(): State {
    return {
      phase: "idle",
      walk: walk.init(),
      actual: [],
      plan: [],
      appliedCursor: 0,
      applied: initCache<Change>(),
    };
  }

  // === Verb: scan ==========================================================

  /**
   * Begin the reconcile: start the paginated walk over the ACTUAL world and
   * enter `scanning`. Issues the first scan-page fetch (gated through the
   * inherited resilience). A no-op on any non-`idle` phase — re-scanning a
   * reconcile already in flight would restart the actual walk and double-count,
   * so a stray `scan` is absorbed. PURE — `at` threads into the fetch gate.
   */
  function scan(s: State, at: number): readonly [State, readonly OutCmd[]] {
    if (s.phase !== "idle") return [s, []];
    const [w, cmds] = walk.start(s.walk, at);
    const next: State = { ...s, phase: "scanning", walk: w };
    return [next, cmds];
  }

  // === Verb: pageOk ========================================================

  /**
   * Record a successfully fetched actual-list `page`: append its items to the
   * `actual` accumulator and advance the walk. When the walk finishes (the
   * listing is exhausted), the full actual snapshot is in hand → compute the
   * plan (`planned`) and start applying. PURE — `at` is the scan clock.
   *
   * A stray `pageOk` while not `scanning` (a late duplicate after the scan
   * completed) is absorbed by the walk (no cursor advance) and contributes no
   * items — the reconcile never re-accumulates after the plan is computed.
   */
  function pageOk(
    s: State,
    page: Page,
    at: number,
  ): readonly [State, readonly OutCmd[]] {
    // Once we are past scanning, the actual snapshot is frozen — absorb stray pages.
    if (s.phase !== "scanning") {
      const [w] = walk.pageOk(s.walk, page, at);
      return [withWalk(s, w), []];
    }

    const [w, walkCmds] = walk.pageOk(s.walk, page, at);
    const actual = [...s.actual, ...config.itemsOf(page)];
    const scanned: State = { ...s, walk: w, actual };

    // The walk emits the next scan-page fetch while it stays fetching. When it
    // finishes (done / paused with no fetch), `walkCmds` is empty.
    const cmds: readonly OutCmd[] = walkCmds;

    // Scan exhausted → plan + begin applying. `walk.isComplete` is the honest
    // "the API returned a null next cursor" signal.
    if (walk.isComplete(scanned.walk)) {
      const [plannedState, applyCmds] = planned(scanned, at);
      return [plannedState, [...cmds, ...applyCmds]];
    }

    return [scanned, cmds];
  }

  // === Verb: pageErr =======================================================

  /**
   * Record a failed scan-page fetch and back off via the inherited resilience:
   * schedule a retry (the scan cursor stays parked — no advance) or, once the
   * page-fetch retries are exhausted, the underlying call settles `failed`. When
   * the scan call is terminally failed, the whole reconcile enters `failed`.
   * PURE — `at` stamps the breaker trip + the retry-delay base.
   */
  function pageErr(
    s: State,
    error: unknown,
    at: number,
  ): readonly [State, readonly OutCmd[]] {
    const [w, cmds] = walk.pageErr(s.walk, error, at);
    let next = withWalk(s, w);
    // The page-fetch call settling `failed` (retries exhausted) is a terminal
    // scan failure → the reconcile cannot trust an incomplete actual snapshot.
    if (
      s.phase === "scanning" &&
      w.resilience.calls[PAGE_KEY]?.phase === "failed"
    ) {
      next = { ...next, phase: "failed" };
    }
    return [next, cmds];
  }

  // === Verb: planned =======================================================

  /**
   * Compute the remediation plan from the accumulated `actual` snapshot and the
   * configured `desired`, store it, and enter `applying`. Normally driven
   * internally by `pageOk` when the scan finishes, but exposed as a
   * verb so a consumer can force planning from an externally-supplied actual
   * snapshot (e.g. a single-shot actual fetch outside the paginated scan), or
   * re-plan after a desired change. An empty plan settles straight to `done`
   * (already in sync). PURE — `at` only stamps the (empty) apply-loop clock.
   *
   * `changes` is optional: omit it to diff the slice's own accumulated `actual`
   * against `config.desired`; pass an explicit plan to install it directly
   * (skipping the diff — the consumer computed it elsewhere).
   */
  function planned(
    s: State,
    at: number,
    changes?: readonly Change[],
  ): readonly [State, readonly OutCmd[]] {
    const plan = changes ?? config.diff(config.desired, s.actual);
    const planning: State = {
      ...s,
      phase: "applying",
      plan,
      appliedCursor: 0,
    };
    return applyNext(planning, at);
  }

  // === Verb: applyNext =====================================================

  /**
   * Emit the apply Cmd for the next not-yet-applied change in the plan, skipping
   * any whose id is already in the applied ledger (idempotent re-apply after
   * eviction). Advances `appliedCursor` past skipped + the emitted change. When
   * the cursor reaches the end of the plan, settles `done`. A no-op unless
   * `applying`. PURE — `at` is read only for the ledger lookup clock; `idOf`
   * keys the skip check.
   *
   * Emits at most ONE apply Cmd per call (the loop is sequential: each `applied`
   * drives the next `applyNext`). This keeps the actual-world mutation
   * one-at-a-time, matching a controller's serial reconcile.
   */
  function applyNext(
    s: State,
    at: number,
  ): readonly [State, readonly OutCmd[]] {
    if (s.phase !== "applying") return [s, []];

    let cursor = s.appliedCursor;
    // Skip changes already in the ledger (a resumed reconcile re-issues from the
    // cursor but must not re-apply what already settled).
    while (cursor < s.plan.length) {
      const change = s.plan[cursor];
      // `cursor < plan.length` guarantees an element under normal indexing; the
      // explicit `undefined` narrow (vs a non-null assertion) keeps the access
      // typed without a suppression and tolerates a sparse hole by skipping it.
      if (change === undefined) {
        cursor++;
        continue;
      }
      const id = changeId(change);
      if (cacheGet(s.applied, id, at) === undefined) {
        // This change is not yet applied — emit its Cmd and park the cursor here
        // (it advances to cursor+1 only once `applied` confirms the change).
        const advanced: State = { ...s, appliedCursor: cursor };
        return [advanced, [config.apply(change)]];
      }
      cursor++;
    }

    // Every change applied → reconcile complete.
    const done: State = { ...s, phase: "done", appliedCursor: cursor };
    return [done, []];
  }

  // === Verb: applied =======================================================

  /**
   * Record that `change` finished applying: write it into the applied ledger,
   * advance the cursor past it, and drive the next `applyNext`. PURE — `at` is
   * the ledger-write clock (the entry never expires in practice; a large TTL
   * keeps the idempotency window open for the reconcile's lifetime).
   *
   * `change` is the SAME change the consumer's apply handler settled (echoed back
   * on the settle Msg) — its id is computed from the change's own identity (NOT a
   * cursor position), so the ledger key matches the skip check in `applyNext`
   * regardless of where the change sits in the plan. A no-op unless `applying` (a
   * late settle after `done` is ignored). PURE.
   */
  function applied(
    s: State,
    change: Change,
    at: number,
  ): readonly [State, readonly OutCmd[]] {
    if (s.phase !== "applying") return [s, []];
    const id = changeId(change);
    // A very large TTL: the ledger entry must outlive the whole reconcile pass.
    // `get(..., at)` treats it as fresh for `at < expiresAtMs`, which holds for
    // any realistic reconcile (the cache exists to dedupe within one pass).
    const applied = cacheSet(
      s.applied,
      id,
      change,
      at,
      Number.MAX_SAFE_INTEGER,
    );
    const advanced: State = {
      ...s,
      applied,
      appliedCursor: s.appliedCursor + 1,
    };
    return applyNext(advanced, at);
  }

  // === Verb: onTimer =======================================================

  /**
   * A scan retry / deadline timer fired. Defers to paginated-walk's `onTimer`: a
   * retry timer re-issues the SAME scan-page fetch (re-fetching the parked
   * cursor); a deadline timer settles the scan call failed. A deadline-driven
   * terminal scan failure escalates the whole reconcile to `failed`. A stale fire
   * is a pure no-op (inherited identity). PURE.
   */
  function onTimer(
    s: State,
    msg: ReconcilerTimerMsg,
  ): readonly [State, readonly OutCmd[]] {
    const [w, cmds] = walk.onTimer(s.walk, msg);
    if (w === s.walk) {
      // Inherited no-op identity → keep our slice identity too.
      return [s, []];
    }
    let next = withWalk(s, w);
    if (
      s.phase === "scanning" &&
      w.resilience.calls[PAGE_KEY]?.phase === "failed"
    ) {
      next = { ...next, phase: "failed" };
    }
    return [next, cmds];
  }

  // === Derived predicate ===================================================

  /**
   * Whether the reconcile has fully settled — every planned change applied (or an
   * empty plan: already in sync). PURE, read-only. Lets a consumer's reducer fire
   * a "reconcile complete" Cmd without re-checking the phase by hand.
   */
  function isComplete(s: State): boolean {
    return s.phase === "done";
  }

  // === Subs ================================================================

  /**
   * Pre-wired subscriptions: exactly the scan's paginated-walk subs — a retry
   * timer while a scan page is `waiting_retry`, and (with the `deadline` brick) a
   * per-page deadline timer while a scan fetch is active. The apply loop emits no
   * timers (each apply settles via the consumer's own Msg), so once the scan
   * finishes the desired sub set empties. Reconciled by id; wire `subscribe: {
   * deadline: subscribeDeadline }` (re-exported below).
   */
  function subs(s: State): readonly DeadlineSub[] {
    return walk.subs(s.walk);
  }

  // === Handlers ============================================================

  /**
   * Pre-wired interpret handler for the scan page-fetch effect. Inherited from
   * paginated-walk (`resilient_run`): wraps the consumer's `run(cursor)` actual-
   * list port via `tryInterpret` (Railway) — success → `resilient_ok` (handled by
   * `pageOk`), failure → `resilient_err` (handled by `pageErr`), each stamped
   * with `Date.now()` at the effect boundary (the ONE permitted clock read).
   *
   *   interpret: rec.handlers({ run: (cursor) => api.listActual(cursor) })
   *
   * The apply-Cmd side is the CONSUMER's interpret handler (it knows how to
   * realize `apply(change)`); the consumer routes its settle Msg back through
   * `applied`. This knob only owns the scan's interpret cell.
   */
  function handlers(ports: ReconcilerPorts<Cursor, Page>) {
    return walk.handlers(ports);
  }

  return {
    init,
    scan,
    pageOk,
    pageErr,
    planned,
    applyNext,
    applied,
    onTimer,
    isComplete,
    subs,
    handlers,
  };
}

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice
 * lives at `state.rec`. Convenience for the common single-slice host; hosts with
 * a differently-named field spread by hand. PURE — a thin record rebuild, no
 * clock / RNG.
 */
export function liftReconciler<
  S extends { rec: ReconcilerState<Actual, Change, Page, Cursor> },
  Actual,
  Change,
  Page,
  Cursor,
  C extends Cmd,
>(
  state: S,
  [slice, cmds]: readonly [
    ReconcilerState<Actual, Change, Page, Cursor>,
    readonly C[],
  ],
): readonly [S, readonly C[]] {
  return [{ ...state, rec: slice }, cmds];
}

/**
 * Re-export the deadline Sub primitives (inherited from paginated-walk) so
 * consumers wire one import: `subscribeDeadline` is the `subscribe` cell,
 * `deadlineSub` builds the Sub literal this knob's `subs` emits.
 */
export { subscribeDeadline, deadlineSub };
export type { DeadlineSub };
