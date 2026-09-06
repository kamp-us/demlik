import { Result } from "better-result";
import { describe, expect, it } from "vitest";
import {
  applyCell,
  defineMachine,
  foldMsgs,
  type Interpret,
  NoCellError,
  type Reducer,
  type Transitions,
  tryApplyCell,
  tryFoldMsgs,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// `tryApplyCell` / `tryFoldMsgs` — refusal as DATA.
//
// `applyCell`/`foldMsgs` throw `NoCellError` on a missing cell, which is right
// for `run` (the error sink and supervision want the throw) and wrong for a
// caller that drives a machine itself and treats "this Msg does not apply
// here" as an ordinary answer. Those callers were wrapping every step in
// `try { … } catch (e) { if (e instanceof NoCellError) … }` — control flow
// through the exception channel, with a `catch` wide enough to swallow a real
// bug thrown from inside a cell.
//
// Two invariants matter beyond the happy path:
//   - the throwing and Result paths select the SAME cell (they share
//     `lookupCell`), so they can never disagree about what a machine accepts;
//   - a cell that throws from its own body is a BUG and still propagates —
//     only the ABSENCE of a cell is data.
// ───────────────────────────────────────────────────────────────────────────

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

type LightState = { readonly type: "red" } | { readonly type: "green" };
type LightMsg = { readonly type: "go" } | { readonly type: "stop" };

function lightMachine() {
  const update: Transitions<LightState, LightMsg, never> = {
    red: { go: () => [{ type: "green" }, []], stop: (s) => [s, []] },
    // No `go` cell in `green` — the state-sensitive refusal.
    green: { stop: () => [{ type: "red" }, []] },
  } as unknown as Transitions<LightState, LightMsg, never>;
  return defineMachine<LightState, LightMsg, never, never, undefined>({
    init: () => [{ type: "red" }, []],
    update,
    interpret: {} as Interpret<LightMsg, never, undefined>,
  });
}

describe("tryApplyCell", () => {
  it("Ok carries the cell's [nextState, cmds] verbatim", () => {
    const r = tryApplyCell<CounterState, CounterMsg, never>(
      counterMachine(),
      { count: 4 },
      { type: "bump" },
    );
    expect(Result.isOk(r)).toBe(true);
    if (!Result.isOk(r)) return;
    expect(r.value).toEqual([{ count: 5 }, []]);
  });

  it("Err carries the same NoCellError applyCell would have thrown", () => {
    const machine = counterMachine();
    const state: CounterState = { count: 0 };
    const wire = { type: "unknown_wire" } as unknown as CounterMsg;

    const r = tryApplyCell<CounterState, CounterMsg, never>(
      machine,
      state,
      wire,
    );
    expect(Result.isError(r)).toBe(true);
    if (!Result.isError(r)) return;
    expect(r.error).toBeInstanceOf(NoCellError);
    expect(r.error.msgType).toBe("unknown_wire");

    // Same facts the throwing twin reports — one lookup, two skins.
    let thrown: unknown;
    try {
      applyCell(machine, state, wire);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NoCellError);
    expect((thrown as NoCellError).msgType).toBe(r.error.msgType);
    expect((thrown as NoCellError).stateName).toBe(r.error.stateName);
    // Including the accepted set (#14): both skins read one `lookupCell`, so
    // neither can under-report what the refusing state would have taken.
    expect((thrown as NoCellError).acceptedTypes).toEqual(
      r.error.acceptedTypes,
    );
    expect((thrown as NoCellError).message).toBe(r.error.message);
  });

  it("refuses per STATE in transitions form, and names the state", () => {
    const m = lightMachine();
    expect(
      Result.isOk(
        tryApplyCell<LightState, LightMsg, never>(
          m,
          { type: "red" },
          { type: "go" },
        ),
      ),
    ).toBe(true);

    const r = tryApplyCell<LightState, LightMsg, never>(
      m,
      { type: "green" },
      { type: "go" },
    );
    expect(Result.isError(r)).toBe(true);
    if (!Result.isError(r)) return;
    expect(r.error.stateName).toBe("green");
    expect(r.error.msgType).toBe("go");
  });

  it("agrees with the throwing path on EVERY (state, msg) pair", () => {
    const m = lightMachine();
    const states: LightState[] = [{ type: "red" }, { type: "green" }];
    const msgs: LightMsg[] = [{ type: "go" }, { type: "stop" }];
    for (const state of states) {
      for (const msg of msgs) {
        const viaResult = tryApplyCell<LightState, LightMsg, never>(
          m,
          state,
          msg,
        );
        let threw = false;
        try {
          applyCell(m, state, msg);
        } catch {
          threw = true;
        }
        expect(Result.isError(viaResult)).toBe(threw);
      }
    }
  });

  it("a cell that THROWS from its own body still propagates — that is a bug, not data", () => {
    const boom = new Error("cell bug");
    const machine = defineMachine<
      CounterState,
      CounterMsg,
      never,
      never,
      undefined
    >({
      init: () => [{ count: 0 }, []],
      update: {
        bump: () => {
          throw boom;
        },
        reset: () => [{ count: 0 }, []],
      } as Reducer<CounterState, CounterMsg, never>,
    });
    expect(() =>
      tryApplyCell<CounterState, CounterMsg, never>(
        machine,
        { count: 0 },
        { type: "bump" },
      ),
    ).toThrow(boom);
  });
});

describe("tryFoldMsgs", () => {
  it("folds a clean log to Ok(finalState), matching foldMsgs", () => {
    const m = counterMachine();
    const msgs: CounterMsg[] = [
      { type: "bump" },
      { type: "bump" },
      { type: "reset" },
      { type: "bump" },
    ];
    const r = tryFoldMsgs<CounterState, CounterMsg, never>(
      m,
      { count: 0 },
      msgs,
    );
    expect(Result.isOk(r)).toBe(true);
    if (!Result.isOk(r)) return;
    expect(r.value).toEqual({ count: 1 });
    expect(r.value).toEqual(foldMsgs(m, { count: 0 }, msgs));
  });

  it("an empty log is Ok(base)", () => {
    const base: CounterState = { count: 7 };
    const r = tryFoldMsgs<CounterState, CounterMsg, never>(
      counterMachine(),
      base,
      [],
    );
    expect(Result.isOk(r) && r.value).toEqual(base);
  });

  it("names WHICH message failed — index, the msg itself, and the error", () => {
    // The motivating case: a persisted log that does not replay. The error
    // alone is not enough — the same msg.type usually appears many times, so
    // the INDEX is the load-bearing fact.
    const m = counterMachine();
    const bad = { type: "unknown_wire" } as unknown as CounterMsg;
    const msgs: CounterMsg[] = [
      { type: "bump" },
      { type: "bump" },
      bad,
      { type: "reset" },
    ];
    const r = tryFoldMsgs<CounterState, CounterMsg, never>(
      m,
      { count: 0 },
      msgs,
    );
    expect(Result.isError(r)).toBe(true);
    if (!Result.isError(r)) return;
    expect(r.error.index).toBe(2);
    expect(r.error.msg).toBe(bad);
    expect(r.error.error).toBeInstanceOf(NoCellError);
    expect(r.error.error.msgType).toBe("unknown_wire");
  });

  it("stops at the FIRST refusal — a later msg is never applied", () => {
    const m = counterMachine();
    const bad = { type: "nope" } as unknown as CounterMsg;
    const r = tryFoldMsgs<CounterState, CounterMsg, never>(m, { count: 0 }, [
      bad,
      { type: "bump" },
      bad,
    ]);
    expect(Result.isError(r) && r.error.index).toBe(0);
  });

  it("reports the state-sensitive refusal a transitions log hits mid-replay", () => {
    const m = lightMachine();
    const msgs: LightMsg[] = [
      { type: "go" }, // red → green
      { type: "go" }, // green has no `go` cell
    ];
    const r = tryFoldMsgs<LightState, LightMsg, never>(
      m,
      { type: "red" },
      msgs,
    );
    expect(Result.isError(r)).toBe(true);
    if (!Result.isError(r)) return;
    expect(r.error.index).toBe(1);
    expect(r.error.error.stateName).toBe("green");
  });

  it("keeps foldMsgs' dev-mode purity discipline — a mutating cell trips", () => {
    // `foldMsgs` deep-freezes the input state in DEV so an in-place mutation
    // fails loudly. The Result twin must not quietly relax that.
    const machine = defineMachine<
      CounterState,
      CounterMsg,
      never,
      never,
      undefined
    >({
      init: () => [{ count: 0 }, []],
      update: {
        bump: (s: CounterState) => {
          (s as { count: number }).count += 1;
          return [s, []] as const;
        },
        reset: () => [{ count: 0 }, []] as const,
      } as Reducer<CounterState, CounterMsg, never>,
    });
    expect(() =>
      tryFoldMsgs<CounterState, CounterMsg, never>(machine, { count: 0 }, [
        { type: "bump" },
      ]),
    ).toThrow();
  });
});
