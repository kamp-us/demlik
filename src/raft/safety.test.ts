/**
 * Raft safety properties (#121) — the four invariants from §5 of the paper,
 * expressed as assertions checked at EVERY step across a fast-check family of
 * deterministic schedules driven through {@link runSchedule}. This is the epic's
 * headline payoff (#117): consensus verified by deterministic replay, NOT by
 * flaky wall-clock timing.
 *
 * The four properties (Raft paper Figure 3):
 *   1. Election Safety       — at most one leader per term across the cluster.
 *   2. Log Matching          — if two logs hold an entry at the same index with
 *                              the same term, all preceding entries are identical.
 *   3. Leader Completeness    — an entry committed in some term is present in the
 *                              log of every leader of a higher term.
 *   4. State-Machine Safety   — no two nodes commit different entries at the same
 *                              log index.
 * Plus the determinism property: the same schedule re-run is byte-identical.
 *
 * Each property is checked at every step of a generated schedule. On violation
 * fast-check shrinks to a minimal counterexample SCHEDULE — a replayable list of
 * events, not an irreproducible timing fluke (errors are data). Globals are NOT
 * enabled in vitest.config.ts (describe/it/expect imported); fast-check's seed +
 * numRuns are pinned by `src/test-setup.ts`.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NodeId } from "./index";
import {
  type ClusterStates,
  clusterConfigs,
  type RaftConfig,
  replaySchedule,
  runSchedule,
  type Schedule,
  type SimEvent,
  type SimTrace,
} from "./sim";

// ===========================================================================
// Schedule generators — the controllable, wall-clock-free event family
// ===========================================================================

// A 3-node cluster (majority 2) is the smallest that exercises split votes,
// elections, and replication; a 5-node cluster (majority 3) stresses the
// majority arithmetic. Both are driven by the SAME schedule generator.
const CLUSTER_3 = clusterConfigs(3);
const CLUSTER_5 = clusterConfigs(5);

/**
 * An arbitrary schedule event over a cluster of the given node ids. Includes the
 * `settle` drain — without it the random `deliver` index almost never threads
 * the exact RPC sequence an election + replication round needs, so the safety
 * properties would pass *vacuously* over empty logs (measured: 0 committed
 * entries across 2000 purely-random schedules; 529 once `settle` is in the
 * family). `settle` is weighted up so most schedules actually reach consensus.
 */
function eventArb(nodes: readonly NodeId[]): fc.Arbitrary<SimEvent> {
  const nodeArb = fc.constantFrom(...nodes);
  return fc.oneof(
    // Fire a node's election or heartbeat timer.
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("timer" as const),
        node: nodeArb,
        timer: fc.constantFrom("election" as const, "heartbeat" as const),
      }),
    },
    // Deliver one arbitrary in-flight message (index modulo the pool size) —
    // models out-of-order / partial network delivery.
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("deliver" as const),
        index: fc.integer({ min: 0, max: 1_000 }),
      }),
    },
    // A client submits a command (grows the replicated log via the leader).
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("client" as const),
        node: nodeArb,
        command: fc.integer({ min: 0, max: 1_000 }),
      }),
    },
    // Let the network settle: drain the pending pool to quiescence (bounded).
    // This is what lets started elections + submitted commands run to
    // completion, so commits actually happen and the properties are non-vacuous.
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("settle" as const),
        bound: fc.integer({ min: 1, max: 20 }),
      }),
    },
  );
}

/** A schedule over a cluster: a finite array of events. */
function scheduleArb(
  nodes: readonly NodeId[],
  maxLength = 40,
): fc.Arbitrary<Schedule> {
  return fc.array(eventArb(nodes), { maxLength });
}

// ===========================================================================
// Invariant checkers — pure predicates over a cluster snapshot / a whole trace
// ===========================================================================

/**
 * Election Safety: at most one leader per term across the cluster, checked on a
 * single snapshot. Returns the offending term (with the two leader ids) when
 * violated, or `null` when the snapshot is safe.
 */
