/**
 * @demlik/tea/throttled-input — gate a high-frequency input stream into a
 * SETTLED, RATE-CAPPED, optionally DEDUPED sequence of emits, as a TEA knob: one
 * config object + a few pre-wired hooks you spread into your machine.
 *
 * Layering (the throttle-family map): `../throttle` and `../debounce` are the
 * two host-boundary PRIMITIVES — two distinct algorithms
 * (at-most-once-per-window vs collapse-a-burst) behind one signature shape.
 * THIS module is the third name but NOT a third primitive: a TEA machine
 * composed OVER them that re-exports both. Three exports, one layering — not
 * duplication. The reuse list below spells out composition vs reimplemented
 * semantic per sibling.
 *
 * What it reuses, and HOW (composition vs. reimplemented semantic — the two are
 * not the same, so this list keeps them apart):
 *
 *   - `../cache` — COMPOSED directly. The DEDUPE / memoize layer is `../cache`'s
 *     `TtlCache` plus its `get` / `set` / `initCache` ops, called at runtime —
 *     not reinvented. While `cacheTtlMs` is set, an input whose `cacheKey` is
 *     already cached and unexpired is served from the cache and emits NOTHING
 *     (the downstream effect ran once for that key within its TTL); a fresh emit
 *     writes the value into the cache so the next identical input within
 *     `cacheTtlMs` is suppressed. The optional eviction Sub is the consumer's to
 *     wire if they want memory reclaim (this knob's correctness needs only TTL
 *     reads).
 *   - `../deadline` — COMPOSED directly. The settle timer IS a `../deadline`
 *     Sub: `subsFor` builds it via `deadlineSub`, and the subscribe cell +
 *     Msg constructor are RE-EXPORTS of `../deadline`'s own (`subscribeDeadline`
 *     → `subscribeThrottledInput`, `deadlineExceeded` → `throttledInputSettled`).
 *     The timer lifecycle stays owned by `../deadline`; this knob redraws none
 *     of it.
 *   - `../throttle` / `../debounce` — TYPE + SEMANTIC reuse only, NOT composed.
 *     Those siblings are host-boundary SINK transformers that hold a live
 *     `setTimeout`; a `setTimeout` in a closure is exactly what a durable,
 *     replayable knob must NOT hold. So their CODE is never called here. Instead
 *     the RATE-cap semantic ("at most once per `ms`", leading-edge) and the
 *     SETTLE semantic ("wait until quiet", trailing-edge) are REIMPLEMENTED as
 *     pure Model state: `lastAt` is the durable rate cursor (half-open cutoff
 *     `at - lastAt >= throttleMs`), and `pending` + the `../deadline` Sub realize
 *     the debounce window inside `update`. The `throttle` / `debounce`
 *     transformers themselves are RE-EXPORTED (the only reuse of their actual
 *     code) so a consumer can pre-throttle / pre-coalesce a genuinely bursty
 *     HOST event at the boundary BEFORE it ever becomes an `input` Msg — a
 *     separate, optional escape hatch, not part of this knob's gates.
 *
 * "Omit a brick, omit its gate" (the resilient-call config rule): every gate
 * field is optional. Omit `throttleMs` → no rate cap (every input passes the
 * rate gate). Omit `debounceMs` → no settle wait (an input that clears the rate
 * gate emits IMMEDIATELY rather than being held). Omit `cacheTtlMs` → no cache
 * slice at all (the `cache` field is absent; no dedupe). A config with all three
 * omitted is a pass-through: `input` always emits.
 *
 * Why this is a knob and not hand-wired logic: the managed state (`lastAt`,
 * `pending`, `cache`) lives in the Model, so it survives DO eviction / reload
 * (durable) and every transition is still a Msg through `update` (replayable). A
 * closure holding a `setTimeout` and a mutable "last value" would break both —
 * banned. `input` / `onFlush` are PURE: time arrives as an `at` parameter, never
 * `Date.now()`; they return NEW slice values, never mutate.
 *
 * Typical wiring (combinator form):
 *
 *   const search = createThrottledInput<string, Msg>({
 *     debounceMs: 200,        // wait for the user to stop typing
 *     throttleMs: 1_000,      // but never fire more than 1/s during a long burst
 *     cacheTtlMs: 30_000,     // skip a query repeated within 30s
 *     cacheKey: (q) => q,
 *     emit: (q) => ({ type: "RunSearch", query: q }),
 *   });
 *
 *   // Model:        { search: ThrottledInput<string>, ... }
 *   // init:         (loaded) => [loaded ?? { search: search.init(), ... }, []]
 *   // update cells:
 *   //   QueryTyped:   (s, m) => mapInput(s, search.input(s.search, m.value, m.at))
 *   //   SettleFired:  (s, m) => mapInput(s, search.onFlush(s.search, m.atMs))
 *   // subscriptions: (s) => search.subs(s.search)
 *   // subscribe:     { ...search.handlers() }
 *
 * where `mapInput(s, [slice, cmds]) => [{ ...s, search: slice }, cmds]` lifts the
 * slice transition into the consumer's Model. The `RunSearch` Cmd's interpret
 * handler is the consumer's — it is where the settled input meets I/O.
 *
 * NOT a substrate primitive: it depends only on sibling subpaths (`../throttle`,
 * `../debounce`, `../cache`, `../deadline`) and the core `Cmd` / `Sub` types.
 * Consumers reach it via the `@demlik/tea/throttled-input` subpath; the L1
 * escape hatch is those sibling subpaths threaded by hand. NOT exported from the
 * package root — same one-shape-per-package rule as `batch-window` and `poller`.
 */

