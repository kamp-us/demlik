/**
 * @demlik/tea/raft — the ELECTION half of Raft (Figure 2) as a pure TEA
 * reducer. Slice #119 of the consensus epic (#117): the role state machine
 * (`follower → candidate → leader`), election + heartbeat timers as
 * `DeadlineSub`s, and `RequestVote` request/reply handling. Log replication
 * (`AppendEntries` payloads + commit-index advancement), persistence, the
 * safety-property suite, and the multi-node harness are LATER siblings
 * (#120/#121/#122/#123) — out of scope here.
 *
 * The Raft paper ("In Search of an Understandable Consensus Algorithm",
 * raft.github.io) maps onto TEA almost 1:1, and this module is the first proof
 * of that mapping:
 *
 *   - **Reducer** — the Raft transition function over `RaftState`. PURE: it
 *     reads no ambient clock and no ambient RNG. Wall time arrives as the `at`
 *     parameter every verb takes (the firing Msg carries it, same discipline
 *     as `../poller`); election-timeout jitter comes from the `rng` injected
 *     ONCE at `createRaftNode` (default `Math.random` at the effect boundary, a
 *     fixed value in tests). No verb body names the global RNG or `Date.now`,
 *     so a node driven by a recorded `(timer × message)` schedule re-decides
 *     bit-for-bit — the headline replay-testing payoff of the epic.
 *   - **Sub** — the election-timeout and heartbeat timers are `DeadlineSub`s
 *     (`../deadline`, the same shape `../poller` / the agent layer arm). A
 *     fired timer is a `Msg` the consumer routes back into a verb; the verb
 *     never owns a `setTimeout`.
 *   - **Cmd** — the RPCs (`RequestVote` request + reply, empty `AppendEntries`
 *     heartbeat) are `Cmd`s routed through the consumer's `interpret` over an
 *     injected transport port. This module emits the Cmd literals; it performs
 *     NO networking. Tests assert against the emitted Cmds and fake the
 *     transport.
 *
 * Invalid states are unrepresentable: the leader-only volatile state
 * (`nextIndex` / `matchIndex`) lives ONLY on the `leader` variant of the role
 * union, so a follower or candidate cannot carry — or be asked for — replication
 * bookkeeping it has no business holding (#119 acceptance criterion).
 *
 * NOT a substrate primitive: it depends only on sibling subpaths (`../deadline`)
 * and the core `Cmd` / `Sub` types. Consumers reach it via the
 * `@demlik/tea/raft` subpath.
 */

import { type DeadlineSub, deadlineSub } from "../deadline";
import { type Cmd, type Sub, subId } from "../index";

// ===========================================================================
// Identity & config
// ===========================================================================

/**
 * A Raft node identity. Opaque string; the cluster's `peers` set lists every
 * OTHER node (self excluded). Branded-by-convention only — kept a plain string
 * so transport adapters can use it as an address key without unwrapping.
 */
export type NodeId = string;

/**
 * A Raft term — a monotonically increasing logical clock. Starts at 0 (no
 * leader elected yet) and bumps by one each time a node starts an election.
 */
export type Term = number;

/**
 * The election-timeout window, in milliseconds. Raft randomizes each node's
 * timeout uniformly in `[minMs, maxMs]` so split votes resolve quickly — the
 * single source of liveness in leader election. The concrete duration is drawn
 * from the injected `rng` (never `Math.random` ambiently), so a fixed `rng`
 * pins the timeout and the run replays identically.
 */
export interface ElectionTimeout {
  /** Lower bound of the randomized election timeout, inclusive. */
  readonly minMs: number;
  /** Upper bound of the randomized election timeout, inclusive. */
  readonly maxMs: number;
}

/**
 * Static configuration for one Raft node, injected at construction. Pure data:
 * no node reads its own id or peer set from any ambient source.
 */
