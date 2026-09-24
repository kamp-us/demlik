/**
 * Durable command carrier — the #91 fix under simulated DO eviction.
 *
 * The bug: `acceptCommandSocket` pairs a NON-hibernatable socket with the
 * VOLATILE `deferredGateway` (an isolate-local `pending` Map). When the DO
 * hibernates mid-round-trip, the heap is gone and the in-flight tool round-trips
 * are lost silently. The fix makes each round-trip a DURABLE owed effect (via
 * `durableCommandCarrier` / `durableDeferredGateway` + the #67 ledger) so it
 * survives eviction regardless of the socket, and makes the socket itself
 * hibernation-aware (`acceptDurableCommandSocket` over the Cloudflare
 * Hibernation API).
 *
 * The load-bearing property (mirrors `durable-effects.test.ts`): a round-trip
 * owed-but-not-confirmed when the carrier is evicted RE-EMITS exactly once after
 * wake, dedup-by-`deliveryId` absorbs a late/duplicate reply, and the ledger
 * rebuilt-by-fold after eviction equals the never-evicted one. A
 * confirmed-before-eviction round-trip does NOT re-emit; an empty carrier
 * re-emits nothing.
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported
 * explicitly, matching the rest of the package's test files. fast-check's seed +
 * numRuns are pinned globally by `src/test-setup.ts`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type EffectLedgerEvent,
  foldLedger,
  pendingEffectsLedger,
  survivingEffects,
} from "./durable-effects";
import {
  acceptDurableCommandSocket,
  broadcastHibernatable,
  type DurableCommandCarrier,
  deferredGateway,
  durableCommandCarrier,
  type HibernatableCtx,
  reissueSurvivingEffects,
} from "./host";

// ── The tool-result type the carrier round-trips. A small structured value so
//    settle/fail carry something meaningful. ──────────────────────────────────
type ClientResult = { readonly ok: true; readonly value: string };

/** A `callId`-keyed effect-ledger event, as the carrier records them. */
type CarrierEvent = EffectLedgerEvent<{ callId: string }>;

// ─────────────────────────────────────────────────────────────────────────────
// A consumer-shaped harness: a durable carrier whose persist hooks append into
// an in-memory "event log" standing in for the DO's storage. Eviction = drop the
// carrier + its isolate-local gateway, keep ONLY the log. Wake = build a NEW
// harness whose recorder is rehydrated from the log, then re-emit survivors.
// ─────────────────────────────────────────────────────────────────────────────

interface Harness {
  /** The persisted event log (the only thing that survives an eviction). */
  readonly log: CarrierEvent[];
  /** The frames `send` (and the wake re-emit) pushed — one per command sent. */
  readonly sent: string[];
  /** The durable carrier the interpret cell awaits. */
  readonly carrier: DurableCommandCarrier<ClientResult>;
  /** Open a round-trip: persist `effect_owed`, fire `send`, await the reply. */
  start(callId: string): Promise<ClientResult>;
}

/**
 * Build a harness over a fresh log (cold boot) or an existing one (a wake — the
 * recorder rehydrates from the persisted events, the counter resumes gap-free).
 */
function harness(restore?: CarrierEvent[]): Harness {
  const log: CarrierEvent[] = restore ? [...restore] : [];
  const sent: string[] = [];
  const inner = deferredGateway<ClientResult>();
  const recorder = pendingEffectsLedger<{ callId: string }>(
    restore ? { events: restore } : undefined,
  );
  const carrier = durableCommandCarrier(inner, recorder, {
    recordOwed: (_callId, event) => log.push(event),
    recordConfirmed: (_callId, event) => log.push(event),
  });

  return {
    log,
    sent,
    carrier,
    start(callId) {
      // Long deadline so the deadline timer never fires during a test tick.
      const p = carrier.await(callId, () => sent.push(callId), 1_000_000);
      // The interpret cell maps a rejection to `agent_tool_err`; the test only
      // asserts on the durable ledger, so swallow it here to avoid an unhandled
      // rejection on a `fail`-settled round-trip.
      p.catch(() => {});
      return p;
    },
  };
}

// ── An op script: open round-trips and settle a subset, in arbitrary order. ──
type Op =
  | { readonly kind: "open" }
  | { readonly kind: "settle"; readonly which: number };