import {
  get as cacheGet,
  set as cacheSet,
  initCache,
  type TtlCache,
} from "../cache";
import { type DeadlineSub, deadlineSub } from "../deadline";
import type { Cmd, Sub } from "../index";

// `../throttle` + `../debounce` — host-boundary pre-transformers (see file
// header). Re-exported so a consumer that wants to throttle/debounce a bursty
// HOST source BEFORE it becomes an `input` Msg reaches them from the same
// import as the durable gate.
export { type Debounced, debounce } from "../debounce";
export { type Throttled, throttle } from "../throttle";

/**
 * The gate fields every throttled-input config shares, regardless of whether
 * dedupe is on. The two dedupe variants below extend this with mutually
 * exclusive cache fields.
 *
 * `emit` is a pure Cmd CONSTRUCTOR, not a closure-with-state: it maps a settled
 * value to the single Cmd the runtime performs when the gates let a value
 * through. Keeping it `(value) => Cmd` (not `(value) => void`) is what keeps the
 * trigger replayable — the emit is a Cmd in the transition's output, never a
 * side effect inside the verb (mirrors `batch-window`'s `flush`).
 */
interface ThrottledInputGates<V, C extends Cmd> {
  /**
   * Rate cap, in milliseconds. An input that lands within `throttleMs` of the
   * last EMIT (`at - lastAt < throttleMs`) is dropped from immediate firing —
   * the leading-edge "at most once per `throttleMs`" rate-cap rule, applied to
   * emits. The half-open cutoff (`>=` passes) matches `../throttle` and
   * `../cache`'s window-edge convention. Omit for no rate cap.
   *
   * Interacts with `debounceMs`: when both are set, a rate-blocked input is
   * still HELD as `pending` (so the settle timer eventually trails it out at a
   * legal moment) rather than silently dropped — the trailing-edge guarantee
   * that the FINAL sample of a window is never lost.
   */
  readonly throttleMs?: number;
  /**
   * Settle wait, in milliseconds. An input that clears the rate gate is not
   * emitted immediately; it is held as `pending` and a debounce deadline is
   * armed at `pendingAt + debounceMs`. A fresh input re-arms (slides) the
   * window. `onFlush` emits the pending value when the window finally expires.
   * Omit for no settle wait — a passing input emits on arrival.
   */
  readonly debounceMs?: number;
  /**
   * Map a settled value to the single Cmd the runtime performs. Called with the
   * value the gates let through; the returned Cmd is what `input` / `onFlush`
   * emit. PURE constructor — no I/O, no clock; the I/O happens later in the
   * consumer's interpret handler for the returned Cmd.
   */
  readonly emit: (value: V) => C;
}

