import { describe, expect, it } from "vitest";
import { type Cmd, defineMachine } from "../index";
import { expectReplayDeterministic } from "./expect-replay-deterministic";

interface Model {
  readonly stamps: readonly number[];
}

type Msg = { readonly type: "tick"; readonly at: number };

type LogCmd = Cmd<"log"> & { readonly at: number };

const machineWith = (read: (m: Msg) => { state: number; cmd: number }) =>
  defineMachine({
    types: {
      model: {} as Model,
      msg: {} as Msg,
      cmd: {} as LogCmd,
      ctx: undefined,
    },
    init: (loaded) => [loaded ?? { stamps: [] }, []],
    update: {
      tick: (s, m) => {
        const { state, cmd } = read(m);
        return [
          { stamps: [...s.stamps, state] },
          [{ type: "log" as const, at: cmd }],
        ];
      },
    },
  });

const opts = {
  msgs: [
    { type: "tick" as const, at: 10 },
    { type: "tick" as const, at: 20 },
  ],
  ctx: undefined,
};

describe("expectReplayDeterministic", () => {
  it("passes on an update that takes time only from the Msg", () => {
    const pure = machineWith((m) => ({ state: m.at, cmd: m.at }));
    expect(() => expectReplayDeterministic(pure, opts)).not.toThrow();
  });

  it("fails when update folds Date.now() into state", () => {
    const leaky = machineWith((m) => ({ state: Date.now(), cmd: m.at }));
    expect(() => expectReplayDeterministic(leaky, opts)).toThrow(
      /final state changed/,
    );
  });

  it("fails when update folds Math.random() into state", () => {
    const leaky = machineWith((m) => ({ state: Math.random(), cmd: m.at }));
    expect(() => expectReplayDeterministic(leaky, opts)).toThrow(
      /final state changed/,
    );
  });

  it("fails when a Cmd payload carries Date.now() and state stays pure", () => {
    const leaky = machineWith((m) => ({ state: m.at, cmd: Date.now() }));
    expect(() => expectReplayDeterministic(leaky, opts)).toThrow(
      /emitted Cmds changed/,
    );
  });

  it("fails when a Cmd payload carries Math.random() and state stays pure", () => {
    const leaky = machineWith((m) => ({ state: m.at, cmd: Math.random() }));
    expect(() => expectReplayDeterministic(leaky, opts)).toThrow(
      /emitted Cmds changed/,
    );
  });

  it("fails when init reads the clock", () => {
    const leaky = defineMachine({
      types: {
        model: {} as Model,
        msg: {} as Msg,
        cmd: {} as LogCmd,
        ctx: undefined,
      },
      init: (loaded) => [loaded ?? { stamps: [Date.now()] }, []],
      update: { tick: (s) => [s, []] },
    });
    expect(() => expectReplayDeterministic(leaky, opts)).toThrow(
      /final state changed/,
    );
  });

  it("restores the global clock and RNG after it runs", () => {
    const now = Date.now;
    const random = Math.random;
    const pure = machineWith((m) => ({ state: m.at, cmd: m.at }));
    expectReplayDeterministic(pure, opts);
    expect(Date.now).toBe(now);
    expect(Math.random).toBe(random);
  });
});
