import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineMachine, type Reducer } from "../../index";
import { foldEvents } from "../runners";
import { arbMsg } from "./msg";
import { arbMsgSequence } from "./sequence";

// A machine with a deep state: `deep` takes 20 ticks, and `wait` steals draws
// the way a machine's other Msgs do.

const TICKS_TO_DEEP = 20;

type State =
  | { readonly type: "climbing"; readonly ticks: number }
  | { readonly type: "deep" };

type Msg = { type: "tick" } | { type: "wait" };

const update: Reducer<State, Msg, never> = {
  tick: (s) => {
    if (s.type === "deep") return [s, []];
    const ticks = s.ticks + 1;
    return [ticks === TICKS_TO_DEEP ? { type: "deep" } : { ...s, ticks }, []];
  },
  wait: (s) => [s, []],
};

const machine = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    ctx: {} as Record<string, never>,
  },
  init: (loaded) => [loaded ?? { type: "climbing", ticks: 0 }, []],
  update,
});

const msgArb = arbMsg<Msg>({
  tick: fc.constant({ type: "tick" as const }),
  wait: fc.constant({ type: "wait" as const }),
});

const SEEDS = [1, 42, 20261101];
const RUNS = 200;

const draw = <T>(arb: fc.Arbitrary<T>, seed: number): readonly T[] =>
  fc.sample(arb, { seed, numRuns: RUNS });

const reachesDeep = (msgs: readonly Msg[]): boolean =>
  foldEvents(machine, {}, null, msgs).finalState.type === "deep";

const longest = (lists: readonly (readonly Msg[])[]): number =>
  Math.max(...lists.map((list) => list.length));

describe("arbMsgSequence size", () => {
  it.each(SEEDS)("reaches a 20-tick state at size max, seed %i", (seed) => {
    const lists = draw(
      arbMsgSequence(msgArb, { maxLength: 60, size: "max" }),
      seed,
    );
    expect(lists.some(reachesDeep)).toBe(true);
  });

  it.each(SEEDS)("never reaches it with no size, seed %i", (seed) => {
    const lists = draw(arbMsgSequence(msgArb, { maxLength: 60 }), seed);
    expect(lists.some(reachesDeep)).toBe(false);
  });

  it.each(SEEDS)("with no size draws what fc.array draws, seed %i", (seed) => {
    expect(draw(arbMsgSequence(msgArb, { maxLength: 60 }), seed)).toEqual(
      draw(fc.array(msgArb, { minLength: 0, maxLength: 60 }), seed),
    );
  });

  it("works with minLength and prefix, and prefix stays out of the length", () => {
    const prefix: readonly Msg[] = [{ type: "wait" }, { type: "tick" }];
    const lists = draw(
      arbMsgSequence(msgArb, {
        minLength: 5,
        maxLength: 60,
        prefix,
        size: "max",
      }),
      SEEDS[0] as number,
    );

    for (const list of lists) {
      expect(list.slice(0, prefix.length)).toEqual(prefix);
      expect(list.length - prefix.length).toBeGreaterThanOrEqual(5);
      expect(list.length - prefix.length).toBeLessThanOrEqual(60);
    }
    // Past what the default size allows for this minLength: 2 * 5 + 10.
    expect(longest(lists) - prefix.length).toBeGreaterThan(20);
  });
});