/**
 * Configuration for a throttled input — the knob. Pure config, no mutable state
 * (the `ThrottledInput<V>` slice carries that). One config object is shared
 * across every input of one logical stream (often a module-scope const).
 *
 * A DISCRIMINATED UNION on the presence of dedupe, so the type system makes a
 * cache-key collision UNREPRESENTABLE ("omit a brick, omit its gate"):
 *
 *   - **No dedupe** (`ThrottledInputNoCache`): `cacheTtlMs` absent ⇒ no cache
 *     slice, no dedupe. `cacheKey` is statically forbidden here (`never`) — a
 *     key with no cache to feed is dead config, so the type rejects it rather
 *     than silently ignoring it.
 *   - **Dedupe** (`ThrottledInputWithCache`): `cacheTtlMs` set ⇒ `cacheKey` is
 *     REQUIRED. There is no `String(value)` default to fall back to, so a
 *     structured value can NEVER collapse two distinct values to one slot (the
 *     `"[object Object]"` collision). The consumer must state the identity that
 *     keys the cache; a primitive stream still trivially passes `(v) => v` /
 *     `String`, but it does so EXPLICITLY.
 */
export type ThrottledInputConfig<V, C extends Cmd> =
  | ThrottledInputNoCache<V, C>
  | ThrottledInputWithCache<V, C>;

/**
 * The no-dedupe config variant: gates only, no cache. `cacheTtlMs` is absent
 * and `cacheKey` is statically `never` so a stray key (which would feed no
 * cache) is a type error, not a silently-ignored field.
 */
export interface ThrottledInputNoCache<V, C extends Cmd>
  extends ThrottledInputGates<V, C> {
  readonly cacheTtlMs?: undefined;
  readonly cacheKey?: never;
}

/**
 * The dedupe config variant: a per-entry TTL plus a REQUIRED `cacheKey`. An
 * input whose `cacheKey` is already cached and unexpired emits NOTHING (the
 * downstream effect ran once for that key within its TTL); a fresh emit writes
 * the value into the cache.
 *
 * `cacheKey` is required (no `String(value)` default) precisely so a structured
 * value cannot silently collide — the consumer names the identity, the cache
 * keys on exactly that.
 */
export interface ThrottledInputWithCache<V, C extends Cmd>
  extends ThrottledInputGates<V, C> {
  /**
   * Dedupe / memoize TTL, in milliseconds. An input whose `cacheKey` is already
   * cached and unexpired emits NOTHING; a fresh emit writes the value into the
   * cache so the next identical input within `cacheTtlMs` is suppressed.
   */
  readonly cacheTtlMs: number;
  /**
   * Key a value for the dedupe cache. REQUIRED whenever `cacheTtlMs` is set:
   * there is no `String(value)` fallback, so a structured value's identity is
   * always the consumer's explicit choice and two distinct values can never
   * collapse to one slot. A primitive stream passes `(v) => v` / `String`.
   */
  readonly cacheKey: (value: V) => string;
}

/**
 * The Model slice a throttled input owns — its visible slice (the knob
 * principle: managed state lives in the Model, never a closure, so it is durable
 * and replayable).
 *
 * - `lastAt`  — the `at` of the most recent EMIT, or `null` before the first
 *               emit. The `../throttle` rate cap measures against it: an input
 *               within `throttleMs` of `lastAt` is rate-blocked. Persisted so a
 *               resumed gate keeps its rate cursor.
 * - `pending` — the value HELD for the settle (debounce) window, paired with the
 *               `at` it was held (the anchor the deadline targets), or `null`
 *               when nothing is waiting. The single source of truth for "is a
 *               settle window open?" — the debounce timer Sub arms iff this is
 *               non-null.
 * - `cache`   — the `../cache` TTL store backing dedupe, present IFF
 *               `cacheTtlMs` is configured. Absent (the field omitted) for a
 *               gate with no dedupe — no per-op cost, nothing to serialize.
 */
export interface ThrottledInput<V> {
  readonly lastAt: number | null;
  readonly pending: PendingInput<V> | null;
  readonly cache?: TtlCache<V>;
}

/**
 * A value held for the settle window: the `value` itself and the `at` it was
 * held (the anchor the debounce deadline targets, `at + debounceMs`). A distinct
 * type (not a bare `V`) because `V` may itself be `null` — a present-but-null
 * value is still a real pending input, distinct from "nothing pending", exactly
 * the `null`-sentinel discipline `../throttle` / `../debounce` use for their
 * `pendingArgs`.
 */
export interface PendingInput<V> {
  readonly value: V;
  readonly at: number;
}

