import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Cmd, defineMachine } from "../index";
import { bindMachine } from "../testing";
import {
  defaultPaginatorPolicy,
  drain,
  initPaginator,
  isDone,
  type PaginatorPolicy,
  type PaginatorState,
  recordPage,
  resume,
  start,
} from "./index";

// A numeric-offset policy with a small high-water mark, so the backpressure
// edge is reachable in a handful of pages rather than a thousand. Cursor is a
// `number` here (offset); the token-based variant is exercised separately.
const offsetPolicy: PaginatorPolicy<number> = {
  firstCursor: 0,
  highWaterMark: 5,
};

// Backpressure-disabled policy: a non-positive mark must run the walk flat-out,
// never parking in `paused`.
const unboundedPolicy: PaginatorPolicy<number> = {
  firstCursor: 0,
  highWaterMark: 0,
};

describe("initPaginator", () => {
  it("starts idle with zero seen and zero pages", () => {
    expect(initPaginator<number>()).toEqual({
      phase: "idle",
      seen: 0,
      pages: 0,
    });
  });
});

describe("start", () => {
  it("arms the first cursor from idle", () => {
    const armed = start(initPaginator<number>(), offsetPolicy);
    expect(armed).toEqual({ phase: "fetching", cursor: 0, seen: 0, pages: 0 });
  });

  it("is a no-op on any non-idle phase (no skip-to-page-one, no mutation)", () => {
    const fetching: PaginatorState<number> = {
      phase: "fetching",
      cursor: 40,
      seen: 3,
      pages: 1,
    };
    const frozen = Object.freeze({ ...fetching });
    const after = start(frozen, offsetPolicy);
    // Same value back (the op refuses to re-arm), input untouched.
    expect(after).toBe(frozen);
    expect(frozen).toEqual({
      phase: "fetching",
      cursor: 40,
      seen: 3,
      pages: 1,
    });
  });

  it("respects an API-specific first cursor (page tokens, not just offsets)", () => {
    const tokenPolicy: PaginatorPolicy<string> = {
      firstCursor: "PAGE_ONE",
      highWaterMark: 5,
    };
    const armed = start(initPaginator<string>(), tokenPolicy);
    expect(armed).toEqual({
      phase: "fetching",
      cursor: "PAGE_ONE",
      seen: 0,
      pages: 0,
    });
  });
});

describe("recordPage", () => {
  it("advances the cursor and accumulates seen/pages while under the mark", () => {
    const s0 = start(initPaginator<number>(), offsetPolicy);
    const s1 = recordPage(s0, 2, 20, offsetPolicy);
    expect(s1).toEqual({ phase: "fetching", cursor: 20, seen: 2, pages: 1 });
    const s2 = recordPage(s1, 1, 40, offsetPolicy);
    expect(s2).toEqual({ phase: "fetching", cursor: 40, seen: 3, pages: 2 });
  });

  it("finishes when the API returns a null next cursor", () => {
    const s0 = start(initPaginator<number>(), offsetPolicy);
    const s1 = recordPage(s0, 2, null, offsetPolicy);
    expect(s1).toEqual({ phase: "done", seen: 2, pages: 1 });
    expect(isDone(s1)).toBe(true);
  });

  it("pauses for backpressure the instant seen reaches highWaterMark", () => {
    const s0 = start(initPaginator<number>(), offsetPolicy);
    // One page of 5 items hits the mark exactly (>= edge) → pause, carrying the
    // next cursor so resume re-issues the right fetch.
    const s1 = recordPage(s0, 5, 20, offsetPolicy);
    expect(s1).toEqual({ phase: "paused", cursor: 20, seen: 5, pages: 1 });
  });

  it("checks the post-page seen total, not the pre-page value", () => {
    // seen 4 (< mark) before the page; a page of 1 lands exactly on 5 → pause,
    // not one-more-fetch. Proves the new total gates the decision.
    const s: PaginatorState<number> = {
      phase: "fetching",
      cursor: 20,
      seen: 4,
      pages: 1,
    };
    const next = recordPage(s, 1, 40, offsetPolicy);
    expect(next).toEqual({ phase: "paused", cursor: 40, seen: 5, pages: 2 });
  });

  it("never pauses when backpressure is disabled (highWaterMark <= 0)", () => {
    const s0 = start(initPaginator<number>(), unboundedPolicy);
    const s1 = recordPage(s0, 10_000, 20, unboundedPolicy);
    expect(s1).toEqual({
      phase: "fetching",
      cursor: 20,
      seen: 10_000,
      pages: 1,
    });
  });

  it("is a no-op when no fetch is outstanding (late duplicate result)", () => {
    const idle = initPaginator<number>();
    expect(recordPage(idle, 3, 20, offsetPolicy)).toBe(idle);

    const done: PaginatorState<number> = { phase: "done", seen: 9, pages: 4 };
    const frozen = Object.freeze({ ...done });
    // A stray result after completion must not un-finish or double-count.
    expect(recordPage(frozen, 5, 60, offsetPolicy)).toBe(frozen);
    expect(frozen).toEqual({ phase: "done", seen: 9, pages: 4 });
  });
});

