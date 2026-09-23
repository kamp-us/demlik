/**
 * internal/resilience/cache — a TTL cache as pure state, PLUS a periodic eviction Sub.
 *
 * Same pure-state-ops shape as `../../idempotency/` and
 * `../../work-queue/ops.ts`: a state type plus pure transition functions. Host-
 * agnostic by construction — no `Date.now()`, no timers, no I/O inside the ops.
 * The caller injects the clock (`nowMs`) and folds the result through its own
 * reducer, keeping the store inside TEA's invariant 2 (transitions are pure:
 * same inputs → same outputs) so a consumer can exercise it with `replay`
 * without a fake clock.
 *
 * Every op returns a NEW cache value and never mutates its input (invariant 1 —
 * state is a value, not a place). `get` / `has` are read-shaped; `set` /
 * `remove` / `evictExpired` return a new cache.
 *
 * **Distinct from `/idempotency`.** Both are TTL-bounded key maps, but they
 * answer different questions and so carry different shapes:
 *
 *   - `/idempotency` is DEDUPE-focused — "have I already processed this key?"
 *     TTL is a single store-level policy (`ttlMs`), each entry stores the
 *     `atMs` it was remembered at, and expiry is derived (`now - atMs >=
 *     ttlMs`). It carries an `order` ledger + `capacity` because the use case
 *     (webhook receivers, retried messages) needs bounded LRU eviction.
 *   - `/cache` is RETRIEVAL-focused — "what is the value for this key right
 *     now?" TTL is set PER ENTRY at write time: `set(key, value, nowMs,
 *     ttlMs)` bakes the absolute `expiresAtMs = nowMs + ttlMs` into the entry.
 *     Different keys can carry different lifetimes (a hot key cached for 1s, a
 *     cold one for 1h) — the dimension idempotency's single store-level
 *     `ttlMs` cannot express. No `order`, no `capacity`: a cache bounds itself
 *     by TTL + periodic eviction, not by LRU count.
 *
 * The eviction Sub is the "eviction is a Msg" half: a `setInterval`-shaped Sub
 * (composed directly on `fromInterval`, from `src/subs/`) that periodically
 * dispatches a `cache_evict` Msg the consumer's reducer handles by calling
 * `evictExpired`. Time still never enters the reducer — the Sub fires the Msg,
 * the reducer reads `nowMs` off the Msg (the consumer stamps it at the Sub
 * boundary), and `evictExpired` does the pure drop.
 *
 * Internal to the package (`src/internal/resilience/`), not a published
 * subpath (#46); same one-shape-per-module rule as `work-queue`, `idempotency`,
 * and `rate-limit`.
 */

import type { DepKeyedSub, Sub } from "../../../index";
import { fromInterval } from "../../../subs";
import type { SubscribeHandler } from "../../../subs/types";

/**
 * A cached entry: the `value` and the absolute clock reading `expiresAtMs` it
 * expires at. Unlike `/idempotency`'s entry (which stores `atMs` and derives
 * expiry from a store-level `ttlMs`), the expiry instant is baked in at write
 * time — so per-entry TTLs are a first-class capability. Both fields are plain
 * data so the whole cache is trivially JSON-serializable into a consumer's
 * `Store<S>`.
 */
export interface CacheEntry<V> {
  readonly value: V;
  readonly expiresAtMs: number;
}

/**
 * The cache: a map of `key → entry`. No `order` ledger and no `capacity` (cf.
 * `/idempotency`) — a TTL cache bounds itself by expiry + periodic eviction,
 * not by LRU count. Each entry carries its own `expiresAtMs`, so the cache
 * needs no store-level TTL policy field.
 */
export interface TtlCache<V> {
  readonly entries: Readonly<Record<string, CacheEntry<V>>>;
}

/** Create an empty cache. */
export function initCache<V>(): TtlCache<V> {
  return { entries: {} };
}

/**
 * Whether `entry` is expired at `nowMs`. Half-open: an entry whose
 * `expiresAtMs` exactly equals `nowMs` is expired (`nowMs >= expiresAtMs`),
 * matching `/idempotency` and `/rate-limit`'s window-edge cutoff — a value
 * cached at `t` with a `ttlMs` lifetime is gone at exactly `t + ttlMs`.
 */
function isExpired<V>(entry: CacheEntry<V>, nowMs: number): boolean {
  return nowMs >= entry.expiresAtMs;
}

/**
 * The cached `value` for `key` iff present AND unexpired at `nowMs`, else
 * `undefined`. An expired entry reads as absent even though it is physically
 * still in `entries` until the next `evictExpired` (or an overwriting `set`)
 * drops it. PURE — reads only, never mutates.
 */
export function get<V>(
  cache: TtlCache<V>,
  key: string,
  nowMs: number,
): V | undefined {
  const entry = cache.entries[key];
  if (entry === undefined || isExpired(entry, nowMs)) return undefined;
  return entry.value;
}

/**
 * True iff `key` is present AND unexpired at `nowMs`. The boolean sibling of
 * `get` for callers that only need presence, not the value. PURE.
 */
export function has<V>(
  cache: TtlCache<V>,
  key: string,
  nowMs: number,
): boolean {
  const entry = cache.entries[key];
  if (entry === undefined) return false;
  return !isExpired(entry, nowMs);
}

