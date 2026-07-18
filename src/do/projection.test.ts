/**
 * @demlik/tea/do — CQRS projection seam tests (#69).
 *
 * The load-bearing contracts (projections.md / offset-tracking.md /
 * delivery-semantics.md):
 *
 *   1. REBUILD-EQUIVALENCE — a projection rebuilt from the (msg, model) stream
 *      equals the live view. Both are the same pure `apply` fold over the same
 *      ordered updates, so equality is by construction; the property guards the
 *      offset/driver plumbing around it.
 *   2. IDEMPOTENT APPLY / EXCLUSIVE OFFSET — re-presenting an update at/below the
 *      stored offset is a no-op (the at-least-once replay window). Resuming from
 *      a stored offset does not reprocess the last-applied event (the offset is
 *      EXCLUSIVE — never ±1).
 *   3. ONE MODEL, MANY PROJECTIONS — two projections over the same stream produce
 *      independent views; one's failure/reset does not corrupt the other.
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported
 * explicitly, matching the rest of the package's test files.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineMachine, type Reducer, run } from "../index";
import { arbMsg, arbMsgSequence, type MsgArbitraryTable } from "../pbt";
import { sseHub, sseProjection } from "./host";
import {
  driveProjections,
  type Projection,
  type ProjectionId,
  projectionRegistry,
  rebuildProjection,
  runProjection,
} from "./projection";

// ── The same tiny counter write model the es-store test uses. ───────────────
// State folds every Msg, so an arbitrary Msg sequence exercises a real fold.

interface State {
  readonly type: "counting";
  readonly count: number;
  readonly log: readonly string[];
}

type Msg =
  | { type: "inc"; by: number }
  | { type: "dec"; by: number }
  | { type: "reset" }
  | { type: "note"; text: string };

const update: Reducer<State, Msg, never> = {
  inc: (s, m) => [{ ...s, count: s.count + m.by }, []],
  dec: (s, m) => [{ ...s, count: s.count - m.by }, []],
  reset: (s) => [{ ...s, count: 0 }, []],
  note: (s, m) => [{ ...s, log: [...s.log, m.text] }, []],
};

function counter() {
  return defineMachine<State, Msg, never, never, Record<string, never>>({
    init: (loaded) => [loaded ?? { type: "counting", count: 0, log: [] }, []],
    update,
    subscribe: {},
  });
}

const ctx: Record<string, never> = {};

const INITIAL: State = { type: "counting", count: 0, log: [] };

const msgTable: MsgArbitraryTable<Msg> = {
  inc: fc.record({
    type: fc.constant<"inc">("inc"),
    by: fc.integer({ min: 1, max: 10 }),
  }),
  dec: fc.record({
    type: fc.constant<"dec">("dec"),
    by: fc.integer({ min: 1, max: 10 }),
  }),
  reset: fc.constant({ type: "reset" as const }),
  note: fc.record({
    type: fc.constant<"note">("note"),
    text: fc.string(),
  }),
};

const arbMsgs = (max: number) =>
  arbMsgSequence(arbMsg(msgTable), { minLength: 0, maxLength: max });

// ── Two example projections over the counter write model. ───────────────────

/**
 * COUNT-VIEW — an event-shaped projection. Accumulates a running tally by
 * folding each Msg INDEPENDENTLY of the write model's own count (so a bug that
 * accidentally reads `model.count` instead of folding events would show up as a
 * divergence under reset). Upsert, never blind increment: idempotent because the
 * exclusive-offset guard drops re-presented updates.
 */
interface CountView {
  readonly total: number;
  readonly notes: number;
}

function countProjection(
  sink: (v: CountView) => void,
): Projection<State, Msg, CountView> {
  return {
    id: { name: "count", key: "main" },
    initial: { total: 0, notes: 0 },
    apply(view, u) {
      const msg = u.msg;
      if (msg === null) return view; // boot update — event-shaped projection skips it
      switch (msg.type) {
        case "inc":
          return { ...view, total: view.total + msg.by };
        case "dec":
          return { ...view, total: view.total - msg.by };
        case "reset":
          return { ...view, total: 0 };
        case "note":
          return { ...view, notes: view.notes + 1 };
      }
    },
    emit: sink,
  };
}