export interface RaftConfig {
  /** This node's identity. */
  readonly self: NodeId;
  /**
   * Every OTHER node in the cluster (self excluded). Cluster size is
   * `peers.length + 1`; a majority is `floor((peers.length + 1) / 2) + 1`.
   */
  readonly peers: readonly NodeId[];
  /** The randomized election-timeout window (see {@link ElectionTimeout}). */
  readonly electionTimeout: ElectionTimeout;
  /**
   * The leader's heartbeat interval, in milliseconds. A leader re-arms an empty
   * `AppendEntries` to every peer this often; it MUST be comfortably below
   * `electionTimeout.minMs` so followers never time out under a live leader.
   */
  readonly heartbeatMs: number;
}

// ===========================================================================
// Log placeholder (#120 lands the real entries)
// ===========================================================================

/**
 * A placeholder log entry. #119 is election-only: the candidate "log at least
 * as up-to-date" check is stubbed `true` (see {@link logIsUpToDate}), so the
 * entries themselves carry no payload yet. #120 replaces this with the real
 * `{ term, index, command }` shape and the genuine up-to-date comparison.
 */
export interface LogEntry {
  /** The term in which this entry was created. Real entries land in #120. */
  readonly term: Term;
}

// ===========================================================================
// Role union — invalid states unrepresentable
// ===========================================================================

/**
 * The role discriminated union. `_tag` is the discriminant (engine convention).
 *
 * The crux of "make invalid states unrepresentable": the leader-only volatile
 * state — `nextIndex` / `matchIndex`, the per-peer replication bookkeeping —
 * exists ONLY on the `leader` variant. A follower or candidate value has no
 * such field to read or mis-set; the type makes "a follower with a matchIndex
 * map" unspellable rather than merely discouraged (#119 acceptance criterion).
 *
 * `candidate` carries the per-election vote tally (`votesGranted`, including
 * self) so the reducer can decide majority without re-deriving it.
 */
export type Role =
  | { readonly _tag: "follower" }
  | {
      readonly _tag: "candidate";
      /**
       * The set of nodes (self + peers) that have granted this candidate a vote
       * THIS term. A `Set`-by-id semantic kept as a readonly array of unique
       * ids; the reducer dedups on insert so a duplicate reply never
       * double-counts toward the majority.
       */
      readonly votesGranted: readonly NodeId[];
    }
  | {
      readonly _tag: "leader";
      /**
       * For each peer, the index of the next log entry to send (Figure 2,
       * leader volatile state). Initialized to the leader's last-log index + 1
       * on election; #120 advances it on `AppendEntries`. Keyed by `NodeId`.
       */
      readonly nextIndex: Readonly<Record<NodeId, number>>;
      /**
       * For each peer, the highest log index known to be replicated (Figure 2,
       * leader volatile state). Initialized to 0; #120 advances it. Keyed by
       * `NodeId`.
       */
      readonly matchIndex: Readonly<Record<NodeId, number>>;
    };

// ===========================================================================
// RaftState — persistent + volatile, role-discriminated
// ===========================================================================

/**
 * The whole state of one Raft node. Persistent state (`currentTerm`,
 * `votedFor`, `log`) survives crashes in a real deployment (#122); volatile
 * state (`commitIndex`, the leader's `nextIndex`/`matchIndex`) is rebuilt on
 * restart. #119 holds it all in memory.
 */
export interface RaftState {
  /**
   * Latest term this node has seen (Figure 2, persistent). Init 0; increases
   * monotonically — every higher-term message observed bumps it (and steps the
   * node down to follower).
   */
  readonly currentTerm: Term;
  /**
   * The candidate this node voted for in `currentTerm`, or `null` if it has not
   * voted this term (Figure 2, persistent). Reset to `null` whenever
   * `currentTerm` advances.
   */
  readonly votedFor: NodeId | null;
  /**
   * The replicated log (Figure 2, persistent). A placeholder array in #119 —
   * the real entries + commit semantics land in #120. Present now so the
   * up-to-date stub and the leader's `nextIndex` initialization have something
   * to read.
   */
  readonly log: readonly LogEntry[];
  /**
   * Highest log index known to be committed (Figure 2, volatile). Placeholder
   * (stays 0) in #119; #120 advances it as entries replicate to a majority.
   */
  readonly commitIndex: number;
  /** The current role + its role-specific state (see {@link Role}). */
  readonly role: Role;
}

// ===========================================================================
// Messages — fired timers + inbound RPCs, the verbs' inputs
// ===========================================================================

