import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deadlineSub } from "../deadline";
import { defineMachine } from "../index";
import { bindMachine } from "../testing";
import {
  createThrottledInput,
  initThrottledInput,
  input,
  onFlush,
  subscribeThrottledInput,
  subsFor,
  type ThrottledInput,
  type ThrottledInputConfig,
  type ThrottledInputSettled,
  throttledInputSettled,
} from "./index";

// The Cmd an emit produces in these tests: a plain tagged-data Cmd carrying the
// settled value. `emit` is a pure constructor — no I/O, no clock — so the verbs
// stay replayable and the emitted Cmd is inspectable structurally.
type EmitCmd = { type: "emit"; value: string };
const emit = (value: string): EmitCmd => ({ type: "emit", value });

const BASE = 1_000_000; // a readable epoch instant for absolute targets.

// Convenience config builders — one per gate combination so each suite reads
// its triggers off the config name.
const passThrough: ThrottledInputConfig<string, EmitCmd> = { emit };
const debounceOnly: ThrottledInputConfig<string, EmitCmd> = {
  debounceMs: 200,
  emit,
};
const throttleOnly: ThrottledInputConfig<string, EmitCmd> = {
  throttleMs: 1_000,
  emit,
};
const cacheOnly: ThrottledInputConfig<string, EmitCmd> = {
  cacheTtlMs: 5_000,
  cacheKey: (q) => q,
  emit,
};
const allGates: ThrottledInputConfig<string, EmitCmd> = {
  throttleMs: 1_000,
  debounceMs: 200,
  cacheTtlMs: 5_000,
  cacheKey: (q) => q,
  emit,
};

describe("initThrottledInput / createThrottledInput.init", () => {
  it("seeds a clean slice with no prior emit, nothing pending, no cache", () => {
    expect(initThrottledInput<string>()).toEqual({
      lastAt: null,
      pending: null,
    });
  });

  it("createThrottledInput.init carries no cache when cacheTtlMs is unset", () => {
    const gate = createThrottledInput(debounceOnly);
    expect(gate.init()).toEqual({ lastAt: null, pending: null });
    expect("cache" in gate.init()).toBe(false);
  });

  it("createThrottledInput.init seeds an empty cache when cacheTtlMs is set", () => {
    const gate = createThrottledInput(cacheOnly);
    expect(gate.init()).toEqual({
      lastAt: null,
      pending: null,
      cache: { entries: {} },
    });
  });
});

describe("input — pass-through (no gates configured)", () => {
  it("emits immediately on every input and advances the rate cursor", () => {
    const [next, cmds] = input(
      passThrough,
      initThrottledInput<string>(),
      "a",
      BASE,
    );
    expect(cmds).toEqual([emit("a")]);
    expect(next).toEqual({ lastAt: BASE, pending: null });
  });
});

describe("input — rate gate (throttleMs only)", () => {
  it("the first input always passes (no prior emit to measure against)", () => {
    const [next, cmds] = input(
      throttleOnly,
      initThrottledInput<string>(),
      "a",
      BASE,
    );
    expect(cmds).toEqual([emit("a")]);
    expect(next.lastAt).toBe(BASE);
  });

  it("drops an input within throttleMs of the last emit (no settle window to catch it)", () => {
    let s = initThrottledInput<string>();
    [s] = input(throttleOnly, s, "a", BASE); // emits, lastAt = BASE
    const [next, cmds] = input(throttleOnly, s, "b", BASE + 999); // < 1000ms later
    expect(cmds).toEqual([]); // rate-blocked, pure drop
    expect(next).toEqual(s); // slice unchanged
  });

  it("passes an input exactly throttleMs later (half-open: >= passes)", () => {
    let s = initThrottledInput<string>();
    [s] = input(throttleOnly, s, "a", BASE);
    const [next, cmds] = input(throttleOnly, s, "b", BASE + 1_000); // exactly the cutoff
    expect(cmds).toEqual([emit("b")]);
    expect(next.lastAt).toBe(BASE + 1_000);
  });
});

