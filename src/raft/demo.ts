/**
 * @demlik/tea/raft — a runnable, deterministic multi-node Raft demo (#123,
 * stories 7+8 of epic #117). The live demo the docs reference: it boots a
 * 3-node cluster and drives the full consensus arc through {@link runSchedule}
 * — elect a leader, replicate + commit a client command to a majority, KILL the
 * leader (a network partition), watch the surviving majority elect a NEW leader,
 * and show the committed log converged across the survivors.
 *
 * It is a thin, readable composition over the existing simulation harness
 * (`./sim`): every phase is just a slice of one fixed {@link Schedule}, so the
 * whole run is pure, replayable, and byte-identical on re-run (the determinism
 * the safety suite already enforces — here turned into a watchable narrative).
 * It owns NO clock, NO RNG, NO IO beyond an optional narration printer.
 *
 * Two entry points:
 *   - {@link runDemo} — fold the scripted schedule, return a structured
 *     {@link DemoResult} (the phases, the per-phase cluster summary, the final
 *     trace). Pure: it asserts nothing and prints nothing — the test and the
 *     CLI both read its result.
 *   - {@link narrateDemo} — render a {@link DemoResult} as readable lines (the
 *     `pnpm demo:raft` output). Pure string-building; the runner does the IO.
 *
 * Run it:  `pnpm --filter @demlik/tea demo:raft`
 * (see `src/raft/README.md`).
 */

import type { NodeId, RaftState } from "./index";
import {
  type ClusterStates,
  clusterConfigs,
  type RaftConfig,
  replaySchedule,
  runSchedule,
  type Schedule,
  type SimTrace,
} from "./sim";

// ===========================================================================
// The scripted scenario — one fixed schedule, sliced into named phases
// ===========================================================================

// The demo cluster is the 3 default nodes n0/n1/n2 (see {@link clusterConfigs}).
// Only the two nodes the script names explicitly need constants; the rest of the
// cluster is addressed via `nodes`.
const N0 = "n0";
const N1 = "n1";

/** The two client commands the demo replicates (opaque numeric payloads). */
const FIRST_COMMAND = 42;
const SECOND_COMMAND = 77;

/**
 * One phase of the demo: a human-readable headline plus the slice of the
 * schedule that drives it. Concatenating every phase's `events` in order yields
 * the full {@link Schedule} {@link runDemo} folds — so the phase boundaries are
 * exactly the trace-step boundaries, and narration lines up with the trace.
 */
interface DemoPhase {
  /** What this phase demonstrates (printed as the section headline). */
  readonly title: string;
  /** A one-line plain-language description of the move. */
  readonly note: string;
  /** The schedule events this phase contributes (in order). */
  readonly events: Schedule;
}

/**
 * The scripted arc. Each phase is a deterministic macro over the harness:
 *
 *   1. n0's election timer fires; `settle` drains the RequestVote round → n0
 *      wins a majority (n0+n1, or n0+n2) and becomes leader of term 1, then its
 *      first heartbeat round drains.
 *   2. A client command hits the leader; `settle` runs the AppendEntries
 *      replication + success replies → the entry commits on a majority.
 *   3. `partition` isolates n0 (the leader): the transport now drops every
 *      message to/from n0. n0 can no longer heartbeat the cluster.
 *   4. A surviving follower (n1) times out and starts an election; `settle`
 *      drains it across the survivors {n1,n2} (a majority of 3) → n1 becomes
 *      leader of a HIGHER term.
 *   5. A client command hits the NEW leader; `settle` replicates it → it commits
 *      on the surviving majority. The survivors' committed logs have converged.
 *
 * The `bound`s are generous caps (the FIFO drain stops early when the pool is
 * empty); they only guard against a pathological re-emit loop.
 */
const PHASES: readonly DemoPhase[] = [
  {
    title: "1. Elect a leader",
    note: "n0 times out, runs an election, and wins a majority (term 1).",
    events: [
      { kind: "timer", node: N0, timer: "election" },
      { kind: "settle", bound: 30 },
    ],
  },
  {
    title: "2. Replicate + commit a command",
    note: `client sends ${FIRST_COMMAND} to the leader; it replicates to a majority, commits, and the next heartbeat carries the commit to the followers.`,
    events: [
      { kind: "client", node: N0, command: FIRST_COMMAND },
      { kind: "settle", bound: 30 },
      // The leader's commitIndex advances on the success replies, but followers
      // only learn it on the NEXT AppendEntries (Figure 2 `leaderCommit`). One
      // heartbeat round propagates the commit so the cluster converges.
      { kind: "timer", node: N0, timer: "heartbeat" },
      { kind: "settle", bound: 30 },
    ],
  },
  {
    title: "3. Kill the leader",
    note: "partition isolates n0 — the transport drops all traffic to/from it.",
    events: [{ kind: "partition", down: [N0] }],
  },
  {
    title: "4. A new leader is elected",
    note: "a surviving follower (n1) times out and wins the surviving majority {n1,n2} in a higher term.",
    events: [
      { kind: "timer", node: N1, timer: "election" },
      { kind: "settle", bound: 30 },
    ],
  },
  {
    title: "5. Replicate on the new leader → logs converged",
    note: `client sends ${SECOND_COMMAND} to the new leader; it commits on the surviving majority, and a heartbeat converges the survivors' committed logs.`,
    events: [
      { kind: "client", node: N1, command: SECOND_COMMAND },
      { kind: "settle", bound: 30 },
      // Same as phase 2: a heartbeat round carries the new commitIndex to the
      // surviving follower (n2) so every survivor's committed log converges.
      { kind: "timer", node: N1, timer: "heartbeat" },
      { kind: "settle", bound: 30 },
    ],
  },
] as const;

