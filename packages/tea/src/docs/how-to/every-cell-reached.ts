/**
 * The check both halves of the drive how-to share (#929): the cases the page
 * shows reach every update cell of the machine it drives.
 *
 * It sits outside the page's `#region`s, so a reader copying the page gets the
 * cases and not this. `docs/how-to/test-a-machine-with-drive.md` is backed by
 * `./test-a-machine-with-drive.test.ts` (Promise engine) and
 * `../../testing/effect/drive-how-to.test.ts` (Effect engine); each hands this
 * the trace of every `drive` its cases ran.
 */

import { expect } from "vitest";
import type { DriveTraceEntry } from "../../testing/drive-loop";

/** One run's trace, whichever engine's `drive` returned it. */
export type Trace = readonly DriveTraceEntry<
  { readonly type: string },
  unknown
>[];

/**
 * Fail unless the Msg types folded across `traces` are exactly the keys of
 * `machine.update`, so an update cell added to the machine fails the page's
 * tests until a case reaches it.
 */
export function expectEveryCellReached(
  machine: { readonly update: object },
  traces: readonly Trace[],
): void {
  const reached = new Set(
    traces.flatMap((trace) =>
      trace.flatMap((entry) => (entry.kind === "msg" ? [entry.msg.type] : [])),
    ),
  );
  expect([...reached].sort()).toEqual(Object.keys(machine.update).sort());
}
