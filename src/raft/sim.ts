/**
 * @demlik/tea/raft — a deterministic, in-memory multi-node Raft simulation
 * driver. Slice #121 (the safety-property half) of the consensus epic (#117):
 * the headline payoff is consensus verified by **deterministic replay**, not by
 * flaky wall-clock timing.
 *
 * This module owns NO wall clock, NO real timers, and NO networking. Time and
 * message ordering are entirely the *schedule* — a finite list of {@link SimEvent}s
 * the caller (a fast-check generator or an explicit fixture) hands the driver.
 * The driver folds the schedule one event at a time over a cluster of pure
 * {@link createRaftNode}s, routing every emitted `Cmd` into a pending-message
 * pool and recording the full `(event → resulting cluster states)` trace.
 *
 * Because the underlying reducer is pure (no ambient clock — `at` rides on the
 * Msg; no ambient RNG — `rng` injected once per node), the same schedule re-run
 * yields **byte-identical** cluster state. That replay identity is the property
 * the safety suite (`safety.test.ts`) leans on: a violated invariant shrinks to
 * a *replayable schedule*, not an irreproducible timing fluke (errors are data).
 *
 * ## The schedule model
 *
 * The cluster is N nodes plus a pending-message pool. Each {@link SimEvent} is
 * one of two moves:
 *
 *   - `{ kind: "timer", node, timer }` — fire node's election OR heartbeat timer.
 *     Drives an `onElectionTimeout` / `onHeartbeat` verb on that node. The
 *     firing `at` is the driver's monotonic logical clock (one tick per event),
 *     so no verb reads a real clock.
 *   - `{ kind: "deliver", index }` — deliver the in-flight message at `index` in
 *     the pending pool to its target node, as the matching inbound `RaftMsg`.
 *     An out-of-range `index` is taken modulo the pool size (so a fast-check
 *     integer always names *some* deliverable message when the pool is
 *     non-empty); a `deliver` against an empty pool is a no-op event (recorded,
 *     advances the clock, changes nothing) — the schedule stays total.
 *
 * Delivering a message removes it from the pool and feeds it to the target's
 * verb; any Cmds that verb emits are appended to the pool (each Cmd carries its
 * own `to`, so routing is just a lookup). This is the in-memory transport: a
 * `SendRequestVote{to}` delivered becomes a `RequestVoteRequest` on `to`; the
 * `SendRequestVoteReply{to}` it emits becomes a `RequestVoteReply` on the
 * original candidate; and so on around the RPC pairs.
 *
 * ## Record / replay
 *
 * {@link runSchedule} returns a {@link SimTrace}: the ordered list of steps, each
 * the event applied and the resulting per-node {@link RaftState} snapshot, plus
 * the final cluster. {@link replaySchedule} re-runs the identical schedule from a
 * fresh cluster; {@link clusterStatesEqual} compares two cluster snapshots
 * structurally. The safety suite asserts `runSchedule(s)` and
 * `replaySchedule(s)` agree byte-for-byte.
 *
 * NOT a substrate primitive and NOT shipped in the node's public verb surface:
 * it depends only on `./index` (the pure node) read-only, and lives beside the
 * node as a test/replay harness.
 */

import {
  type AppendEntriesReply,
  type AppendEntriesRequest,
  createRaftNode,
  type LogEntry,
  type NodeId,
  type RaftCmd,
  type RaftConfig,
  type RaftMsg,
  type RaftNode,
  type RaftState,
  type RequestVoteReply,
  type RequestVoteRequest,
} from "./index";

// ===========================================================================
// Schedule — the controllable, wall-clock-free event stream
// ===========================================================================

/** Which of a node's two timers a `timer` event fires. */
export type TimerKind = "election" | "heartbeat";

/**
 * One move in a schedule. The whole simulation is a fold of these — there is no
 * other source of time or ordering. `_tag`-style `kind` discriminant matches the
 * engine's tagged-union convention.
 */