/**
 * Write `key → value` with an absolute expiry of `nowMs + ttlMs`. Re-`set`ting
 * an existing key overwrites both the value and the expiry — the TTL clock
 * restarts from the new `nowMs`. PURE — returns a new cache; the input is
 * untouched (a fresh shallow copy of `entries`).
 */
export function set<V>(
  cache: TtlCache<V>,
  key: string,
  value: V,
  nowMs: number,
  ttlMs: number,
): TtlCache<V> {
  const nextEntries: Record<string, CacheEntry<V>> = { ...cache.entries };
  nextEntries[key] = { value, expiresAtMs: nowMs + ttlMs };
  return { ...cache, entries: nextEntries };
}

/**
 * Drop `key` regardless of expiry. PURE — returns a new cache; the input is
 * untouched. Removing an absent key returns an equivalent cache (the shallow
 * copy still happens, but no entry is dropped).
 */
export function remove<V>(cache: TtlCache<V>, key: string): TtlCache<V> {
  const nextEntries: Record<string, CacheEntry<V>> = { ...cache.entries };
  delete nextEntries[key];
  return { ...cache, entries: nextEntries };
}

/**
 * Physically drop every entry expired at `nowMs` (`nowMs >= expiresAtMs`).
 * Returns a NEW cache with the survivors. This is the pure work the eviction
 * Sub's `cache_evict` Msg triggers — `get` / `has` already treat expired
 * entries as absent, so eviction is purely a memory-reclaim pass, not a
 * correctness one. PURE — the input cache is never mutated.
 */
export function evictExpired<V>(
  cache: TtlCache<V>,
  nowMs: number,
): TtlCache<V> {
  const nextEntries: Record<string, CacheEntry<V>> = {};
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (isExpired(entry, nowMs)) continue;
    nextEntries[key] = entry;
  }
  return { ...cache, entries: nextEntries };
}

// ---------------------------------------------------------------------------
// Eviction Sub — "eviction is a Msg".
//
// A periodic timer Sub that dispatches `cache_evict` so the consumer's reducer
// can call `evictExpired`. It is `fromInterval` specialized to a fixed Msg
// shape — the interval rides in the Sub's `deps` (which the engine keys the
// Sub on) and the runner dispatches a `cache_evict` Msg tagged with the cache's
// name, so a consumer running several caches can route each tick to the right
// cache by `msg.id`.
//
// Mirrors `fromInterval` exactly (factory + SubscribeHandler cell + exported
// Msg constructor); it does NOT reimplement the timer lifecycle — it composes
// directly on `fromInterval`, which owns `setInterval` / `clearInterval`. That
// keeps the timer-handle bookkeeping (and its cleanup) in one place and this
// module purely declarative.
//
// Strengthens invariant 4 (external time is a Sub the engine reconciles) and
// invariant 9 (named, small Sub surface composed on the shared factory).
// ---------------------------------------------------------------------------

/**
 * The Msg the eviction Sub dispatches each tick. `id` is the cache's name so a
 * consumer with multiple caches can route the tick to the matching cache. The
 * reducer reads `Date.now()`-free time by stamping `nowMs` itself at the Sub
 * boundary if needed; the canonical reducer cell is
 * `cache_evict: (s) => [{ ...s, cache: evictExpired(s.cache, nowMs) }, []]`.
 */
export interface CacheEvictMsg {
  readonly type: "cache_evict";
  readonly id: string;
}

/** Construct a `cache_evict` Msg for the cache identified by `id`. */
export function cacheEvictMsg(id: string): CacheEvictMsg {
  return { type: "cache_evict", id };
}

/**
 * The `deps` of an eviction Sub: which cache it ticks for (`name`, echoed as
 * the Msg's `id`) and the tick period (`intervalMs`, which `fromInterval`
 * reads).
 */
export type CacheEvictionDeps = {
  readonly name: string;
  readonly intervalMs: number;
};

/**
 * The running eviction Sub: a `setInterval`-shaped Sub whose `deps` carry the
 * cache's name and tick period. `type: "cache"` is the lowercase source-noun
 * Sub convention (canon §2.5 / naming-style).
 */
export type CacheEvictionSub = Sub<"cache", CacheEvictionDeps>;

/**
 * The `subs` entry for an eviction tick on the cache named `name`, every
 * `everyMs`. It is on for the machine's life:
 *
 *   subs: [cacheEvictionSub("session-cache", 30_000)],
 *   // run(machine, { subscribe: { cache: cacheEvictionSubscribe } })
 *
 * The engine keys the Sub on its `deps`, so a machine that declares the same
 * name and period keeps one running interval, and a changed period restarts
 * it at the new one.
 */
export function cacheEvictionSub(
  name: string,
  everyMs: number,
): DepKeyedSub<unknown, CacheEvictionSub> {
  return { type: "cache", deps: () => ({ name, intervalMs: everyMs }) };
}

/**
 * The `cache` runner for the eviction Sub. Hand it to `run`:
 *
 *   run(machine, { subscribe: { cache: cacheEvictionSubscribe } })
 *
 * Composed directly on `fromInterval` — it owns the `setInterval` /
 * `clearInterval` lifecycle; this runner only pins the Msg the tick dispatches
 * (`cacheEvictMsg(sub.deps.name)`). The cleanup `fromInterval` returns stops
 * the interval when the Sub stops.
 */
export const cacheEvictionSubscribe: SubscribeHandler<
  CacheEvictionSub,
  CacheEvictMsg,
  unknown
> = fromInterval((sub) => cacheEvictMsg(sub.deps.name));