function electionSafetyViolation(
  states: ClusterStates,
): { term: number; leaders: NodeId[] } | null {
  const leadersByTerm = new Map<number, NodeId[]>();
  for (const [id, s] of Object.entries(states)) {
    if (s.role._tag === "leader") {
      const list = leadersByTerm.get(s.currentTerm) ?? [];
      list.push(id);
      leadersByTerm.set(s.currentTerm, list);
    }
  }
  for (const [term, leaders] of leadersByTerm) {
    if (leaders.length > 1) return { term, leaders };
  }
  return null;
}

/**
 * Log Matching: for every PAIR of node logs, if they hold an entry at the same
 * index with the same term, all preceding entries are identical. Equivalent (and
 * cheaper) formulation from the paper: walk both logs in lockstep; the first
 * shared index whose terms agree forces every earlier (term, command) to agree
 * too. Returns the first offending `(a, b, index)` or `null`.
 *
 * We assert the stronger, directly-checkable consequence: whenever two entries
 * at the same index share a term, their COMMANDS are equal AND every preceding
 * pair (up to that index) is equal too. A single scan over the shared prefix
 * surfaces any divergence.
 */
function logMatchingViolation(states: ClusterStates): {
  a: NodeId;
  b: NodeId;
  index: number;
} | null {
  const ids = Object.keys(states);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      if (!a || !b) continue;
      const la = states[a]?.log ?? [];
      const lb = states[b]?.log ?? [];
      const shared = Math.min(la.length, lb.length);
      // Find the highest shared index where the terms agree; from there down,
      // everything must match.
      let highestMatch = -1;
      for (let k = shared - 1; k >= 0; k--) {
        if (la[k]?.term === lb[k]?.term) {
          highestMatch = k;
          break;
        }
      }
      for (let k = 0; k <= highestMatch; k++) {
        const ea = la[k];
        const eb = lb[k];
        if (
          ea?.term !== eb?.term ||
          ea?.index !== eb?.index ||
          ea?.command !== eb?.command
        ) {
          return { a, b, index: k + 1 };
        }
      }
    }
  }
  return null;
}

/**
 * State-Machine Safety: no two nodes commit (apply) DIFFERENT entries at the
 * same log index. "Committed" here is the entries at or below each node's
 * `commitIndex`. Returns the first conflicting `(a, b, index)` or `null`.
 *
 * The committed prefix of any node is the slice `log[0 .. commitIndex)`; two
 * nodes that both consider index `k` committed must hold the same (term, command)
 * there.
 */
function stateMachineSafetyViolation(states: ClusterStates): {
  a: NodeId;
  b: NodeId;
  index: number;
} | null {
  const ids = Object.keys(states);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      if (!a || !b) continue;
      const sa = states[a];
      const sb = states[b];
      if (!sa || !sb) continue;
      const sharedCommitted = Math.min(sa.commitIndex, sb.commitIndex);
      for (let k = 0; k < sharedCommitted; k++) {
        const ea = sa.log[k];
        const eb = sb.log[k];
        if (ea?.term !== eb?.term || ea?.command !== eb?.command) {
          return { a, b, index: k + 1 };
        }
      }
    }
  }
  return null;
}

/**
 * Leader Completeness: an entry committed in some term is present (same index +
 * term) in the log of every leader of a HIGHER term. Checked over the WHOLE
 * trace, not one snapshot: we accumulate every entry any node has ever marked
 * committed (index → {term, command}), then at each step verify every current
 * leader's log contains each such committed entry whose term is below the
 * leader's currentTerm.
 *
 * Returns the first offending `(leader, index)` or `null`.
 */
