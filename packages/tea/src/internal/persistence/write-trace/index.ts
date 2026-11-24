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
 * A windowed trace (`recorder(..., { window })`) carries `Trace.skipped`, the
 * transitions before its moved anchor. It is passed on the `init` boundary as
 * `skipped`, so a store that numbers its frames stores the anchor at
 * `skipped + 1` and every step at the number the live run gave it, and refuses
 * the write when its log already has frames. A trace without `skipped` is
 * written exactly as before.
 *
 * Throws, before it loads or saves anything, when the trace has no `loaded`
 * State, when it holds messages but no steps (record with
 * `captureSteps: true`), when it has a different number of steps than
 * messages, when its `skipped` is not a non-negative integer, or when its
 * last step would be numbered past `Number.MAX_SAFE_INTEGER`.
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
  const { skipped } = trace;
  if (
    skipped !== undefined &&
    (!Number.isSafeInteger(skipped) || skipped < 0)
  ) {
    throw new Error(
      `tea writeTrace: the trace's skipped count must be an integer >= 0, got ${skipped}`,
    );
  }
  const last = (skipped ?? 0) + (trace.steps?.length ?? 0) + 1;
  if (!Number.isSafeInteger(last)) {
    throw new Error(
      `tea writeTrace: the trace's last sequence ${last} is not a safe integer`,
    );
  }
  await store.load();
  await store.save(
    trace.loaded,
    undefined,
    skipped === undefined
      ? { _tag: "init", cmds: [] }
      : { _tag: "init", cmds: [], skipped },
  );
  for (const step of trace.steps ?? []) {
    await store.save(
      step.state,
      step.msg,
      step.cmds === undefined ? undefined : { _tag: "step", cmds: step.cmds },
    );
  }
}
