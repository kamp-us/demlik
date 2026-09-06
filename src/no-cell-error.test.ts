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

// ───────────────────────────────────────────────────────────────────────────
// #14 — the refusal names the state's ACCEPTED set.
//
// Before this, learning that a state accepts nothing at all cost one dispatch
// per Msg type: every refusal was byte-identical, so "not this one" was the
// whole answer and "dead end" had to be inferred from a probe sweep. These
// pin the set on the error, the empty case stated in words, and the pre-#14
// text kept as a prefix so a caller matching on it still matches.
// ───────────────────────────────────────────────────────────────────────────

describe("NoCellError — the accepted set (#14)", () => {
  // The verbatim pre-#14 message, as a template. A caller that matched on it
  // must keep matching, so it is asserted as a PREFIX, never as equality.
  const legacy = (msgType: string, stateName: string) =>
    `@demlik/tea: no update cell for msg.type "${msgType}" in state ` +
    `"${stateName}" — the machine's update does not handle this Msg ` +
    `(an unknown wire msg.type, or a missing cell reached by bypassing ` +
    `the mapped types).`;

  // `applyCell` only ever reads `update` (+ the optional `__form` stamp), so a
  // hand-shaped machine is the narrowest way to pin a table the mapped
  // `Transitions` type deliberately cannot express — a state with no cells.
  const refusal = (machine: object, state: unknown, msgType: string) => {
    const msg: { type: string } = { type: msgType };
    try {
      applyCell(machine as { update: object }, state, msg);
    } catch (err) {
      expect(err).toBeInstanceOf(NoCellError);
      return err as NoCellError;
    }
    throw new Error(`applyCell returned — expected NoCellError for ${msgType}`);
  };

  it("transitions form: the refusing state's own row is the accepted set", () => {
    const m = {
      __form: "transitions" as const,
      update: {
        idle: { start: () => [{ type: "running" }, []] },
        running: {
          step: (s: unknown) => [s, []],
          halt: () => [{ type: "idle" }, []],
        },
      },
    };

    const e = refusal(m, { type: "running" }, "start");
    expect(e.acceptedTypes).toEqual(["step", "halt"]);
    expect(e.message).toContain('This state accepts: "step", "halt".');
    expect(e.message.startsWith(legacy("start", "running"))).toBe(true);
  });

  it("transitions form: a state with no cells says so in words, not as an empty list", () => {
    const m = {
      __form: "transitions" as const,
      update: {
        running: { freeze: () => [{ type: "frozen" }, []] },
        frozen: {},
      },
    };

    const e = refusal(m, { type: "frozen" }, "UNBLOCKED");
    expect(e.acceptedTypes).toEqual([]);
    expect(e.message).toContain("This state accepts no Msg at all.");
    expect(e.message).not.toContain("[]");
    expect(e.message.startsWith(legacy("UNBLOCKED", "frozen"))).toBe(true);
  });

  it("transitions form: a type-bypassed missing ROW accepts nothing", () => {
    const m = {
      __form: "transitions" as const,
      update: { idle: { start: () => [{ type: "idle" }, []] } },
    };

    const e = refusal(m, { type: "vanished" }, "start");
    expect(e.stateName).toBe("vanished");
    expect(e.acceptedTypes).toEqual([]);
  });

  it("reducer form: the flat table's keys are the accepted set", () => {
    const m = {
      __form: "reducer" as const,
      update: {
        bump: (s: unknown) => [s, []],
        reset: () => [{ count: 0 }, []],
      },
    };

    const e = refusal(m, { type: "counting", count: 3 }, "unknown_wire");
    expect(e.acceptedTypes).toEqual(["bump", "reset"]);
    expect(e.message).toContain('This state accepts: "bump", "reset".');
    expect(e.message.startsWith(legacy("unknown_wire", "counting"))).toBe(true);
  });

  it("reducer form: an untagged state still yields the placeholder AND the set", () => {
    const m = {
      __form: "reducer" as const,
      update: { bump: (s: unknown) => [s, []] },
    };

    const e = refusal(m, { count: 3 }, "unknown_wire");
    expect(e.stateName).toBe("(untagged state)");
    expect(e.acceptedTypes).toEqual(["bump"]);
    expect(
      e.message.startsWith(legacy("unknown_wire", "(untagged state)")),
    ).toBe(true);
  });

  it("reducer form: an empty update accepts nothing", () => {
    const e = refusal(
      { __form: "reducer" as const, update: {} },
      { type: "counting" },
      "bump",
    );
    expect(e.acceptedTypes).toEqual([]);
    expect(e.message).toContain("This state accepts no Msg at all.");
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
