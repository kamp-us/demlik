import type { Machine } from "../../packages/tea/src/index.js";
import {
  type BoundMachine,
  bindMachine,
  expectCmdEmitted,
  expectCmdSequence,
  expectFinalState,
  type ReplayOpts,
  step,
} from "../../packages/tea/src/testing/index.js";

type State = { type: "ready"; n: number };
type Msg = { type: "add"; by: number };
type Cmd = { type: "run"; value: string };
type Ctx = { label: string };
export function declaredChannels(
  machine: Machine<State, Msg, Cmd, never, Ctx>,
  ctx: Ctx,
) {
  const opts: ReplayOpts<State, Msg, Ctx> = { ctx, msgs: [] };
  const bound: BoundMachine<State, Msg, Cmd, never, Ctx> = bindMachine(
    machine,
    ctx,
  );
  expectCmdSequence(machine, opts, []);
  bound.expectCmdSequence({ msgs: [] }, []);
  // @ts-expect-error Expected state stays anchored to the machine's State.
  expectFinalState(machine, opts, { type: "ready", n: "wrong" });
  // @ts-expect-error Expected command stays anchored to the machine's Cmd.
  expectCmdEmitted(machine, opts, { type: "run", value: 17 });
  // @ts-expect-error Bound command checking retains the authored Cmd channel.
  bound.expectCmdEmitted({ msgs: [] }, { type: "other" });
  // @ts-expect-error Direct step does not widen the authored Msg channel.
  step(machine, { type: "ready", n: 0 }, { type: "add", by: "wrong" }, ctx);
}
