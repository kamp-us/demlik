// ═══════════════════════════════════════════════════════════════════════════
// SENDING AN EVENT — the page proposes, fabrika disposes.
//
// THE ONE RULE HERE: this never writes `events.jsonl`. `lane transition`'s own
// contract is "record one operator event AFTER the machine accepts it, never
// before" — it refuses an event with no cell in the task's current state, one
// outside the operator's six, a task outside the active phase, or a finished
// workflow, and leaves the log byte-identical when it does.
//
// A second writer would have to re-implement every one of those refusals and
// would drift from them the first time either side changed. So the page shells
// out to the CLI that already owns the ledger, and a refusal is an answer we
// display rather than a case we handle. One writer, one set of rules.
// ═══════════════════════════════════════════════════════════════════════════

/** The operator's six. `lane transition` refuses anything else anyway. */
export const OPERATOR_EVENTS = [
  "WIP",
  "DONE",
  "PASS",
  "FAIL",
  "BLOCKED",
  "UNBLOCKED",
] as const;

export type OperatorEvent = (typeof OPERATOR_EVENTS)[number];

export interface DispatchRequest {
  readonly lane: string;
  readonly event: OperatorEvent;
  /** Omittable on a single-task lane, exactly as the verb is. */
  readonly task?: string;
}

export interface DispatchResult {
  readonly ok: boolean;
  /** The verb's own exit code — 12 is "refused, log unappended". */
  readonly exit: number;
  /** What the operator would have seen in their terminal. */
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * What a non-zero exit MEANS, in the words a reader needs.
 *
 * Straight off `lane transition --help`. A refusal is not a failure of the
 * page — it is the machine saying no, and the reason belongs on screen.
 */
export function explainExit(exit: number, stderr: string): string {
  const trimmed = stderr.trim();
  switch (exit) {
    case 0:
      return "recorded";
    case 12:
      return trimmed || "the machine refused it — nothing was recorded";
    case 13:
      return trimmed || "that task is not in the machine";
    case 7:
      return "there is no lane there";
    case 8:
      return "the append did not land — the event is NOT recorded";
    case 4:
    case 11:
      return trimmed || "the lane record could not be read";
    default:
      return trimmed || `fabrika exited ${exit}`;
  }
}

export async function send(req: DispatchRequest): Promise<DispatchResult> {
  const res = await fetch("/__lane/transition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  return (await res.json()) as DispatchResult;
}