/**
 * STATE-VIEW — a state-shaped projection. Mirrors the write model's count
 * directly off `update.model` (the "latest" read model). Distinct view, distinct
 * offset, distinct sink — registered alongside COUNT-VIEW on one registry.
 */
interface StateView {
  readonly count: number;
}

function stateProjection(
  sink: (v: StateView) => void,
): Projection<State, Msg, StateView> {
  return {
    id: { name: "state", key: "main" },
    initial: { count: 0 },
    apply(_view, u) {
      return { count: u.model.count };
    },
    emit: sink,
  };
}

// Build the ordered `(msg, model)` update stream a live run would observe:
// the boot update (msg = null, model = INITIAL) then one entry per applied Msg
// with the post-transition model. This is the oracle `rebuildProjection` folds.
function streamOf(msgs: readonly Msg[]): { msg: Msg | null; model: State }[] {
  const stream: { msg: Msg | null; model: State }[] = [
    { msg: null, model: INITIAL },
  ];
  let model = INITIAL;
  for (const m of msgs) {
    [model] = update[m.type](model, m as never);
    stream.push({ msg: m, model });
  }
  return stream;
}

// Drive a LIVE runtime through `driveProjections`, returning each projection's
// final view. This is the in-process equivalent of the host wiring
// `driveProjections(registry, runtime)`.
async function liveViews(
  msgs: readonly Msg[],
): Promise<{ count: CountView; state: StateView }> {
  const registry = projectionRegistry<State, Msg>();
  const countRunner = registry.register(countProjection(() => {}));
  const stateRunner = registry.register(stateProjection(() => {}));
  const runtime = run(counter(), { ctx });
  const detach = driveProjections(registry, runtime);
  await runtime.ready;
  for (const m of msgs) await runtime.dispatch(m);
  const out = { count: countRunner.view(), state: stateRunner.view() };
  detach();
  await runtime.stop();
  return out;
}

// ── Property 1: rebuilt-by-fold == live view. ───────────────────────────────

describe("Projection — rebuild-equivalence", () => {
  it("a view rebuilt from the (msg, model) stream equals the live view", async () => {
    await fc.assert(
      fc.asyncProperty(arbMsgs(30), async (msgs) => {
        const live = await liveViews(msgs);
        const stream = streamOf(msgs);

        const rebuiltCount = rebuildProjection(
          countProjection(() => {}),
          stream,
        );
        const rebuiltState = rebuildProjection(
          stateProjection(() => {}),
          stream,
        );

        expect(rebuiltCount.view()).toEqual(live.count);
        expect(rebuiltState.view()).toEqual(live.state);
      }),
      { numRuns: 50 },
    );
  });

  it("the count projection folds events, not the write model's count (independent derivation)", () => {
    // A run of inc/dec then reset: the write-model count is 0 after reset, and so
    // is the event-fold total — but they reach 0 via independent paths.
    const msgs: Msg[] = [
      { type: "inc", by: 5 },
      { type: "dec", by: 2 },
      { type: "note", text: "x" },
      { type: "reset" },
    ];
    const r = rebuildProjection(
      countProjection(() => {}),
      streamOf(msgs),
    );
    expect(r.view()).toEqual({ total: 0, notes: 1 });
  });

  // Regression for #197: rebuildProjection presented `updates[i]` at offset `i`
  // against a runner whose stored offset starts at 0, so `updates[0]` (offset 0)
  // was skipped by the exclusive-offset guard and the FIRST event was silently
  // dropped. This exercises the naive-consumer path the bug hit: a plain ordered
  // EVENT list (no boot prepend) — the first event MUST be folded.
  it("includes the FIRST event of a rebuild stream (no boot prepend) — #197", () => {
    // A single `inc by 7`: if `updates[0]` is dropped, the total is 0; it must be 7.
    const single = rebuildProjection(
      countProjection(() => {}),
      [{ msg: { type: "inc", by: 7 }, model: INITIAL }],
    );
    expect(single.view()).toEqual({ total: 7, notes: 0 });

    // And the first of several: the leading `note` must be counted, not skipped.
    const several = rebuildProjection(
      countProjection(() => {}),
      [
        { msg: { type: "note", text: "first" }, model: INITIAL },
        { msg: { type: "inc", by: 2 }, model: INITIAL },
        { msg: { type: "inc", by: 3 }, model: INITIAL },
      ],
    );
    expect(several.view()).toEqual({ total: 5, notes: 1 });

    // The runner's stored offset reflects every event applied (first included):
    // three events fold to offset 3 (offsets 1,2,3), not 2 — which a dropped
    // first event (the #197 bug) would yield.
    expect(several.offset()).toBe(3);
  });
});

