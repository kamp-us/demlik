/**
 * How a click reaches a run, in one place: both hooks build their `send` here.
 *
 * A view hands the run a Msg and waits for nothing. What the step ends with is
 * the run's to report, on its own sink; this file reports only what the run
 * cannot, because the Msg never reached it.
 */

import { defaultOnError, type Postable, post } from "../internal/engine/loop";
import {
  DispatchDiscardedError,
  type OnError,
  type RuntimeErrorContext,
} from "../runtime-types";

/** A failure outside the run falls back to the default sink if its sink throws. */
export function sinkOrDefault(
  sink: OnError,
  error: unknown,
  context: RuntimeErrorContext,
): void {
  try {
    sink(error, context);
  } catch (thrown) {
    defaultOnError(thrown, context);
  }
}

/** What a `send` can be built on: a run with a line to post to, or only its own `dispatch`. */
export type SendTarget<S, M extends { type: string }> =
  | Postable<S, M>
  | { dispatch(msg: M): Promise<void> };

/**
 * Every Msg goes on the line, whatever the State. One the State has no cell for
 * fails its fold with a `NoCellError`, which the run's sink hears, as the
 * caller of `dispatch` heard it: a stray click stays loud.
 */
const everyState = (): boolean => true;

/**
 * Decide once how `target` takes a Msg, and give back a `send` that waits for
 * nothing. A run from either engine's `run` carries the `post` line: its step's
 * failures go to its own sink, and a run that has stopped sends `report` a
 * discard. A handle with only `dispatch` (hand-built, or an engine with no line)
 * sends `report` whatever that `dispatch` rejects with.
 */
export function senderOf<S, M extends { type: string }>(
  target: SendTarget<S, M>,
  report: OnError,
): (msg: M) => void {
  if (post in target) {
    const line = target[post];
    return (msg) => {
      if (line(msg, everyState) === "stopped")
        report(new DispatchDiscardedError(msg.type), { phase: "discard" });
    };
  }
  return (msg) => {
    try {
      target
        .dispatch(msg)
        .catch((error: unknown) => report(error, { phase: "follow-up" }));
    } catch (error) {
      report(error, { phase: "follow-up" });
    }
  };
}
