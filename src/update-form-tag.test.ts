import { describe, expect, it } from "vitest";
import {
  defineMachine,
  detectUpdateForm,
  formOf,
  type Interpret,
  type Reducer,
  replay,
  run,
  type Transitions,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// Update-form tag (#57): `defineMachine` stamps a non-enumerable `__form`
// ("reducer" | "transitions") ONCE at construction; `run`, `replay`, and the
// `withX` wrappers read it via `formOf` instead of re-deriving it structurally.
// These tests pin the tag mechanism: it is set, it is non-enumerable (never
// serializes / never collides with a Msg.type key), and it is authoritative
// over the structural heuristic — so a reducer whose cell is an
// object-with-a-call no longer flips the form to "transitions".
// ───────────────────────────────────────────────────────────────────────────

type CounterState = { readonly count: number };
type CounterMsg = { readonly type: "bump" };

function reducerMachine() {
  const update: Reducer<CounterState, CounterMsg, never> = {
    bump: (s) => [{ count: s.count + 1 }, []],
  };
  return defineMachine<CounterState, CounterMsg, never, never, undefined>({
    init: () => [{ count: 0 }, []],
    update,
    interpret: {} as Interpret<CounterMsg, never, undefined>,
  });
}

type LightState = { readonly type: "red" } | { readonly type: "green" };
type LightMsg = { readonly type: "go" } | { readonly type: "stop" };

function transitionsMachine() {
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
    interpret: {} as Interpret<LightMsg, never, undefined>,
  });
}

describe("defineMachine stamps a non-enumerable __form (#57)", () => {
  it("tags a Reducer-form machine as 'reducer'", () => {
    const m = reducerMachine();
    expect(m.__form).toBe("reducer");
    expect(formOf(m)).toBe("reducer");
  });

  it("tags a Transitions-form machine as 'transitions'", () => {
    const m = transitionsMachine();
    expect(m.__form).toBe("transitions");
    expect(formOf(m)).toBe("transitions");
  });

  it("the tag is non-enumerable — never serializes, never lists in keys", () => {
    const m = reducerMachine();
    expect(Object.keys(m)).not.toContain("__form");
    expect(JSON.stringify(m)).not.toContain("__form");
    // …but it is present as an own property for `formOf` to read.
    expect(Object.getOwnPropertyNames(m)).toContain("__form");
  });

  it("is idempotent under re-wrap (defineMachine(defineMachine(m)))", () => {
    const once = reducerMachine();
    const twice = defineMachine(once);
    expect(twice.__form).toBe("reducer");
    expect(twice).toBe(once); // identity pass-through, no clone
  });
});

describe("__form is authoritative over the structural heuristic (#57)", () => {
  // The bug the tag fixes: a reducer cell that is an object-with-a-call (a
  // callable carrying own-enumerable data keys) makes a naive
  // `Object.keys(firstValue)` style inspection see a non-empty record and
  // mis-read the flat Reducer as a 2D Transitions table. Because `formOf`
  // prefers the stamped `__form`, the form stays "reducer" regardless of what
  // the cell value's own keys look like.
  type CState = { readonly n: number };
  type CMsg = { readonly type: "tick" };

  it("a callable-with-keys reducer cell stays 'reducer'", () => {
    const tick = Object.assign((s: CState) => [{ n: s.n + 1 }, []] as const, {
      // extra own-enumerable keys hanging off the cell function
      label: "tick-cell",
      go: () => undefined,
    });
    const update = { tick } as unknown as Reducer<CState, CMsg, never>;
    const m = defineMachine<CState, CMsg, never, never, undefined>({
      init: () => [{ n: 0 }, []],
      update,
      interpret: {} as Interpret<CMsg, never, undefined>,
    });
    expect(m.__form).toBe("reducer");
    expect(formOf(m)).toBe("reducer");
  });

  it("formOf falls back to detectUpdateForm when no tag is present", () => {
    // A machine that never passed through defineMachine carries no __form.
    const raw = {
      init: () => [{ n: 0 }, []] as const,
      update: { tick: (s: CState) => [{ n: s.n + 1 }, []] as const },
      interpret: {},
    };
    expect((raw as { __form?: string }).__form).toBeUndefined();
    expect(formOf(raw as { update: object })).toBe("reducer");
    expect(detectUpdateForm(raw.update)).toBe("reducer");
  });
});

describe("run and replay agree on the tagged form (#57)", () => {
  it("run dispatches a tagged Reducer machine correctly", async () => {
    const rt = await run(reducerMachine(), { ctx: undefined }).ready;
    await rt.dispatch({ type: "bump" });
    await rt.dispatch({ type: "bump" });
    expect(rt.getState().count).toBe(2);
  });

  it("run dispatches a tagged Transitions machine correctly", async () => {
    const rt = await run(transitionsMachine(), { ctx: undefined }).ready;
    await rt.dispatch({ type: "go" });
    expect(rt.getState().type).toBe("green");
    await rt.dispatch({ type: "stop" });
    expect(rt.getState().type).toBe("red");
  });

  it("replay folds a tagged Transitions machine via the same tag", () => {
    const out = replay(transitionsMachine(), {
      msgs: [{ type: "go" }, { type: "stop" }, { type: "go" }] as LightMsg[],
    });
    expect(out.state.type).toBe("green");
  });

  it("replay folds a tagged Reducer machine via the same tag", () => {
    const out = replay(reducerMachine(), {
      msgs: [
        { type: "bump" },
        { type: "bump" },
        { type: "bump" },
      ] as CounterMsg[],
    });
    expect(out.state.count).toBe(3);
  });
});