// ===========================================================================
// Cluster-state reading — the demo's view of "who leads / what committed"
// ===========================================================================

/** A compact, JSON-friendly read of one node's state (what the demo reports). */
export interface NodeSummary {
  /** The node's id. */
  readonly id: NodeId;
  /** Its role this snapshot: follower / candidate / leader. */
  readonly role: RaftState["role"]["_tag"];
  /** Its current term. */
  readonly term: number;
  /** Its commit index (entries at or below this are committed). */
  readonly commitIndex: number;
  /** The COMMITTED commands, in log order (entries `1..commitIndex`). */
  readonly committed: readonly number[];
}

/** Read one node's committed commands (the prefix of its log up to commitIndex). */
export function committedCommands(state: RaftState<number>): readonly number[] {
  return state.log.slice(0, state.commitIndex).map((e) => e.command);
}

/** Summarize one node from a cluster snapshot. */
function summarizeNode(id: NodeId, states: ClusterStates): NodeSummary {
  const state = states[id];
  if (!state) {
    return { id, role: "follower", term: 0, commitIndex: 0, committed: [] };
  }
  return {
    id,
    role: state.role._tag,
    term: state.currentTerm,
    commitIndex: state.commitIndex,
    committed: committedCommands(state),
  };
}

/** Summarize every node in a cluster snapshot, in the given order. */
function summarizeCluster(
  nodes: readonly NodeId[],
  states: ClusterStates,
): readonly NodeSummary[] {
  return nodes.map((id) => summarizeNode(id, states));
}

/**
 * The cluster's *current* leader in a snapshot: the leader of the HIGHEST term,
 * or `null` if no node leads (mid-election) or two nodes tie for the top term (a
 * genuine split). A partitioned OLD leader keeps believing it leads — it cannot
 * learn it was deposed while its traffic is dropped — but it sits at a strictly
 * LOWER term than whoever the surviving majority elected, so the highest-term
 * leader is the legitimate one. (Election Safety guarantees ≤1 leader per term,
 * so a single top-term leader is unambiguous.)
 */
function leaderOf(
  nodes: readonly NodeId[],
  states: ClusterStates,
): NodeId | null {
  const leaders = nodes.filter((id) => states[id]?.role._tag === "leader");
  if (leaders.length === 0) return null;
  const topTerm = Math.max(
    ...leaders.map((id) => states[id]?.currentTerm ?? 0),
  );
  const top = leaders.filter((id) => states[id]?.currentTerm === topTerm);
  return top.length === 1 ? (top[0] ?? null) : null;
}

// ===========================================================================
// The demo result — what runDemo returns (the test + the CLI both read this)
// ===========================================================================

/** A snapshot of one phase's outcome: its headline + the cluster after it ran. */
export interface PhaseOutcome {
  /** The phase headline. */
  readonly title: string;
  /** The phase's one-line note. */
  readonly note: string;
  /** The single leader after this phase, or `null`. */
  readonly leader: NodeId | null;
  /** Every node's summary after this phase. */
  readonly cluster: readonly NodeSummary[];
}

/** The structured outcome of a full demo run — pure data, asserts nothing. */
export interface DemoResult {
  /** The cluster node ids, in config order. */
  readonly nodes: readonly NodeId[];
  /** The nodes partitioned off by the end of the run (the killed leader). */
  readonly partitioned: readonly NodeId[];
  /** The leader elected in phase 1 (before the kill). */
  readonly firstLeader: NodeId | null;
  /** The leader elected in phase 4 (after the kill) — a DIFFERENT node. */
  readonly secondLeader: NodeId | null;
  /** The commands committed across the SURVIVING majority by the end. */
  readonly convergedLog: readonly number[];
  /** Per-phase outcomes, in order. */
  readonly phases: readonly PhaseOutcome[];
  /** The full underlying simulation trace (for replay / deep inspection). */
  readonly trace: SimTrace;
}

// ===========================================================================
// Running the demo
// ===========================================================================

/** The demo cluster: 3 nodes, default election-timeout window + heartbeat. */
export function demoCluster(): readonly RaftConfig[] {
  return clusterConfigs(3);
}

/** The full scripted schedule (every phase's events concatenated, in order). */
export function demoSchedule(): Schedule {
  return PHASES.flatMap((phase) => phase.events);
}

