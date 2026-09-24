/**
 * Durable pending-effects ledger — property + example tests.
 *
 * The load-bearing property (durable-effects.md / ADR 0003 #1): the ledger is a
 * PURE FOLD over `effect_owed` / `effect_confirmed` events, NOT a side table.
 * So rebuilding it by folding the persisted event stream after a simulated DO
 * eviction yields the SAME ledger as the never-evicted one, and every owed-but-
 * unconfirmed effect is re-emitted exactly once on activation (dedup-by-id makes
 * a re-sent already-handled id a no-op at the receiver).
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported
 * explicitly, matching the rest of the package's test files.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyEffectEvent,
  type EffectLedgerEvent,
  emptyLedger,
  foldLedger,
  isOwed,
  type PendingEffectsLedger,
  pendingEffectsLedger,
  survivingEffects,
} from "./durable-effects";

// ── The effect payload the ledger carries. A small structured value so equality
//    checks are meaningful (not just an id). ──────────────────────────────────
interface ToolCall {
  readonly callId: string;
}

// ── Arbitrary interleaving of owed/confirmed events. ────────────────────────
// We model an actor that issues monotonic owed ids and confirms some subset of
// them, in an arbitrary order. The recorder owns the monotonic id; the test
// drives `owe` / `confirm` through it so the event stream is well-formed (every
// confirmed id was previously owed). Confirming an id more than once and
// confirming a never-owed id are exercised separately (boundary tests below).

type Op =
  | { readonly kind: "owe" }
  | { readonly kind: "confirm"; readonly which: number };

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ kind: "owe" }),
  // `which` selects among currently-owed ids by index (mod, applied at run time).
  fc.record({ kind: fc.constant("confirm" as const), which: fc.nat() }),
);

/**
 * Replay an op script through a live recorder, collecting the exact event
 * stream the consumer would persist. Returns the stream plus the live ledger.
 */
function driveRecorder(ops: readonly Op[]): {
  readonly events: EffectLedgerEvent<ToolCall>[];
  readonly liveLedger: PendingEffectsLedger<ToolCall>;
} {
  const rec = pendingEffectsLedger<ToolCall>();
  const events: EffectLedgerEvent<ToolCall>[] = [];

  for (const op of ops) {
    if (op.kind === "owe") {
      // Distinct callId per owed event; the issued monotonic id makes it unique.
      const { id, event } = rec.owe({ callId: `c${rec.lastId() + 1}` });
      void id;
      events.push(event);
    } else {
      const owed = rec.surviving();
      if (owed.length === 0) continue; // nothing to confirm yet
      // biome-ignore lint/style/noNonNullAssertion: owed.length > 0 guarded above, so (which % length) is always a valid in-bounds index under noUncheckedIndexedAccess
      const target = owed[op.which % owed.length]!;
      const { event } = rec.confirm(target.id);
      events.push(event);
    }
  }
  return { events, liveLedger: rec.ledger() };
}

describe("foldLedger — the pure fold (no side table)", () => {
  it("rebuilds the same ledger after a simulated eviction (PBT)", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 60 }), (ops) => {
        const { events, liveLedger } = driveRecorder(ops);

        // SIMULATED EVICTION: the isolate dies; only the persisted event stream
        // survives. Rebuild the ledger by folding it — the same fold, fresh.
        const rebuilt = foldLedger(events);

        // The rebuilt ledger equals the never-evicted live one, by construction
        // (a pure fold over identical input).
        expect([...rebuilt.entries()]).toEqual([...liveLedger.entries()]);
      }),
    );
  });

  it("survivors after eviction == owed-but-unconfirmed, exactly once each", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 60 }), (ops) => {
        const { events } = driveRecorder(ops);

        const owedIds = new Set(
          events.filter((e) => e.type === "effect_owed").map((e) => e.id),
        );
        const confirmedIds = new Set(
          events.filter((e) => e.type === "effect_confirmed").map((e) => e.id),
        );
        const expectedSurviving = [...owedIds]
          .filter((id) => !confirmedIds.has(id))
          .sort((a, b) => a - b);

        const rebuilt = foldLedger(events);
        const survivors = survivingEffects(rebuilt);

        // Re-emitted set == owed-minus-confirmed.
        expect(survivors.map((s) => s.id)).toEqual(expectedSurviving);
        // Exactly once each — no duplicate ids in the re-emit set.
        expect(new Set(survivors.map((s) => s.id)).size).toBe(survivors.length);
        // Ordered oldest-first by monotonic id (no sort needed at the call site).
        const ids = survivors.map((s) => s.id);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
      }),
    );
  });

  it("re-emitting a survivor's id is a no-op at the receiver (dedup-by-id)", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 60 }), (ops) => {
        const { events } = driveRecorder(ops);
        const rebuilt = foldLedger(events);
        const survivors = survivingEffects(rebuilt);

        // The receiver dedups by id. Model it as a Set of handled ids: feeding
        // the SAME survivor twice processes it once.
        const handled = new Set<number>();
        const receive = (id: number): boolean => {
          if (handled.has(id)) return false; // duplicate → no-op
          handled.add(id);
          return true;
        };

        for (const s of survivors) expect(receive(s.id)).toBe(true);
        // Activation crashes again before confirms persist → re-emit the SAME
        // survivors. Every one is now a no-op.
        for (const s of survivors) expect(receive(s.id)).toBe(false);
        expect(handled.size).toBe(survivors.length);
      }),
    );
  });
});

