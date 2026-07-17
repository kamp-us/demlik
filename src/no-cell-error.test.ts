import { describe, expect, it, vi } from "vitest";
import {
  applyCell,
  defineMachine,
  NoCellError,
  type Reducer,
  run,
  type Sub,
  type Subscribe,
  subId,
  type Transitions,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// #276 — the runtime cell-lookup guard + the subscribe vertical tracer.
//
// (a) An unknown `msg.type` (wire data reaching dispatch) or a type-bypassed
//     missing cell used to blow up as a bare `TypeError: ... is not a
//     function` inside `applyCell` — no msg.type, no state name, nothing
//     actionable. These tests pin the named `NoCellError` that replaces it,
//     carrying both facts, thrown from the ONE dispatch primitive (#275) so
//     every stepping site (run, replay, PBT, withX) gets the same error.
// (b) The tracer: a machine with a REAL Sub union and `subscribe` wired sees
//     `reconcileSubs` invoke the handler in a real `run` — the subscription
//     is observed live, not just compiled.
// ───────────────────────────────────────────────────────────────────────────

describe("NoCellError — reducer form", () => {
  type State = { readonly count: number };
  type Msg = { readonly type: "bump" };

  const update: Reducer<State, Msg, never> = {
    bump: (s) => [{ count: s.count + 1 }, []],
  };

  function machine() {
    return defineMachine<State, Msg, never, never, undefined>({
      init: () => [{ count: 0 }, []],
      update,
    });
  }

  it("dispatching an unknown msg.type rejects with NoCellError, not a bare TypeError", async () => {
    // no-op onError: the failed transition also reports to the runtime's
    // error sink; the assertion target is the dispatch rejection itself.
    const runtime = await run(machine(), {
      ctx: undefined,
      onError: () => {},
    }).ready;
    const wire = { type: "unknown_wire" } as unknown as Msg;

    await runtime.dispatch(wire).then(
      () => {
        throw new Error("dispatch resolved — expected NoCellError");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(NoCellError);
        expect(err).not.toBeInstanceOf(TypeError);
        const e = err as NoCellError;
        expect(e.name).toBe("NoCellError");
        expect(e.msgType).toBe("unknown_wire");
        expect(e.message).toContain('"unknown_wire"');
      },
    );
    await runtime.stop();
  });

  it("a known msg.type still dispatches normally", async () => {
    const runtime = await run(machine(), { ctx: undefined }).ready;
    await runtime.dispatch({ type: "bump" });
    expect(runtime.getState().count).toBe(1);
    await runtime.stop();
  });
});

describe("NoCellError — transitions form carries the current state name", () => {
  type State =
    | { readonly type: "idle" }
    | { readonly type: "running"; readonly n: number };
  type Msg = { readonly type: "start" } | { readonly type: "step" };

  const update: Transitions<State, Msg, never> = {
    idle: {
      start: () => [{ type: "running", n: 0 }, []],
      step: (s) => [s, []],
    },
    running: {
      start: (s) => [s, []],
      step: (s) => [{ type: "running", n: s.n + 1 }, []],
    },
  };

  function machine() {
    return defineMachine<State, Msg, never, never, undefined>({
      init: () => [{ type: "idle" }, []],
      update,
    });
  }

  it("names both the msg.type and the state the machine was in", async () => {
    const runtime = await run(machine(), {
      ctx: undefined,
      onError: () => {},
    }).ready;
    await runtime.dispatch({ type: "start" });
    const wire = { type: "bogus" } as unknown as Msg;

    await runtime.dispatch(wire).then(
      () => {
        throw new Error("dispatch resolved — expected NoCellError");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(NoCellError);
        const e = err as NoCellError;
        expect(e.msgType).toBe("bogus");
        expect(e.stateName).toBe("running");
        expect(e.message).toContain('"bogus"');
        expect(e.message).toContain('"running"');
      },
    );
    await runtime.stop();
  });

  it("a type-bypassed missing ROW (unknown state.type) is the same named error", () => {
    const m = machine();
    const rogueState = { type: "vanished" } as unknown as State;
    expect(() => applyCell(m, rogueState, { type: "step" })).toThrowError(
      NoCellError,
    );
    try {
      applyCell(m, rogueState, { type: "step" });
    } catch (err) {
      const e = err as NoCellError;
      expect(e.msgType).toBe("step");
      expect(e.stateName).toBe("vanished");
    }
  });
});

describe("vertical tracer — a real Sub union wired through subscribe runs live (#276)", () => {
  // A two-phase machine: `start` moves to `running`, whose subscriptions
  // declare one `tick` Sub. The subscribe handler fires a `ticked` follow-up
  // and records its own invocation + cleanup — proving `reconcileSubs`
  // started it in a real run and reconciled it out on the transition away.
  type State =
    | { readonly type: "idle"; readonly ticks: number }
    | { readonly type: "running"; readonly ticks: number };
  type Msg =
    | { readonly type: "start" }
    | { readonly type: "ticked" }
    | { readonly type: "halt" };
  type TickSub = Sub<"tick">;

  const started = vi.fn();
  const cleaned = vi.fn();

  const update: Transitions<State, Msg, never> = {
    idle: {
      start: (s) => [{ type: "running", ticks: s.ticks }, []],
      ticked: (s) => [s, []],
      halt: (s) => [s, []],
    },
    running: {
      start: (s) => [s, []],
      ticked: (s) => [{ type: "running", ticks: s.ticks + 1 }, []],
      halt: (s) => [{ type: "idle", ticks: s.ticks }, []],
    },
  };

  const subscribe: Subscribe<Msg, TickSub, undefined> = {
    tick: (_sub, _ctx, dispatch) => {
      started();
      dispatch({ type: "ticked" });
      return cleaned;
    },
  };

  function machine() {
    return defineMachine<State, Msg, never, TickSub, undefined>({
      init: () => [{ type: "idle", ticks: 0 }, []],
      update,
      subscriptions: (s) =>
        s.type === "running" ? [{ id: subId("tick"), type: "tick" }] : [],
      subscribe,
    });
  }

  it("reconcileSubs invokes the handler live, its dispatch lands, and cleanup fires on the way out", async () => {
    started.mockClear();
    cleaned.mockClear();
    const runtime = await run(machine(), { ctx: undefined }).ready;

    expect(started).not.toHaveBeenCalled(); // idle declares no subs

    await runtime.dispatch({ type: "start" });
    await runtime.idle();
    expect(started).toHaveBeenCalledTimes(1); // handler ran in the real run
    expect(runtime.getState()).toEqual({ type: "running", ticks: 1 }); // its dispatch landed

    await runtime.dispatch({ type: "halt" });
    expect(cleaned).toHaveBeenCalledTimes(1); // reconciled out on transition away

    await runtime.stop();
  });
});
