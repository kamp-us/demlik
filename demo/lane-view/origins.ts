/**
 * WHO SENDS EACH EVENT — the one fact `workflow.json` does not record.
 *
 * The library ships no such map on purpose: a document records topology and
 * never provenance, so the cast belongs to whoever's world the lane models. But
 * THIS is a fabrika viewer, so it carries fabrika's cast rather than making you
 * state it before you can see anything. Drop an `origins.json` beside a lane to
 * override it.
 *
 * It is what turns "nothing is stuck" into "`blocked` moves only when a human
 * sends `UNBLOCKED`" — without it the page can see that a task cannot move and
 * not that it is WAITING ON SOMEONE, which is the whole question you opened it
 * to answer.
 */
import type { WorkflowImportOptions } from "../../src/chart/report/workflow";

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
