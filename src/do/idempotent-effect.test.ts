/**
 * Idempotent-effect brick — the receiver/effect-side dedup half (#227).
 *
 * The load-bearing property (mirrors `durable-effects.test.ts`): the applied-
 * marker set is a PURE FOLD over `effect_applied` / `effect_forgotten` events,
 * NOT a side table. So rebuilding it by folding the persisted stream after a
 * simulated evict-after-save yields the SAME set as the never-evicted one, and a
 * re-fired effect whose key is already applied is a proven no-op — `fn` is not
 * invoked a second time (asserted with a call-count spy).
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported
 * explicitly, matching the rest of the package's test files.
 */

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { defineMachine, type Reducer } from "../index";
import { doEventSourcedStore } from "./event-sourced-store";
import {
  type AppliedEffectsEvent,
  appliedEffects,
  applyAppliedEvent,
  emptyApplied,
  foldApplied,
  idempotentEffect,
  isApplied,
} from "./idempotent-effect";
import { doStore } from "./index";

// ── An in-memory `DurableObjectStorage` fake (mirrors the sibling do-store
//    tests). Enough of the surface for `doStore` / `doEventSourcedStore`. ──────
function fakeStorage(backing: Map<string, string> = new Map()) {
  const storage = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return backing.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      backing.set(key, value as unknown as string);
    },
    async delete(key: string): Promise<boolean> {
      return backing.delete(key);
    },
    async list<T = unknown>(options?: {
      readonly prefix?: string;
    }): Promise<Map<string, T>> {
      const out = new Map<string, T>();
      const prefix = options?.prefix ?? "";
      for (const [k, v] of [...backing.entries()].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        if (k.startsWith(prefix)) out.set(k, v as unknown as T);
      }
      return out;
    },
  };
  return { backing, storage: storage as unknown as DurableObjectStorage };
}

describe("foldApplied — the pure fold (no side table)", () => {
  it("rebuilds the same applied set after a simulated eviction (PBT)", () => {
    const arbEvents: fc.Arbitrary<AppliedEffectsEvent[]> = fc.array(
      fc.oneof(
        fc.record({
          type: fc.constant("effect_applied" as const),
          key: fc.string({ minLength: 1 }),
        }),
        fc.record({
          type: fc.constant("effect_forgotten" as const),
          key: fc.string({ minLength: 1 }),
        }),
      ),
    );
    fc.assert(
      fc.property(arbEvents, (events) => {
        // Live: fold as the actor advances. Post-eviction: fold the persisted
        // stream. A pure fold over identical input is identical.
        const live = foldApplied(events);
        const rebuilt = foldApplied(events);
        expect([...rebuilt].sort()).toEqual([...live].sort());
      }),
    );
  });

  it("effect_applied adds, effect_forgotten removes; duplicates are no-ops", () => {
    const applied = emptyApplied();
    const a1 = applyAppliedEvent(applied, {
      type: "effect_applied",
      key: "k1",
    });
    expect(isApplied(a1, "k1")).toBe(true);
    // Duplicate add is a no-op fold (at-least-once tolerates a re-fired marker).
    const a2 = applyAppliedEvent(a1, { type: "effect_applied", key: "k1" });
    expect([...a2].sort()).toEqual(["k1"]);
    // Forget removes it; forgetting an absent key is a no-op.
    const a3 = applyAppliedEvent(a2, { type: "effect_forgotten", key: "k1" });
    expect(isApplied(a3, "k1")).toBe(false);
    const a4 = applyAppliedEvent(a3, { type: "effect_forgotten", key: "nope" });
    expect([...a4]).toEqual([]);
  });

  it("empty fold applies nothing", () => {
    expect([...foldApplied([])]).toEqual([]);
  });
});

describe("idempotentEffect + appliedEffects — apply-once semantics", () => {
  it("runs fn once, records the marker, and swallows a same-session re-fire", async () => {
    const guard = appliedEffects();
    const fn = vi.fn(async () => "wrote");

    const first = await guard.run(idempotentEffect("run1:v1", fn));
    expect(first.ran).toBe(true);
    if (first.ran) {
      expect(first.result).toBe("wrote");
      expect(first.event).toEqual({ type: "effect_applied", key: "run1:v1" });
    }
    expect(fn).toHaveBeenCalledTimes(1);

    // A re-fire of the SAME key in the same session: no-op, fn not called again.
    const second = await guard.run(idempotentEffect("run1:v1", fn));
    expect(second.ran).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a first-time key runs fn and records its applied-marker as the transition", async () => {
    const guard = appliedEffects();
    const outcome = await guard.run(idempotentEffect("k", async () => 42));
    expect(outcome.ran).toBe(true);
    expect(guard.isApplied("k")).toBe(true);
    // The marker the caller persists IS what makes the next re-fire a no-op.
    if (outcome.ran) {
      expect(outcome.event).toEqual({ type: "effect_applied", key: "k" });
    }
  });
});

