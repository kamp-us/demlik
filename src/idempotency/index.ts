/**
 * @demlik/tea/idempotency — dedupe-by-key + last-result cache as pure state + ops.
 *
 * Same shape as `@demlik/tea/work-queue`'s `ops.ts` and `@demlik/tea/rate-limit`:
 * a state type plus pure transition functions. Host-agnostic by construction —
 * no `Date.now()`, no timers, no I/O. The caller injects the clock (`nowMs`)
 * and wires the result into its own reducer / interpret. This keeps the store
 * inside TEA's invariant 2 (transitions are pure: same inputs → same outputs,
 * no `Date.now`) so a consumer can fold it through `update` and exercise it
 * with `replay` / the pbt fold without a fake clock.
 *
 * Every op returns a NEW store value and never mutates its input (invariant 1 —
 * state is a value, not a place). `seen` / `recall` are read-shaped predicates;
 * `remember` / `evictExpired` return a new store.
 *
 * The use case: a webhook receiver, a retried queue message, or a repeated user
 * action arrives carrying an idempotency key. `seen(store, key, now)` answers
 * "did I already process this?"; `recall(store, key, now)` returns the cached
 * result so the duplicate request gets the SAME response the original produced
 * rather than re-running the side effect. `remember(store, key, value, now)`
 * records the key + its result after the first run.
 *
 * Two eviction policies keep the store bounded, both injected at `initStore`:
 *
 *   - **`ttlMs`** — an entry expires `ttlMs` after the `atMs` it was remembered
 *     at. `seen` / `recall` treat an expired entry as absent; `evictExpired`
 *     (and every `remember`) physically drops it. Without a TTL, entries live
 *     until evicted by capacity. The cutoff is half-open: an entry exactly
 *     `ttlMs` old is expired (`age >= ttlMs` drops it), matching `rate-limit`'s
 *     window edge — a key remembered at `t` no longer counts at `t + ttlMs`.
 *   - **`capacity`** — at most `capacity` entries are retained. When a
 *     `remember` would push the count past `capacity` (after expiry eviction),
 *     the OLDEST entries by insertion `order` are dropped until the count fits.
 *     Without a capacity, the store grows unbounded (TTL alone bounds it).
 *
 * `order` is the insertion-order index that capacity eviction reads — the keys
 * oldest-first. It is the store's own LRU-by-insertion ledger, kept in lockstep
 * with `entries` so `entries` never needs to be sorted to find the oldest.
 *
 * **Overwrite semantics** (decided + pinned by tests): re-`remember`ing an
 * existing key is an UPDATE, not a no-op. It (1) overwrites `value`, (2)
 * refreshes `atMs` to the new `nowMs` — so the TTL clock restarts and a
 * frequently-seen key never expires — and (3) moves the key to the NEWEST
 * position in `order` — so capacity eviction treats a re-remembered key as
 * fresh, not as a stale candidate for eviction. This makes `remember` behave
 * like "touch": a key actively being re-seen is kept alive on both the TTL and
 * capacity axes.
 *
 * NOT exported from the package root — reached via the `@demlik/tea/idempotency`
 * subpath, same one-shape-per-package rule as `work-queue`, `rate-limit`, and
 * `do`.
 */

/**
 * A cached entry: the result `value` the original request produced and the
 * clock reading `atMs` it was remembered at. `atMs` is the TTL anchor — expiry
 * is measured from here, and a re-`remember` refreshes it. Both fields are
 * plain data so the whole store is trivially JSON-serializable into a
 * consumer's `Store<S>`.
 */
export interface IdempotencyEntry<V> {
  readonly value: V;
  readonly atMs: number;
}

/**
 * The dedupe store: a map of `key → entry`, an insertion-`order` ledger
 * (oldest-first) that capacity eviction reads, and the two optional bounds.
 *
 * `entries` and `order` are kept in lockstep — every key in `order` has an
 * entry and vice versa. `capacity` / `ttlMs` are carried on the store (not
 * passed per-op) so a single value fully describes the policy; a consumer
 * persists the store and rehydrates the same bounds without re-deriving them.
 */
export interface IdempotencyStore<V> {
  readonly entries: Readonly<Record<string, IdempotencyEntry<V>>>;
  readonly order: readonly string[];
  readonly capacity?: number;
  readonly ttlMs?: number;
}

/**
 * Create an empty store. `capacity` and `ttlMs` are both optional — omit both
 * for an unbounded cache, supply either or both to bound by count, age, or
 * both. Stored on the returned value so every later op reads the policy off
 * the store rather than from a re-passed argument.
 */
export function initStore<V>(opts?: {
  capacity?: number;
  ttlMs?: number;
}): IdempotencyStore<V> {
  return {
    entries: {},
    order: [],
    capacity: opts?.capacity,
    ttlMs: opts?.ttlMs,
  };
}

