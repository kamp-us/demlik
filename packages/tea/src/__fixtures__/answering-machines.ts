/**
 * The machines `tell`'s tests run on both engines (#639). The first pair is the
 * ring that used to stop: a child reports each round to its parent from a Cmd
 * handler, the parent answers from its own, and the answer starts the child's
 * next round. Built from the neutral core only; the handlers that `tell` live in
 * each engine's suite.
 */

import { defineMachine, type Transitions } from "../index";

// === The ring: a parent and its children, answering each other ===

export type RingChildState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "working"; readonly answered: number }
  | { readonly _tag: "finished"; readonly answered: number };

export type RingChildMsg =
  | { readonly _tag: "begin" }
  | { readonly _tag: "answer"; readonly round: number };

export type RingChildCmd = {
  readonly _tag: "report";
  readonly id: string;
  readonly round: number;
};

/** A child that reports `rounds` rounds, each one only after the last's answer. */
export const ringChild = (id: string, rounds: number) => {
  const update: Transitions<RingChildState, RingChildMsg, RingChildCmd> = {
    idle: {
      begin: () => [
        { _tag: "working", answered: 0 },
        [{ _tag: "report", id, round: 1 }],
      ],
    },
    working: {
      answer: (s, m) => {
        if (s.answered + 1 === rounds) {
          return [{ _tag: "finished", answered: rounds }, []];
        }
        return [
          { _tag: "working", answered: s.answered + 1 },
          [{ _tag: "report", id, round: m.round + 1 }],
        ];
      },
    },
    finished: {},
  };
  return defineMachine({
    types: {
      model: {} as RingChildState,
      msg: {} as RingChildMsg,
      cmd: {} as RingChildCmd,
    },
    init: (loaded) => [loaded ?? { _tag: "idle" }, []],
    update,
  });
};

export type RingParentState =
  | {
      readonly _tag: "listening";
      readonly reports: Readonly<Record<string, number>>;
    }
  | {
      readonly _tag: "finished";
      readonly reports: Readonly<Record<string, number>>;
    };

export type RingParentMsg = {
  readonly _tag: "child_result";
  readonly id: string;
  readonly round: number;
};

export type RingParentCmd = {
  readonly _tag: "answer_back";
  readonly id: string;
  readonly round: number;
};

/** A parent that answers every report, until each child reported `rounds`. */
export const ringParent = (ids: readonly string[], rounds: number) =>
  defineMachine({
    types: {
      model: {} as RingParentState,
      msg: {} as RingParentMsg,
      cmd: {} as RingParentCmd,
    },
    init: (loaded) => [loaded ?? { _tag: "listening", reports: {} }, []],
    update: {
      listening: {
        child_result: (s, m) => {
          const reports = {
            ...s.reports,
            [m.id]: (s.reports[m.id] ?? 0) + 1,
          };
          const all = ids.every((id) => reports[id] === rounds);
          return [
            { _tag: all ? "finished" : "listening", reports },
            [{ _tag: "answer_back", id: m.id, round: m.round }],
          ];
        },
      },
      finished: {},
    },
  });

// === A receiver with a handler that can be held ===

export type LineState =
  | { readonly _tag: "open"; readonly folded: readonly string[] }
  | { readonly _tag: "closed"; readonly folded: readonly string[] };

export type LineMsg =
  | { readonly _tag: "hold" }
  | { readonly _tag: "ping"; readonly name: string }
  | { readonly _tag: "close" };

export type LineCmd = { readonly _tag: "wait" };

/**
 * `hold` runs a handler the test keeps waiting, so the line behind it does not
 * move. `ping` writes down its name. A closed line has no cell for `ping`.
 */
export const line = defineMachine({
  types: { model: {} as LineState, msg: {} as LineMsg, cmd: {} as LineCmd },
  init: (loaded) => [loaded ?? { _tag: "open", folded: [] }, []],
  update: {
    open: {
      hold: (s) => [s, [{ _tag: "wait" }]],
      ping: (s, m) => [{ ...s, folded: [...s.folded, m.name] }, []],
      close: (s) => [{ _tag: "closed", folded: s.folded }, []],
    },
    closed: {},
  },
});

export const ping = (name: string): LineMsg => ({ _tag: "ping", name });