/**
 * Tagged wire shapes the consumer unions into its machine's Msg type and routes
 * into the matching verb. `_tag` is the discriminant. Each carries the sender's
 * `term` (Figure 2: every RPC carries the sender's `currentTerm`) so the
 * "rules for all servers" higher-term step-down applies uniformly.
 */

/** Inbound `RequestVote` RPC — a candidate asking this node for its vote. */
export interface RequestVoteRequest {
  readonly _tag: "request_vote_request";
  /** The candidate's term. */
  readonly term: Term;
  /** The candidate requesting the vote. */
  readonly candidateId: NodeId;
  /**
   * Index of the candidate's last log entry (Figure 2). Read by the up-to-date
   * check — STUBBED in #119 (see {@link logIsUpToDate}); real comparison in #120.
   */
  readonly lastLogIndex: number;
  /** Term of the candidate's last log entry (Figure 2). Stub-read in #119. */
  readonly lastLogTerm: Term;
}

/** Inbound `RequestVote` reply — a peer answering this node's vote request. */
export interface RequestVoteReply {
  readonly _tag: "request_vote_reply";
  /** The replier's `currentTerm`, for the candidate to update itself. */
  readonly term: Term;
  /** The peer that replied (so the candidate can dedup its tally). */
  readonly from: NodeId;
  /** Whether the peer granted its vote. */
  readonly voteGranted: boolean;
}

/** Inbound `AppendEntries` RPC — in #119, only the empty heartbeat is modeled. */
export interface AppendEntriesRequest {
  readonly _tag: "append_entries_request";
  /** The leader's term. */
  readonly term: Term;
  /** The leader sending the heartbeat (so a follower can track the leader). */
  readonly leaderId: NodeId;
}

/**
 * The two fired-timer Msgs, dispatched by the `DeadlineSub`s this module arms.
 * The consumer maps a `deadline_exceeded` whose id matches the election /
 * heartbeat sub id onto these (`toRaftMsg` does the mapping), then routes them
 * into `onElectionTimeout` / `onHeartbeat`. Each carries the firing `at` (the
 * deadline's `atMs`) so the verb re-arms the next absolute target without
 * reading the clock.
 */
export interface ElectionTimeoutFired {
  readonly _tag: "election_timeout_fired";
  /** Absolute wall-clock ms the timer fired at (the deadline's target). */
  readonly at: number;
}
export interface HeartbeatFired {
  readonly _tag: "heartbeat_fired";
  /** Absolute wall-clock ms the timer fired at (the deadline's target). */
  readonly at: number;
}

/** The full inbound-Msg union a Raft node's `update` handles in #119. */
export type RaftMsg =
  | RequestVoteRequest
  | RequestVoteReply
  | AppendEntriesRequest
  | ElectionTimeoutFired
  | HeartbeatFired;

// ===========================================================================
// Cmds — outbound RPCs routed through the injected transport port
// ===========================================================================

/**
 * Outbound RPCs as `Cmd`s. The consumer's `interpret` performs each over the
 * injected transport port (a fetch binding, an in-memory bus in tests); this
 * module only emits the literals. `to` addresses a peer; a reply addresses the
 * original caller.
 */

/** Send a `RequestVote` request to one peer (fanned out, one Cmd per peer). */
export interface SendRequestVote extends Cmd<"raft:send_request_vote"> {
  /** The peer to ask. */
  readonly to: NodeId;
  /** This candidate's term. */
  readonly term: Term;
  /** This candidate's id. */
  readonly candidateId: NodeId;
  /** This candidate's last-log index (stub payload until #120). */
  readonly lastLogIndex: number;
  /** This candidate's last-log term (stub payload until #120). */
  readonly lastLogTerm: Term;
}

/** Reply to a `RequestVote` request the original candidate awaits. */
export interface SendRequestVoteReply
  extends Cmd<"raft:send_request_vote_reply"> {
  /** The candidate that asked. */
  readonly to: NodeId;
  /** This node's `currentTerm`. */
  readonly term: Term;
  /** Whether this node granted its vote. */
  readonly voteGranted: boolean;
}