function leaderCompletenessViolation(trace: SimTrace): {
  leader: NodeId;
  index: number;
  committedTerm: number;
} | null {
  // index -> the committed entry observed there (term, command). Raft guarantees
  // a committed index never changes its entry, so the first sighting is canonical.
  const committed = new Map<number, { term: number; command: number }>();

  for (const step of trace.steps) {
    // 1. Absorb everything committed this step into the running record.
    for (const s of Object.values(step.states)) {
      for (let k = 0; k < s.commitIndex; k++) {
        const e = s.log[k];
        if (e && !committed.has(e.index)) {
          committed.set(e.index, { term: e.term, command: e.command });
        }
      }
    }
    // 2. Every current leader of term T must hold every committed entry whose
    //    term is < T (Leader Completeness, §5.4).
    for (const [id, s] of Object.entries(step.states)) {
      if (s.role._tag !== "leader") continue;
      for (const [index, entry] of committed) {
        if (entry.term >= s.currentTerm) continue;
        const held = s.log[index - 1];
        if (
          !held ||
          held.term !== entry.term ||
          held.command !== entry.command
        ) {
          return { leader: id, index, committedTerm: entry.term };
        }
      }
    }
  }
  return null;
}

// ===========================================================================
// 1. Election Safety
// ===========================================================================

describe("Raft safety — Election Safety (≤1 leader per term)", () => {
  it("never elects two leaders in the same term, on any schedule (3-node)", () => {
    fc.assert(
      fc.property(scheduleArb(CLUSTER_3.map((c) => c.self)), (schedule) => {
        const trace = runSchedule(CLUSTER_3, schedule);
        for (const step of trace.steps) {
          const v = electionSafetyViolation(step.states);
          // A counterexample reports the offending term + the colliding leaders;
          // the schedule itself is fast-check's shrunk replay.
          expect(v).toBeNull();
        }
      }),
    );
  });

  it("never elects two leaders in the same term, on any schedule (5-node)", () => {
    fc.assert(
      fc.property(scheduleArb(CLUSTER_5.map((c) => c.self)), (schedule) => {
        const trace = runSchedule(CLUSTER_5, schedule);
        for (const step of trace.steps) {
          expect(electionSafetyViolation(step.states)).toBeNull();
        }
      }),
    );
  });
});

// ===========================================================================
// 2. Log Matching
// ===========================================================================

describe("Raft safety — Log Matching (shared index+term ⇒ identical prefix)", () => {
  it("holds across all node logs at every step, on any schedule (3-node)", () => {
    fc.assert(
      fc.property(scheduleArb(CLUSTER_3.map((c) => c.self)), (schedule) => {
        const trace = runSchedule(CLUSTER_3, schedule);
        for (const step of trace.steps) {
          expect(logMatchingViolation(step.states)).toBeNull();
        }
      }),
    );
  });

  it("holds across all node logs at every step, on any schedule (5-node)", () => {
    fc.assert(
      fc.property(scheduleArb(CLUSTER_5.map((c) => c.self)), (schedule) => {
        const trace = runSchedule(CLUSTER_5, schedule);
        for (const step of trace.steps) {
          expect(logMatchingViolation(step.states)).toBeNull();
        }
      }),
    );
  });
});

// ===========================================================================
// 3. Leader Completeness
// ===========================================================================

describe("Raft safety — Leader Completeness (committed ⊆ every higher-term leader)", () => {
  it("every higher-term leader holds every previously-committed entry (3-node)", () => {
    fc.assert(
      fc.property(scheduleArb(CLUSTER_3.map((c) => c.self)), (schedule) => {
        const trace = runSchedule(CLUSTER_3, schedule);
        expect(leaderCompletenessViolation(trace)).toBeNull();
      }),
    );
  });

  it("every higher-term leader holds every previously-committed entry (5-node)", () => {
    fc.assert(
      fc.property(scheduleArb(CLUSTER_5.map((c) => c.self)), (schedule) => {
        const trace = runSchedule(CLUSTER_5, schedule);
        expect(leaderCompletenessViolation(trace)).toBeNull();
      }),
    );
  });
});

// ===========================================================================
// 4. State-Machine Safety
// ===========================================================================