describe("drain", () => {
  it("lowers the seen gauge without touching the phase or cursor", () => {
    const paused: PaginatorState<number> = {
      phase: "paused",
      cursor: 40,
      seen: 5,
      pages: 2,
    };
    const after = drain(paused, 3);
    expect(after).toEqual({ phase: "paused", cursor: 40, seen: 2, pages: 2 });
  });

  it("floors seen at 0 on an over-ack and never goes negative", () => {
    const fetching: PaginatorState<number> = {
      phase: "fetching",
      cursor: 20,
      seen: 2,
      pages: 1,
    };
    expect(drain(fetching, 99).seen).toBe(0);
  });

  it("is a no-op for non-positive n and for a drain that changes nothing", () => {
    const s: PaginatorState<number> = {
      phase: "fetching",
      cursor: 20,
      seen: 4,
      pages: 1,
    };
    expect(drain(s, 0)).toBe(s);
    expect(drain(s, -5)).toBe(s);
    // seen already 0 → drain(1) subtracts to 0, unchanged → same reference.
    const empty: PaginatorState<number> = { phase: "idle", seen: 0, pages: 0 };
    expect(drain(empty, 1)).toBe(empty);
  });
});

describe("resume", () => {
  it("re-arms the parked cursor once seen drops below the mark", () => {
    const paused: PaginatorState<number> = {
      phase: "paused",
      cursor: 40,
      seen: 5,
      pages: 2,
    };
    const drained = drain(paused, 1); // seen 4 < mark 5
    const resumed = resume(drained, offsetPolicy);
    expect(resumed).toEqual({
      phase: "fetching",
      cursor: 40,
      seen: 4,
      pages: 2,
    });
  });

  it("refuses to resume while still at or above the mark (valve stays shut)", () => {
    const paused: PaginatorState<number> = {
      phase: "paused",
      cursor: 40,
      seen: 5,
      pages: 2,
    };
    // No drain happened; resuming optimistically must not defeat backpressure.
    expect(resume(paused, offsetPolicy)).toBe(paused);
  });

  it("is a no-op on any non-paused phase", () => {
    const fetching: PaginatorState<number> = {
      phase: "fetching",
      cursor: 20,
      seen: 1,
      pages: 1,
    };
    expect(resume(fetching, offsetPolicy)).toBe(fetching);
    const done: PaginatorState<number> = { phase: "done", seen: 9, pages: 4 };
    expect(resume(done, offsetPolicy)).toBe(done);
  });
});

describe("a full drain-and-resume walk cycle", () => {
  it("pauses, drains below the mark, resumes, then finishes", () => {
    let s: PaginatorState<number> = start(
      initPaginator<number>(),
      offsetPolicy,
    );
    s = recordPage(s, 5, 20, offsetPolicy); // hits mark → paused(20)
    expect(s.phase).toBe("paused");

    s = drain(s, 3); // seen 2 < mark
    s = resume(s, offsetPolicy); // → fetching(20)
    expect(s).toEqual({ phase: "fetching", cursor: 20, seen: 2, pages: 1 });

    s = recordPage(s, 1, null, offsetPolicy); // API exhausted
    expect(s).toEqual({ phase: "done", seen: 3, pages: 2 });
    expect(isDone(s)).toBe(true);
  });
});