export type SimEvent =
  | {
      /** Fire a node's timer (drives `onElectionTimeout` / `onHeartbeat`). */
      readonly kind: "timer";
      /** The node whose timer fires. */
      readonly node: NodeId;
      /** Which timer. */
      readonly timer: TimerKind;
    }
  | {
      /**
       * Deliver an in-flight message from the pending pool to its target. The
       * index is taken modulo the pool size, so any integer names a deliverable
       * message when the pool is non-empty; a deliver against an empty pool is a
       * recorded no-op (the clock still advances).
       */
      readonly kind: "deliver";
      /** Which pending message to deliver (modulo pool size). */
      readonly index: number;
    }
  | {
      /**
       * A client submits a command to a node (Figure 2 §5.3). On the leader it
       * appends + replicates; on a non-leader it is a no-op. This is how the
       * replicated log grows in a simulation.
       */
      readonly kind: "client";
      /** The node the client contacts. */
      readonly node: NodeId;
      /** The opaque command to submit. */
      readonly command: number;
    }
  | {
      /**
       * Drain the pending pool to quiescence: deliver messages FIFO (each new
       * Cmd a delivery emits is appended and itself delivered) until the pool is
       * empty or `bound` deliveries have run. This is the "let the network
       * settle" move — it lets a started election or a submitted client command
       * run its RPC round(s) to completion, which is what actually produces
       * leaders and committed entries. Without it, a purely-random `deliver`
       * index almost never threads the exact sequence an election + replication
       * needs (measured: 0 commits in 2000 random schedules vs. 529 with settle),
       * so the safety properties would pass *vacuously* over empty logs.
       *
       * The `bound` caps the drain so a pathological re-emit loop cannot diverge;
       * every step is still recorded (one trace step per delivery), so a settle
       * is a deterministic, replayable macro — not a black box.
       */
      readonly kind: "settle";
      /** Max deliveries to run (the drain is FIFO; stops early when empty). */
      readonly bound: number;
    }
  | {
      /**
       * Set the cluster's *partitioned* node set (a network fault, NOT a state
       * change). A node in `down` is isolated: the transport DROPS every message
       * to OR from it (both directions, as a real partition does) while its
       * timers still fire — so a crashed/partitioned leader stops being able to
       * heartbeat and the surviving majority elects a new leader. This is the
       * "kill the leader" / "heal the partition" move the failover demo needs.
       *
       * It names the WHOLE down-set absolutely (not a toggle): `{ down: [n0] }`
       * isolates n0; a later `{ down: [] }` heals every partition. Recorded as
       * one step (clock advances, no message moves), so it replays deterministically.
       */
      readonly kind: "partition";
      /** The nodes that are currently isolated (drop all their traffic). */
      readonly down: readonly NodeId[];
    };

/** A whole schedule: the finite event stream the driver folds. */
export type Schedule = readonly SimEvent[];

// ===========================================================================
// In-flight messages — emitted Cmds parked in the pending pool
// ===========================================================================

/**
 * A Cmd a node emitted, parked until a `deliver` event routes it. We keep the
 * raw {@link RaftCmd} (it already carries `to`) plus the sender, so a delivery
 * can build the correct inbound {@link RaftMsg} on the target. Commands over a
 * numeric payload (the simulation's `C = number`).
 */
export interface InFlight {
  /** The node that emitted this Cmd (the inbound Msg's `from` / sender). */
  readonly from: NodeId;
  /** The emitted Cmd, addressed to `cmd.to`. */
  readonly cmd: RaftCmd<number>;
}

// ===========================================================================
// Cluster + trace
// ===========================================================================

/** A snapshot of every node's state, keyed by id. */
export type ClusterStates = Readonly<Record<NodeId, RaftState<number>>>;

/**
 * A read-off of the message a `deliver` step actually pulled off the pending
 * pool — sender, target, and the {@link RaftCmd} discriminant (`cmd.type`). This
 * is a pure projection of what the fold *already did* (the InFlight that
 * {@link deliverOne} consumed), recorded so a renderer can draw the RPC flow.
 * It is NOT a new input and changes NO simulation behavior. Recorded even when
 * the packet is dropped by a partition (the RPC was still attempted), so the
 * arrow shows the intent while the greyed node shows the drop.
 */
export interface DeliveredMessage {
  /** The node that emitted the delivered Cmd (the inbound Msg's sender). */
  readonly from: NodeId;
  /** The node the Cmd was addressed to (`cmd.to`). */
  readonly to: NodeId;
  /** The delivered Cmd's discriminant (`RaftCmd["type"]`). */
  readonly kind: RaftCmd<number>["type"];
}

