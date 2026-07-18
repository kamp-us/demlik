/**
 * @demlik/tea/do — the durable pending-effects ledger (substrate primitive #1).
 *
 * Durable *state* and durable *effects* are different problems. An
 * event-sourced actor rebuilds its STATE by folding the event log
 * (`doEventSourcedStore`, sibling file). But an outbound side effect — a tool
 * round-trip, a message to a sibling grain — is fire-and-forget: if the actor
 * interprets the `Cmd` inside an activation that hibernates mid-flight, the
 * effect is lost, yet nothing in the replayed state records that it is still
 * OWED. This is the one real tax of the event-sourced-virtual-actor target
 * (ADR 0003 primitive #1): "I owe this effect" must itself be part of the
 * folded state.
 *
 * Akka's classic `AtLeastOnceDelivery` solves it with a ledger of unconfirmed
 * deliveries kept AS PART OF the persisted state: each `deliver` adds an entry
 * keyed by a monotonic `deliveryId`; each `confirmDelivery` removes it. On
 * recovery the ledger is rebuilt from the SAME events, and any surviving entry
 * is re-sent. At-least-once ⇒ a confirmed-but-not-yet-persisted delivery WILL
 * be re-sent after a crash, so the receiver must deduplicate by id.
 *
 * ## The load-bearing rule (do not violate)
 *
 * The ledger is a PURE FOLD over the same kind of event stream the actor
 * already replays — it is **NOT** a separately-persisted side table:
 *
 *   - `effect_owed`     — `{ id, effect }` ADDS an entry to the ledger.
 *   - `effect_confirmed`— `{ id }`         REMOVES the entry.
 *
 * `foldLedger(events)` is `events.reduce(applyEffectEvent, empty())` — the same
 * fold shape `replay` / `foldEvents` / the recorder use. Persist these two
 * events into the SAME log `doEventSourcedStore` already appends (they are just
 * Msg variants), and the ledger is rebuilt for free on the next activation:
 * `foldLedger(log)` after eviction equals `foldLedger(log)` never-evicted, by
 * construction (a pure fold over identical input).
 *
 * On activation (replay completion), `survivingEffects(ledger)` returns the
 * owed-but-unconfirmed entries to re-fire, ordered by their monotonic id. The
 * re-fire is a SIDE EFFECT DERIVED from the surviving ledger — never stored
 * separately, never fired during replay (recovery.md: add to the ledger during
 * recovery; let recovery-END re-emit the survivors).
 *
 * Anti-patterns this file refuses (mirroring durable-effects.md):
 *   - A side-table ledger persisted apart from the events. The events ARE the
 *     ledger; the Map is rebuilt by folding them.
 *   - Re-firing every historical effect during replay. Only `survivingEffects`
 *     (post-fold) re-emits.
 *   - Assuming the receiver gets each effect exactly once. At-least-once: dedup
 *     by `id` at the receiver (`hasOwed` / `isConfirmed` here are the sender's
 *     view; the receiver owns its own dedup).
 */

import type { Cmd } from "../index";

// ─────────────────────────────────────────────────────────────────────────────
// The two events the ledger folds. These are ordinary Msg variants — persist
// them into the same event log `doEventSourcedStore` appends, and the ledger
// rebuilds itself on the next activation with no extra storage.
// ─────────────────────────────────────────────────────────────────────────────

/** Monotonic, gap-free delivery id — the single correlation + dedup key. */
export type DeliveryId = number;

/**
 * An effect is now OWED: it has been decided but its delivery is not yet
 * confirmed. Adds `{ id → effect }` to the ledger when folded.
 *
 * Persist this BEFORE interpreting the effect (durable-effects.md rule:
 * "persist the intent before deliver"). A crash between persist and deliver is
 * fine — the surviving entry re-fires on activation. A crash before the persist
 * means the effect was never owed, so nothing is lost that the actor promised.
 */
export interface EffectOwed<E> extends Cmd<"effect_owed"> {
  readonly id: DeliveryId;
  readonly effect: E;
}

/**
 * An owed effect has been CONFIRMED delivered. Removes its entry from the
 * ledger when folded. Persist this BEFORE acting on the confirmation
 * ("persist the confirmation before confirmDelivery").
 */