/**
 * Whether `entry` (remembered at `entry.atMs`) is expired at `nowMs` under
 * `ttlMs`. Half-open: an entry exactly `ttlMs` old is expired (`age >= ttlMs`),
 * matching `rate-limit`'s window-edge cutoff. A `nowMs` before `atMs` (clock
 * skewed backwards) yields a negative age — never expired, the safe direction
 * (a duplicate is still deduped rather than re-run). When `ttlMs` is undefined
 * the entry never expires by age.
 */
function isExpired<V>(
  entry: IdempotencyEntry<V>,
  nowMs: number,
  ttlMs: number | undefined,
): boolean {
  if (ttlMs === undefined) return false;
  return nowMs - entry.atMs >= ttlMs;
}

/**
 * True iff `key` is present AND not expired at `nowMs`. This is the dedupe
 * predicate: a webhook / retried message / repeated action whose key returns
 * `true` has already been processed and should be short-circuited (paired with
 * `recall` to return the original result). PURE — reads only, never mutates.
 */
export function seen<V>(
  store: IdempotencyStore<V>,
  key: string,
  nowMs: number,
): boolean {
  const entry = store.entries[key];
  if (entry === undefined) return false;
  return !isExpired(entry, nowMs, store.ttlMs);
}

/**
 * The cached `value` for `key` if present and unexpired at `nowMs`, else
 * `undefined`. Use after `seen` returns `true` to replay the original result to
 * a duplicate request. An expired entry reads as absent (returns `undefined`)
 * even though it is physically still in `entries` until the next `remember` /
 * `evictExpired` drops it. PURE — reads only, never mutates.
 */
export function recall<V>(
  store: IdempotencyStore<V>,
  key: string,
  nowMs: number,
): V | undefined {
  const entry = store.entries[key];
  if (entry === undefined || isExpired(entry, nowMs, store.ttlMs))
    return undefined;
  return entry.value;
}

/**
 * Drop every entry expired at `nowMs` (older than `ttlMs`). Returns a NEW store
 * with the survivors; `order` is rebuilt to drop the same keys, preserving the
 * relative insertion order of the survivors. A no-TTL store returns an
 * equivalent store (nothing ages out). PURE — the input store is never mutated.
 */
export function evictExpired<V>(
  store: IdempotencyStore<V>,
  nowMs: number,
): IdempotencyStore<V> {
  if (store.ttlMs === undefined) return store;
  const nextEntries: Record<string, IdempotencyEntry<V>> = {};
  const nextOrder: string[] = [];
  // Walk `order` (not `Object.keys`) so the surviving order ledger keeps the
  // exact relative insertion order capacity eviction depends on.
  for (const key of store.order) {
    const entry = store.entries[key];
    if (entry === undefined) continue; // defensive: order/entries kept in lockstep
    if (isExpired(entry, nowMs, store.ttlMs)) continue;
    nextEntries[key] = entry;
    nextOrder.push(key);
  }
  return { ...store, entries: nextEntries, order: nextOrder };
}

/**
 * Record `key → value` at `nowMs`, then enforce both bounds. PURE — returns a
 * new store; the input is untouched.
 *
 * Order of operations (each step matters):
 *   1. **Expiry eviction** — drop everything older than `ttlMs` first, so an
 *      expired key never occupies a capacity slot the new entry could take, and
 *      a stale entry under the same `key` is cleared before the overwrite.
 *   2. **Insert / overwrite** — write the new entry. If `key` already exists,
 *      this is an UPDATE: `value` is overwritten, `atMs` is refreshed to
 *      `nowMs` (restarting the TTL clock), and the key is moved to the NEWEST
 *      position in `order` (removed from wherever it sat, appended at the end).
 *      See the module-level "Overwrite semantics" note.
 *   3. **Capacity eviction** — if the entry count now exceeds `capacity`, drop
 *      the OLDEST keys by `order` until the count fits. Because step 2 moves a
 *      re-remembered key to the newest position, an actively re-seen key is
 *      never the eviction victim.
 */
export function remember<V>(
  store: IdempotencyStore<V>,
  key: string,
  value: V,
  nowMs: number,
): IdempotencyStore<V> {
  // Step 1 — expire first so stale entries free capacity slots before insert.
  const pruned = evictExpired(store, nowMs);

  // Step 2 — insert/overwrite. Drop any prior position of `key` from order,
  // then append it as newest. `delete` on a fresh shallow copy keeps the input
  // store untouched (invariant 1).
  const nextEntries: Record<string, IdempotencyEntry<V>> = {
    ...pruned.entries,
  };
  nextEntries[key] = { value, atMs: nowMs };
  const nextOrder = pruned.order.filter((k) => k !== key);
  nextOrder.push(key);

  // Step 3 — capacity eviction. Drop oldest (front of `order`) until the count
  // fits. `capacity <= 0` evicts everything just inserted down to the bound;
  // `undefined` capacity skips eviction entirely.
  if (store.capacity !== undefined) {
    while (nextOrder.length > store.capacity) {
      const oldest = nextOrder.shift();
      if (oldest === undefined) break; // order emptied — nothing left to evict
      delete nextEntries[oldest];
    }
  }

  return { ...store, entries: nextEntries, order: nextOrder };
}