/** One recorded step: the event applied and the cluster state it produced. */
export interface SimStep {
  /** The event applied at this step. */
  readonly event: SimEvent;
  /** The pending-pool size AFTER applying the event. */
  readonly pending: number;
  /** Every node's state after the event. */
  readonly states: ClusterStates;
  /**
   * On a `deliver` step (incl. each delivery a `settle` drains), the message
   * that was actually pulled off the pool. ABSENT on every other step kind and
   * on a `deliver` against an empty pool — additive + backward-compatible, so a
   * trace recorded before this field still folds and renders identically (field
   * absent ⇒ no arrow). Purely a read-off of {@link deliverOne}'s work.
   */
  readonly delivered?: DeliveredMessage;
}

/**
 * The full record of a run: the per-node configs, the ordered steps, and the
 * final cluster. Replaying the same schedule reproduces this byte-for-byte.
 */
export interface SimTrace {
  /** The cluster's node ids, in config order. */
  readonly nodes: readonly NodeId[];
  /** One step per event in the schedule (in order). */
  readonly steps: readonly SimStep[];
  /** The final per-node states (== `steps.at(-1)?.states` when non-empty). */
  readonly final: ClusterStates;
}

// ===========================================================================
// Building the cluster
// ===========================================================================

/**
 * Build N node configs sharing one election-timeout window + heartbeat. Each
 * node's `peers` is every OTHER id. Ids are `n0..n{N-1}`.
 */
export function clusterConfigs(
  n: number,
  over?: Partial<Omit<RaftConfig, "self" | "peers">>,
): readonly RaftConfig[] {
  const ids = Array.from({ length: n }, (_, i) => `n${i}`);
  return ids.map((self) => ({
    self,
    peers: ids.filter((id) => id !== self),
    electionTimeout: over?.electionTimeout ?? { minMs: 150, maxMs: 300 },
    heartbeatMs: over?.heartbeatMs ?? 50,
  }));
}

/**
 * A fixed-jitter rng for a node, derived from its index so that distinct nodes
 * draw *distinct but deterministic* election timeouts (the real-cluster effect
 * that breaks split votes), while a replay with the same configs reproduces them
 * exactly. Pure function of the index — no ambient randomness.
 */
function fixedRng(index: number, count: number): () => number {
  // Spread the [0,1) jitter evenly across the cluster: node i draws i/count.
  const value = count > 0 ? index / count : 0;
  return () => value;
}

// ===========================================================================
// The driver
// ===========================================================================

/**
 * The mutable bag the fold threads. Kept local to {@link runSchedule}; never
 * escapes. `clock` is the monotonic logical clock — incremented once per event
 * and used as the `at` for timer firings, so the reducer never reads a real
 * clock and a replay reproduces every `at`.
 */
interface SimWorld {
  readonly handles: ReadonlyMap<NodeId, RaftNode<number>>;
  states: Record<NodeId, RaftState<number>>;
  pending: InFlight[];
  clock: number;
  /**
   * The currently-partitioned nodes (a `partition` event sets this absolutely).
   * The transport drops any in-flight message to OR from a down node — its
   * timers still fire, but its RPCs never land and it never hears the cluster.
   */
  down: Set<NodeId>;
}

/**
 * Translate one emitted {@link RaftCmd} into the inbound {@link RaftMsg} the
 * target node should receive. Pure mapping over the RPC pairs (Figure 2 wire
 * shapes); `sender` becomes the Msg's `from` / candidateId / leaderId as
 * appropriate. The target is always `cmd.to`.
 */
function cmdToInbound(sender: NodeId, cmd: RaftCmd<number>): RaftMsg<number> {
  switch (cmd.type) {
    case "raft:send_request_vote": {
      const msg: RequestVoteRequest = {
        _tag: "request_vote_request",
        term: cmd.term,
        candidateId: cmd.candidateId,
        lastLogIndex: cmd.lastLogIndex,
        lastLogTerm: cmd.lastLogTerm,
      };
      return msg;
    }
    case "raft:send_request_vote_reply": {
      const msg: RequestVoteReply = {
        _tag: "request_vote_reply",
        term: cmd.term,
        from: sender,
        voteGranted: cmd.voteGranted,
      };
      return msg;
    }
    case "raft:send_append_entries": {
      const msg: AppendEntriesRequest<number> = {
        _tag: "append_entries_request",
        term: cmd.term,
        leaderId: cmd.leaderId,
        prevLogIndex: cmd.prevLogIndex,
        prevLogTerm: cmd.prevLogTerm,
        entries: cmd.entries,
        leaderCommit: cmd.leaderCommit,
      };
      return msg;
    }
    case "raft:send_append_entries_reply": {
      const msg: AppendEntriesReply = {
        _tag: "append_entries_reply",
        term: cmd.term,
        from: sender,
        success: cmd.success,
        matchIndex: cmd.matchIndex,
      };
      return msg;
    }
  }
}

