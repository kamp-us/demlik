/**
 * @demlik/tea/persistence — `writeTrace`: write a captured `Trace` into a
 * `Store` as the boundaries a live run would have saved. A drive that records
 * in memory (`recorder` with `captureSteps: true`) can keep a failed drive's
 * recording and drop a successful one, instead of writing every drive's.
 */

import type { Store } from "../../../runtime-types";
import type { Trace } from "../recorder";

/**
 * Write a captured Trace into a Store as the frames a live run would have
 * saved: an `init` boundary for `loaded`, then one `step` boundary per
 * recorded transition, each with the State after it and the Cmds it started.
 * A store that does not record evidence keeps messages only.
 *
 * The recorder's boot observe carries no Cmds, so the `init` frame is written
 * with `cmds: []`; it equals a live run's `init` frame only when `init` starts
 * no Cmds. A step recorded without Cmds is written without Cmd evidence.
 * Throws, before it loads or saves anything, when the trace has no `loaded`
 * State, when it holds messages but no steps (record with
 * `captureSteps: true`), or when it has a different number of steps than
 * messages.
 */
export async function writeTrace<S, M extends { readonly _tag: string }>(
  store: Pick<Store<S>, "load" | "save">,
  trace: Trace<S, M>,
): Promise<void> {
  if (trace.loaded === null) {
    throw new Error("tea writeTrace: the trace has no post-init State");
  }
  if (trace.steps === undefined && trace.msgs.length > 0) {
    throw new Error(
      "tea writeTrace: the trace kept no steps; record with captureSteps: true",
    );
  }
  if (trace.steps !== undefined && trace.steps.length !== trace.msgs.length) {
    throw new Error(
      `tea writeTrace: the trace has ${trace.steps.length} steps for ${trace.msgs.length} messages`,
    );
  }
  await store.load();
  await store.save(trace.loaded, undefined, { _tag: "init", cmds: [] });
  for (const step of trace.steps ?? []) {
    await store.save(
      step.state,
      step.msg,
      step.cmds === undefined ? undefined : { _tag: "step", cmds: step.cmds },
    );
  }
}