/** Send an empty `AppendEntries` (heartbeat) to one peer. */
export interface SendAppendEntries extends Cmd<"raft:send_append_entries"> {
  /** The peer to heartbeat. */
  readonly to: NodeId;
  /** The leader's term. */
  readonly term: Term;
  /** The leader's id. */
  readonly leaderId: NodeId;
}

/** The full outbound-Cmd union a Raft node emits in #119. */
export type RaftCmd =
  | SendRequestVote
  | SendRequestVoteReply
  | SendAppendEntries;

// ===========================================================================
// Subs — election + heartbeat DeadlineSubs
// ===========================================================================

/** Stable sub id for this node's election-timeout deadline. */
function electionSubId(self: NodeId): string {
  return `raft:election:${self}`;
}
/** Stable sub id for this node's heartbeat deadline. */
function heartbeatSubId(self: NodeId): string {
  return `raft:heartbeat:${self}`;
}

/**
 * Map a fired `deadline_exceeded` (from `../deadline`'s subscribe cell) onto the
 * Raft timer Msg it represents, by matching the sub id. Returns `null` if the
 * id belongs to neither Raft timer — so a consumer wiring several deadline
 * families can route ours without a brittle string-prefix check at the call
 * site. The deadline's `atMs` becomes the Msg's `at` (no clock read).
 */
export function toRaftMsg(
  self: NodeId,
  fired: { readonly id: string; readonly atMs: number },
): ElectionTimeoutFired | HeartbeatFired | null {
  if (fired.id === electionSubId(self)) {
    return { _tag: "election_timeout_fired", at: fired.atMs };
  }
  if (fired.id === heartbeatSubId(self)) {
    return { _tag: "heartbeat_fired", at: fired.atMs };
  }
  return null;
}

// ===========================================================================
// The node handle — pure verbs + subs, rng injected once
// ===========================================================================

/**
 * Result tuple every verb returns: the next state and the Cmds to emit. Matches
 * the `(state, cmds)` shape the substrate's reducer cells return, so a consumer
 * threads these straight through their `update`.
 */
export type RaftStep = readonly [RaftState, readonly RaftCmd[]];

/**
 * The node handle returned by {@link createRaftNode}. Spread its hooks into a
 * machine: `init()` seeds a fresh follower, the verbs (`onElectionTimeout`,
 * `onRequestVote`, `onRequestVoteReply`, `onAppendEntries`, `onHeartbeat`) are
 * the reducer cells, and `subs(state, now)` returns the live `DeadlineSub`s.
 *
 * Every verb is PURE given the injected `rng`: no clock read (time arrives as
 * `at`), no ambient randomness, no mutation, no throw.
 */
export interface RaftNode {
  /** Seed a fresh node: term 0, no vote, empty log, follower. */
  init(): RaftState;

  /**
   * The election timeout fired without a heartbeat / granted vote. Convert
   * follower OR candidate → candidate and start a NEW election: bump the term,
   * vote for self, reset the tally to `{self}`, and emit `RequestVote` to every
   * peer. A leader ignores its own election timeout (it has a live mandate).
   *
   * `at` is the firing wall-clock (carried by the Msg) — used only so the
   * caller can re-arm the next election deadline at `at + <jittered timeout>`
   * via `subs`; the verb itself reads no clock.
   *
   * A single-node cluster (`peers` empty) wins the election immediately:
   * one vote (self) is already a majority, so the node converts straight to
   * leader and emits the first heartbeat round (empty here — no peers).
   */
  onElectionTimeout(state: RaftState, at: number): RaftStep;

  /**
   * Handle an inbound `RequestVote` request (Figure 2 receiver rule).
   *
   * - Rules for all servers: if `req.term > currentTerm`, adopt the term, clear
   *   `votedFor`, and step down to follower BEFORE evaluating the grant.
   * - Reply `false` if `req.term < currentTerm` (stale candidate).
   * - Otherwise grant iff (`votedFor` is null OR already this candidate) AND the
   *   candidate's log is at least as up-to-date (STUBBED `true` in #119; real
   *   check in #120). Granting sets `votedFor = candidateId`.
   *
   * Granting a vote (or stepping down) counts as "heard from a valid leader /
   * candidate", so the consumer re-arms the election timer off the resulting
   * state (`subs`).
   */
  onRequestVote(state: RaftState, req: RequestVoteRequest): RaftStep;