/**
 * The Sub variant a throttled input's settle timer produces — a `../deadline`
 * Sub (so the window fires at the correct ABSOLUTE moment even after a late
 * subscribe / rehydrate, and so a consumer running several gates routes each by
 * `id`). `atMs` is the absolute settle-by instant (`pendingAt + debounceMs`).
 */
export type ThrottledInputSub = DeadlineSub;

/**
 * The stable Sub id the gate arms its settle deadline under. A single gate arms
 * exactly one settle timer at a time, so one id suffices; a consumer running
 * several gates on one machine namespaces them by composing the knob under
 * distinct slices with distinct ids (the `subs(state, id)` parameter).
 */
const DEFAULT_SUB_ID = "throttled-input:settle";

/**
 * The starting slice: no prior emit, nothing pending. The `cache` field is
 * seeded only when `cacheTtlMs` is configured (see `createThrottledInput`); the
 * free `initThrottledInput` leaves it absent (the no-dedupe shape).
 */
export function initThrottledInput<V>(): ThrottledInput<V> {
  return { lastAt: null, pending: null };
}

/**
 * Resolve a value's cache key under a DEDUPE config. PURE. Takes the narrowed
 * `ThrottledInputWithCache` (not the union) because `cacheKey` is only present —
 * and only meaningful — when dedupe is on; there is no `String(value)` default
 * to fall back to, so a structured value's identity is always the consumer's
 * explicit choice and two distinct values can never collapse to one slot.
 */
function keyOf<V, C extends Cmd>(
  config: ThrottledInputWithCache<V, C>,
  value: V,
): string {
  return config.cacheKey(value);
}

/**
 * Narrow `config` to its dedupe variant iff a cache slice is actually wired —
 * `cacheTtlMs` set AND a `cache` store present. Returns the narrowed config
 * (carrying the required `cacheKey`) paired with the resolved `cache` store, or
 * `null` when no dedupe is configured. The single place the union is
 * discriminated, so `isCacheHit` / `commitEmit` share one narrowing — and reuse
 * the resolved `cache` — rather than re-deriving the predicate and re-narrowing
 * `state.cache`.
 */
function cacheConfig<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
  state: ThrottledInput<V>,
): {
  readonly config: ThrottledInputWithCache<V, C>;
  readonly cache: TtlCache<V>;
} | null {
  return config.cacheTtlMs !== undefined && state.cache !== undefined
    ? { config, cache: state.cache }
    : null;
}

/**
 * Whether `value` is a cache HIT under `config` at `at` — present and unexpired.
 * PURE — reads only. Always `false` when `cacheTtlMs` is unset or no `cache`
 * slice exists (no dedupe configured), so the dedupe gate is a no-op for an
 * unconfigured gate.
 */
function isCacheHit<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
  state: ThrottledInput<V>,
  value: V,
  at: number,
): boolean {
  const cached = cacheConfig(config, state);
  if (cached === null) return false;
  return cacheGet(cached.cache, keyOf(cached.config, value), at) !== undefined;
}

/**
 * Emit `value` at clock `at`: bump the rate cursor, refresh the dedupe cache,
 * and clear any pending hold. PURE. The single place an emit's bookkeeping
 * lives, shared by `input` (immediate emit) and `onFlush` (trailing emit) so the
 * two paths can never drift on what an emit updates.
 *
 * - `lastAt` advances to `at` — the next input is rate-measured against this
 *   emit, the `../throttle` window cursor.
 * - `cache` (when configured) records `value` under its key with `cacheTtlMs`
 *   from `at` — so the next identical input within the TTL is suppressed.
 * - `pending` clears — the value just went out; nothing is waiting.
 */
function commitEmit<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
  state: ThrottledInput<V>,
  value: V,
  at: number,
): readonly [ThrottledInput<V>, readonly C[]] {
  const cached = cacheConfig(config, state);
  const cache =
    cached !== null
      ? cacheSet(
          cached.cache,
          keyOf(cached.config, value),
          value,
          at,
          cached.config.cacheTtlMs,
        )
      : state.cache;
  const next: ThrottledInput<V> = {
    ...state,
    lastAt: at,
    pending: null,
    ...(cache !== undefined ? { cache } : {}),
  };
  return [next, [config.emit(value)]];
}

