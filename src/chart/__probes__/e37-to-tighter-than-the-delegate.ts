// PROBE 37: an edge claiming a fan-out TIGHTER than the code behind it can
// prove. `onError` delegates to `poll.tickErr`, whose declared return is
// `PollerPolling | PollerGaveUp` — so the cell's `slice.phase` is
// `"polling" | "gave_up"` and an edge saying `to: ["gave_up"]` is a claim the
// compiler cannot check and correctly rejects.
//
// This is the SHAPE of hole 2, and the direction the fix has to come from: `to`
// is bounded ABOVE by the delegate's return type, so the only way to tighten
// the picture is to tighten the verb (which is what `PollerPolling` /
// `PollerDone` / `PollerGaveUp` did — see `A74`–`A81`). No amount of declaring
// on the chart's side can buy precision the delegate does not have.
import { createPoller, type PollerState } from "../../poller";
import type { Cmd } from "../../pure/core";
import {
  type Cells,
  defineChart,
  type MsgOf,
  type StateOf,
  ty,
} from "../graph";

type R = { readonly done: boolean };
const poll = createPoller<{ readonly poll: PollerState<R> }, R>({
  everyMs: 1_000,
  until: (s) => s.poll.lastResult?.done === true,
  onTick: (): Cmd => ({ type: "read" }),
});

const chart = defineChart({
  ctx: ty<{ readonly poll: PollerState<R> }>(),
  events: {
    poll_failed: {
      data: ty<{ readonly error: string; readonly at: number }>(),
      scope: "edges",
    },
  },
  states: {
    live: {
      polling: {
        initial: true,
        on: { poll_failed: { to: ["gave_up"], cell: "onError" } },
      },
      gave_up: {},
    },
  },
});
type G = typeof chart;

export const cells: Cells<G, StateOf<G>, MsgOf<G>> = {
  onError: (s, m) => {
    const [slice] = poll.tickErr(s.poll, m.error, m.at);
    // `slice.phase` is `"polling" | "gave_up"`; the edge admits only `gave_up`.
    return [{ ...s, poll: slice, type: slice.phase }, []];
  },
};