  /**
   * Handle an inbound `RequestVote` reply (the candidate tallying votes).
   *
   * - Rules for all servers: a higher-term reply steps the node down to follower
   *   (it lost the election implicitly).
   * - A stale-term reply (`reply.term < currentTerm`) is dropped.
   * - A grant from a peer not yet counted adds to the tally; on reaching a
   *   majority the candidate converts to leader (initializing `nextIndex` /
   *   `matchIndex`) and emits the first heartbeat round to every peer.
   * - A reply that arrives when the node is no longer a candidate (already
   *   leader / stepped down) is a no-op.
   */
  onRequestVoteReply(state: RaftState, reply: RequestVoteReply): RaftStep;

  /**
   * Handle an inbound `AppendEntries` (heartbeat in #119).
   *
   * - Reply-side rule: `req.term < currentTerm` is rejected — a stale leader; the
   *   node holds its role (no reply Cmd modeled in #119; #120 adds the
   *   AppendEntries reply).
   * - `req.term >= currentTerm`: a valid leader exists for this term. Adopt the
   *   term if higher, and revert candidate → follower (Figure 2: a candidate
   *   that hears from a leader of term ≥ its own steps down). A follower stays
   *   follower; a leader of the same term should not exist (election safety) but
   *   a higher-term one steps this leader down.
   *
   * Hearing a valid heartbeat resets the election timer (the consumer re-arms
   * off the resulting state).
   */
  onAppendEntries(state: RaftState, req: AppendEntriesRequest): RaftStep;

  /**
   * The leader's heartbeat timer fired: emit an empty `AppendEntries` to every
   * peer. A no-op (no Cmds) on a non-leader — a stale heartbeat fire racing a
   * step-down the reconcile pass has not yet retired.
   */
  onHeartbeat(state: RaftState, at: number): RaftStep;

  /**
   * The live `DeadlineSub`s for `state`, computed against the current clock
   * `now` (the ONLY clock read — at subscribe time, never in a verb; same seam
   * as `../poller`'s `subs`). The election-timeout target is `now + <jittered
   * timeout>` drawn from the injected `rng`; the heartbeat target is
   * `now + heartbeatMs`.
   *
   * - follower / candidate → arm ONLY the election timeout.
   * - leader → arm ONLY the heartbeat (a leader does not time itself out).
   */
  subs(state: RaftState, now: number): readonly DeadlineSub[];
}

/**
 * The candidate "log at least as up-to-date" check (Figure 2 receiver rule).
 *
 * STUBBED `true` in #119 — election-only slice. #120 lands the real log and
 * replaces this with the genuine comparison: the candidate's log is up-to-date
 * iff its last-log term is greater, OR equal-term-and-its-last-index is ≥ ours.
 * Until then every otherwise-eligible request is granted on the log axis, so
 * the term / `votedFor` rules (which ARE real here) are what gate the vote.
 *
 * Kept as a named exported function (not an inline `true`) so #120 is a
 * one-symbol swap and the seam is greppable.
 */
// #120: replace the stub with the real last-log-term / last-log-index comparison.
export function logIsUpToDate(
  _log: readonly LogEntry[],
  _candidateLastLogIndex: number,
  _candidateLastLogTerm: Term,
): boolean {
  return true;
}

/**
 * The number of votes that constitutes a majority of the cluster. Cluster size
 * is `peers + self`; a strict majority is `floor(size / 2) + 1`. A single-node
 * cluster (size 1) needs 1 vote — its own.
 */
function majority(peerCount: number): number {
  const clusterSize = peerCount + 1;
  return Math.floor(clusterSize / 2) + 1;
}

/**
 * Build a Raft node from `config`. Returns the hook bag to spread into a
 * machine. Pure factory — no clock read, no timer; everything happens when the
 * consumer calls the verbs / `subs` with an injected `at` / `now`.
 *
 * `rng` is injected ONCE here (default `Math.random` at the effect boundary, a
 * fixed value in tests) and read ONLY by `subs` to jitter the election timeout.
 * No verb body names the global RNG, so a node driven by a recorded schedule
 * replays bit-for-bit (the epic's headline payoff).
 */