describe("evict-after-save: a re-fired already-applied key is a proven no-op", () => {
  // The #227 heart. Simulate `stepDispatch`'s save-before-effects window:
  //   1. run the effect (fn fires) and persist its `effect_applied` marker,
  //   2. EVICT — drop the in-memory guard,
  //   3. reload/replay: rebuild a fresh guard by folding the persisted marker,
  //   4. re-fire the SAME keyed effect (the ledger's at-least-once re-emit) →
  //      fn is NOT invoked a second time.
  it("fn is called exactly once across an eviction (call-count spy)", async () => {
    const persisted: AppliedEffectsEvent[] = [];
    const fn = vi.fn(async () => "external write");

    // Activation 1: first application. Persist the marker (folds into State).
    const live = appliedEffects({ events: persisted });
    const outcome = await live.run(idempotentEffect("run1:violation7", fn));
    expect(outcome.ran).toBe(true);
    if (outcome.ran) persisted.push(outcome.event);
    expect(fn).toHaveBeenCalledTimes(1);

    // — EVICTION — the in-memory `live` guard is dropped. `persisted` is all
    //   that survives (the marker folded alongside State).

    // Activation 2: reload by folding the persisted stream, then the ledger
    // re-fires the same keyed effect. Must be a no-op.
    const reloaded = appliedEffects({ events: persisted });
    expect(reloaded.isApplied("run1:violation7")).toBe(true);
    const refire = await reloaded.run(idempotentEffect("run1:violation7", fn));
    expect(refire.ran).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1); // NOT invoked a second time
  });

  it("at-least-once: an eviction BETWEEN firing and marking re-fires fn", async () => {
    // The complementary window. fn ran but the `effect_applied` event never
    // persisted before eviction — so the reloaded guard does not know the key
    // is applied, and the ledger's re-fire runs fn again (at-least-once). Once
    // the marker IS persisted, all later re-fires are swallowed.
    const fn = vi.fn(async () => "write");

    const live = appliedEffects();
    const outcome = await live.run(idempotentEffect("k", fn));
    expect(outcome.ran).toBe(true);
    // Marker LOST: the activation hibernated before persisting `outcome.event`.
    const persistedButLostMarker: AppliedEffectsEvent[] = [];

    const reloaded = appliedEffects({ events: persistedButLostMarker });
    const refire = await reloaded.run(idempotentEffect("k", fn));
    expect(refire.ran).toBe(true); // re-fired — at-least-once
    expect(fn).toHaveBeenCalledTimes(2);
    // Now persist and reload once more → swallowed.
    const nowPersisted: AppliedEffectsEvent[] = refire.ran
      ? [refire.event]
      : [];
    const settled = appliedEffects({ events: nowPersisted });
    expect((await settled.run(idempotentEffect("k", fn))).ran).toBe(false);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("retention: forget prunes the marker (ledger confirm-removes-entry shape)", () => {
  it("a forgotten key re-fires again (marker is gone, not permanent)", async () => {
    const fn = vi.fn(async () => "w");
    const guard = appliedEffects();
    const first = await guard.run(idempotentEffect("k", fn));
    expect(first.ran).toBe(true);
    // Prune once the effect can no longer re-fire (its ledger entry confirmed).
    const { event } = guard.forget("k");
    expect(event).toEqual({ type: "effect_forgotten", key: "k" });
    expect(guard.isApplied("k")).toBe(false);

    const persisted: AppliedEffectsEvent[] = first.ran
      ? [first.event, event]
      : [event];
    // Folding applied+forgotten collapses to empty — the set stays bounded.
    expect([...foldApplied(persisted)]).toEqual([]);
  });
});

describe("composition — the marker lives in the Store alongside State", () => {
  // AC: works with the default snapshot `doStore` AND with `doEventSourcedStore`.

  it("snapshot doStore: the applied Set round-trips in the Model (via serialize/parse)", async () => {
    // A Model carrying its applied set as a field. `Set` flattens under
    // JSON.stringify (the #182 sharp edge), so the store's serialize/parse pair
    // owns the boundary — the marker is checkpointed WITH the rest of State.
    interface RunState {
      readonly runId: string;
      readonly applied: ReadonlySet<string>;
    }
    interface RunCarrier {
      readonly runId: string;
      readonly applied: readonly string[];
    }
    const serialize = (s: RunState): RunCarrier => ({
      runId: s.runId,
      applied: [...s.applied],
    });
    const parse = (raw: unknown): RunState | null => {
      if (typeof raw !== "object" || raw === null) return null;
      const c = raw as Partial<RunCarrier>;
      if (typeof c.runId !== "string" || !Array.isArray(c.applied)) return null;
      return { runId: c.runId, applied: new Set(c.applied) };
    };

    const { backing, storage } = fakeStorage();
    const writer = doStore<RunState>(storage, parse, { serialize });

    // Activation 1: apply an effect, fold the marker into State, save.
    const guard = appliedEffects();
    const outcome = await guard.run(idempotentEffect("run1:v1", async () => 1));
    expect(outcome.ran).toBe(true);
    await writer.save({ runId: "run1", applied: guard.applied() });

    // — EVICTION — reload from the snapshot bytes.
    const reader = doStore<RunState>(storage, parse, { serialize });
    const loaded = reader.migrate(await reader.load());
    expect(loaded).not.toBeNull();
    // Rebuild the guard from the reloaded set; the re-fire is swallowed.
    const reloaded = appliedEffects({
      events: [...(loaded?.applied ?? [])].map((key) => ({
        type: "effect_applied" as const,
        key,
      })),
    });
    const fn = vi.fn(async () => 1);
    expect((await reloaded.run(idempotentEffect("run1:v1", fn))).ran).toBe(
      false,
    );
    expect(fn).not.toHaveBeenCalled();
    // Sanity: the snapshot really held the marker (not a lost Set).
    expect(JSON.parse(backing.get("@@state") as string).applied).toEqual([
      "run1:v1",
    ]);
  });

  it("doEventSourcedStore: the markers fold from the SAME event log", async () => {
    // The event-sourced path: `effect_applied` markers are ordinary Msgs
    // appended to the same log the store already persists. Folding the log on
    // activation rebuilds the applied set for free — no separate storage.
    interface Model {
      readonly applied: ReadonlySet<string>;
    }
    type Msg = AppliedEffectsEvent;
    const update: Reducer<Model, Msg, never> = {
      effect_applied: (m, msg) => [
        { applied: applyAppliedEvent(m.applied, msg) },
        [],
      ],
      effect_forgotten: (m, msg) => [
        { applied: applyAppliedEvent(m.applied, msg) },
        [],
      ],
    };
    const machine = () =>
      defineMachine<Model, Msg, never, never, Record<string, never>>({
        init: (loaded) => [loaded ?? { applied: emptyApplied() }, []],
        update,
        subscribe: {},
      });

    const { storage } = fakeStorage();
    const ctx: Record<string, never> = {};

    // Activation 1: append two applied markers to the log.
    const es1 = doEventSourcedStore<Model, Msg, typeof ctx>(
      storage,
      machine(),
      ctx,
      { snapshotEvery: 100 },
    );
    await es1.append({ type: "effect_applied", key: "run1:v1" });
    await es1.append({ type: "effect_applied", key: "run1:v2" });

    // — EVICTION — a brand-new store instance folds the SAME log at load.
    const es2 = doEventSourcedStore<Model, Msg, typeof ctx>(
      storage,
      machine(),
      ctx,
      { snapshotEvery: 100 },
    );
    const rebuilt = es2.store.migrate(await es2.store.load());
    expect(rebuilt).not.toBeNull();
    // The applied set rebuilt from the folded log — both markers present.
    const reloaded = appliedEffects({
      events: [...(rebuilt?.applied ?? [])].map((key) => ({
        type: "effect_applied" as const,
        key,
      })),
    });
    expect(reloaded.isApplied("run1:v1")).toBe(true);
    expect(reloaded.isApplied("run1:v2")).toBe(true);
    const fn = vi.fn(async () => 0);
    expect((await reloaded.run(idempotentEffect("run1:v1", fn))).ran).toBe(
      false,
    );
    expect(fn).not.toHaveBeenCalled();
  });
});