/** Run one node verb for the inbound Msg, returning `[next, cmds]`. */
function applyInbound(
  node: RaftNode<number>,
  state: RaftState<number>,
  msg: RaftMsg<number>,
  at: number,
) {
  switch (msg._tag) {
    case "election_timeout_fired":
      return node.onElectionTimeout(state, at);
    case "heartbeat_fired":
      return node.onHeartbeat(state, at);
    case "request_vote_request":
      return node.onRequestVote(state, msg);
    case "request_vote_reply":
      return node.onRequestVoteReply(state, msg);
    case "append_entries_request":
      return node.onAppendEntries(state, msg);
    case "append_entries_reply":
      return node.onAppendEntriesReply(state, msg);
    case "client_command":
      return node.onClientCommand(state, msg);
  }
}

/** Park the Cmds an acting node emitted into the pending pool (FIFO append). */
function park(
  world: SimWorld,
  actor: NodeId,
  emitted: readonly RaftCmd<number>[],
): void {
  for (const cmd of emitted) {
    world.pending.push({ from: actor, cmd });
  }
}

/**
 * Deliver the pending message at `index` (modulo the pool size) to its target,
 * parking whatever it emits. Advances the clock and returns the {@link InFlight}
 * it consumed from the pool (so a caller can record what was delivered),
 * or `null` when the pool was empty (a recorded no-op). A single atomic unit of
 * simulated work — one trace step.
 *
 * The return value is a PURE read-off of work the function already does (the
 * splice was always there); returning it instead of a `boolean` adds no
 * behavior — every existing call-site path (apply, partition-drop, empty-pool)
 * is byte-for-byte unchanged.
 */
function deliverOne(world: SimWorld, index: number): InFlight | null {
  if (world.pending.length === 0) {
    world.clock += 1;
    return null;
  }
  world.clock += 1;
  const at = world.clock;
  const i =
    ((index % world.pending.length) + world.pending.length) %
    world.pending.length;
  const [inFlight] = world.pending.splice(i, 1);
  if (!inFlight) return null;
  const target = inFlight.cmd.to;
  // Partition: a message to OR from an isolated node is dropped — consumed from
  // the pool (so a `settle` still terminates) but never applied (the packet was
  // lost on the wire). Both directions, as a real partition severs.
  if (world.down.has(target) || world.down.has(inFlight.from)) {
    return inFlight;
  }
  const node = world.handles.get(target);
  const state = world.states[target];
  if (node && state) {
    const inbound = cmdToInbound(inFlight.from, inFlight.cmd);
    const [next, cmds] = applyInbound(node, state, inbound, at);
    world.states[target] = next;
    park(world, target, cmds);
  }
  return inFlight;
}

/** Project a consumed {@link InFlight} into the additive {@link DeliveredMessage} read-off. */
function deliveredOf(inFlight: InFlight): DeliveredMessage {
  return { from: inFlight.from, to: inFlight.cmd.to, kind: inFlight.cmd.type };
}

/**
 * Apply one {@link SimEvent} to the world, pushing one trace step PER unit of
 * work onto `steps`. A `timer` / `client` / `deliver` produces exactly one step;
 * a `settle` produces one step per drained delivery (so the macro stays a
 * transparent, replayable sequence — not a black box). Mutates the world's
 * `states` / `pending` / `clock` in place (the local fold bag).
 */