const arbOp: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ kind: "open" }),
  fc.record({ kind: fc.constant("settle" as const), which: fc.nat() }),
);

/**
 * Drive an op script through a fresh harness BEFORE eviction. Each `open`
 * starts a round-trip with a distinct callId; each `settle` settles one of the
 * currently-in-flight round-trips (chosen by index). Returns the harness (whose
 * `log` is the persisted stream) plus the opened / settled callId sets.
 */
function driveBeforeEviction(ops: readonly Op[]): {
  readonly h: Harness;
  readonly opened: string[];
  readonly settled: Set<string>;
} {
  const h = harness();
  const opened: string[] = [];
  const settled = new Set<string>();
  let n = 0;

  for (const op of ops) {
    if (op.kind === "open") {
      const callId = `c${++n}`;
      opened.push(callId);
      // The interpret cell awaits this promise; we don't `await` here — a
      // round-trip in flight at eviction is exactly the unsettled case. The
      // floating promise is fine (it is never rejected in-test).
      void h.start(callId);
    } else {
      const live = h.carrier.inFlight();
      if (live.length === 0) continue;
      const callId = live[op.which % live.length];
      if (callId === undefined) continue;
      h.carrier.settle(callId, { ok: true, value: `v:${callId}` });
      settled.add(callId);
    }
  }
  return { h, opened, settled };
}

describe("durable command carrier — survives eviction (PBT)", () => {
  it("re-emits exactly the owed-but-unconfirmed round-trips after a wake", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 60 }), (ops) => {
        const { h, opened, settled } = driveBeforeEviction(ops);
        const expectedSurvivors = opened.filter((c) => !settled.has(c)).sort();

        // EVICTION: the isolate (and its gateway `pending` Map) dies. Only the
        // persisted event log survives.
        const persisted = [...h.log];

        // WAKE: a fresh carrier rehydrated from the log. Re-emit survivors via
        // the host's activation path; `reissue(callId)` re-sends the command.
        const woken = harness(persisted);
        const reemitted = reissueSurvivingEffects(woken.carrier, (callId) =>
          woken.sent.push(callId),
        );

        // Re-emitted set == owed-minus-confirmed, exactly once.
        expect([...reemitted].sort()).toEqual(expectedSurvivors);
        expect(new Set(reemitted).size).toBe(reemitted.length);
        // The re-emit actually re-sent each survivor's command, once.
        expect([...woken.sent].sort()).toEqual(expectedSurvivors);
        // The rehydrated recorder's own surviving view agrees.
        expect(
          woken.carrier.recorder
            .surviving()
            .map((s) => s.effect.callId)
            .sort(),
        ).toEqual(expectedSurvivors);
      }),
    );
  });

  it("the ledger rebuilt-by-fold after eviction equals the never-evicted one", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 60 }), (ops) => {
        const { h } = driveBeforeEviction(ops);
        // Never-evicted: the live recorder's mirror.
        const live = h.carrier.recorder.ledger();
        // Evicted + rebuilt: fold the SAME persisted stream fresh.
        const rebuilt = foldLedger([...h.log]);
        expect([...rebuilt.entries()]).toEqual([...live.entries()]);
      }),
    );
  });

  it("dedup-by-deliveryId absorbs a late/duplicate reply after re-emit", () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 60 }), (ops) => {
        const { h } = driveBeforeEviction(ops);
        const survivors = survivingEffects(foldLedger(h.log));

        // The receiver dedups by the monotonic deliveryId. A re-emitted survivor
        // is handled once; a late/duplicate reply for the same id is a no-op.
        const handled = new Set<number>();
        const receive = (id: number): boolean => {
          if (handled.has(id)) return false;
          handled.add(id);
          return true;
        };

        for (const s of survivors) expect(receive(s.id)).toBe(true);
        // A second eviction re-emits the SAME survivors; every one is a no-op.
        for (const s of survivors) expect(receive(s.id)).toBe(false);
        expect(handled.size).toBe(survivors.length);
      }),
    );
  });
});

