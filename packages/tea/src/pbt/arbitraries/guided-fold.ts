// ---------------------------------------------------------------------------
// The guided fold: turn blind events into a Msg list in which every answer
// answers a Cmd that was sent and not yet answered.
//
// Any generator can draw the blind events. `arbGuidedSequence` draws them with
// fast-check, and `@demlik/tea/testing/effect` draws them with Effect's
// `Arbitrary`, so this file imports neither: one rule, two generators.
// The route: https://github.com/kamp-us/demlik/issues/745#issuecomment-6552209764
// ---------------------------------------------------------------------------

import {
  acceptedTypes,
  applyCell,
  type Cmd,
  type Machine,
  replay,
  type Sub,
} from "../../index";

/**
 * One drawn event. It means nothing until the fold reads it. An answer event
 * may carry an `otherwise` Msg, which stands in for the answer when nothing is
 * waiting, so the event is not dropped.
 */
export type BlindEvent<M> =
  | { readonly kind: "outside"; readonly msg: M }
  | {
      readonly kind: "answer";
      readonly pick: number;
      readonly values: readonly unknown[];
      readonly otherwise?: M;
    };

/**
 * Largest blind pick, read modulo the Cmds waiting. 5040 divides evenly by every
 * count from 1 to 10, so no Cmd is favoured among that many.
 */
export const MAX_PICK = 5039;

/**
 * How one Cmd type's answer is made from a drawn value. An answer event holds
 * one value per answerer, in the order of the list the fold is given.
 */
export interface Answerer<C extends Cmd, M> {
  readonly cmdType: string;
  readonly make: (cmd: C, value: unknown) => M;
}

/**
 * Fold blind events through the machine into a Msg list. An answer event's pick
 * is read modulo the Cmds waiting at that point and names one of them; with
 * nothing waiting the answer is dropped, and the event's `otherwise` Msg, when it
 * carries one, goes in its place. An event whose Msg the state has no cell for is
 * dropped too, and a refused answer leaves its Cmd waiting.
 *
 * A boot or step that throws ends the list there, so a runner's own fold meets
 * the same throw and reports it as that list's failure.
 */
export function resolveGuided<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  loaded: NoInfer<S> | null,
  answerers: readonly Answerer<C, M>[],
  events: readonly BlindEvent<M>[],
): readonly M[] {
  const index = new Map(answerers.map(({ cmdType }, at) => [cmdType, at]));

  /**
   * What an event means now: an answer to the waiting Cmd at `answers`, an outside
   * Msg (`answers` is `null`), or `null` when it is dropped.
   */
  const read = (
    event: BlindEvent<M>,
    waiting: readonly C[],
  ): { readonly msg: M; readonly answers: number | null } | null => {
    if (event.kind === "outside") return { msg: event.msg, answers: null };
    if (waiting.length === 0) {
      return event.otherwise === undefined
        ? null
        : { msg: event.otherwise, answers: null };
    }
    const at = event.pick % waiting.length;
    const cmd = waiting[at] as C;
    const cell = index.get(cmd.type) as number;
    const answerer = answerers[cell] as Answerer<C, M>;
    return { msg: answerer.make(cmd, event.values[cell]), answers: at };
  };
  const answerable = (cmds: readonly C[]): readonly C[] =>
    cmds.filter((cmd) => index.has(cmd.type));

  const msgs: M[] = [];
  const waiting: C[] = [];
  let state: S;
  try {
    const boot = replay(machine, { msgs: [], ctx, loaded });
    state = boot.state;
    waiting.push(...answerable(boot.cmds));
  } catch {
    return msgs; // The runner's fold boots too, and fails on this same throw.
  }
  for (const event of events) {
    const meant = read(event, waiting);
    if (meant === null) continue;
    const { msg, answers } = meant;
    // A refused answer takes nothing off `waiting`: its Cmd still has no answer.
    if (!acceptedTypes(machine, state).includes(msg.type)) continue;
    if (answers !== null) waiting.splice(answers, 1);
    msgs.push(msg);
    try {
      const [next, sent] = applyCell<S, M, C>(machine, state, msg);
      state = next;
      waiting.push(...answerable(sent));
    } catch {
      return msgs; // `msg` is last, so the runner's fold fails on this same throw.
    }
  }
  return msgs;
}