/**
 * The nodes that survive the partition (everyone NOT in the down-set). The demo
 * checks convergence over THESE — the partitioned leader is, by construction,
 * stuck at its pre-kill log.
 */
export function survivors(
  nodes: readonly NodeId[],
  partitioned: readonly NodeId[],
): readonly NodeId[] {
  const down = new Set(partitioned);
  return nodes.filter((id) => !down.has(id));
}

/**
 * Run the scripted demo against a fresh 3-node cluster and return a structured
 * {@link DemoResult}. Pure: folds {@link demoSchedule} through {@link runSchedule},
 * then reads the cluster at each phase boundary. Deterministic — the same
 * schedule yields a byte-identical trace, so {@link runDemo}() === runDemo().
 */
export function runDemo(): DemoResult {
  const configs = demoCluster();
  const nodes = configs.map((c) => c.self);
  const schedule = demoSchedule();
  const trace = runSchedule(configs, schedule);

  // Walk the trace one phase at a time: each phase consumes as many trace steps
  // as it contributed events — except `settle`, which expands to one step per
  // drained delivery. So we slice by counting steps until the phase's last
  // non-settle event is consumed. Simpler + robust: re-fold each cumulative
  // prefix of phases and read the resulting cluster (the schedule is tiny).
  const phases: PhaseOutcome[] = [];
  for (let i = 0; i < PHASES.length; i++) {
    const phase = PHASES[i];
    if (!phase) continue;
    const prefix = PHASES.slice(0, i + 1).flatMap((p) => p.events);
    const states = runSchedule(configs, prefix).final;
    phases.push({
      title: phase.title,
      note: phase.note,
      leader: leaderOf(nodes, states),
      cluster: summarizeCluster(nodes, states),
    });
  }

  const partitioned: readonly NodeId[] = [N0];
  const firstLeader = phases[1]?.leader ?? null;
  const secondLeader = phases.at(-1)?.leader ?? null;

  // Converged log = the committed commands the surviving majority agree on. We
  // read the new leader's committed prefix; the test asserts every survivor
  // matches it once the final settle drains.
  const leaderState = secondLeader ? trace.final[secondLeader] : undefined;
  const convergedLog = leaderState ? committedCommands(leaderState) : [];

  return {
    nodes,
    partitioned,
    firstLeader,
    secondLeader,
    convergedLog,
    phases,
    trace,
  };
}

// ===========================================================================
// Narration — render a DemoResult as readable lines (the CLI output)
// ===========================================================================

/** One node's summary as a compact line, e.g. `n0 leader  term=2 commit=2 [42,77]`. */
function nodeLine(n: NodeSummary): string {
  const role = n.role.padEnd(9);
  return `    ${n.id}  ${role} term=${n.term} commit=${n.commitIndex} committed=[${n.committed.join(",")}]`;
}

/**
 * Render a {@link DemoResult} as a readable, deterministic narrative — the
 * `pnpm demo:raft` output. Pure: returns the lines; the runner prints them.
 */
export function narrateDemo(result: DemoResult): string {
  const lines: string[] = [];
  lines.push("=".repeat(72));
  lines.push("  @demlik/tea/raft — multi-node consensus demo (deterministic)");
  lines.push(`  cluster: ${result.nodes.join(", ")}  (majority = 2 of 3)`);
  lines.push("=".repeat(72));

  for (const phase of result.phases) {
    lines.push("");
    lines.push(phase.title);
    lines.push(`  ${phase.note}`);
    lines.push(`  leader: ${phase.leader ?? "(none — election in progress)"}`);
    for (const node of phase.cluster) {
      lines.push(nodeLine(node));
    }
  }

  lines.push("");
  lines.push("-".repeat(72));
  lines.push("  Summary");
  lines.push(`  first leader (pre-kill):  ${result.firstLeader ?? "none"}`);
  lines.push(`  killed (partitioned):     ${result.partitioned.join(", ")}`);
  lines.push(`  new leader (post-kill):   ${result.secondLeader ?? "none"}`);
  lines.push(`  converged committed log:  [${result.convergedLog.join(", ")}]`);
  const failedOver =
    result.firstLeader !== null &&
    result.secondLeader !== null &&
    result.firstLeader !== result.secondLeader;
  lines.push(
    `  failover: ${failedOver ? "OK — a NEW leader took over and the log converged" : "NOT observed"}`,
  );
  lines.push("-".repeat(72));
  return lines.join("\n");
}

// ===========================================================================
// Replay helper — prove the demo is byte-identically reproducible
// ===========================================================================

/**
 * Re-run the demo's schedule from a fresh cluster and report whether the trace
 * is byte-identical to the original run (the determinism contract). Used by the
 * test and surfaced in the CLI footer.
 */
export function demoIsReproducible(result: DemoResult): boolean {
  const replay = replaySchedule(demoCluster(), demoSchedule());
  return (
    JSON.stringify(replay.final) === JSON.stringify(result.trace.final) &&
    JSON.stringify(replay.steps) === JSON.stringify(result.trace.steps)
  );
}