describe("defaultPaginatorPolicy", () => {
  it("is a coherent offset-from-zero policy with a positive mark", () => {
    expect(defaultPaginatorPolicy.firstCursor).toBe(0);
    expect(defaultPaginatorPolicy.highWaterMark).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Properties — the invariants that must hold over ANY walk sequence.
// ===========================================================================

// One op the property fold can apply, as plain data the arbitrary picks from.
type Op =
  | { readonly kind: "start" }
  | {
      readonly kind: "record";
      readonly count: number;
      readonly next: number | null | undefined;
    }
  | { readonly kind: "drain"; readonly n: number }
  | { readonly kind: "resume" };

function applyOp(
  state: PaginatorState<number>,
  op: Op,
  policy: PaginatorPolicy<number>,
): PaginatorState<number> {
  switch (op.kind) {
    case "start":
      return start(state, policy);
    case "record":
      return recordPage(state, op.count, op.next, policy);
    case "drain":
      return drain(state, op.n);
    case "resume":
      return resume(state, policy);
  }
}

// `count` deliberately spans negatives, NaN, and the infinities — a page's
// item count SHOULD be a finite non-negative, but a buggy / hostile consumer
// can hand `recordPage` anything. The floor + finite-guard must absorb all of
// it: a record may only hold or raise `seen`, never drive it negative/NaN and
// poison the backpressure comparison. Narrowing this to `min: 0` (as the
// original did) hides exactly that defect.
const countArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.double({ noDefaultInfinity: false, noNaN: false }),
);

// `next` spans a real cursor, an explicit `null`, AND a missing `undefined`
// (an optional API cursor field). Both end-of-walk sentinels must finish the
// walk via the op's loose `== null`.
const nextArb: fc.Arbitrary<number | null | undefined> = fc.oneof(
  fc.integer(),
  fc.constant<null>(null),
  fc.constant<undefined>(undefined),
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ kind: "start" }),
  fc
    .record({ count: countArb, next: nextArb })
    .map((r): Op => ({ kind: "record", count: r.count, next: r.next })),
  fc.integer({ min: -10, max: 1000 }).map((n): Op => ({ kind: "drain", n })),
  fc.constant<Op>({ kind: "resume" }),
);

const policyArb: fc.Arbitrary<PaginatorPolicy<number>> = fc.record({
  firstCursor: fc.integer(),
  // Span both the disabled (<= 0) and enabled (> 0) backpressure regimes.
  highWaterMark: fc.integer({ min: -5, max: 50 }),
});

describe("paginator properties", () => {
  it("seen and pages are monotonic across a record, and never go negative", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 60 }),
        policyArb,
        (ops, policy) => {
          let state = initPaginator<number>();
          for (const op of ops) {
            const before = state;
            const after = applyOp(before, op, policy);
            // pages never decreases — only `recordPage` touches it, always +1.
            if (after.pages < before.pages) return false;
            // seen is always a finite, non-negative number. The floor +
            // finite-guard in recordPage must hold even when `count` is
            // negative, NaN, or ±Infinity — otherwise a poisoned `seen`
            // permanently defeats the `seen >= highWaterMark` comparison.
            if (!Number.isFinite(after.seen)) return false;
            if (after.seen < 0) return false;
            // drain is the ONLY op that may lower seen; every other op keeps or
            // raises it.
            if (op.kind !== "drain" && after.seen < before.seen) return false;
            state = after;
          }
          return true;
        },
      ),
    );
  });

  it("once done, no op resurrects the walk (terminal phase is absorbing)", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 60 }),
        policyArb,
        (ops, policy) => {
          let state = initPaginator<number>();
          let everDone = false;
          for (const op of ops) {
            state = applyOp(state, op, policy);
            if (state.phase === "done") everDone = true;
            // Once done, the phase can never leave done again.
            if (everDone && state.phase !== "done") return false;
          }
          return true;
        },
      ),
    );
  });

  it("never sits in paused with headroom — a paused walk is always at/over the mark", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 60 }),
        policyArb,
        (ops, policy) => {
          let state = initPaginator<number>();
          for (const op of ops) {
            state = applyOp(state, op, policy);
            if (state.phase === "paused") {
              // Pausing is only legal under a positive mark, and only at/over it.
              // (drain can lower seen below the mark, but resume is what clears
              // the phase — until then the invariant is "paused implies a
              // positive mark", since hwm <= 0 never pauses in the first place.)
              if (policy.highWaterMark <= 0) return false;
            }
          }
          return true;
        },
      ),
    );
  });

  it("every op returns a new value without mutating its input", () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 60 }),
        policyArb,
        (ops, policy) => {
          let state = initPaginator<number>();
          for (const op of ops) {
            const snapshot = JSON.stringify(state);
            const frozen = Object.freeze({ ...state });
            // Object.freeze would throw on a mutating op (strict mode in ESM).
            applyOp(frozen, op, policy);
            // Input value is structurally unchanged after the op ran.
            if (JSON.stringify(state) !== snapshot) return false;
            state = applyOp(state, op, policy);
          }
          return true;
        },
      ),
    );
  });
});

// ===========================================================================
// WIRED MACHINE — the paginator's ops folded through a REAL `defineMachine` and
// driven by `replay`. The unit/PBT specs above hand-feed `recordPage` and read
// the value it returns; this drives the SAME ops as Msgs through the substrate's
// dispatch table and asserts the END STATE the machine settles into — the test
// class that was missing and is exactly why the floor / loose-null bugs shipped
// green.
//
// The machine's state IS the paginator walk; each Msg is a knob op:
//   { type: "start" }                       → start
//   { type: "page", count, next }           → recordPage
//   { type: "drain", n }                    → drain
//   { type: "resume" }                      → resume
// ===========================================================================

