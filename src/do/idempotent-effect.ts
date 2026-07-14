/**
 * @demlik/tea/do — the idempotent-effect brick (the receiver/effect-side dedup).
 *
 * ## The half this closes (do NOT re-implement the ledger)
 *
 * The runtime's `stepDispatch` step order is SAVE-BEFORE-EFFECTS: state is
 * persisted (`store.save(next)`) *before* its commands are interpreted
 * (`packages/tea/src/index.ts` — "Save-before-effects is the hard ordering;
 * tests pin it"). So a DO evicted after `save` but before an effect's result is
 * folded RE-FIRES that effect on the next activation.
 *
 * `durable-effects.ts` (sibling) owns the SENDER half of this: the at-least-once
 * `pendingEffectsLedger`, whose surviving owed entries `reissueSurvivingEffects`
 * re-fires on activation. Its own header states the contract this file fulfils:
 * "At-least-once ⇒ a confirmed-but-not-yet-persisted delivery WILL be re-sent
 * after a crash, so the receiver must deduplicate by id" and "the receiver owns
 * its own dedup." This module IS that receiver-side dedup — the piece that
 * upgrades the ledger's at-least-once re-fire to **effectively-once at the
 * external write**:
 *
 *   - ledger (`survivingEffects` / `reissueSurvivingEffects`) = at-least-once re-fire;
 *   - this brick (`idempotentEffect` + `appliedEffects`)      = effect-side dedup
 *   ⇒ together, effectively-once.
 *
 * It COMPLEMENTS the ledger; it does not re-implement it. The ledger keys owed
 * effects by a monotonic `DeliveryId` (its private sender bookkeeping); this
 * brick keys applied effects by a caller-supplied durable `EffectKey` (e.g.
 * `(runId, violationId)`), because dedup identity must be stable across the
 * re-fire — the same external write must resolve to the same key on every
 * activation, which a fresh monotonic id cannot guarantee.
 *
 * ## The load-bearing rule (mirrors `durable-effects.ts`)
 *
 * The applied-marker set is a PURE FOLD over the same kind of event stream the
 * actor already replays — it is **NOT** a separately-persisted side table:
 *
 *   - `effect_applied`   — `{ key }` ADDS the key to the applied set.
 *   - `effect_forgotten` — `{ key }` REMOVES it (retention — see below).
 *
 * `foldApplied(events)` is `events.reduce(applyAppliedEvent, empty)` — the same
 * fold shape `replay` / `foldLedger` use. This makes the marker live "alongside
 * State (single authority)" for BOTH persistence modes:
 *
 *   - `doEventSourcedStore`: persist the two events into the SAME log it already
 *     appends; folding the log on activation rebuilds the applied set for free.
 *   - default snapshot `doStore`: carry the `AppliedEffects` set as a field of
 *     the Model, round-tripped by the store's `serialize`/`parse` hooks (a `Set`
 *     flattens under `JSON.stringify`, exactly the `Map` sharp edge #182), so it
 *     is checkpointed with the rest of `S`.
 *
 * Either way the marker is folded/snapshotted with State, never a side channel.
 *
 * ## Ordering — why the marker is recorded AFTER `fn` (at-least-once, not at-most)
 *
 * `run` invokes `fn` and only THEN yields the `effect_applied` event to persist.
 * An eviction in the window between `fn` succeeding and that event being folded
 * re-fires the effect (at-least-once) — correct, because recording the marker
 * BEFORE `fn` would let a crash strand the marker with the write never made
 * (at-most-once ⇒ a silently-dropped effect). Once the marker is folded, every
 * subsequent re-fire of that key is a proven no-op: `fn` is not invoked again.
 * The ledger guarantees the re-fire; this brick swallows the duplicate.
 *
 * ## Retention — pruning mirrors the ledger's confirm-removes-entry (not a new policy)
 *
 * An applied-marker is only needed while its effect can still re-fire. The
 * ledger stops re-firing an effect once its `effect_confirmed` removes the owed
 * entry — so at that same point the marker is dead weight and is pruned via
 * `effect_forgotten` (`guard.forget(key)`), keeping the applied set bounded. This
 * deliberately reuses the ledger's confirm-removes-entry retention shape rather
 * than inventing a second policy (the #227 triage's one open question).
 */

