import { describe, expect, it, vi } from "vitest";
import { defineMachine, type Reducer, replay, type Transitions } from "./index";
import { bindMachine, step } from "./testing/index";

type State = { readonly type: "ready"; readonly count: number };
type Msg = { readonly type: "add"; readonly by: number };
type Cmd = { readonly type: "resume" | "added" };
const loaded: State = { type: "ready", count: 4 };
const add: Reducer<State, Msg, Cmd>["add"] = (state, msg) => [
  { ...state, count: state.count + msg.by },
  [{ type: "added" }],
];

describe("restored initialization", () => {
  it("collects restored init commands and update commands without executing them", () => {
    const machine = defineMachine({
      types: { model: {} as State, msg: {} as Msg, cmd: {} as Cmd },
      init: (saved) => [
        { ...(saved ?? loaded), count: (saved ?? loaded).count + 10 },
        [{ type: "resume" }],
      ],
      update: { add },
    });
    const result = replay(machine, {
      loaded,
      ctx: {},
      msgs: [{ type: "add" as const, by: 2 }],
    });
    expect(result.state).toEqual({ type: "ready", count: 16 });
    expect(result.cmds).toEqual([{ type: "resume" }, { type: "added" }]);
  });

  it.each([
    "reducer",
    "transitions",
  ])("%s steps an existing state without initializing it", (form) => {
    const init = vi.fn((): readonly [State, readonly Cmd[]] => [
      { type: "ready", count: 999 },
      [],
    ]);
    const reducer: Reducer<State, Msg, Cmd> = { add };
    const transitions: Transitions<State, Msg, Cmd> = { ready: { add } };
    const machine = defineMachine({
      types: { model: {} as State, msg: {} as Msg, cmd: {} as Cmd },
      init,
      update: form === "reducer" ? reducer : transitions,
    });
    const expected = [{ type: "ready", count: 6 }, [{ type: "added" }]];
    expect(step(machine, loaded, { type: "add", by: 2 }, {})).toEqual(expected);
    expect(
      bindMachine(machine, {}).step(loaded, { type: "add", by: 2 }),
    ).toEqual(expected);
    expect(init).not.toHaveBeenCalled();
  });
});