/**
 * Feed a new input `value` arriving at clock `at` through the gates. PURE.
 *
 * The gate order is DEDUPE → RATE → SETTLE (each skipped when its config field
 * is omitted), the same cache-first-then-gate order `resilient-call` uses (a hit
 * short-circuits before the expensive path):
 *
 *   1. **Dedupe** (`cacheTtlMs` set): if `value`'s key is cached and unexpired,
 *      suppress — return the slice UNCHANGED (no emit, no pending, no re-arm).
 *      The downstream effect already ran for this key within its TTL.
 *   2. **Rate** (`throttleMs` set): if `at` is within `throttleMs` of the last
 *      emit (`at - lastAt < throttleMs`), this input is rate-blocked.
 *        - With `debounceMs` set → HOLD it as `pending` (the trailing edge: the
 *          settle timer will emit it at a legal moment, so the final sample is
 *          never lost). The deadline `subs` arms targets `at + debounceMs`.
 *        - Without `debounceMs` → DROP it (pure rate cap, no catch-up).
 *   3. **Settle** (`debounceMs` set): the input cleared the rate gate. HOLD it
 *      as `pending` and let the debounce window slide; `onFlush` emits it once
 *      the window expires. A fresh input before expiry overwrites `pending` (the
 *      trailing edge fires with the LAST value, the `../debounce` default).
 *   4. **Pass-through**: no `debounceMs`, cleared the rate gate → EMIT now.
 *
 * @param config the knob (the three optional gates + `emit`)
 * @param state  the current slice
 * @param value  the input value
 * @param at     the arrival instant (epoch ms) — the caller stamps it; the verb
 *               never reads the clock
 */
export function input<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
  state: ThrottledInput<V>,
  value: V,
  at: number,
): readonly [ThrottledInput<V>, readonly C[]] {
  // 1. Dedupe gate — a cached, unexpired key short-circuits everything.
  if (isCacheHit(config, state, value, at)) {
    return [state, []];
  }

  // 2. Rate gate — half-open cutoff (`>=` passes). `lastAt === null` (no prior
  // emit) always passes: the first input is never rate-blocked. Shared with
  // `onFlush` via `rateBlockedAt` so the arrival and trailing-edge paths agree
  // on the window.
  if (rateBlockedAt(config, state, at)) {
    // With a settle window, a rate-blocked input is HELD (trailing edge) so it
    // emits at the next legal moment; without one, it is a pure drop.
    if (config.debounceMs !== undefined) {
      return [{ ...state, pending: { value, at } }, []];
    }
    return [state, []];
  }

  // 3. Settle gate — passed the rate gate; if a debounce window is configured,
  // hold the value and (re)arm the settle deadline rather than emit now.
  if (config.debounceMs !== undefined) {
    return [{ ...state, pending: { value, at } }, []];
  }

  // 4. Pass-through — no settle wait, cleared the rate gate: emit immediately.
  return commitEmit(config, state, value, at);
}

/**
 * Whether emitting at clock `at` would breach the rate cap — `at` lands within
 * `throttleMs` of the last emit (`at - lastAt < throttleMs`). PURE — reads only.
 * Always `false` when `throttleMs` is unset (no rate cap) or before the first
 * emit (`lastAt === null`), so an unconfigured / never-fired gate never holds on
 * the rate gate. The single rate-gate predicate, shared by `input` (drop / hold
 * on arrival) and `onFlush` (re-hold a still-early trailing edge) so the two
 * paths can never drift on what "within the rate window" means.
 */
function rateBlockedAt<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
  state: ThrottledInput<V>,
  at: number,
): boolean {
  return (
    config.throttleMs !== undefined &&
    state.lastAt !== null &&
    at - state.lastAt < config.throttleMs
  );
}