describe("Raft safety — State-Machine Safety (no divergent committed entry)", () => {
  it("no two nodes commit different entries at the same index (3-node)", () => {
    fc.assert(
      fc.property(scheduleArb(CLUSTER_3.map((c) => c.self)), (schedule) => {
        const trace = runSchedule(CLUSTER_3, schedule);
        for (const step of trace.steps) {
          expect(stateMachineSafetyViolation(step.states)).toBeNull();
        }
      }),
    );
  });

  it("no two nodes commit different entries at the same index (5-node)", () => {
    fc.assert(
      fc.property(scheduleArb(CLUSTER_5.map((c) => c.self)), (schedule) => {
        const trace = runSchedule(CLUSTER_5, schedule);
        for (const step of trace.steps) {
          expect(stateMachineSafetyViolation(step.states)).toBeNull();
        }
      }),
    );
  });
});

// ===========================================================================
// Determinism — the same schedule replays byte-identically
// ===========================================================================

describe("Raft safety — deterministic replay (record == replay)", () => {
  it("the same schedule re-run yields byte-identical cluster state (3-node)", () => {
    fc.assert(
      fc.property(scheduleArb(CLUSTER_3.map((c) => c.self)), (schedule) => {
        const a = runSchedule(CLUSTER_3, schedule);
        const b = replaySchedule(CLUSTER_3, schedule);
        // Final cluster identical…
        expect(a.final).toEqual(b.final);
        // …and the WHOLE recorded trace identical (every step's states + pool).
        expect(a.steps).toEqual(b.steps);
      }),
    );
  });

  it("the same schedule re-run yields byte-identical cluster state (5-node)", () => {
    fc.assert(
      fc.property(scheduleArb(CLUSTER_5.map((c) => c.self)), (schedule) => {
        const a = runSchedule(CLUSTER_5, schedule);
        const b = replaySchedule(CLUSTER_5, schedule);
        expect(a.final).toEqual(b.final);
        expect(a.steps).toEqual(b.steps);
      }),
    );
  });
});

// ===========================================================================
// Worked replay — an explicit schedule that drives a full election + commit,
// proving the harness produces real consensus (not vacuously-safe empty logs).
// ===========================================================================

describe("Raft safety — worked replay drives real consensus", () => {
  /**
   * An explicit (not generated) schedule: n0 times out, wins the election, takes
   * a client command, and replicates+commits it. Asserts the harness actually
   * reaches a leader + a committed entry (so the property suite above is not
   * vacuously green over empty logs), and that the four invariants hold along it.
   */
  it("elects a leader, replicates a command, and commits it deterministically", () => {
    const cfg: readonly RaftConfig[] = CLUSTER_3;
    const n0 = cfg[0]?.self as NodeId;

    // n0 times out and starts an election; `settle` drains the resulting
    // RequestVote round to quiescence → n0 reaches a majority and becomes leader
    // (its first heartbeat round also drains). Then a client command to the
    // leader, and a second `settle` runs the AppendEntries replication + the
    // success replies, advancing the leader's commitIndex. A compact, readable,
    // fully-replayable schedule.
    const schedule: Schedule = [
      { kind: "timer", node: n0, timer: "election" },
      { kind: "settle", bound: 20 },
      { kind: "client", node: n0, command: 42 },
      { kind: "settle", bound: 20 },
    ];

    const trace = runSchedule(cfg, schedule);

    // A leader emerged in term 1.
    const leaders = trace.nodes.filter(
      (id) => trace.final[id]?.role._tag === "leader",
    );
    expect(leaders).toEqual([n0]);
    expect(trace.final[n0]?.currentTerm).toBe(1);

    // The client command is in the leader's log and committed.
    expect(trace.final[n0]?.log.map((e) => e.command)).toContain(42);
    expect(trace.final[n0]?.commitIndex).toBeGreaterThanOrEqual(1);

    // All four invariants hold along the whole worked trace.
    for (const step of trace.steps) {
      expect(electionSafetyViolation(step.states)).toBeNull();
      expect(logMatchingViolation(step.states)).toBeNull();
      expect(stateMachineSafetyViolation(step.states)).toBeNull();
    }
    expect(leaderCompletenessViolation(trace)).toBeNull();

    // And it replays byte-for-byte.
    expect(replaySchedule(cfg, schedule).steps).toEqual(trace.steps);
  });
});