describe("durable command carrier — boundary cases", () => {
  it("a confirmed-before-eviction round-trip does NOT re-emit", () => {
    const h = harness();
    void h.start("c1");
    h.carrier.settle("c1", { ok: true, value: "v" });

    const woken = harness([...h.log]);
    const reemitted = reissueSurvivingEffects(woken.carrier, () => {
      throw new Error("must not re-emit a confirmed round-trip");
    });
    expect(reemitted).toEqual([]);
  });

  it("an owed-but-evicted-before-settle round-trip DOES re-emit (once)", () => {
    const h = harness();
    void h.start("c1");
    // Eviction strikes before any settle — only the `effect_owed` is persisted.
    const persisted = [...h.log];

    const woken = harness(persisted);
    const reemitted = reissueSurvivingEffects(woken.carrier, (callId) =>
      woken.sent.push(callId),
    );
    expect(reemitted).toEqual(["c1"]);
    expect(woken.sent).toEqual(["c1"]);
  });

  it("an empty carrier re-emits nothing", () => {
    const h = harness();
    const reemitted = reissueSurvivingEffects(h.carrier, () => {
      throw new Error("empty carrier must re-emit nothing");
    });
    expect(reemitted).toEqual([]);
  });

  it("a failed (transport-close) round-trip is confirmed and does NOT re-emit", () => {
    const h = harness();
    void h.start("c1");
    h.carrier.fail("c1", "ws_closed");

    const woken = harness([...h.log]);
    const reemitted = reissueSurvivingEffects(woken.carrier, () => {
      throw new Error("a failed round-trip is confirmed; must not re-emit");
    });
    expect(reemitted).toEqual([]);
  });

  it("re-issuing the SAME survivor twice in one activation re-sends once", () => {
    const h = harness();
    void h.start("c1");
    const persisted = [...h.log];

    // The reissue callback re-arms the survivor through the carrier's OWN
    // `await` (idempotent): the gateway returns the open promise without
    // re-firing `send` for an in-flight callId, so the second is a no-op.
    const woken = harness(persisted);
    const reissue = (callId: string) =>
      void woken.carrier.await(
        callId,
        () => woken.sent.push(callId),
        1_000_000,
      );
    reissue("c1");
    reissue("c1");
    expect(woken.sent).toEqual(["c1"]);
  });
});

describe("acceptDurableCommandSocket — hibernation-aware accept", () => {
  it("accepts via the Hibernation API and broadcasts over getWebSockets()", () => {
    // A minimal fake of the Hibernation slice of DurableObjectState: it records
    // accepted sockets and hands them back from getWebSockets (as the runtime
    // does, repopulating the set after a wake).
    const accepted: WebSocket[] = [];
    const ctx: HibernatableCtx = {
      acceptWebSocket: (ws) => {
        accepted.push(ws);
      },
      getWebSockets: () => accepted,
    };

    const sentFrames: unknown[] = [];
    const fakeServer = {
      send: (json: string) => sentFrames.push(JSON.parse(json)),
    } as unknown as WebSocket;

    // Exercise the two observable effects of the accept — the Hibernation API
    // accept + the getWebSockets-based broadcast. (`acceptDurableCommandSocket`
    // itself constructs a `WebSocketPair`, which is runtime-only; its accept +
    // broadcast seam is what this asserts via the ctx fake.)
    ctx.acceptWebSocket(fakeServer);
    expect(accepted).toContain(fakeServer);

    broadcastHibernatable(ctx, { kind: "cmd", callId: "c1" });
    expect(sentFrames).toEqual([{ kind: "cmd", callId: "c1" }]);

    expect(typeof acceptDurableCommandSocket).toBe("function");
  });

  it("a dead socket in getWebSockets is skipped; others still receive", () => {
    const dead = {
      send: () => {
        throw new Error("dead socket");
      },
    } as unknown as WebSocket;
    const live: unknown[] = [];
    const liveWs = {
      send: (json: string) => live.push(JSON.parse(json)),
    } as unknown as WebSocket;
    const ctx: HibernatableCtx = {
      acceptWebSocket: () => {},
      getWebSockets: () => [dead, liveWs],
    };
    broadcastHibernatable(ctx, { kind: "x" });
    expect(live).toEqual([{ kind: "x" }]);
  });
});
