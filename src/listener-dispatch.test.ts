import { describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  type Interpret,
  type Reducer,
  RuntimeDiscardNotice,
  run,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// Schedule, never apply (issue #202).
//
// A `dispatch` issued from inside a `subscribe` or `observe` listener is
// ENQUEUED onto the serial tail behind the fold that fired the listener — the
// rule React and Redux both hold. It is never folded re-entrantly, never
// dropped, and the listeners' issue order is the fold order. A caller
// therefore needs no `setTimeout(fn, 0)` deferral to make the dispatch land,
// which is the twenty minutes this file exists to stop anyone else spending.
//
// The mechanism is `enqueueDispatch` chaining on `tail`: fan-out runs INSIDE
// the tail step, so the step a listener's dispatch chains behind is the fold
// it is reacting to. These tests pin the observable rule, not that mechanism.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly log: readonly string[] };
type Msg =
  | { readonly type: "outer" }
  | { readonly type: "echoed" }
  | { readonly type: "fromSubscribe" }
  | { readonly type: "fromObserve" }
  | { readonly type: "later" };
type Cmd = { readonly type: "echo" };

// Every Msg appends its own name, so the folded `log` IS the fold order. The
// `outer` fold also emits a Cmd, so a listener dispatch is ordered against an
// interpret follow-up as well as against a later external one.
const update: Reducer<State, Msg, Cmd> = {
  outer: (s) => [{ log: [...s.log, "outer"] }, [{ type: "echo" }]],
  echoed: (s) => [{ log: [...s.log, "echoed"] }, []],
  fromSubscribe: (s) => [{ log: [...s.log, "fromSubscribe"] }, []],
  fromObserve: (s) => [{ log: [...s.log, "fromObserve"] }, []],
  later: (s) => [{ log: [...s.log, "later"] }, []],
};

const interpret: Interpret<Msg, Cmd, undefined> = {
  echo: async () => ({ type: "echoed" as const }),
};

const machine = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as Cmd,
    ctx: undefined,
  },
  init: () => [{ log: [] }, []],
  update,
  interpret,
});

describe("dispatch from inside a listener", () => {
  it("folds after the current fold, in listener-issue order, before a later external dispatch", async () => {
    const runtime = await run(machine, { ctx: undefined }).ready;

    // Two listeners issuing in order: `subscribe` fans out before `observe`,
    // so `fromSubscribe` must fold before `fromObserve`.
    runtime.subscribe(() => {
      if (runtime.getState().log.at(-1) !== "outer") return;
      void runtime.dispatch({ type: "fromSubscribe" });
      // Still inside the `outer` fold — the dispatch was scheduled, not
      // applied. A re-entrant fold would already have appended here.
      expect(runtime.getState().log).toEqual(["outer"]);
    });
    runtime.observe((msg) => {
      if (msg.type !== "outer") return;
      void runtime.dispatch({ type: "fromObserve" });
      expect(runtime.getState().log).toEqual(["outer"]);
    });

    await runtime.dispatch({ type: "outer" });
    await runtime.dispatch({ type: "later" });

    expect(runtime.getState().log).toEqual([
      "outer",
      // The `outer` fold's own Cmd follow-up: emitted by the transition, so it
      // is ahead of anything a listener reacting to that transition issues.
      "echoed",
      "fromSubscribe",
      "fromObserve",
      "later",
    ]);

    await runtime.stop();
  });

  it("gives a subscribe listener's getState() the state just committed", async () => {
    const runtime = await run(machine, { ctx: undefined }).ready;

    const fromSubscribe: State[] = [];
    const fromObserve: State[] = [];
    runtime.subscribe(() => {
      fromSubscribe.push(runtime.getState());
    });
    runtime.observe((_msg, state) => {
      fromObserve.push(state);
    });

    await runtime.dispatch({ type: "outer" });

    // `observe`'s `state` argument is the fold's committed State by contract;
    // `getState()` inside `subscribe` is the same State, not the one before.
    expect(fromSubscribe).toEqual(fromObserve);
    expect(fromSubscribe.at(0)?.log).toEqual(["outer"]);

    await runtime.stop();
  });

  it("raises no RuntimeDiscardNotice for a listener-issued dispatch", async () => {
    const onError = vi.fn();
    const runtime = await run(machine, { ctx: undefined, onError }).ready;

    runtime.observe((msg) => {
      if (msg.type !== "outer") return;
      void runtime.dispatch({ type: "fromObserve" });
    });

    await runtime.dispatch({ type: "outer" });

    expect(runtime.getState().log).toContain("fromObserve");
    expect(
      onError.mock.calls.filter(
        (call) => call[0] instanceof RuntimeDiscardNotice,
      ),
    ).toEqual([]);

    await runtime.stop();
  });

  it("needs no next-tick deferral when a script parks on an observed State", async () => {
    const runtime = await run(machine, { ctx: undefined }).ready;

    // The shape a scripted caller writes: park a promise, resolve it from
    // `observe`, dispatch from the continuation. No `setTimeout(resolve, 0)`.
    let seen: () => void = () => {};
    const outerSeen = new Promise<void>((resolve) => {
      seen = resolve;
    });
    runtime.observe((msg) => {
      if (msg.type === "outer") seen();
    });

    const script = (async () => {
      await outerSeen;
      await runtime.dispatch({ type: "fromObserve" });
    })();

    void runtime.dispatch({ type: "outer" });
    await script;
    await runtime.dispatch({ type: "later" });

    expect(runtime.getState().log).toEqual([
      "outer",
      "echoed",
      "fromObserve",
      "later",
    ]);

    await runtime.stop();
  });
});