describe("input — settle gate (debounceMs only)", () => {
  it("holds the value instead of emitting, anchoring pending.at to the input `at`", () => {
    const [next, cmds] = input(
      debounceOnly,
      initThrottledInput<string>(),
      "a",
      BASE,
    );
    expect(cmds).toEqual([]); // held, not emitted
    expect(next).toEqual({
      lastAt: null,
      pending: { value: "a", at: BASE },
    });
  });

  it("a fresh input slides the window — pending overwrites with the LAST value/at", () => {
    let s = initThrottledInput<string>();
    [s] = input(debounceOnly, s, "a", BASE);
    const [next, cmds] = input(debounceOnly, s, "b", BASE + 50);
    expect(cmds).toEqual([]);
    expect(next.pending).toEqual({ value: "b", at: BASE + 50 }); // last wins
  });
});

describe("onFlush — the settle window closes", () => {
  it("emits the pending value, advances the rate cursor, and clears pending", () => {
    let s = initThrottledInput<string>();
    [s] = input(debounceOnly, s, "a", BASE);
    const [next, cmds] = onFlush(debounceOnly, s, BASE + 200);
    expect(cmds).toEqual([emit("a")]);
    expect(next).toEqual({ lastAt: BASE + 200, pending: null });
  });

  it("is a no-op on an empty pending — never emits a stale value", () => {
    const [next, cmds] = onFlush(
      debounceOnly,
      initThrottledInput<string>(),
      BASE,
    );
    expect(cmds).toEqual([]);
    expect(next).toEqual({ lastAt: null, pending: null });
  });

  it("ignores a stale settle Msg that lands AFTER an immediate emit cleared pending", () => {
    // Race: a debounce-less config emitted immediately and there is no pending;
    // a settle Msg arrives later. It must not double-fire.
    let s = initThrottledInput<string>();
    [s] = input(passThrough, s, "a", BASE); // immediate emit, pending stays null
    const [next, cmds] = onFlush(passThrough, s, BASE + 200);
    expect(cmds).toEqual([]);
    expect(next).toEqual(s);
  });
});

