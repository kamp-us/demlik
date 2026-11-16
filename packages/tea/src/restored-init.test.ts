import { describe, expect, it, vi } from "vitest";
import { defineMachine, type Reducer, replay, type Transitions } from "./index";
import { bindMachine, step } from "./testing/index";

type State = { readonly _tag: "ready"; readonly count: number };
type Msg = { readonly _tag: "add"; readonly by: number };
type Cmd = { readonly _tag: "resume" | "added" };
const loaded: State = { _tag: "ready", count: 4 };
const add: Reducer<State, Msg, Cmd>["add"] = (state, msg) => [
  { ...state, count: state.count + msg.by },
  [{ _tag: "added" }],
];

describe("restored initialization", () => {
  it("collects restored init commands and update commands without executing them", () => {
    const machine = defineMachine({
      types: { model: {} as State, msg: {} as Msg, cmd: {} as Cmd },
      init: (saved) => [
        { ...(saved ?? loaded), count: (saved ?? loaded).count + 10 },
        [{ _tag: "resume" }],
      ],
      update: { add },
    });
    const result = replay(machine, {
      loaded,
      ctx: {},
      msgs: [{ _tag: "add" as const, by: 2 }],
    });
    expect(result.state).toEqual({ _tag: "ready", count: 16 });
    expect(result.cmds).toEqual([{ _tag: "resume" }, { _tag: "added" }]);
  });

  it.each([
    "reducer",
    "transitions",
  ])("%s steps an existing state without initializing it", (form) => {
    const init = vi.fn((): readonly [State, readonly Cmd[]] => [
      { _tag: "ready", count: 999 },
      [],
    ]);
    const reducer: Reducer<State, Msg, Cmd> = { add };
    const transitions: Transitions<State, Msg, Cmd> = { ready: { add } };
    const machine = defineMachine({
      types: { model: {} as State, msg: {} as Msg, cmd: {} as Cmd },
      init,
      update: form === "reducer" ? reducer : transitions,
    });
    const expected = [{ _tag: "ready", count: 6 }, [{ _tag: "added" }]];
    expect(step(machine, loaded, { _tag: "add", by: 2 }, {})).toEqual(expected);
    expect(
      bindMachine(machine, {}).step(loaded, { _tag: "add", by: 2 }),
    ).toEqual(expected);
    expect(init).not.toHaveBeenCalled();
  });
});