export function createRaftNode(
  config: RaftConfig,
  rng: () => number = Math.random,
): RaftNode {
  const { self, peers, electionTimeout, heartbeatMs } = config;
  const quorum = majority(peers.length);

  /**
   * Adopt a strictly-higher term: bump `currentTerm`, clear `votedFor`, and
   * step down to follower (Figure 2 "rules for all servers"). Pure; the caller
   * folds the rest of its decision on top of the returned state. Returns the
   * input unchanged when `term` is not higher (so callers can apply it
   * unconditionally before evaluating their own rule).
   */
  function adoptHigherTerm(state: RaftState, term: Term): RaftState {
    if (term <= state.currentTerm) return state;
    return {
      ...state,
      currentTerm: term,
      votedFor: null,
      role: { _tag: "follower" },
    };
  }

  /**
   * Convert to candidate and start a fresh election. Bumps the term, votes for
   * self, resets the tally to `{self}`, and emits `RequestVote` to every peer.
   * Shared by `onElectionTimeout` for both follower→candidate and
   * candidate→candidate (a new election after a split vote). The last-log
   * index/term are stub-read from the placeholder log (real values in #120).
   */
  function startElection(state: RaftState): RaftStep {
    const newTerm = state.currentTerm + 1;
    const lastLogIndex = state.log.length;
    const lastLogTerm = state.log.at(-1)?.term ?? 0;

    const next: RaftState = {
      ...state,
      currentTerm: newTerm,
      votedFor: self,
      role: { _tag: "candidate", votesGranted: [self] },
    };

    const requests: RaftCmd[] = peers.map((peer) => ({
      type: "raft:send_request_vote",
      to: peer,
      term: newTerm,
      candidateId: self,
      lastLogIndex,
      lastLogTerm,
    }));

    // A single-node cluster reaches majority with its own vote alone — convert
    // straight to leader and emit the (empty, no-peer) first heartbeat round.
    if (
      next.role._tag === "candidate" &&
      next.role.votesGranted.length >= quorum
    ) {
      return becomeLeader(next);
    }

    return [next, requests];
  }

  /**
   * Convert a winning candidate to leader: initialize per-peer `nextIndex`
   * (leader's last-log index + 1) and `matchIndex` (0), then emit the first
   * heartbeat round to every peer. Figure 2 leader-on-election rules. `nextIndex`
   * / `matchIndex` live only on the leader variant — built here, nowhere else.
   */
  function becomeLeader(state: RaftState): RaftStep {
    const nextIdx = state.log.length + 1;
    const nextIndex: Record<NodeId, number> = {};
    const matchIndex: Record<NodeId, number> = {};
    for (const peer of peers) {
      nextIndex[peer] = nextIdx;
      matchIndex[peer] = 0;
    }

    const leader: RaftState = {
      ...state,
      role: { _tag: "leader", nextIndex, matchIndex },
    };

    return [leader, heartbeats(leader)];
  }

  /** The empty-AppendEntries fanout a leader sends each heartbeat interval. */
  function heartbeats(state: RaftState): RaftCmd[] {
    return peers.map((peer) => ({
      type: "raft:send_append_entries",
      to: peer,
      term: state.currentTerm,
      leaderId: self,
    }));
  }

  function init(): RaftState {
    return {
      currentTerm: 0,
      votedFor: null,
      log: [],
      commitIndex: 0,
      role: { _tag: "follower" },
    };
  }

  function onElectionTimeout(state: RaftState, _at: number): RaftStep {
    // A leader has a live mandate; its own election timer is never armed (see
    // `subs`), but a stale fire racing a step-up must be a no-op regardless.
    if (state.role._tag === "leader") return [state, []];
    return startElection(state);
  }

  function onRequestVote(state: RaftState, req: RequestVoteRequest): RaftStep {
    // Rules for all servers: a higher term steps us down BEFORE we decide.
    const base = adoptHigherTerm(state, req.term);

    // Stale candidate — reject. Use `base.currentTerm` (already adopted) so the
    // reply carries our up-to-date term.
    if (req.term < base.currentTerm) {
      return [base, [voteReply(req.candidateId, base.currentTerm, false)]];
    }

    const free = base.votedFor === null || base.votedFor === req.candidateId;
    const upToDate = logIsUpToDate(base.log, req.lastLogIndex, req.lastLogTerm);
    const grant = free && upToDate;

    if (!grant) {
      return [base, [voteReply(req.candidateId, base.currentTerm, false)]];
    }

    // Granting records the vote (and resets the election timer via `subs`, off
    // the returned follower state).
    const granted: RaftState = {
      ...base,
      votedFor: req.candidateId,
      role: { _tag: "follower" },
    };
    return [granted, [voteReply(req.candidateId, base.currentTerm, true)]];
  }

  function onRequestVoteReply(
    state: RaftState,
    reply: RequestVoteReply,
  ): RaftStep {
    // Rules for all servers: a higher-term reply steps us down (we lost).
    if (reply.term > state.currentTerm) {
      return [adoptHigherTerm(state, reply.term), []];
    }

    // Drop stale-term replies and replies for a role that is no longer
    // tallying (already leader / stepped down).
    if (reply.term < state.currentTerm) return [state, []];
    if (state.role._tag !== "candidate") return [state, []];
    if (!reply.voteGranted) return [state, []];

    // Dedup the granter so a duplicate reply never double-counts.
    if (state.role.votesGranted.includes(reply.from)) return [state, []];

    const votesGranted = [...state.role.votesGranted, reply.from];
    const tallied: RaftState = {
      ...state,
      role: { _tag: "candidate", votesGranted },
    };

    if (votesGranted.length >= quorum) return becomeLeader(tallied);
    return [tallied, []];
  }

  function onAppendEntries(
    state: RaftState,
    req: AppendEntriesRequest,
  ): RaftStep {
    // Stale leader — reject by holding our role (no reply Cmd modeled in #119).
    if (req.term < state.currentTerm) return [state, []];

    // Valid leader for term ≥ ours. Adopt a higher term (clears votedFor, steps
    // down); then ensure we are a follower for this term — a candidate that
    // hears from a leader of term ≥ its own reverts (Figure 2). Hearing a
    // heartbeat resets the election timer (consumer re-arms off this state).
    const base = adoptHigherTerm(state, req.term);
    if (base.role._tag === "follower") return [base, []];
    return [{ ...base, role: { _tag: "follower" } }, []];
  }

  function onHeartbeat(state: RaftState, _at: number): RaftStep {
    // Only a leader heartbeats. A stale fire racing a step-down is a no-op.
    if (state.role._tag !== "leader") return [state, []];
    return [state, heartbeats(state)];
  }

  function subs(state: RaftState, now: number): readonly DeadlineSub[] {
    if (state.role._tag === "leader") {
      // A leader arms ONLY the heartbeat; it never times itself out.
      return [deadlineSub(heartbeatSubId(self), now + heartbeatMs)];
    }
    // Follower / candidate arm ONLY the election timeout, jittered in
    // [minMs, maxMs] from the injected rng (never Math.random ambiently).
    const span = electionTimeout.maxMs - electionTimeout.minMs;
    const timeout = electionTimeout.minMs + Math.floor(rng() * (span + 1));
    return [deadlineSub(electionSubId(self), now + timeout)];
  }

  /** Build a `RequestVote` reply Cmd addressed to the asking candidate. */
  function voteReply(
    to: NodeId,
    term: Term,
    voteGranted: boolean,
  ): SendRequestVoteReply {
    return { type: "raft:send_request_vote_reply", to, term, voteGranted };
  }

  return {
    init,
    onElectionTimeout,
    onRequestVote,
    onRequestVoteReply,
    onAppendEntries,
    onHeartbeat,
    subs,
  };
}

// Re-export the sub-id builders' identities for consumers wiring `subscribe`
// cells / asserting against the armed sub ids without re-deriving the strings.
export { electionSubId, heartbeatSubId };

// `Sub` / `subId` are imported for the `DeadlineSub` return type and id
// branding inside `../deadline`; re-exported here so a consumer wiring the Raft
// subs into a machine's `subscribe` map need not also reach into the core.
export type { Sub };
export { subId };
