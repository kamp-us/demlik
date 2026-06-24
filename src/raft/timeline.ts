/**
 * @demlik/tea/raft — an ASCII step-timeline renderer for a {@link SimTrace}.
 *
 * PURE. `renderTimeline(trace)` folds a recorded trace into a deterministic,
 * paced-friendly string: a header, then one block per step — the {@link SimEvent}
 * that drove it, followed by one row per node (role · term · commit · committed
 * log), with the current leader marked and partitioned nodes flagged.
 *
 * It is a *projection of the trace*, not an instrumentation of the engine: the
 * trace already carries every node's full {@link RaftState} at every step
 * (`step.states`), so this reads that data and never touches the reducer. The
 * same renderer works for ANY trace `runSchedule` produces — the canned
 * {@link runDemo} failover, or an author's own schedule.
 *
 * Plain ASCII + a little box-drawing, no ANSI — so it renders identically in a
 * terminal, a captured asciinema cast, and a golden test assertion (the
 * deterministic-output property the rest of the raft module leans on).
 *
 * The partition set is not on `SimStep` (it lives in the sim's internal world),
 * so the renderer RECONSTRUCTS it by folding the `partition` events as it walks
 * the steps — a `{ kind: "partition", down }` sets the down-set absolutely,
 * `{ down: [] }` heals (exactly the harness's own semantics).
 */

import type { NodeId, RaftState } from "./index";
import type { ClusterStates, SimEvent, SimTrace } from "./sim";

/** Options for {@link renderTimeline}. */
export interface TimelineOptions {
  /**
   * Drop the header banner (the `@demlik/tea/raft …` title + the column key).
   * Default `false` — the banner is shown. A cast that frames its own title
   * passes `true`.
   */
  readonly noHeader?: boolean;
}

/** The committed commands of a node — `log[0 .. commitIndex)`, in order. */
function committedCommands(state: RaftState<number>): number[] {
  return state.log.slice(0, state.commitIndex).map((entry) => entry.command);
}

/** One-line summary of the move a step applied. */
function summarizeEvent(event: SimEvent): string {
  switch (event.kind) {
    case "timer":
      return `timer    · ${event.node} ${event.timer}`;
    case "deliver":
      return `deliver  · in-flight msg #${event.index}`;
    case "client":
      return `client   · ${event.node} ⟵ cmd ${event.command}`;
    case "settle":
      return `settle   · drain the network (≤ ${event.bound})`;
    case "partition":
      return event.down.length === 0
        ? "partition · HEAL — every node reachable"
        : `partition · DOWN [${[...event.down].join(", ")}] (traffic dropped)`;
  }
}

/** Pad `s` to `width` with trailing spaces (left-aligned column). */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Render one node's row. The leader of the cluster is marked with `▸`; a
 * partitioned (down) node is dimmed with `╳` and a `(down)` tag — it keeps
 * showing its last-known state because, isolated, it cannot learn otherwise.
 */
function renderNodeRow(
  id: NodeId,
  state: RaftState<number>,
  down: ReadonlySet<NodeId>,
): string {
  const isLeader = state.role._tag === "leader";
  const isDown = down.has(id);
  const marker = isDown ? "╳" : isLeader ? "▸" : " ";
  const committed = committedCommands(state);
  const logSize = state.log.length;
  // committed/total so a row shows replication progress (committed ≤ total).
  const logCell = `[${committed.join(", ")}]${
    logSize > committed.length
      ? ` (+${logSize - committed.length} uncommitted)`
      : ""
  }`;
  return (
    `  ${marker} ${pad(id, 4)} ${pad(state.role._tag, 10)} ` +
    `term ${pad(String(state.currentTerm), 3)} ` +
    `commit ${pad(String(state.commitIndex), 3)} ` +
    `log ${logCell}${isDown ? "   (down)" : ""}`
  );
}

/** Render one step block: the event header + every node's row. */
function renderStep(
  index: number,
  event: SimEvent,
  states: ClusterStates,
  nodes: readonly NodeId[],
  down: ReadonlySet<NodeId>,
): string {
  const header = `step ${pad(String(index), 3)}│ ${summarizeEvent(event)}`;
  const rows = nodes.map((id) => {
    const state = states[id];
    return state === undefined
      ? `  · ${pad(id, 4)} (absent)`
      : renderNodeRow(id, state, down);
  });
  return [header, ...rows].join("\n");
}

/**
 * Render a whole {@link SimTrace} as an ASCII step timeline. PURE +
 * deterministic — the same trace renders byte-identically every time.
 */
export function renderTimeline(
  trace: SimTrace,
  opts: TimelineOptions = {},
): string {
  const blocks: string[] = [];
  if (!opts.noHeader) {
    const majority = Math.floor(trace.nodes.length / 2) + 1;
    blocks.push(
      "═".repeat(64),
      ` @demlik/tea/raft — consensus timeline` +
        `  (${trace.nodes.length} nodes, majority ${majority})`,
      ` ▸ leader   ╳ partitioned   ·  log = [committed]`,
      "═".repeat(64),
    );
  }
  // Fold the partition set as we walk — a `partition` event sets it absolutely.
  let down: ReadonlySet<NodeId> = new Set();
  trace.steps.forEach((step, i) => {
    if (step.event.kind === "partition") {
      down = new Set(step.event.down);
    }
    blocks.push(renderStep(i + 1, step.event, step.states, trace.nodes, down));
  });
  return blocks.join("\n\n");
}