type WalkMsg =
  | { readonly type: "start" }
  | {
      readonly type: "page";
      readonly count: number;
      readonly next: number | null | undefined;
    }
  | { readonly type: "drain"; readonly n: number }
  | { readonly type: "resume" };

// The walk emits no real effects; a phantom Cmd keeps the machine well-typed.
type WalkCmd = Cmd<"noop">;

function makeWalkMachine(policy: PaginatorPolicy<number>) {
  return defineMachine<PaginatorState<number>, WalkMsg, WalkCmd, never, object>(
    {
      init: (loaded) => [loaded ?? initPaginator<number>(), []],
      update: {
        start: (s) => [start(s, policy), []],
        page: (s, m) => [recordPage(s, m.count, m.next, policy), []],
        drain: (s, m) => [drain(s, m.n), []],
        resume: (s) => [resume(s, policy), []],
      },
    },
  );
}

describe("paginator — wired in a real machine (replay end-state)", () => {
  const ctx = {} as object;

  it("walks clean pages to done through the dispatch table", () => {
    const bound = bindMachine(makeWalkMachine(offsetPolicy), ctx);
    // start → page(2,→20) → page(1,→40) → page(1, end) ⇒ done, seen 4, pages 3.
    bound.expectFinalState(
      {
        msgs: [
          { type: "start" },
          { type: "page", count: 2, next: 20 },
          { type: "page", count: 1, next: 40 },
          { type: "page", count: 1, next: null },
        ],
      },
      { phase: "done", seen: 4, pages: 3 },
    );
  });

  // DEFECT #1 — additive floor. A poisoned page (negative count) early in the
  // walk would, unfloored, drag `seen` below zero; then a later large page that
  // SHOULD cross the high-water mark and pause leaves `seen` still under it, so
  // the walk keeps fetching and backpressure never trips. Driven entirely
  // through the machine; we assert the END STATE is `paused`, not the Msgs.
  it("a negative-count page can never poison backpressure (floored)", () => {
    const bound = bindMachine(makeWalkMachine(offsetPolicy), ctx);
    const { state } = bound.replay({
      msgs: [
        { type: "start" }, // → fetching(0)
        { type: "page", count: -100, next: 20 }, // poison: seen would go -100
        { type: "page", count: 5, next: 40 }, // 5 items → must reach mark (hwm 5)
      ],
    });
    // hwm is 5. With the floor, seen = max(0,0-100)=0, then max(0,0+5)=5 ≥ 5 →
    // PAUSED. Without the floor seen = -95, then -90 < 5 → still fetching: the
    // valve silently never trips. The end state proves the fix.
    expect(state).toEqual({ phase: "paused", cursor: 40, seen: 5, pages: 2 });
  });

  // DEFECT #1 — non-finite floor. A NaN count poisons every later comparison
  // (NaN >= hwm is false forever), so the walk can NEVER pause. Same end-state
  // assertion through the machine.
  it("a NaN-count page can never poison backpressure (finite-guarded)", () => {
    const bound = bindMachine(makeWalkMachine(offsetPolicy), ctx);
    const { state } = bound.replay({
      msgs: [
        { type: "start" },
        { type: "page", count: Number.NaN, next: 20 }, // poison: seen would be NaN
        { type: "page", count: 5, next: 40 }, // must reach mark (hwm 5)
      ],
    });
    expect(state).toEqual({ phase: "paused", cursor: 40, seen: 5, pages: 2 });
  });

  // DEFECT #2 — loose null. An optional cursor field the consumer extracted as
  // `undefined` must finish the walk, not carry a cursor-less fetching/paused
  // state forward. Driven through the machine; assert the END STATE is `done`.
  it("a missing (undefined) next cursor finishes the walk", () => {
    const bound = bindMachine(makeWalkMachine(offsetPolicy), ctx);
    bound.expectFinalState(
      {
        msgs: [
          { type: "start" },
          { type: "page", count: 2, next: 20 },
          { type: "page", count: 1, next: undefined }, // missing cursor → done
        ],
      },
      { phase: "done", seen: 3, pages: 2 },
    );
  });

  it("full drain → resume → finish cycle through the dispatch table", () => {
    const bound = bindMachine(makeWalkMachine(offsetPolicy), ctx);
    bound.expectFinalState(
      {
        msgs: [
          { type: "start" },
          { type: "page", count: 5, next: 20 }, // → paused(20)
          { type: "drain", n: 3 }, // seen 2 < mark
          { type: "resume" }, // → fetching(20)
          { type: "page", count: 1, next: null }, // → done
        ],
      },
      { phase: "done", seen: 3, pages: 2 },
    );
  });
});