// ── Property 2: idempotent apply + exclusive offset. ────────────────────────

describe("Projection — exclusive offset + idempotent apply", () => {
  it("re-presenting an update at/below the stored offset is a no-op", () => {
    const emitted: CountView[] = [];
    const runner = runProjection(countProjection((v) => emitted.push(v)));

    const u1 = {
      msg: { type: "inc", by: 3 } as Msg,
      model: INITIAL,
      offset: 1,
    };
    const u2 = {
      msg: { type: "inc", by: 4 } as Msg,
      model: INITIAL,
      offset: 2,
    };

    expect(runner.present(u1)).toBe(true); // applied → offset 1, total 3
    expect(runner.present(u2)).toBe(true); // applied → offset 2, total 7
    expect(runner.offset()).toBe(2);
    expect(runner.view()).toEqual({ total: 7, notes: 0 });

    // Replay window: re-present u1 (offset 1 ≤ stored 2) and u2 (offset 2 ≤ 2).
    expect(runner.present(u1)).toBe(false); // NO-OP
    expect(runner.present(u2)).toBe(false); // NO-OP
    // View + offset unchanged; no extra emits — a blind increment would 2× here.
    expect(runner.view()).toEqual({ total: 7, notes: 0 });
    expect(runner.offset()).toBe(2);
    expect(emitted).toHaveLength(2);
  });

  it("resuming from a stored offset does not reprocess the last-applied event (exclusive, no ±1)", () => {
    // Build a runner that already applied through offset 2 (the eviction point).
    const stream = streamOf([
      { type: "inc", by: 10 },
      { type: "inc", by: 5 },
      { type: "inc", by: 1 },
    ]);
    // stream offsets: 0 boot, 1 inc10, 2 inc5, 3 inc1.
    const live = runProjection(countProjection(() => {}));
    stream.forEach((s, i) => {
      live.present({ msg: s.msg, model: s.model, offset: i });
    });
    expect(live.view()).toEqual({ total: 16, notes: 0 });
    const storedOffset = live.offset(); // 3 — the last applied position.

    // RESUME: a fresh runner that loaded the stored offset (3) and the view at
    // that point (total 16). It must NOT re-apply offset 3 — the stored offset
    // is EXCLUSIVE. Hand it back the SAME offset and a re-presented event 3.
    const resumed = runProjection(
      countProjection(() => {}),
      storedOffset,
    );
    // The runner does not carry the view across the simulated eviction (it would
    // be loaded from storage); seed it by presenting the next REAL event only.
    expect(
      resumed.present({
        // biome-ignore lint/style/noNonNullAssertion: stream has 4 entries (offsets 0..3, see comment above); index 3 is guaranteed present under noUncheckedIndexedAccess
        msg: stream[3]!.msg,
        // biome-ignore lint/style/noNonNullAssertion: same fixed 4-entry stream; index 3 is guaranteed present
        model: stream[3]!.model,
        offset: 3,
      }),
    ).toBe(false); // offset 3 ≤ stored 3 → exclusive guard drops it (no reprocess)
    // A new event strictly after the stored offset DOES apply.
    expect(
      resumed.present({
        msg: { type: "inc", by: 100 } as Msg,
        model: INITIAL,
        offset: 4,
      }),
    ).toBe(true);
    expect(resumed.offset()).toBe(4);
  });

  it("rebuild after reset re-folds the full stream to the same view", () => {
    const stream = streamOf([
      { type: "inc", by: 2 },
      { type: "note", text: "a" },
      { type: "dec", by: 1 },
    ]);
    const runner = runProjection(countProjection(() => {}));
    stream.forEach((s, i) => {
      runner.present({ msg: s.msg, model: s.model, offset: i });
    });
    const before = runner.view();
    expect(runner.offset()).toBe(3);

    // Clear the view + reset the offset to 0 (the canonical rebuild reset).
    runner.reset();
    expect(runner.view()).toEqual({ total: 0, notes: 0 });
    expect(runner.offset()).toBe(0);

    // Replay from the start → identical view.
    stream.forEach((s, i) => {
      runner.present({ msg: s.msg, model: s.model, offset: i });
    });
    expect(runner.view()).toEqual(before);
  });
});