export interface EffectConfirmed extends Cmd<"effect_confirmed"> {
  readonly id: DeliveryId;
}

/** The event union the ledger folds over. `E` is the consumer's effect type. */
export type EffectLedgerEvent<E> = EffectOwed<E> | EffectConfirmed;

// ─────────────────────────────────────────────────────────────────────────────
// The ledger itself — a pure value. Insertion-ordered by monotonic id, so
// `survivingEffects` re-emits in owed-order without a sort.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The pending-effects ledger: owed-but-unconfirmed effects keyed by their
 * monotonic delivery id. A pure value reconstructed by `foldLedger` — it is
 * never persisted on its own; the events are.
 *
 * `ReadonlyMap` preserves insertion order, which (because ids are appended
 * monotonically) is exactly id order — so iteration yields the survivors
 * oldest-first with no sort.
 */
export type PendingEffectsLedger<E> = ReadonlyMap<DeliveryId, E>;

/** A single surviving entry to re-emit: its id and the effect it owes. */
export interface OwedEffect<E> {
  readonly id: DeliveryId;
  readonly effect: E;
}

/** The empty ledger — the fold's seed (a fresh actor owes nothing). */
export function emptyLedger<E>(): PendingEffectsLedger<E> {
  return new Map<DeliveryId, E>();
}

/**
 * Apply ONE ledger event — the reducer at the heart of the fold.
 *
 *   - `effect_owed`      → add `{ id → effect }`.
 *   - `effect_confirmed` → remove `id` (no-op if already absent: a duplicate
 *     confirm, or a confirm for an id evicted with the actor — at-least-once
 *     tolerates both).
 *
 * Pure: returns a NEW ledger, never mutates the input — so folding the same
 * events twice (live and post-eviction) yields equal results, and a caller may
 * keep the prior ledger value.
 */
export function applyEffectEvent<E>(
  ledger: PendingEffectsLedger<E>,
  event: EffectLedgerEvent<E>,
): PendingEffectsLedger<E> {
  const next = new Map(ledger);
  switch (event.type) {
    case "effect_owed":
      next.set(event.id, event.effect);
      return next;
    case "effect_confirmed":
      next.delete(event.id);
      return next;
  }
}

/**
 * THE FOLD. Rebuild the ledger from an event stream — the same fold shape
 * `replay` uses for state. After a simulated eviction this is called over the
 * persisted log and yields a ledger byte-for-byte equal to the never-evicted
 * one, because a pure fold over identical input is identical.
 *
 * This is the function that proves "no side table": the ledger is `events`
 * reduced, nothing more.
 */
export function foldLedger<E>(
  events: Iterable<EffectLedgerEvent<E>>,
): PendingEffectsLedger<E> {
  let ledger = emptyLedger<E>();
  for (const event of events) ledger = applyEffectEvent(ledger, event);
  return ledger;
}

/**
 * RE-EMIT ON ACTIVATION. Given the rebuilt ledger, the owed-but-unconfirmed
 * effects to re-fire — ordered oldest-first by monotonic id. On a fresh /
 * fully-confirmed actor this is empty (nothing re-emitted).
 *
 * Idempotency is the RECEIVER's job: it must dedup by `id`, because
 * at-least-once means a re-emitted already-handled id WILL arrive again
 * (e.g. an effect confirmed in the activation that hibernated before the
 * `effect_confirmed` event was persisted). Re-firing the same id is therefore
 * a no-op AT THE RECEIVER, not here.
 */
export function survivingEffects<E>(
  ledger: PendingEffectsLedger<E>,
): readonly OwedEffect<E>[] {
  const out: OwedEffect<E>[] = [];
  for (const [id, effect] of ledger) out.push({ id, effect });
  return out;
}