describe("input — dedupe gate (cacheTtlMs)", () => {
  it("a fresh key emits and is written into the cache", () => {
    const gate = createThrottledInput(cacheOnly);
    const [next, cmds] = gate.input(gate.init(), "a", BASE);
    expect(cmds).toEqual([emit("a")]);
    // The emitted value is now cached with a 5s TTL from BASE.
    expect(next.cache && "a" in next.cache.entries).toBe(true);
  });

  it("suppresses a repeated key within its TTL (downstream effect ran once)", () => {
    const gate = createThrottledInput(cacheOnly);
    let s = gate.init();
    [s] = gate.input(s, "a", BASE); // fresh → emit + cache
    const [next, cmds] = gate.input(s, "a", BASE + 4_999); // within TTL
    expect(cmds).toEqual([]); // deduped
    expect(next).toEqual(s); // slice unchanged
  });

  it("re-emits a key after its TTL elapses (half-open: at == expiry is a miss)", () => {
    const gate = createThrottledInput(cacheOnly);
    let s = gate.init();
    [s] = gate.input(s, "a", BASE); // cached, expires at BASE + 5000
    const [, cmds] = gate.input(s, "a", BASE + 5_000); // exactly the expiry instant
    expect(cmds).toEqual([emit("a")]); // cache miss → fresh emit
  });

  it("distinct keys are independent — a different value emits despite a cached one", () => {
    const gate = createThrottledInput(cacheOnly);
    let s = gate.init();
    [s] = gate.input(s, "a", BASE);
    const [, cmds] = gate.input(s, "b", BASE + 1);
    expect(cmds).toEqual([emit("b")]);
  });

  it("two distinct STRUCTURED values never share a cache slot (the closed `[object Object]` collision)", () => {
    // The regression this guards: a structured value under the old
    // `String(value)` default keyed as `"[object Object]"`, so EVERY structured
    // value collided into one slot — a second, genuinely different value read as
    // a dedupe hit and was silently dropped. `cacheKey` is now REQUIRED when
    // `cacheTtlMs` is set (no `String(value)` default exists), so the consumer
    // names the identity and two distinct values can never collapse together.
    type Query = { readonly term: string; readonly page: number };
    const structuredCmd = (q: Query): EmitCmd => ({
      type: "emit",
      value: `${q.term}#${q.page}`,
    });
    const gate = createThrottledInput<Query, EmitCmd>({
      cacheTtlMs: 5_000,
      cacheKey: (q) => `${q.term}#${q.page}`, // identity is BOTH fields
      emit: structuredCmd,
    });
    let s = gate.init();
    const a: Query = { term: "react", page: 1 };
    const b: Query = { term: "react", page: 2 }; // differs only by page

    let cmds: readonly EmitCmd[];
    [s, cmds] = gate.input(s, a, BASE);
    expect(cmds).toEqual([structuredCmd(a)]); // fresh → emits

    // `b` is a DIFFERENT structured value. Under the old default both keyed to
    // `"[object Object]"`, so this would have been a (wrong) dedupe hit and
    // emitted nothing. With a real key it emits.
    [s, cmds] = gate.input(s, b, BASE + 1);
    expect(cmds).toEqual([structuredCmd(b)]); // distinct slot → emits

    // Both keys are now cached under their OWN slot — re-feeding either within
    // the TTL is correctly deduped, independently.
    expect(Object.keys(s.cache?.entries ?? {}).sort()).toEqual([
      "react#1",
      "react#2",
    ]);
    [, cmds] = gate.input(s, a, BASE + 100);
    expect(cmds).toEqual([]); // a still cached → deduped
    [, cmds] = gate.input(s, b, BASE + 100);
    expect(cmds).toEqual([]); // b still cached → deduped
  });

  it("a dedupe hit short-circuits BEFORE the rate / settle gates", () => {
    // With all gates on, a cached key must suppress without holding `pending`
    // or re-arming the settle timer — the cache-first order.
    const gate = createThrottledInput(allGates);
    let s = gate.init();
    [s] = gate.input(s, "a", BASE); // throttle+debounce → held, not yet cached
    [s] = gate.onFlush(s, BASE + 200); // settle fires → emit + cache "a" (TTL 5s)
    expect(s.cache && "a" in s.cache.entries).toBe(true);
    // "a" again, past the throttle window (rate would pass) but still inside the
    // cache TTL (cached at BASE+200, expires BASE+5200). The dedupe gate fires
    // FIRST and suppresses without holding `pending` or re-arming the settle
    // timer — the cache-first order.
    const [next, cmds] = gate.input(s, "a", BASE + 3_000);
    expect(cmds).toEqual([]);
    expect(next).toEqual(s); // slice unchanged: no pending, no re-arm
    expect(next.pending).toBeNull();
  });
});

describe("input — throttle + debounce together (trailing edge)", () => {
  it("a rate-blocked input is HELD (not dropped) so the settle timer trails it out", () => {
    const gate = createThrottledInput(allGates);
    let s = gate.init();
    [s] = gate.input(s, "a", BASE); // held by debounce
    [s] = gate.onFlush(s, BASE + 200); // emit "a", lastAt = BASE + 200
    expect(s.lastAt).toBe(BASE + 200);
    // "b" arrives 100ms later — within throttleMs of the emit, so rate-blocked.
    // With a settle window configured it is HELD, not dropped (trailing edge).
    const [next, cmds] = gate.input(s, "b", BASE + 300);
    expect(cmds).toEqual([]);
    expect(next.pending).toEqual({ value: "b", at: BASE + 300 });
  });
});

describe("immutability (verbs never mutate their input)", () => {
  it("input leaves the input slice untouched on an emit", () => {
    const s = Object.freeze({
      lastAt: null,
      pending: null,
    }) as ThrottledInput<string>;
    const before: ThrottledInput<string> = { lastAt: null, pending: null };
    input(passThrough, s, "a", BASE);
    expect(s).toEqual(before);
  });

  it("onFlush leaves the input slice untouched", () => {
    const s = Object.freeze({
      lastAt: null,
      pending: Object.freeze({ value: "a", at: BASE }),
    }) as ThrottledInput<string>;
    const before: ThrottledInput<string> = {
      lastAt: null,
      pending: { value: "a", at: BASE },
    };
    onFlush(debounceOnly, s, BASE + 200);
    expect(s).toEqual(before);
  });
});