import type { Cmd } from "../index";

// ─────────────────────────────────────────────────────────────────────────────
// The two events the applied-marker set folds. Ordinary `Cmd` (Msg) variants —
// persist them into the same log `doEventSourcedStore` appends, or carry the
// folded set in the snapshot Model; either way the set rebuilds with no side
// table. Mirrors `durable-effects.ts`'s `effect_owed`/`effect_confirmed`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The caller-supplied durable dedup identity for an effect — stable across the
 * re-fire (e.g. `` `${runId}:${violationId}` ``). Unlike the ledger's monotonic
 * `DeliveryId`, it is chosen by the domain so the SAME external write resolves
 * to the SAME key on every activation.
 */
export type EffectKey = string;

/** An effect keyed `key` has been APPLIED. Adds `key` to the set when folded. */
export interface EffectApplied extends Cmd<"effect_applied"> {
  readonly key: EffectKey;
}

/**
 * An applied-marker is no longer needed (its effect can no longer re-fire, e.g.
 * its ledger entry was confirmed) and may be pruned. Removes `key` when folded.
 */
export interface EffectForgotten extends Cmd<"effect_forgotten"> {
  readonly key: EffectKey;
}

/** The event union the applied-marker set folds over. */
export type AppliedEffectsEvent = EffectApplied | EffectForgotten;

// ─────────────────────────────────────────────────────────────────────────────
// The applied-marker set — a pure value reconstructed by `foldApplied`. Never
// persisted on its own; the events (or the snapshot that embeds it) are.
// ─────────────────────────────────────────────────────────────────────────────

/** The set of keys whose effect has been applied. A pure fold result. */
export type AppliedEffects = ReadonlySet<EffectKey>;

/** The empty applied set — the fold's seed (a fresh actor has applied nothing). */
export function emptyApplied(): AppliedEffects {
  return new Set<EffectKey>();
}

/**
 * Apply ONE event — the reducer at the heart of the fold.
 *
 *   - `effect_applied`   → add `key` (a duplicate add is a no-op — a re-fired
 *     already-applied key tolerated by at-least-once).
 *   - `effect_forgotten` → remove `key` (a no-op if already absent).
 *
 * Pure: returns a NEW set on change, never mutates the input — so folding the
 * same events twice (live and post-eviction) yields equal results.
 */
export function applyAppliedEvent(
  applied: AppliedEffects,
  event: AppliedEffectsEvent,
): AppliedEffects {
  switch (event.type) {
    case "effect_applied": {
      if (applied.has(event.key)) return applied;
      const next = new Set(applied);
      next.add(event.key);
      return next;
    }
    case "effect_forgotten": {
      if (!applied.has(event.key)) return applied;
      const next = new Set(applied);
      next.delete(event.key);
      return next;
    }
  }
}

/**
 * THE FOLD. Rebuild the applied set from an event stream — the same fold shape
 * `replay`/`foldLedger` use. After a simulated eviction this is called over the
 * persisted events and yields a set equal to the never-evicted one, because a
 * pure fold over identical input is identical. This is what proves "no side
 * table": the set is `events` reduced, nothing more.
 */
export function foldApplied(
  events: Iterable<AppliedEffectsEvent>,
): AppliedEffects {
  let applied = emptyApplied();
  for (const event of events) applied = applyAppliedEvent(applied, event);
  return applied;
}