describe("boundary cases", () => {
  it("empty ledger re-emits nothing", () => {
    const ledger = foldLedger<ToolCall>([]);
    expect(survivingEffects(ledger)).toEqual([]);
    expect([...ledger.entries()]).toEqual([]);
  });

  it("an effect owed-then-confirmed in the same activation does NOT re-emit", () => {
    const rec = pendingEffectsLedger<ToolCall>();
    const owe = rec.owe({ callId: "c1" });
    const conf = rec.confirm(owe.id);
    expect(conf.confirmed).toBe(true);

    // After eviction, fold the persisted stream: owed + confirmed → empty.
    const rebuilt = foldLedger([owe.event, conf.event]);
    expect(survivingEffects(rebuilt)).toEqual([]);
  });

  it("an effect owed-then-evicted-before-confirm DOES re-emit", () => {
    const rec = pendingEffectsLedger<ToolCall>();
    const owe = rec.owe({ callId: "c1" });
    // Eviction strikes BEFORE the confirm event is ever recorded/persisted.
    const rebuilt = foldLedger([owe.event]);
    expect(survivingEffects(rebuilt)).toEqual([
      { id: owe.id, effect: { callId: "c1" } },
    ]);
  });

  it("at-least-once: a confirm that never persisted re-emits the effect", () => {
    // The actor confirmed in-memory but hibernated before the `effect_confirmed`
    // event was persisted — so the log holds only `effect_owed`. The receiver
    // WILL see the effect again; dedup-by-id absorbs it.
    const rec = pendingEffectsLedger<ToolCall>();
    const owe = rec.owe({ callId: "c1" });
    rec.confirm(owe.id); // in-memory confirm, event NOT persisted

    const persisted: EffectLedgerEvent<ToolCall>[] = [owe.event]; // confirm lost
    const rebuilt = foldLedger(persisted);
    expect(survivingEffects(rebuilt).map((s) => s.id)).toEqual([owe.id]);
  });

  it("duplicate confirm is reported false; folding it twice is idempotent", () => {
    const rec = pendingEffectsLedger<ToolCall>();
    const owe = rec.owe({ callId: "c1" });
    expect(rec.confirm(owe.id).confirmed).toBe(true);
    expect(rec.confirm(owe.id).confirmed).toBe(false); // duplicate → false

    const conf = { type: "effect_confirmed", id: owe.id } as const;
    const once = foldLedger([owe.event, conf]);
    const twice = foldLedger([owe.event, conf, conf]);
    expect([...once.entries()]).toEqual([...twice.entries()]);
    expect([...once.entries()]).toEqual([]);
  });

  it("confirming a never-owed id is a no-op fold", () => {
    const ledger = applyEffectEvent(emptyLedger<ToolCall>(), {
      type: "effect_confirmed",
      id: 999,
    });
    expect([...ledger.entries()]).toEqual([]);
  });
});

describe("pendingEffectsLedger — live recorder", () => {
  it("issues gap-free monotonic ids", () => {
    const rec = pendingEffectsLedger<ToolCall>();
    const a = rec.owe({ callId: "a" });
    const b = rec.owe({ callId: "b" });
    const c = rec.owe({ callId: "c" });
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    expect(rec.lastId()).toBe(3);
  });

  it("isOwed reflects the live ledger; confirm removes", () => {
    const rec = pendingEffectsLedger<ToolCall>();
    const a = rec.owe({ callId: "a" });
    expect(isOwed(rec.ledger(), a.id)).toBe(true);
    rec.confirm(a.id);
    expect(isOwed(rec.ledger(), a.id)).toBe(false);
  });

  it("restore rehydrates survivors and resumes ids without gaps", () => {
    const rec = pendingEffectsLedger<ToolCall>();
    const a = rec.owe({ callId: "a" });
    const b = rec.owe({ callId: "b" });
    rec.confirm(a.id);
    const persisted = [
      a.event,
      b.event,
      { type: "effect_confirmed", id: a.id } as const,
    ];

    // Simulated activation: rebuild from the log + carry lastId across.
    const revived = pendingEffectsLedger<ToolCall>({
      events: persisted,
      lastId: rec.lastId(),
    });
    // b survives, a does not.
    expect(revived.surviving().map((s) => s.id)).toEqual([b.id]);
    // Next id continues past the highest issued — no reuse of a confirmed id.
    const c = revived.owe({ callId: "c" });
    expect(c.id).toBe(3);
  });

  it("restore from a single-use generator seeds the counter (no id reuse)", () => {
    const rec = pendingEffectsLedger<ToolCall>();
    const a = rec.owe({ callId: "a" });
    const b = rec.owe({ callId: "b" });
    rec.confirm(a.id);
    const persisted: readonly EffectLedgerEvent<ToolCall>[] = [
      a.event,
      b.event,
      { type: "effect_confirmed", id: a.id },
    ];

    // A generator is single-pass: a naive double walk of `events` (fold, then
    // counter-seed) would exhaust it on the first pass and seed the counter to
    // 0, reissuing colliding ids. No explicit `lastId`, so the counter must be
    // derived from the events themselves.
    function* once(): Generator<EffectLedgerEvent<ToolCall>> {
      yield* persisted;
    }
    const revived = pendingEffectsLedger<ToolCall>({ events: once() });

    // b still surviving from the fold.
    expect(revived.surviving().map((s) => s.id)).toEqual([b.id]);
    // Next id resumes past the highest id in the events — it must NOT collide
    // with the still-owed b (id 2) by restarting at 1.
    const c = revived.owe({ callId: "c" });
    expect(c.id).toBe(b.id + 1);
    expect(revived.surviving().map((s) => s.id)).toEqual([b.id, c.id]);
  });
});
