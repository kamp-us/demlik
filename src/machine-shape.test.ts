import { describe, expect, it } from "vitest";
import {
  acceptsOf,
  defineMachine,
  describeMachine,
  type Interpret,
  type Reducer,
  type Transitions,
} from "./index";
import { withTelemetry } from "./with-telemetry";

// ───────────────────────────────────────────────────────────────────────────
// `describeMachine` / `acceptsOf` — the per-state accept-sets as a public
// reading, replacing the `machine.update as Record<string, Record<string,
// unknown>>` cast an external consumer had to write to recover "which Msgs
// does each state accept".
//
// Two things are pinned here, and the second is the reason it is a FUNCTION
// and not a property on the machine:
//   1. the reading itself, per form;
//   2. that the `withX` wrappers destroy any property hung on a machine — they
//      return a fresh object literal — so a property-based design would go
//      blank on the first wrap while a derived reading keeps telling the truth
//      about the machine it is handed.
// ───────────────────────────────────────────────────────────────────────────

type LightState = { readonly type: "red" } | { readonly type: "green" };
type LightMsg = { readonly type: "go" } | { readonly type: "stop" };

function lightMachine() {
  const update: Transitions<LightState, LightMsg, never> = {
    red: { go: () => [{ type: "green" }, []], stop: (s) => [s, []] },
    green: { go: (s) => [s, []], stop: () => [{ type: "red" }, []] },
  };
  return defineMachine<LightState, LightMsg, never, never, undefined>({
    init: () => [{ type: "red" }, []],
    update,
    interpret: {} as Interpret<LightMsg, never, undefined>,
  });
}

type CounterState = { readonly count: number };
type CounterMsg = { readonly type: "bump" } | { readonly type: "reset" };

function counterMachine() {
  const update: Reducer<CounterState, CounterMsg, never> = {
    bump: (s) => [{ count: s.count + 1 }, []],
    reset: () => [{ count: 0 }, []],
  };
  return defineMachine<CounterState, CounterMsg, never, never, undefined>({
    init: () => [{ count: 0 }, []],
    update,
  });
}

describe("describeMachine — transitions form", () => {
  it("reports the form, the states, the Msg union, and the per-state accepts", () => {
    const shape = describeMachine(lightMachine());
    expect(shape).toEqual({
      form: "transitions",
      msgs: ["go", "stop"],
      states: ["red", "green"],
      accepts: { red: ["go", "stop"], green: ["go", "stop"] },
    });
  });

  it("a RAGGED table reports each row's real accept-set, not a uniform one", () => {
    // The dynamic-builder shape: plain `string` discriminants, rows that
    // genuinely differ. This is the case the cast at the consumer existed for.
    type S = { readonly type: string };
    type M = { readonly type: string };
    const m = defineMachine<S, M, never, never, undefined>({
      init: () => [{ type: "idle" }, []],
      update: {
        idle: { start: () => [{ type: "busy" }, []] },
        busy: { cancel: () => [{ type: "idle" }, []], tick: (s: S) => [s, []] },
      } as unknown as Transitions<S, M, never>,
      interpret: {} as Interpret<M, never, undefined>,
    });
    const shape = describeMachine(m);
    expect(shape.form).toBe("transitions");
    if (shape.form !== "transitions") return;
    expect(shape.accepts).toEqual({
      idle: ["start"],
      busy: ["cancel", "tick"],
    });
    expect(shape.msgs).toEqual(["start", "cancel", "tick"]);
  });
});

describe("describeMachine — reducer form", () => {
  it("carries the Msg set and NO per-state accepts (they do not exist)", () => {
    const shape = describeMachine(counterMachine());
    expect(shape).toEqual({ form: "reducer", msgs: ["bump", "reset"] });
    // The union is discriminated on `form`, so `accepts` is not merely absent
    // at runtime — it is unreachable in the type. Narrowing is the only way in.
    expect("accepts" in shape).toBe(false);
    expect("states" in shape).toBe(false);
  });

  it("an empty update is a reducer with no msgs", () => {
    expect(describeMachine({ update: {} })).toEqual({
      form: "reducer",
      msgs: [],
    });
  });
});

describe("acceptsOf", () => {
  it("answers per state for a transitions machine", () => {
    const m = lightMachine();
    expect(acceptsOf(m, "red")).toEqual(["go", "stop"]);
    expect(acceptsOf(m, "green")).toEqual(["go", "stop"]);
  });

  it("a state with no row accepts nothing", () => {
    expect(acceptsOf(lightMachine(), "amber")).toEqual([]);
  });

  it("a reducer accepts its whole Msg set in every state — the true answer", () => {
    // Not a stand-in for a missing accept-set: a flat reducer's dispatch never
    // reads the state, so the accept-set genuinely is state-independent.
    const m = counterMachine();
    expect(acceptsOf(m, "anything")).toEqual(["bump", "reset"]);
    expect(acceptsOf(m, "")).toEqual(["bump", "reset"]);
  });
});

describe("why a derived reading and not a property on the machine", () => {
  it("a withX wrapper returns a FRESH object literal — properties do not survive", () => {
    const base = lightMachine();
    // Hang a marker on the base the way a property-based design would.
    const tagged = Object.assign(base, { __marker: "present" });
    const wrapped = withTelemetry(tagged) as unknown as {
      __marker?: string;
      __form?: string;
    };
    // Gone. The wrapper builds `{ init, update, subscriptions, subscribe,
    // interpret }` from scratch; nothing else crosses the boundary. Note the
    // `__form` tag stamped by `defineMachine` is lost for the same reason.
    expect(wrapped.__marker).toBeUndefined();
    expect(wrapped.__form).toBeUndefined();
  });

  it("the derived reading tells the truth about the WRAPPED machine", () => {
    // The wrapper flattens a transitions base into a reducer over the composed
    // Model — so the wrapped machine really has no per-state accept-sets, and
    // `describeMachine` says exactly that rather than echoing the base.
    const shape = describeMachine(withTelemetry(lightMachine()));
    expect(shape.form).toBe("reducer");
    expect(shape.msgs).toEqual(["go", "stop"]);
  });
});
