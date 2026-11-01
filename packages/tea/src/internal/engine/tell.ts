/**
 * The one `tell` both engines' helpers call (ADR 0029, item 5), so what each
 * answer means cannot drift between them. It reads the machine's accepted Msgs
 * for the loop, which holds the gate and the State but not the cell table.
 */

import { acceptedTypes } from "../../pure/core";
import { type Postable, post, type TellAnswer } from "./loop";

/**
 * Hand `msg` to the run behind `runtime`. The public handle types do not carry
 * the `post` symbol, so a handle that did not come from `run` is refused here,
 * loudly: it has no line to put a Msg on.
 */
export function tellRun<S, M extends { type: string }>(
  machine: Parameters<typeof acceptedTypes>[0],
  runtime: object,
  msg: M,
): TellAnswer {
  const postable = (runtime as Partial<Postable<S, M>>)[post];
  if (postable === undefined) {
    throw new Error(
      "@demlik/tea: `tell` needs a run handle from `run`; this object has no line to post to.",
    );
  }
  return postable(msg, (state) =>
    acceptedTypes(machine, state).includes(msg.type),
  );
}
