// ═══════════════════════════════════════════════════════════════════════════
// THE FLEET — every lane on disk, sorted by what needs a person.
//
// One lane's page answers "what is this doing". With twelve lanes running the
// first question is different and comes first: WHICH OF THESE NEEDS ME. A list
// sorted by id cannot answer it, and neither can a list sorted by time — the
// lane that has been quiet longest is usually the one that finished.
//
// So the sort key is attention, and it is derived rather than stored: a lane
// waiting on a human outranks one that tripped, which outranks one that has
// simply gone quiet. `fabrika lane stale` answers liveness across the fleet
// (#5897 — a shell that dies leaves the ledger reading `active` forever) and
// deliberately does not answer WHY. This does, because the lane's own view
// already knows: `stuck` carries the task, the phase and the reason.
// ═══════════════════════════════════════════════════════════════════════════
import type { LaneViewModel } from "../../src/chart/lane/view";

/** Sorted most-urgent first. The order IS the answer. */
export const RANK = [
  "needs-you",
  "tripped",
  // A lane whose workflow will not parse is ranked among the defects rather
  // than above them: it is a broken file, not a person blocked on a decision.
  // It still gets a row, because the alternative — dropping it — is how a lane
  // disappears from the fleet without anyone being told it did.
  "unreadable",
  "quiet",
  "moving",
  "unstarted",
  "done",
] as const;

export type Attention = (typeof RANK)[number];

export interface FleetRow {
  readonly id: string;
  readonly attention: Attention;
  /** One line, in words. What a reader takes away without opening the lane. */
  readonly headline: string;
  /** `phase2 3/8` — where the work is, when there is more than one phase. */
  readonly progress: string | null;
  /** Minutes since the last event, or `null` for a lane that never ran. */
  readonly quietFor: number | null;
}

/**
 * A lane that could not be read at all.
 *
 * The rest of this file derives a headline FROM a view; there is no view here,
 * so the headline is the parser's own complaint. Saying "unreadable" and
 * stopping would leave the reader to go find out why on their own, which for a
 * one-character JSON error is a long walk.
 */
export function unreadableRow(id: string, why: string): FleetRow {
  return {
    id,
    attention: "unreadable",
    headline: why,
    progress: null,
    quietFor: null,
  };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Minutes of silence past which a still-running lane is worth looking at. */
export const QUIET_AFTER = 60;

export function fleetRow(
  id: string,
  view: LaneViewModel,
  lastEventAt: string | null,
  now: number,
): FleetRow {
  const quietFor =
    lastEventAt === null
      ? null
      : Math.max(0, Math.round((now - Date.parse(lastEventAt)) / 60000));

  const phase = view.phases.find((p) => p.name === view.activePhase);
  const progress =
    phase === undefined || view.phases.length < 2
      ? null
      : `${phase.name} ${phase.tasks.filter((t) => t.endPolarity !== false).length}/${phase.tasks.length}`;

  // A HUMAN FIRST, always. `awaiting-world` is the only stuck kind that names
  // someone outside the machine, and a person reading this screen is asking
  // whether they are that someone.
  const waiting = view.stuck.find((s) => s.reason.kind === "awaiting-world");
  if (waiting !== undefined && waiting.reason.kind === "awaiting-world") {
    return {
      id,
      attention: "needs-you",
      headline: `${waiting.task} is waiting on ${waiting.reason.roles.join(" or ")}`,
      progress,
      quietFor,
    };
  }

  if (view.tripped.length > 0) {
    return {
      id,
      attention: "tripped",
      headline: `${plural(view.tripped.length, "task")} stopped on an error — ${view.tripped.join(", ")}`,
      progress,
      quietFor,
    };
  }

  if (view.status === "done") {
    return {
      id,
      attention: "done",
      headline: `finished on ${view.terminal ?? "a final"}`,
      progress: null,
      quietFor,
    };
  }

  if (lastEventAt === null) {
    return {
      id,
      attention: "unstarted",
      headline: "emitted, nothing has happened yet",
      progress,
      quietFor: null,
    };
  }

  // Quiet is not the same as stuck, and saying so is the point: nothing here
  // is wrong, the lane has simply not moved, which on a live pipeline usually
  // means the shell driving it died rather than that the work is slow.
  if (quietFor !== null && quietFor >= QUIET_AFTER) {
    const other = view.stuck[0];
    return {
      id,
      attention: "quiet",
      headline:
        other === undefined
          ? `no event for ${plural(quietFor, "minute")} — is anything still driving it?`
          : `quiet for ${plural(quietFor, "minute")} · ${other.task} cannot move`,
      progress,
      quietFor,
    };
  }

  // The lane is fine and moving. Say what it is actually doing rather than the
  // word "active", which is the thing the JSON already said.
  const running = (phase?.tasks ?? []).filter((t) => t.endPolarity === false);
  return {
    id,
    attention: "moving",
    headline:
      running.length === 0
        ? "running"
        : `${plural(running.length, "task")} in flight — ${running
            .slice(0, 3)
            .map((t) => `${t.task} at ${t.state}`)
            .join(", ")}${running.length > 3 ? ", …" : ""}`,
    progress,
    quietFor,
  };
}

export const byAttention = (a: FleetRow, b: FleetRow): number => {
  const d = RANK.indexOf(a.attention) - RANK.indexOf(b.attention);
  return d !== 0 ? d : (b.quietFor ?? -1) - (a.quietFor ?? -1);
};
