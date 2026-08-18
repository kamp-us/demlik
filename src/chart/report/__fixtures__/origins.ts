/**
 * FABRIKA'S CAST — who sends each of the operator's six events.
 *
 * A FIXTURE, deliberately, and this is the whole point of the boundary: the
 * library ships no such map. `workflow.json` records topology and never
 * provenance, so the fact lives in fabrika's code (`wire/lane-brief.ts` decides
 * which states spawn a shell; the CLI's `emit` verb is what an operator and a
 * human reach for), and the caller states it ONCE where their world meets ours.
 *
 * This is that statement, for the two committed templates. A different consumer
 * writes a different one — a checkout's `{ world: "the shopper" }`, an ops
 * tool's `{ world: "the on-call" }` — and every reader downstream works
 * unchanged, because the taxonomy is fixed and the cast is not.
 *
 * Keyed by the BARE event name: `ISSUE.WIP` and `PARK_SWEEP.WIP` are the same
 * `WIP`, and the namespace is presentation.
 *
 *   WIP / BLOCKED   the operator, driving the lane by hand or by agent
 *   UNBLOCKED       a human, and only a human — that is what parking is FOR
 *   DONE/PASS/FAIL  the work the lane dispatched, answering: fabrika spawns a
 *                   shell on entering a working state and the shell reports
 *                   back, which is a Cmd's result in every sense TEA means it
 */
import type { WorkflowImportOptions } from "../workflow";

export const FABRIKA_ORIGINS: WorkflowImportOptions = {
  from: {
    WIP: { world: "the operator" },
    BLOCKED: { world: "the operator" },
    UNBLOCKED: { world: "a human" },
    DONE: "cmd",
    PASS: "cmd",
    FAIL: "cmd",
  },
};
