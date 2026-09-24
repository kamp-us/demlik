import { defineMachine } from "@demlik/tea";

/** A child: counts the jobs it has done. */
export interface WorkerState {
  readonly done: number;
}

export type WorkerMsg = { readonly type: "job" };

export const worker = defineMachine({
  types: { model: {} as WorkerState, msg: {} as WorkerMsg },
  init: (loaded) => [loaded ?? { done: 0 }, []],
  update: {
    job: (s) => [{ done: s.done + 1 }, []],
  },
});

/** The parent: lists the children that stopped, until it closes. */
export type ParentState =
  | { readonly type: "open"; readonly stopped: readonly string[] }
  | { readonly type: "closed"; readonly stopped: readonly string[] };

export type ParentMsg =
  | { readonly type: "child_stopped"; readonly id: string }
  | { readonly type: "close" };

export const parent = defineMachine({
  types: { model: {} as ParentState, msg: {} as ParentMsg },
  init: (loaded) => [loaded ?? { type: "open", stopped: [] }, []],
  update: {
    open: {
      child_stopped: (s, m) => [{ ...s, stopped: [...s.stopped, m.id] }, []],
      close: (s) => [{ type: "closed", stopped: s.stopped }, []],
    },
    // A closed parent takes no Msg, so it has no cell for `child_stopped`.
    closed: {},
  },
});