describe("subsFor — settle timer arms only while a value is held", () => {
  it("emits no Sub when nothing is pending", () => {
    expect(subsFor(debounceOnly, initThrottledInput<string>())).toEqual([]);
  });

  it("emits a deadline Sub targeting pending.at + debounceMs while held", () => {
    let s = initThrottledInput<string>();
    [s] = input(debounceOnly, s, "a", BASE);
    expect(subsFor(debounceOnly, s)).toEqual([
      deadlineSub("throttled-input:settle", BASE + 200),
    ]);
  });

  it("re-arms a fresh absolute target after a sliding input restamps pending.at", () => {
    let s = initThrottledInput<string>();
    [s] = input(debounceOnly, s, "a", BASE);
    [s] = input(debounceOnly, s, "b", BASE + 50); // slides the window
    expect(subsFor(debounceOnly, s)[0]).toMatchObject({ atMs: BASE + 250 });
  });

  it("disarms (returns []) after onFlush clears pending", () => {
    let s = initThrottledInput<string>();
    [s] = input(debounceOnly, s, "a", BASE);
    [s] = onFlush(debounceOnly, s, BASE + 200);
    expect(subsFor(debounceOnly, s)).toEqual([]);
  });

  it("never arms without a debounceMs, even with a stray pending value", () => {
    const stray: ThrottledInput<string> = {
      lastAt: null,
      pending: { value: "a", at: BASE },
    };
    expect(subsFor(throttleOnly, stray)).toEqual([]); // no settle window configured
  });

  it("routes by id so several gates on one machine stay distinct", () => {
    let s = initThrottledInput<string>();
    [s] = input(debounceOnly, s, "a", BASE);
    const search = subsFor(debounceOnly, s, "search");
    const filter = subsFor(debounceOnly, s, "filter");
    expect(search[0]?.id).toBe("search");
    expect(filter[0]?.id).toBe("filter");
    expect(search[0]?.id).not.toBe(filter[0]?.id);
  });
});

describe("throttledInputSettled — the settle Msg constructor", () => {
  it("constructs the deadline-shaped Msg the consumer handles via onFlush", () => {
    expect(throttledInputSettled("search", BASE + 200)).toEqual({
      type: "deadline_exceeded",
      id: "search",
      atMs: BASE + 200,
    });
  });
});

describe("subscribeThrottledInput — the settle timer fires", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches the settle Msg once after (atMs - now), then never again", () => {
    vi.setSystemTime(BASE);
    const dispatched: ThrottledInputSettled[] = [];
    const sub = deadlineSub("search", BASE + 200);

    subscribeThrottledInput(sub, undefined, (m) => dispatched.push(m));

    vi.advanceTimersByTime(199);
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dispatched).toEqual([throttledInputSettled("search", BASE + 200)]);

    // One-shot — no re-fire.
    vi.advanceTimersByTime(10_000);
    expect(dispatched).toHaveLength(1);
  });

  it("cleanup cancels the pending timer (disarm-on-flush path)", () => {
    vi.setSystemTime(BASE);
    const dispatched: ThrottledInputSettled[] = [];
    const cleanup = subscribeThrottledInput(
      deadlineSub("search", BASE + 200),
      undefined,
      (m) => dispatched.push(m),
    );
    cleanup(); // the substrate calls this when subsFor drops the Sub after a flush
    vi.advanceTimersByTime(10_000);
    expect(dispatched).toEqual([]);
  });
});

describe("createThrottledInput — combinator knob shape", () => {
  it("input / onFlush delegate to the pure verbs with the bound config", () => {
    const gate = createThrottledInput(allGates);
    let s = gate.init();
    let cmds: readonly EmitCmd[];
    [s, cmds] = gate.input(s, "a", BASE); // throttle+debounce → held
    expect(cmds).toEqual([]);
    [s, cmds] = gate.onFlush(s, BASE + 200); // settle → emit
    expect(cmds).toEqual([emit("a")]);
    expect(s.lastAt).toBe(BASE + 200);
  });

  it("subs wires the settle timer keyed by id", () => {
    const gate = createThrottledInput(debounceOnly);
    let s = gate.init();
    expect(gate.subs(s)).toEqual([]); // nothing held → no timer
    [s] = gate.input(s, "a", BASE);
    expect(gate.subs(s, "search")[0]).toMatchObject({
      id: "search",
      atMs: BASE + 200,
    });
  });
});