/**
 * Emit the pending value because the settle (debounce) window closed. PURE.
 *
 * - Pending present, rate gate CLEAR → emit `config.emit(pending.value)`,
 *   advance the rate cursor (`lastAt = at`), refresh the dedupe cache, and clear
 *   `pending`. The trailing edge of `../debounce` realized as a Model transition.
 * - Pending present, rate gate STILL BLOCKED → re-HOLD: return the slice with
 *   `pending` intact and NO Cmds. A settle Msg can fire at `pending.at +
 *   debounceMs`, which may still be inside the rate window (`lastAt +
 *   throttleMs`) — emitting then would breach the headline "at most once per
 *   `throttleMs`" cap. Re-holding keeps the value waiting; `subs` re-arms the
 *   deadline at `max(pending.at + debounceMs, lastAt + throttleMs)` so the next
 *   timer fires at a LEGAL moment and the trailing edge is deferred, never lost.
 * - Pending absent → no-op: return the same slice and no Cmds. Guards the race
 *   where an `input` already emitted (or a dedupe hit cleared interest) before
 *   the settle timer's Msg lands — a stale `onFlush` must NOT emit. Symmetric
 *   with `batch-window`'s closed-window guard.
 *
 * `at` is the firing instant the settle Msg carried (the caller stamps it; the
 * verb never reads the clock). It becomes the new rate cursor and the cache
 * write's `nowMs`, so a settled emit rate-blocks subsequent inputs from its
 * actual fire moment, not the moment the value was first held.
 *
 * @param config the knob (`throttleMs`, `emit`, cache config)
 * @param state  the current slice
 * @param at     the settle-timer firing instant (epoch ms)
 */
export function onFlush<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
  state: ThrottledInput<V>,
  at: number,
): readonly [ThrottledInput<V>, readonly C[]] {
  // No pending value = an immediate emit already fired, or a dedupe hit cleared
  // interest. A stale timer Msg must not emit — return the slice untouched.
  if (state.pending === null) return [state, []];
  // Rate gate re-check: a settle Msg can land before the rate window opens (its
  // naive deadline is pending.at + debounceMs, which `subs` lifts to a legal
  // target — but a stale / early timer can still arrive). Emitting now would
  // breach "at most once per throttleMs", so re-hold and let `subs` re-arm at
  // the legal moment. The value stays pending; nothing is dropped.
  if (rateBlockedAt(config, state, at)) return [state, []];
  return commitEmit(config, state, state.pending.value, at);
}

/**
 * The settle timer Sub, derived from the slice. PURE.
 *
 * Returns the single `../deadline` Sub while a value is held AND a settle window
 * is configured, or `[]` otherwise. The deadline target is the LATER of two
 * constraints (so the timer never fires before BOTH are satisfied):
 *
 *   - `pending.at + debounceMs` — the settle (debounce) deadline: the value has
 *     stopped sliding, the burst has gone quiet.
 *   - `lastAt + throttleMs` — the rate cap: emitting earlier would breach "at
 *     most once per `throttleMs`". Only applies once a prior emit exists
 *     (`lastAt !== null`) and a rate cap is configured (`throttleMs` set).
 *
 * `max(settleAt, rateAt)` is the earliest LEGAL trailing-edge moment. Anchoring
 * the timer here — rather than the naive `pending.at + debounceMs` — is what
 * keeps the rate cap intact across the trailing edge: a value held while still
 * inside the rate window arms its timer at `lastAt + throttleMs`, so `onFlush`
 * fires at a moment the rate gate already permits. (`onFlush` re-checks the gate
 * anyway and re-holds if an early/stale timer slips through, so the cap holds
 * even if a timer fires ahead of this target.)
 *
 * The substrate's reconcile pass arms the timer when the array gains the Sub and
 * disarms it (clearing the pending `setTimeout`) when the array loses it — so an
 * `onFlush` (or a dedupe hit) that clears `pending` auto-cancels the now-stale
 * settle timer on the next transition, and a sliding input that re-stamps
 * `pending.at` re-arms a fresh absolute target.
 *
 * `debounceMs` undefined ⇒ no settle window ⇒ `[]` even with a `pending` value
 * (an unconfigured settle never holds, but the guard keeps `subs` total).
 *
 * @param config the knob (`debounceMs`, `throttleMs`)
 * @param state  the current slice
 * @param id     stable identity for this gate's settle timer (default
 *               `"throttled-input:settle"`); pass a distinct id per gate when a
 *               machine runs several so the dispatched Msg routes distinctly.
 */
export function subsFor<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
  state: ThrottledInput<V>,
  id = DEFAULT_SUB_ID,
): readonly ThrottledInputSub[] {
  if (config.debounceMs === undefined || state.pending === null) return [];
  const settleAt = state.pending.at + config.debounceMs;
  // The rate floor: the earliest moment the rate cap permits an emit. Absent
  // when no rate cap is configured or no prior emit set a cursor — then the
  // settle deadline alone governs.
  const rateAt =
    config.throttleMs !== undefined && state.lastAt !== null
      ? state.lastAt + config.throttleMs
      : settleAt;
  return [deadlineSub(id, Math.max(settleAt, rateAt))];
}