// ── Property 3: one model, many projections (independence + isolation). ─────

describe("Projection — one model, many projections", () => {
  it("two projections over the same stream produce independent views", async () => {
    await fc.assert(
      fc.asyncProperty(arbMsgs(20), async (msgs) => {
        const { count, state } = await liveViews(msgs);
        // Independent derivations: the event-fold total need not equal the
        // write-model count in general, but for this machine both fold the
        // same arithmetic, so the live write-model count IS the oracle for
        // the state view. The count view tracks notes the state view ignores.
        const stream = streamOf(msgs);
        // biome-ignore lint/style/noNonNullAssertion: streamOf always emits a boot event, so the stream is non-empty and its last element exists under noUncheckedIndexedAccess
        expect(state.count).toBe(stream[stream.length - 1]!.model.count);
        expect(count.notes).toBe(msgs.filter((m) => m.type === "note").length);
      }),
      { numRuns: 50 },
    );
  });

  it("a throwing projection is isolated — its sibling still advances", () => {
    const goodEmits: CountView[] = [];
    const good = runProjection(countProjection((v) => goodEmits.push(v)));
    // A projection whose apply throws on a specific event.
    const poison: Projection<State, Msg, number> = {
      id: { name: "poison", key: "main" },
      initial: 0,
      apply(view, u) {
        if (u.msg?.type === "dec") throw new Error("boom");
        return view + 1;
      },
      emit: () => {},
    };

    const registry = projectionRegistry<State, Msg>();
    const goodRunner = registry.register(
      countProjection((v) => goodEmits.push(v)),
    );
    const poisonRunner = registry.register(poison);

    registry.dispatch(null, INITIAL); // offset 0 — boot update (both projections skip)
    registry.dispatch({ type: "inc", by: 1 }, INITIAL); // offset 1
    registry.dispatch({ type: "dec", by: 1 }, INITIAL); // offset 2 — poison throws
    registry.dispatch({ type: "inc", by: 1 }, INITIAL); // offset 3

    // The good projection saw all three updates; its view is intact.
    expect(goodRunner.view()).toEqual({ total: 1, notes: 0 });
    expect(goodRunner.offset()).toBe(3);
    // The poison projection did not advance past the throw: it applied offset 1,
    // threw on offset 2 (offset NOT advanced → still 1), then applied offset 3.
    // The exclusive guard let offset 3 through (3 > 1); the failed offset 2 is
    // simply skipped — the sibling was never stranded.
    expect(poisonRunner.offset()).toBe(3);
    expect(poisonRunner.view()).toBe(2); // applied at offsets 1 and 3, not 2

    // `good` standalone runner is untouched by the registry's runners.
    expect(good.view()).toEqual({ total: 0, notes: 0 });
  });

  it("an isolated apply/emit throw surfaces via the injected onError sink", () => {
    const surfaced: { error: unknown; id: ProjectionId }[] = [];
    const poison: Projection<State, Msg, number> = {
      id: { name: "poison", key: "main" },
      initial: 0,
      apply(view, u) {
        if (u.msg?.type === "dec") throw new Error("boom");
        return view + 1;
      },
      emit: () => {},
    };

    const registry = projectionRegistry<State, Msg>((error, ctx) => {
      surfaced.push({ error, id: ctx.id });
    });
    registry.register(poison);

    registry.dispatch(null, INITIAL); // offset 0 — boot (skipped)
    registry.dispatch({ type: "inc", by: 1 }, INITIAL); // offset 1 — folds cleanly
    registry.dispatch({ type: "dec", by: 1 }, INITIAL); // offset 2 — throws

    // The throw did not strand the loop, but it did NOT vanish: exactly one
    // error surfaced, tagged with the failing projection's id (errors-are-data).
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]?.error).toBeInstanceOf(Error);
    expect((surfaced[0]?.error as Error).message).toBe("boom");
    expect(surfaced[0]?.id).toEqual({ name: "poison", key: "main" });
  });

  it("resetting one projection does not corrupt the other", () => {
    const registry = projectionRegistry<State, Msg>();
    const a = registry.register(countProjection(() => {}));
    const b = registry.register(stateProjection(() => {}));

    registry.dispatch(null, INITIAL); // offset 0 — boot
    registry.dispatch({ type: "inc", by: 5 }, { ...INITIAL, count: 5 }); // offset 1
    expect(a.view()).toEqual({ total: 5, notes: 0 });
    expect(b.view()).toEqual({ count: 5 });

    a.reset(); // rebuild A only
    expect(a.view()).toEqual({ total: 0, notes: 0 });
    expect(a.offset()).toBe(0);
    // B is untouched.
    expect(b.view()).toEqual({ count: 5 });
    expect(b.offset()).toBe(1);
  });
});