function applyEvent(world: SimWorld, event: SimEvent, steps: SimStep[]): void {
  if (event.kind === "partition") {
    // A pure network-fault move: replace the down-set, advance the clock, record
    // a step. No message moves and no node state changes — the effect surfaces
    // later when `deliverOne` drops traffic to/from a down node.
    world.clock += 1;
    world.down = new Set(event.down);
    steps.push({
      event,
      pending: world.pending.length,
      states: snapshot(world.states),
    });
    return;
  }

  if (event.kind === "settle") {
    // Drain FIFO (index 0) until empty or the bound is hit. Each delivery is its
    // own recorded step, tagged as the deliver-index-0 it actually is.
    const bound = Math.max(0, event.bound);
    for (let n = 0; n < bound && world.pending.length > 0; n++) {
      const inFlight = deliverOne(world, 0);
      steps.push({
        event: { kind: "deliver", index: 0 },
        pending: world.pending.length,
        states: snapshot(world.states),
        // Each drained delivery is its OWN step, so record that step's own
        // delivered message (not "the last of the settle"). The pool was
        // non-empty (loop guard), so `inFlight` is never null here.
        ...(inFlight ? { delivered: deliveredOf(inFlight) } : {}),
      });
    }
    return;
  }

  // The message a top-level `deliver` consumed (null on an empty-pool no-op);
  // read off below into the step's additive `delivered` field. `undefined` for
  // every non-deliver event kind.
  let delivered: InFlight | null = null;
  if (event.kind === "deliver") {
    delivered = deliverOne(world, event.index);
  } else {
    // timer / client: drive the acting node's verb directly.
    world.clock += 1;
    const at = world.clock;
    const actor = event.node;
    const node = world.handles.get(actor);
    const state = world.states[actor];
    if (node && state) {
      const inbound: RaftMsg<number> =
        event.kind === "timer"
          ? event.timer === "election"
            ? { _tag: "election_timeout_fired", at }
            : { _tag: "heartbeat_fired", at }
          : { _tag: "client_command", command: event.command };
      const [next, cmds] = applyInbound(node, state, inbound, at);
      world.states[actor] = next;
      park(world, actor, cmds);
    }
  }

  steps.push({
    event,
    pending: world.pending.length,
    states: snapshot(world.states),
    // Additive read-off: present only when a `deliver` actually consumed a
    // message. Absent (key omitted) for timer/client and empty-pool delivers,
    // so the step is structurally identical to a pre-#144 trace.
    ...(delivered ? { delivered: deliveredOf(delivered) } : {}),
  });
}

/** Deep-freeze-free structural copy of a cluster snapshot (states are already immutable values). */
function snapshot(states: Record<NodeId, RaftState<number>>): ClusterStates {
  return { ...states };
}

/**
 * Run a schedule against a fresh N-node cluster, recording the full trace. Pure
 * given `(configs, schedule)`: no clock, no RNG, no IO — the only "time" is the
 * driver's logical clock, advanced one tick per event. Each node gets a
 * fixed-jitter rng derived from its index (distinct but deterministic timeouts).
 */
export function runSchedule(
  configs: readonly RaftConfig[],
  schedule: Schedule,
): SimTrace {
  const handles = new Map<NodeId, RaftNode<number>>();
  const states: Record<NodeId, RaftState<number>> = {};
  configs.forEach((config, i) => {
    const node = createRaftNode<number>(config, fixedRng(i, configs.length));
    handles.set(config.self, node);
    states[config.self] = node.init();
  });

  const world: SimWorld = {
    handles,
    states,
    pending: [],
    clock: 0,
    down: new Set(),
  };
  const steps: SimStep[] = [];

  for (const event of schedule) {
    applyEvent(world, event, steps);
  }

  return {
    nodes: configs.map((c) => c.self),
    steps,
    final: snapshot(world.states),
  };
}

/**
 * Replay a schedule from a fresh cluster. Identical to {@link runSchedule} (it
 * IS `runSchedule`) — exposed under a name that documents intent at the call
 * site: a replay is meant to reproduce a prior run's trace byte-for-byte.
 */
export function replaySchedule(
  configs: readonly RaftConfig[],
  schedule: Schedule,
): SimTrace {
  return runSchedule(configs, schedule);
}

// ===========================================================================
// Comparison helpers (for the determinism property + counterexample reports)
// ===========================================================================

/**
 * Structural equality of two cluster snapshots. Used by the determinism
 * property: a run and its replay must produce identical per-node state for every
 * node. (Tests use vitest `toEqual` for the same comparison; this is the
 * dependency-free version the driver can expose for ad-hoc checks.)
 */
export function clusterStatesEqual(
  a: ClusterStates,
  b: ClusterStates,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ===========================================================================
// Re-exports the safety suite reads (so it imports the harness, not ./index)
// ===========================================================================

export type { LogEntry, NodeId, RaftConfig, RaftState };