/** Is this id still owed (unconfirmed) in the ledger? Sender-side view. */
export function isOwed<E>(
  ledger: PendingEffectsLedger<E>,
  id: DeliveryId,
): boolean {
  return ledger.has(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// pendingEffectsLedger — the stateful, monotonic-id-issuing recorder.
//
// The pure `foldLedger` is the contract; this is the ergonomic driver a host
// uses live. It owns the monotonic `deliveryId` (gap-free, shared across all
// destinations — durable-effects.md), emits the `effect_owed` / `effect_confirmed`
// events for the caller to PERSIST, and keeps an in-memory mirror folded from
// those same events so `survivingEffects` is available without a re-read.
//
// Mirrors `deferredGateway`'s factory shape: no clock / RNG captured; pure
// bookkeeping. The caller is responsible for persisting each returned event
// into the log (so the ledger survives eviction) and for actually interpreting
// the effect after the owed event is durable.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A live, monotonic-id-issuing ledger recorder.
 *
 *   - `owe(effect)` — allocate the next `deliveryId`, return the
 *     `effect_owed` event to PERSIST plus the allocated `id`. Folding the event
 *     into the recorder's mirror is done for you; the caller persists it.
 *   - `confirm(id)` — return the `effect_confirmed` event to PERSIST, and `true`
 *     iff the id was owed (a duplicate confirm returns `false` — the boolean is
 *     itself a dedup signal, exactly Akka `confirmDelivery`).
 *   - `surviving()` — the current owed-but-unconfirmed effects (for re-emit on
 *     activation).
 *   - `ledger()` — the current folded ledger value.
 *   - `lastId()` — the highest id issued (so a host can seed the counter from a
 *     rebuilt ledger after eviction; see `restore`).
 */
export interface PendingEffectsRecorder<E> {
  owe(effect: E): { id: DeliveryId; event: EffectOwed<E> };
  confirm(id: DeliveryId): { confirmed: boolean; event: EffectConfirmed };
  surviving(): readonly OwedEffect<E>[];
  ledger(): PendingEffectsLedger<E>;
  lastId(): DeliveryId;
}

/**
 * Build a live recorder. `restore` rehydrates it after an eviction: pass the
 * events read back from the log (or the rebuilt ledger's survivors) so the
 * monotonic counter resumes WITHOUT gaps and the mirror reflects the surviving
 * owed set. Omit `restore` for a fresh actor.
 *
 * Counter seeding rule: the next id is `max(seen ids) + 1`. Restoring only the
 * survivors is sufficient for correctness of re-emit, but to keep ids gap-free
 * across confirmed-and-pruned entries the host should pass `lastId` explicitly
 * when it has it (e.g. persisted alongside the snapshot). When only survivors
 * are known, the counter resumes from the highest surviving id — a confirmed id
 * higher than every survivor could in principle be reissued, so a host that
 * needs strict global monotonicity persists `lastId`.
 */
export function pendingEffectsLedger<E>(restore?: {
  readonly events?: Iterable<EffectLedgerEvent<E>>;
  readonly lastId?: DeliveryId;
}): PendingEffectsRecorder<E> {
  // Materialize the restore events ONCE — `restore.events` is only an
  // `Iterable`, so a single-use generator would be exhausted by `foldLedger`
  // and yield nothing on a second walk (seeding the counter to 0 and reissuing
  // colliding ids). Folding and counter-seeding both read this array.
  const events = restore?.events ? [...restore.events] : undefined;
  let mirror: PendingEffectsLedger<E> = events
    ? foldLedger(events)
    : emptyLedger<E>();

  // Seed the monotonic counter. Prefer an explicit `lastId` (gap-free across
  // pruned ids); else the highest id observed in the restore events; else the
  // highest surviving id; else 0 (fresh).
  let counter = restore?.lastId ?? 0;
  if (restore?.lastId === undefined && events) {
    for (const e of events) if (e.id > counter) counter = e.id;
  } else if (restore?.lastId === undefined) {
    for (const id of mirror.keys()) if (id > counter) counter = id;
  }

  return {
    owe(effect) {
      counter += 1;
      const id = counter;
      const event: EffectOwed<E> = { type: "effect_owed", id, effect };
      mirror = applyEffectEvent(mirror, event);
      return { id, event };
    },
    confirm(id) {
      const confirmed = mirror.has(id);
      const event: EffectConfirmed = { type: "effect_confirmed", id };
      mirror = applyEffectEvent(mirror, event);
      return { confirmed, event };
    },
    surviving() {
      return survivingEffects(mirror);
    },
    ledger() {
      return mirror;
    },
    lastId() {
      return counter;
    },
  };
}