/**
 * The bound knob returned by `createThrottledInput`. `init` + the two pure verbs
 * + `subs`, all closing over one `ThrottledInputConfig`. The verbs return
 * `readonly [ThrottledInput<V>, readonly C[]]`: the next slice and the Cmds to
 * emit (one `emit` Cmd when a value passes, none while held / dropped / deduped).
 *
 * Pure-ops + subs module: there is no `handlers(ports)` cell. The settle timer's
 * subscribe cell IS `../deadline`'s `subscribeDeadline` (re-exported below) —
 * the consumer wires it into `subscribe` directly; the knob redraws no timer
 * lifecycle of its own. (Compare `poller`, identical: it too reuses
 * `../deadline`'s cell and ships no `handlers`.)
 */
export interface ThrottledInputKnob<V, C extends Cmd> {
  /** Seed the Model slice (with a cache iff `cacheTtlMs` is configured). */
  init(): ThrottledInput<V>;
  /**
   * Feed a new input through the dedupe → rate → settle gates. See `input`.
   */
  input(
    state: ThrottledInput<V>,
    value: V,
    at: number,
  ): readonly [ThrottledInput<V>, readonly C[]];
  /**
   * Emit the held value because the settle window closed. See `onFlush`.
   */
  onFlush(
    state: ThrottledInput<V>,
    at: number,
  ): readonly [ThrottledInput<V>, readonly C[]];
  /**
   * The settle timer Sub, armed only while a value is held. See `subsFor`.
   * `id` keys the deadline so several gates on one machine route distinctly.
   */
  subs(state: ThrottledInput<V>, id?: string): readonly Sub[];
}

/**
 * Build a throttled-input knob from `config`. Combinator form (the default L2
 * ergonomic): hand it the config, splice the returned hooks into your machine.
 * The pure verbs (`input` / `onFlush`) close over the config so the consumer's
 * reducer cells stay a uniform `(state, ...args)` shape; `subs` pre-wires the
 * settle timer.
 *
 * `init()` seeds a `cache` slice IFF `cacheTtlMs` is configured — an unconfigured
 * gate carries no cache field (nothing to serialize, no dedupe). Pure factory —
 * no clock read, no timer; everything happens when the consumer calls the
 * returned verbs / `subs` with an injected `at`.
 *
 * @typeParam V the input value type
 * @typeParam C the Cmd type `config.emit` returns
 */
export function createThrottledInput<V, C extends Cmd>(
  config: ThrottledInputConfig<V, C>,
): ThrottledInputKnob<V, C> {
  function init(): ThrottledInput<V> {
    const base = initThrottledInput<V>();
    // Seed the cache only when dedupe is configured — an unconfigured gate
    // carries no cache field at all (the no-dedupe shape).
    return config.cacheTtlMs !== undefined
      ? { ...base, cache: initCache<V>() }
      : base;
  }

  return {
    init,
    input: (state, value, at) => input(config, state, value, at),
    onFlush: (state, at) => onFlush(config, state, at),
    subs: (state, id) => subsFor(config, state, id),
  };
}

/**
 * The settle-timer wiring, RE-EXPORTED from `../deadline` (not redrawn) so the
 * timer lifecycle stays owned there. Consolidated into one `export ... from`:
 *
 *   - `subscribeThrottledInput` (= `../deadline`'s `subscribeDeadline`) — the
 *     `subscribe["deadline"]` cell. Arms a one-shot timer for `max(0, atMs -
 *     now)`, dispatches the deadline Msg, returns a cleanup that clears it. The
 *     consumer assigns it: `subscribe: { deadline: subscribeThrottledInput }`.
 *   - `throttledInputSettled` (= `../deadline`'s `deadlineExceeded`) +
 *     `ThrottledInputSettled` (= `DeadlineExceeded`) — the settle-timer Msg
 *     constructor and type the consumer handles via `onFlush`. Sharing one
 *     constructor with the subscribe cell keeps the two from drifting; the
 *     reducer reads `msg.atMs` as the `at` it threads into `onFlush`.
 */
export {
  type DeadlineExceeded as ThrottledInputSettled,
  deadlineExceeded as throttledInputSettled,
  subscribeDeadline as subscribeThrottledInput,
} from "../deadline";