/** Has this key's effect already been applied (folded into the set)? */
export function isApplied(applied: AppliedEffects, key: EffectKey): boolean {
  return applied.has(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// idempotentEffect — the effect descriptor: a durable key paired with the effect
// thunk. It is only a pairing; the `appliedEffects` guard decides whether to run
// it. Mirrors how the ledger's `owe(effect)` pairs a payload with its bookkeeping.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A keyed external effect. `key` is the durable dedup identity; `fn` is the
 * irreversible external write (HTTP write, DB upsert, finding/ticket publish).
 */
export interface IdempotentEffect<A> {
  readonly key: EffectKey;
  readonly fn: () => Promise<A> | A;
}

/**
 * Pair a durable `key` with an external effect `fn` — the brick's primary
 * surface. Run it through {@link appliedEffects}'s guard; a re-fire whose key is
 * already applied is a proven no-op (`fn` is not invoked a second time).
 */
export function idempotentEffect<A>(
  key: EffectKey,
  fn: () => Promise<A> | A,
): IdempotentEffect<A> {
  return { key, fn };
}

/**
 * The outcome of running a keyed effect through the guard. A boolean-discriminated
 * union so the skipped arm cannot carry a (never-produced) `result`/`event`:
 *
 *   - `ran: true`  — first application: `fn` ran, `result` is its value, and
 *     `event` is the `effect_applied` marker the caller MUST persist (fold into
 *     State) so future re-fires are swallowed.
 *   - `ran: false` — the key was already applied: `fn` was NOT invoked, the
 *     duplicate is swallowed, and there is no new event to persist.
 */
export type IdempotentOutcome<A> =
  | {
      readonly ran: true;
      readonly key: EffectKey;
      readonly result: A;
      readonly event: EffectApplied;
    }
  | { readonly ran: false; readonly key: EffectKey };

/**
 * A live guard over an applied-marker set. Mirrors `pendingEffectsLedger`'s
 * recorder shape: it keeps an in-memory mirror folded from the same events the
 * caller persists, so the dedup decision is available without a re-read.
 *
 *   - `run(effect)`   — apply-once: skip (no `fn`) if the key is already applied,
 *     else await `fn` and yield the `effect_applied` event to PERSIST.
 *   - `forget(key)`   — prune a marker once its effect can no longer re-fire;
 *     yields the `effect_forgotten` event to PERSIST.
 *   - `applied()`     — the current folded set.
 *   - `isApplied(key)`— convenience membership test against the mirror.
 */
export interface AppliedEffectsGuard {
  run<A>(effect: IdempotentEffect<A>): Promise<IdempotentOutcome<A>>;
  forget(key: EffectKey): { readonly event: EffectForgotten };
  applied(): AppliedEffects;
  isApplied(key: EffectKey): boolean;
}

/**
 * Build a live guard. `restore` rehydrates it after an eviction: pass the events
 * read back from the log (or the applied set carried in the reloaded snapshot,
 * as single-element `effect_applied` events) so the mirror reflects what was
 * already applied. Omit `restore` for a fresh actor.
 */
export function appliedEffects(restore?: {
  readonly events?: Iterable<AppliedEffectsEvent>;
}): AppliedEffectsGuard {
  let mirror: AppliedEffects = restore?.events
    ? foldApplied(restore.events)
    : emptyApplied();

  return {
    async run<A>(effect: IdempotentEffect<A>): Promise<IdempotentOutcome<A>> {
      // Already-applied ⇒ swallow the re-fire WITHOUT invoking `fn` — the proven
      // no-op the receiver owes the at-least-once ledger.
      if (mirror.has(effect.key)) {
        return { ran: false, key: effect.key };
      }
      // First application: run the effect, THEN record the marker (see the
      // ordering rationale in the module header — after, never before).
      const result = await effect.fn();
      const event: EffectApplied = { type: "effect_applied", key: effect.key };
      mirror = applyAppliedEvent(mirror, event);
      return { ran: true, key: effect.key, result, event };
    },
    forget(key: EffectKey): { readonly event: EffectForgotten } {
      const event: EffectForgotten = { type: "effect_forgotten", key };
      mirror = applyAppliedEvent(mirror, event);
      return { event };
    },
    applied(): AppliedEffects {
      return mirror;
    },
    isApplied(key: EffectKey): boolean {
      return mirror.has(key);
    },
  };
}