// ── sseHub expressed as a projection (additive — API unchanged). ────────────

describe("sseProjection — sseHub as one projection over the seam", () => {
  it("drives the SAME hub: registered sinks receive the mapped events", async () => {
    type SseEvent = { kind: "count"; value: number };
    const hub = sseHub<SseEvent>();
    const received: SseEvent[] = [];
    hub.register((e) => received.push(e)); // existing sseHub API, unchanged

    const projection = sseProjection<State, Msg, SseEvent>(hub, (msg, model) =>
      msg === null ? null : { kind: "count", value: model.count },
    );

    const registry = projectionRegistry<State, Msg>();
    registry.register(projection);
    const runtime = run(counter(), { ctx });
    const detach = driveProjections(registry, runtime);
    await runtime.ready;
    await runtime.dispatch({ type: "inc", by: 3 });
    await runtime.dispatch({ type: "inc", by: 4 });
    detach();
    await runtime.stop();

    // Boot update (msg === null) is skipped by toEvent; two real events emit.
    expect(received).toEqual([
      { kind: "count", value: 3 },
      { kind: "count", value: 7 },
    ]);
  });

  it("a skip (toEvent → null) pushes nothing through the hub", () => {
    type SseEvent = { kind: "note"; text: string };
    const hub = sseHub<SseEvent>();
    const received: SseEvent[] = [];
    hub.register((e) => received.push(e));

    // Only "note" maps to an event; inc/dec/reset are skips.
    const projection = sseProjection<State, Msg, SseEvent>(hub, (msg) =>
      msg?.type === "note" ? { kind: "note", text: msg.text } : null,
    );
    const runner = runProjection(projection);

    runner.present({ msg: { type: "inc", by: 1 }, model: INITIAL, offset: 1 });
    runner.present({
      msg: { type: "note", text: "hi" },
      model: INITIAL,
      offset: 2,
    });
    runner.present({ msg: { type: "reset" }, model: INITIAL, offset: 3 });

    expect(received).toEqual([{ kind: "note", text: "hi" }]);
  });
});
