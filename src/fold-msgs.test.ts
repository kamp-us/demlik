/**
 * `foldMsgs(machine, base, msgs)` — the runtime-free client-prediction fold
 * seam (#211, ADR 0006).
 *
 * `foldMsgs` folds a machine's `update` over an ordered `Msg[]` starting from a
 * caller-supplied `base` state and returns the resulting state ONLY (no
 * `cmds`/`subs`). It is the client-side replay primitive a prediction loop
 * needs: re-simulate pending inputs on top of an authoritative snapshot.
 *
 * Distinct from `replay` (the test idiom): `replay` enters via `init` and
 * returns `{ state, cmds, subs }`; `foldMsgs` enters from `base`, takes no
 * `ctx`, calls no `init`, and returns just `S` — so prediction replay fires no
 * effects by construction. Both share one internal fold keyed on `formOf`, so
 * `foldMsgs` agrees with `run`/`replay` on the reducer-vs-transitions form.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Cmd,
  defineMachine,
  foldMsgs,
  type Interpret,
  type Reducer,
  replay,
  type Sub,
  type Subscribe,
  type Transitions,
} from "./index";

// ── Reducer-form machine (cells emit Cmds, so we can prove they're discarded) ──
type CounterState = { readonly count: number };
type CounterMsg =
  | { readonly type: "add"; readonly n: number }
  | { readonly type: "reset" };

function counterMachine() {
  const update: Reducer<CounterState, CounterMsg, never> = {
    add: (s, m) => [{ count: s.count + m.n }, []],
    reset: () => [{ count: 0 }, []],
  };
  return defineMachine<CounterState, CounterMsg, never, never, undefined>({
    init: () => [{ count: 0 }, []],
    update,
  });
}

// ── Transitions-form machine ──
type LightState = { readonly type: "red" } | { readonly type: "green" };
type LightMsg = { readonly type: "go" } | { readonly type: "stop" };

function lightMachine() {
  const update: Transitions<LightState, LightMsg, never> = {
    red: {
      go: () => [{ type: "green" }, []],
      stop: (s) => [s, []],
    },
    green: {
      go: (s) => [s, []],
      stop: () => [{ type: "red" }, []],
    },
  };
  return defineMachine<LightState, LightMsg, never, never, undefined>({
    init: () => [{ type: "red" }, []],
    update,
  });
}

describe("foldMsgs — folds update over Msg[] from a base state (#211)", () => {
  it("folds a reducer-form machine from base, returning the resulting state", () => {
    const m = counterMachine();
    const result = foldMsgs(m, { count: 10 }, [
      { type: "add", n: 5 },
      { type: "add", n: 2 },
    ]);
    expect(result).toEqual({ count: 17 });
  });

  it("starts from the supplied base, NOT from init (base-state entry)", () => {
    const m = counterMachine();
    // init would yield count:0; foldMsgs must honor base count:100 instead.
    const result = foldMsgs(m, { count: 100 }, [{ type: "add", n: 1 }]);
    expect(result).toEqual({ count: 101 });
  });

  it("works for a Transitions-form machine via the shared formOf reader", () => {
    const m = lightMachine();
    expect(foldMsgs(m, { type: "red" }, [{ type: "go" }])).toEqual({
      type: "green",
    });
    expect(
      foldMsgs(m, { type: "red" }, [{ type: "go" }, { type: "stop" }]),
    ).toEqual({ type: "red" });
    // base-state entry: enter mid-machine at "green", not init's "red".
    expect(foldMsgs(m, { type: "green" }, [{ type: "stop" }])).toEqual({
      type: "red",
    });
  });
});

describe("foldMsgs — fires no Store / interpret / subscription effects (#211)", () => {
  it("invokes no init, interpret, subscribe, or subscriptions — even when each would throw", () => {
    type FxState = { readonly n: number };
    type FxMsg = { readonly type: "inc" };
    type FxCmd = Cmd<"fx">;
    type FxSub = Sub<"tick">;

    // A spy: any of these firing flips a flag (and throws, to fail loudly).
    const fired = {
      init: false,
      interpret: false,
      subscribe: false,
      subscriptions: false,
    };

    const update: Reducer<FxState, FxMsg, FxCmd> = {
      // The cell EMITS a Cmd — if foldMsgs interpreted it, `fired.interpret`
      // would flip. It must discard the Cmd instead.
      inc: (s) => [{ n: s.n + 1 }, [{ type: "fx" }]],
    };
    const interpret: Interpret<FxMsg, FxCmd, undefined> = {
      fx: async () => {
        fired.interpret = true;
        throw new Error("interpret fired — foldMsgs must not interpret Cmds");
      },
    };
    const subscribe: Subscribe<FxMsg, FxSub, undefined> = {
      tick: () => {
        fired.subscribe = true;
        throw new Error("subscribe fired — foldMsgs must not start subs");
      },
    };

    const m = defineMachine<FxState, FxMsg, FxCmd, FxSub, undefined>({
      init: () => {
        fired.init = true;
        throw new Error("init fired — foldMsgs must enter from base, not init");
      },
      update,
      interpret,
      subscribe,
      subscriptions: () => {
        fired.subscriptions = true;
        throw new Error(
          "subscriptions fired — foldMsgs returns state only, no subs",
        );
      },
    });

    const result = foldMsgs(m, { n: 0 }, [
      { type: "inc" },
      { type: "inc" },
      { type: "inc" },
    ]);

    expect(result).toEqual({ n: 3 });
    expect(fired).toEqual({
      init: false,
      interpret: false,
      subscribe: false,
      subscriptions: false,
    });
  });
});

describe("foldMsgs — algebraic laws (#211)", () => {
  const counter = counterMachine();
  const light = lightMachine();

  const counterMsg: fc.Arbitrary<CounterMsg> = fc.oneof(
    fc.record({
      type: fc.constant<"add">("add"),
      n: fc.integer({ min: -1000, max: 1000 }),
    }),
    fc.constant<CounterMsg>({ type: "reset" }),
  );
  const lightMsg: fc.Arbitrary<LightMsg> = fc.constantFrom<LightMsg>(
    { type: "go" },
    { type: "stop" },
  );

  it("empty msg queue is identity on the base state (reducer form)", () => {
    fc.assert(
      fc.property(fc.integer(), (count) => {
        const base: CounterState = { count };
        expect(foldMsgs(counter, base, [])).toBe(base);
      }),
    );
  });

  it("empty msg queue is identity on the base state (transitions form)", () => {
    const base: LightState = { type: "green" };
    expect(foldMsgs(light, base, [])).toBe(base);
  });

  it("fold [a, b] equals fold [a] then fold [b] (associativity, reducer form)", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(counterMsg),
        fc.array(counterMsg),
        (count, a, b) => {
          const base: CounterState = { count };
          const oneShot = foldMsgs(counter, base, [...a, ...b]);
          const split = foldMsgs(counter, foldMsgs(counter, base, a), b);
          expect(split).toEqual(oneShot);
        },
      ),
    );
  });

  it("fold [a, b] equals fold [a] then fold [b] (associativity, transitions form)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<LightState>({ type: "red" }, { type: "green" }),
        fc.array(lightMsg),
        fc.array(lightMsg),
        (base, a, b) => {
          const oneShot = foldMsgs(light, base, [...a, ...b]);
          const split = foldMsgs(light, foldMsgs(light, base, a), b);
          expect(split).toEqual(oneShot);
        },
      ),
    );
  });

  it("agrees with replay's final state (shared internal fold)", () => {
    // replay enters via init() (here yielding count:0) then folds; foldMsgs
    // from that same init state must reach the same final state — the two
    // share one internal fold keyed on formOf, so they agree by construction.
    const msgs: readonly CounterMsg[] = [
      { type: "add", n: 3 },
      { type: "reset" },
      { type: "add", n: 9 },
    ];
    const viaReplay = replay(counter, { msgs, ctx: undefined });
    expect(foldMsgs(counter, { count: 0 }, msgs)).toEqual(viaReplay.state);
  });
});
