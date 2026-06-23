/**
 * @demlik/tea/idempotency/adapter — the verb seam over the pure idempotency ops.
 *
 * The functions in `./index` (`seen` / `recall` / `remember` / `evictExpired`
 * / `initStore`) are the BLESSED transitions, but their names and the
 * `IdempotencyStore<V>` shape they read/return are the STORE's vocabulary. A
 * consumer that owns an `IdempotencyStore<V>` slice (`idempotent-intake`,
 * `poller`) used to import those functions by name and call them directly, so
 * a change to the op surface — or to `IdempotencyStore`'s fields — cascaded to
 * every call site.
 *
 * `IdempotencyMemory<V>` is the insulating interface: five VERBS (`isSeen` /
 * `recall` / `remember` / `evict` / `init`) consumers depend on instead of the
 * raw functions. The verbs keep the ops' pure contract — no I/O, no `Date.now`
 * (the clock is injected as `now`) — so a consumer folding the adapter through
 * its reducer stays inside invariant 2 (pure transitions). `isSeen` renames the
 * blessed `seen` predicate (a noun-y `seen` reads ambiguously as a slice field;
 * the verb form states the question it answers), and `evict` is the verb form
 * of `evictExpired`.
 *
 * `idempotencyMemory<V>()` is the canonical implementation, a thin binding of
 * the blessed ops. Because the verbs are the only surface consumers touch, an
 * `IdempotencyStore` shape change is absorbed HERE rather than at the consumer
 * call sites.
 *
 * INTERNAL seam (no public-API port): consumers import the adapter from this
 * subpath the same way they imported the ops. The ops remain exported from
 * `./index` for any call site that genuinely wants a function directly.
 */

import {
  evictExpired,
  type IdempotencyStore,
  initStore,
  recall,
  remember,
  seen,
} from "./index";

/**
 * The verb interface over an `IdempotencyStore<V>`. Each verb mirrors a blessed
 * op's pure contract but speaks the consumer's dedupe vocabulary, so the
 * consumer never names a store function or reaches into an `IdempotencyStore`
 * field it did not put there.
 */
export interface IdempotencyMemory<V> {
  /** Create an empty store, optionally bounded by `capacity` and/or `ttlMs`. */
  init(opts?: { capacity?: number; ttlMs?: number }): IdempotencyStore<V>;

  /** True iff `key` is present AND not expired at `now`. Read-only. */
  isSeen(store: IdempotencyStore<V>, key: string, now: number): boolean;

  /** The cached value for `key` if present and unexpired at `now`. Read-only. */
  recall(store: IdempotencyStore<V>, key: string, now: number): V | undefined;

  /** Record `key → value` at `now`, enforcing the store's bounds. Returns a new store. */
  remember(
    store: IdempotencyStore<V>,
    key: string,
    value: V,
    now: number,
  ): IdempotencyStore<V>;

  /** Drop every entry expired at `now`. Returns a new store. */
  evict(store: IdempotencyStore<V>, now: number): IdempotencyStore<V>;
}

/**
 * The canonical `IdempotencyMemory<V>`, binding each verb to its blessed op.
 * Pure and stateless — call once at module scope in a consumer and fold its
 * verbs through the reducer. An `IdempotencyStore` shape change is absorbed by
 * re-binding a verb here, not at the consumers.
 */
export function idempotencyMemory<V>(): IdempotencyMemory<V> {
  return {
    init: (opts) => initStore<V>(opts),
    isSeen: (store, key, now) => seen<V>(store, key, now),
    recall: (store, key, now) => recall<V>(store, key, now),
    remember: (store, key, value, now) => remember<V>(store, key, value, now),
    evict: (store, now) => evictExpired<V>(store, now),
  };
}