// ---------------------------------------------------------------------------
// Machine-level: spread the knob into a real machine and assert through
// `replay` (the testing helpers). Proves the hooks compose into a valid
// `defineMachine` and that the slice survives a fold of Msgs.
// ---------------------------------------------------------------------------

type AppState = { readonly search: ThrottledInput<string> };
type AppMsg =
  | { readonly type: "typed"; readonly value: string; readonly at: number }
  | { readonly type: "settled"; readonly at: number };

describe("createThrottledInput — wired into a machine", () => {
  const gate = createThrottledInput(allGates);

  const machine = defineMachine<AppState, AppMsg, EmitCmd, never, undefined>({
    init: (loaded) => [loaded ?? { search: gate.init() }, []],
    update: {
      typed: (s, m) => {
        const [slice, cmds] = gate.input(s.search, m.value, m.at);
        return [{ ...s, search: slice }, cmds];
      },
      settled: (s, m) => {
        const [slice, cmds] = gate.onFlush(s.search, m.at);
        return [{ ...s, search: slice }, cmds];
      },
    },
    subscriptions: (s) => gate.subs(s.search),
  });

  const t = bindMachine(machine, undefined);

  it("a typing burst that settles emits exactly once, with the LAST value", () => {
    t.expectCmdSequence(
      {
        msgs: [
          { type: "typed", value: "h", at: BASE },
          { type: "typed", value: "he", at: BASE + 50 },
          { type: "typed", value: "hel", at: BASE + 100 },
          { type: "settled", at: BASE + 300 },
        ],
      },
      [emit("hel")], // coalesced to the final keystroke
    );
  });

  it("arms the settle deadline while typing, drops it once settled", () => {
    t.expectActiveSubs(
      {
        msgs: [
          { type: "typed", value: "h", at: BASE },
          { type: "typed", value: "he", at: BASE + 50 },
        ],
      },
      [deadlineSub("throttled-input:settle", BASE + 250)], // anchored on last keystroke
    );

    t.expectActiveSubs(
      {
        msgs: [
          { type: "typed", value: "h", at: BASE },
          { type: "settled", at: BASE + 200 },
        ],
      },
      [], // settled → timer disarmed
    );
  });

  it("a query repeated within the cache TTL emits nothing the second time", () => {
    t.expectCmdSequence(
      {
        msgs: [
          { type: "typed", value: "react", at: BASE },
          { type: "settled", at: BASE + 200 }, // emit "react", cache it
          { type: "typed", value: "react", at: BASE + 1_500 }, // deduped (within 5s)
        ],
      },
      [emit("react")], // only the first run
    );
  });

  // -------------------------------------------------------------------------
  // WIRED end-to-end regression: the rate cap must hold across the
  // trailing-edge emit. This is the test class that was MISSING — it drives
  // the real machine (init + update + subscriptions via `replay`) through the
  // full "emit, then a rate-blocked input gets held, then its settle timer
  // fires too early" scenario and asserts the END STATE, not the intermediate
  // Msgs. Against the buggy code it FAILS (the early settle emits a second
  // value within throttleMs); after the fix it passes.
  // -------------------------------------------------------------------------
  describe("rate cap holds across the trailing-edge emit", () => {
    // `b` is rate-blocked at BASE+300 (300ms after the BASE+200 emit, well
    // inside throttleMs=1000). It is held. Its NAIVE settle deadline is
    // pending.at + debounceMs = BASE+500 — but emitting then would be only
    // 300ms after the prior emit, breaking "at most once per throttleMs".
    // The earliest legal emit is lastAt + throttleMs = BASE+1200.
    const emitFirstThenHold: readonly AppMsg[] = [
      { type: "typed", value: "a", at: BASE },
      { type: "settled", at: BASE + 200 }, // emit "a", lastAt = BASE+200
      { type: "typed", value: "b", at: BASE + 300 }, // rate-blocked → HELD
    ];

    it("a settle Msg that fires before lastAt+throttleMs does NOT emit (the rate cap wins)", () => {
      // The settle timer fires at BASE+500 (the naive pending.at+debounceMs).
      // Only "a" may have emitted — "b" is still inside the rate window, so a
      // second emit here would violate the at-most-once-per-throttleMs cap.
      t.expectCmdSequence(
        {
          msgs: [...emitFirstThenHold, { type: "settled", at: BASE + 500 }],
        },
        [emit("a")], // ONLY the first emit — "b" must NOT fire early
      );
    });

    it("the held value still rides the trailing edge once the rate window opens", () => {
      // A settle Msg at the legal moment (lastAt+throttleMs = BASE+1200) emits
      // "b" — the trailing-edge guarantee is preserved, just deferred to a
      // legal instant, never lost.
      t.expectCmdSequence(
        {
          msgs: [...emitFirstThenHold, { type: "settled", at: BASE + 1_200 }],
        },
        [emit("a"), emit("b")],
      );
    });

    it("the held value's settle deadline is anchored at max(pending.at+debounceMs, lastAt+throttleMs)", () => {
      // While "b" is held, the active settle Sub must target BASE+1200
      // (lastAt+throttleMs), NOT the naive BASE+500 (pending.at+debounceMs) —
      // otherwise the runtime arms the timer for an instant at which onFlush
      // would be forced to drop or re-hold the value.
      t.expectActiveSubs({ msgs: emitFirstThenHold }, [
        deadlineSub("throttled-input:settle", BASE + 1_200),
      ]);
    });

    it("an early settle re-holds the value (so its timer re-arms) rather than dropping it", () => {
      // After an early settle Msg fires (BASE+500) without emitting, the value
      // is still pending and the settle Sub is still armed at the legal moment
      // — the trailing edge is not lost to a premature timer.
      t.expectActiveSubs(
        {
          msgs: [...emitFirstThenHold, { type: "settled", at: BASE + 500 }],
        },
        [deadlineSub("throttled-input:settle", BASE + 1_200)],
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Property tests — invariants that must hold across arbitrary input sequences.
// ---------------------------------------------------------------------------

describe("createThrottledInput — properties", () => {
  it("a held value always arms a deadline at pending.at + debounceMs; an empty pending arms nothing", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.string(),
        fc.integer({ min: 0, max: 10_000_000 }),
        (debounceMs, value, at) => {
          const cfg: ThrottledInputConfig<string, EmitCmd> = {
            debounceMs,
            emit,
          };
          const held: ThrottledInput<string> = {
            lastAt: null,
            pending: { value, at },
          };
          const subs = subsFor(cfg, held);
          const empty = subsFor(cfg, { lastAt: null, pending: null });
          return (
            empty.length === 0 &&
            subs.length === 1 &&
            (subs[0] as ReturnType<typeof deadlineSub>).atMs === at + debounceMs
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it("the rate gate is half-open: gap >= throttleMs always passes, gap < throttleMs blocks", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        (throttleMs, lastAt, gap) => {
          // Rate-only config so the only decision is the rate gate.
          const cfg: ThrottledInputConfig<string, EmitCmd> = {
            throttleMs,
            emit,
          };
          const s: ThrottledInput<string> = { lastAt, pending: null };
          const [, cmds] = input(cfg, s, "x", lastAt + gap);
          const passed = cmds.length === 1;
          return passed === gap >= throttleMs;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("a debounced gate emits exactly once per settle, carrying the last value of the burst", () => {
    // Drive a burst of inputs (each within the window) then one settle, and
    // assert the single emit carries the final value. debounceMs only so the
    // rate / dedupe gates never interfere.
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
        (burst) => {
          const cfg: ThrottledInputConfig<string, EmitCmd> = {
            debounceMs: 100,
            emit,
          };
          let s = initThrottledInput<string>();
          const emitted: EmitCmd[] = [];
          for (const [i, value] of burst.entries()) {
            let cmds: readonly EmitCmd[];
            [s, cmds] = input(cfg, s, value, i); // each input within the window
            emitted.push(...cmds);
          }
          // Nothing emitted mid-burst — every input was held.
          expect(emitted).toEqual([]);
          const [, settleCmds] = onFlush(cfg, s, burst.length + 100);
          // Exactly one emit, carrying the LAST value of the burst.
          expect(settleCmds).toEqual([emit(burst[burst.length - 1] as string)]);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("verbs never produce a slice that both has pending AND no debounceMs configured for a non-debounce gate", () => {
    // Invariant: a config with no debounceMs (passThrough / throttleOnly) never
    // leaves a value held — input either emits or drops, never holds.
    type Op = { value: string; at: number };
    const opArb: fc.Arbitrary<Op> = fc.record({
      value: fc.string(),
      at: fc.integer({ min: 0, max: 1_000_000 }),
    });
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: undefined }),
        fc.array(opArb, { maxLength: 40 }),
        (throttleMs, ops) => {
          const cfg: ThrottledInputConfig<string, EmitCmd> = {
            throttleMs,
            emit,
          };
          let s = initThrottledInput<string>();
          for (const op of ops) {
            [s] = input(cfg, s, op.value, op.at);
            // No settle window ⇒ nothing is ever held.
            expect(s.pending).toBeNull();
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  // -------------------------------------------------------------------------
  // DURABILITY GUARD (package-wide invariant, throttled-input's share).
  //
  // The persisted state of this knob IS the `ThrottledInput<V>` slice: it
  // survives DO eviction / reload, so every reachable slice must round-trip
  // through JSON unchanged — `JSON.parse(JSON.stringify(slice))` deep-equals
  // `slice`. There is no separate "terminal phase" machine here; the slice
  // itself is the terminal artifact, and its reachable shapes are exactly
  // `{ lastAt, pending, cache? }` after any sequence of `input` / `onFlush`.
  // This guards the canon: the rate cursor (`lastAt: number | null`), the held
  // value (`pending: { value, at } | null`), and the `../cache` store (plain
  // `{ entries: { [key]: { value, expiresAtMs } } }`) must all be plain data —
  // no `undefined` that JSON drops, no function/closure, no `Date`/`Error`
  // object — or the rehydrated slice would diverge from the in-memory one.
  //
  // We drive the FULL knob (all gates on, so the cache slice is exercised)
  // through arbitrary `input` / `onFlush` sequences and assert the round-trip
  // on the WHOLE slice after every verb. `V` is a STRUCTURED value (with a real
  // `cacheKey`) so the cached payload — not just the key — is asserted JSON-
  // stable, closing the same collision/serialization seam from the type side.
  // -------------------------------------------------------------------------
  it("every reachable slice round-trips through JSON unchanged (durable)", () => {
    type Query = { readonly term: string; readonly page: number };
    type QueryCmd = { readonly type: "run"; readonly key: string };
    const queryKey = (q: Query): string => `${q.term}#${q.page}`;
    const cfg: ThrottledInputConfig<Query, QueryCmd> = {
      throttleMs: 1_000,
      debounceMs: 200,
      cacheTtlMs: 5_000,
      cacheKey: queryKey,
      emit: (q) => ({ type: "run", key: queryKey(q) }),
    };
    const gate = createThrottledInput(cfg);

    const queryArb: fc.Arbitrary<Query> = fc.record({
      term: fc.string(),
      page: fc.integer({ min: 0, max: 50 }),
    });
    type Verb =
      | { kind: "input"; value: Query; at: number }
      | { kind: "flush"; at: number };
    const verbArb: fc.Arbitrary<Verb> = fc.oneof(
      fc.record({
        kind: fc.constant<"input">("input"),
        value: queryArb,
        at: fc.integer({ min: 0, max: 1_000_000 }),
      }),
      fc.record({
        kind: fc.constant<"flush">("flush"),
        at: fc.integer({ min: 0, max: 1_000_000 }),
      }),
    );

    fc.assert(
      fc.property(fc.array(verbArb, { maxLength: 40 }), (verbs) => {
        let s = gate.init();
        // The seed slice itself must be JSON-stable.
        expect(JSON.parse(JSON.stringify(s))).toEqual(s);
        for (const v of verbs) {
          s =
            v.kind === "input"
              ? gate.input(s, v.value, v.at)[0]
              : gate.onFlush(s, v.at)[0];
          // After EVERY verb the whole reachable slice round-trips unchanged.
          expect(JSON.parse(JSON.stringify(s))).toEqual(s);
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });
});
