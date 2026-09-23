import { describe, expect, it } from "vitest";
import {
  type Cmd,
  defineMachine,
  type Interpret,
  type Reducer,
  type Sub,
  subId,
} from "./index";
import { run } from "./promise";

// ───────────────────────────────────────────────────────────────────────────
// Handlers at run (#278, #251 R1.1). A machine is data: the Cmd handlers are
// handed to `run` beside it, so one machine file runs under whatever handlers
// the host supplies — a real backend in production, a stub in a test.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly saved: readonly number[]; readonly ticks: number };
type Msg =
  | { readonly type: "save"; readonly n: number }
  | { readonly type: "saved"; readonly n: number }
  | { readonly type: "tick" };
type SaveCmd = Cmd<"persist"> & { readonly n: number };
type TickSub = Sub<"tick">;

const update: Reducer<State, Msg, SaveCmd> = {
  save: (s, m) => [s, [{ type: "persist", n: m.n }]],
  saved: (s, m) => [{ ...s, saved: [...s.saved, m.n] }, []],
  tick: (s) => [{ ...s, ticks: s.ticks + 1 }, []],
};

const machine = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as SaveCmd,
    sub: {} as TickSub,
  },
  init: () => [{ saved: [], ticks: 0 }, []],
  update,
  subscriptions: (): readonly TickSub[] => [
    { id: subId("tick"), type: "tick" },
  ],
  // The machine's own runner never fires: it arms nothing.
  subscribe: { tick: () => () => {} },
});

describe("run(machine, { interpret })", () => {
  it("performs each Cmd through the handlers handed to run", async () => {
    const performed: number[] = [];
    const interpret: Interpret<Msg, SaveCmd, unknown> = {
      persist: async (cmd) => {
        performed.push(cmd.n);
        return { type: "saved", n: cmd.n };
      },
    };
    const rt = await run(machine, { interpret }).ready;

    await rt.dispatch({ type: "save", n: 7 });

    expect(performed).toEqual([7]);
    expect(rt.getState().saved).toEqual([7]);
    await rt.stop();
  });

  it("runs one machine under two different handler tables", async () => {
    const real = await run(machine, {
      interpret: { persist: async (c) => ({ type: "saved", n: c.n }) },
    }).ready;
    const doubled = await run(machine, {
      interpret: { persist: async (c) => ({ type: "saved", n: c.n * 2 }) },
    }).ready;

    await real.dispatch({ type: "save", n: 3 });
    await doubled.dispatch({ type: "save", n: 3 });

    expect(real.getState().saved).toEqual([3]);
    expect(doubled.getState().saved).toEqual([6]);
    await real.stop();
    await doubled.stop();
  });
});

describe("run(machine, { subscribe })", () => {
  it("replaces the machine's runner of the same Sub type", async () => {
    let fire: (() => void) | undefined;
    const rt = await run(machine, {
      interpret: { persist: async () => undefined },
      subscribe: {
        tick: (_sub, _ctx, dispatch) => {
          fire = () => dispatch({ type: "tick" });
          return () => {
            fire = undefined;
          };
        },
      },
    }).ready;

    expect(fire).toBeDefined();
    fire?.();
    await rt.idle();
    expect(rt.getState().ticks).toBe(1);

    await rt.stop();
    expect(fire).toBeUndefined();
  });

  it("keeps the machine's own runner when run names none", async () => {
    const rt = await run(machine, {
      interpret: { persist: async () => undefined },
    }).ready;
    await rt.idle();
    expect(rt.getState().ticks).toBe(0);
    await rt.stop();
  });
});
