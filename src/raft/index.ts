/**
 * @demlik/tea/raft — Raft (Figure 2) as a pure TEA reducer. Slices #119 (the
 * election half) + #120 (the log-replication half) of the consensus epic
 * (#117): the role state machine (`follower → candidate → leader`), election +
 * heartbeat timers as `DeadlineSub`s, `RequestVote` request/reply handling, and
 * — added in #120 — the real replicated log with the Figure-2 `AppendEntries`
 * consistency check, leader `nextIndex`/`matchIndex` bookkeeping, and
 * `commitIndex` advancement under the Figure-8 current-term safety rule.
 * Persistence/cold-wake (#122) and the safety-property suite + multi-node
 * harness (#121/#123) are LATER siblings — out of scope here.
 *
 * The Raft paper ("In Search of an Understandable Consensus Algorithm",
 * raft.github.io) maps onto TEA almost 1:1, and this module is the proof of
 * that mapping:
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
 *   - **Cmd** — the RPCs (`RequestVote` request + reply, `AppendEntries`
 *     request + reply) are `Cmd`s routed through the consumer's `interpret`
 *     over an injected transport port. This module emits the Cmd literals; it
 *     performs NO networking. Tests assert against the emitted Cmds and fake
 *     the transport.
 *
 * Invalid states are unrepresentable: the leader-only volatile state
 * (`nextIndex` / `matchIndex`) lives ONLY on the `leader` variant of the role
 * union, so a follower or candidate cannot carry — or be asked for — replication
 * bookkeeping it has no business holding (#119 acceptance criterion).
 *
 * **Persistence seam (#120 → #122).** The replicated log *is* the event log
 * (epic Approach). The verbs here keep `log` a pure value computed by folding —
 * a client command or a follower-side `AppendEntries` append/truncate is a
 * deterministic function of `(state, msg)`, with no clock/RNG and no mutation.
 * That is exactly the port the event-sourced store under `../do`
 * (`doEventSourcedStore`) folds over: its `replay(machine, { loaded, msgs })`
 * re-runs this same reducer to rebuild `log` byte-identically. #120 therefore
 * routes the log through the pure-reducer seam and defers the *effectful* host
 * wiring (async persist-before-respond, snapshot retention, cold-wake replay)
 * to #122 — see {@link RaftState.log} and {@link RaftNode.onClientCommand}.
 *
 * Generic over the command payload `C` (`unknown` by default): a `LogEntry`
 * carries an opaque `command` the consumer's state machine interprets on
 * commit. Raft itself never inspects it.
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
// Log entry — the real { term, index, command } (#120)
// ===========================================================================

/**
 * One entry in the replicated log (Figure 2). Generic over the command payload
 * `C` (`unknown` by default): Raft itself never inspects `command` — it
 * replicates and orders the opaque blob, and the consumer's state machine
 * applies it once the entry commits.
 *
 * `index` is 1-based (Raft convention: index 0 means "before the log"; the
 * first real entry is index 1), so an empty log has `lastLogIndex` 0. It is
 * stored on the entry rather than derived from array position so the
 * consistency check and the leader's per-peer bookkeeping read it directly,
 * and so a persisted/replayed log carries its own indices.
 */
export interface LogEntry<C = unknown> {
  /** The term in which the leader created this entry. */
  readonly term: Term;
  /** This entry's 1-based position in the log. */
  readonly index: number;
  /** The opaque command this entry replicates; applied by the consumer on commit. */
  readonly command: C;
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
 * The whole state of one Raft node, generic over the command payload `C`.
 * Persistent state (`currentTerm`, `votedFor`, `log`) survives crashes in a
 * real deployment (#122); volatile state (`commitIndex`, the leader's
 * `nextIndex`/`matchIndex`) is rebuilt on restart.
 */
export interface RaftState<C = unknown> {
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
   * The replicated log (Figure 2, persistent). 1-based: `log[i]` has
   * `index === i + 1`; `lastLogIndex` is `log.length`. The log *is* the event
   * log (epic Approach): every mutation here — a leader appending a client
   * command, a follower truncating-and-appending on `AppendEntries` — is a pure
   * function of `(state, msg)`, so the event-sourced store under `../do` rebuilds
   * it by folding this same reducer over the recorded Msgs (#122 wires the host;
   * see the module header's persistence-seam note).
   */
  readonly log: readonly LogEntry<C>[];
  /**
   * Highest log index known to be committed (Figure 2, volatile). Init 0. A
   * follower advances it to `min(leaderCommit, lastNewEntryIndex)` on a matching
   * `AppendEntries`; a leader advances it under the Figure-8 current-term
   * majority rule (see {@link RaftNode.onAppendEntriesReply}). Entries up to and
   * including `commitIndex` are durably agreed and safe for the consumer to apply.
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

/**
 * Inbound `AppendEntries` RPC (Figure 2). An empty `entries` array is a
 * heartbeat; a non-empty one replicates log entries. The `prevLog*` pair anchors
 * the consistency check, and `leaderCommit` carries the leader's commit index so
 * the follower can advance its own.
 */
export interface AppendEntriesRequest<C = unknown> {
  readonly _tag: "append_entries_request";
  /** The leader's term. */
  readonly term: Term;
  /** The leader sending this (so a follower can track the leader). */
  readonly leaderId: NodeId;
  /**
   * Index of the log entry immediately preceding `entries` (0 if `entries`
   * starts at the head of the log). The follower must already hold an entry at
   * this index whose term is `prevLogTerm`, or it rejects (consistency check).
   */
  readonly prevLogIndex: number;
  /** Term of the entry at `prevLogIndex` (0 when `prevLogIndex` is 0). */
  readonly prevLogTerm: Term;
  /** The new entries to store (empty for a heartbeat). Already index-stamped. */
  readonly entries: readonly LogEntry<C>[];
  /** The leader's `commitIndex`, so the follower can advance its own. */
  readonly leaderCommit: number;
}

/**
 * Inbound `AppendEntries` reply — a follower answering this leader's
 * replication RPC (Figure 2 reply shape). `matchIndex` is the index of the last
 * entry the follower now agrees on (0 if none), used by the leader to advance
 * `matchIndex`/`nextIndex` on success without re-deriving it.
 */
export interface AppendEntriesReply {
  readonly _tag: "append_entries_reply";
  /** The replier's `currentTerm`, for the leader to update itself / step down. */
  readonly term: Term;
  /** The follower that replied (so the leader can update its per-peer bookkeeping). */
  readonly from: NodeId;
  /** Whether the consistency check passed and the entries were stored. */
  readonly success: boolean;
  /**
   * On success, the index of the follower's last entry covered by this RPC
   * (`prevLogIndex + entries.length`) — the leader's new `matchIndex` for this
   * peer. Meaningless (0) on rejection.
   */
  readonly matchIndex: number;
}

/**
 * A client command submitted to this node (Figure 2 §5.3: clients send commands
 * to the leader). The leader appends it to its log and replicates; a non-leader
 * rejects it (the consumer would redirect the client to the known leader).
 */
export interface ClientCommand<C = unknown> {
  readonly _tag: "client_command";
  /** The opaque command to replicate (the consumer's state-machine input). */
  readonly command: C;
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

/** The full inbound-Msg union a Raft node's `update` handles. */
export type RaftMsg<C = unknown> =
  | RequestVoteRequest
  | RequestVoteReply
  | AppendEntriesRequest<C>
  | AppendEntriesReply
  | ClientCommand<C>
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

/**
 * Send an `AppendEntries` to one peer. Empty `entries` is a heartbeat; a
 * non-empty one replicates from the leader's `nextIndex` for that peer. Carries
 * the full Figure-2 payload so the follower can run its consistency check.
 */
export interface SendAppendEntries<C = unknown>
  extends Cmd<"raft:send_append_entries"> {
  /** The peer to send to. */
  readonly to: NodeId;
  /** The leader's term. */
  readonly term: Term;
  /** The leader's id. */
  readonly leaderId: NodeId;
  /** Index of the entry preceding `entries` (0 at the head of the log). */
  readonly prevLogIndex: number;
  /** Term of the entry at `prevLogIndex` (0 when `prevLogIndex` is 0). */
  readonly prevLogTerm: Term;
  /** The entries to replicate (empty for a heartbeat). */
  readonly entries: readonly LogEntry<C>[];
  /** The leader's `commitIndex`. */
  readonly leaderCommit: number;
}

/** Reply to an `AppendEntries` the original leader awaits. */
export interface SendAppendEntriesReply
  extends Cmd<"raft:send_append_entries_reply"> {
  /** The leader that asked. */
  readonly to: NodeId;
  /** This node's `currentTerm`. */
  readonly term: Term;
  /** Whether the consistency check passed and the entries were stored. */
  readonly success: boolean;
  /** On success, this node's new last-agreed index (the leader's `matchIndex`). */
  readonly matchIndex: number;
}

/** The full outbound-Cmd union a Raft node emits. */
export type RaftCmd<C = unknown> =
  | SendRequestVote
  | SendRequestVoteReply
  | SendAppendEntries<C>
  | SendAppendEntriesReply;

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
export type RaftStep<C = unknown> = readonly [
  RaftState<C>,
  readonly RaftCmd<C>[],
];

/**
 * The node handle returned by {@link createRaftNode}. Spread its hooks into a
 * machine: `init()` seeds a fresh follower, the verbs (`onElectionTimeout`,
 * `onRequestVote`, `onRequestVoteReply`, `onAppendEntries`, `onHeartbeat`) are
 * the reducer cells, and `subs(state, now)` returns the live `DeadlineSub`s.
 *
 * Every verb is PURE given the injected `rng`: no clock read (time arrives as
 * `at`), no ambient randomness, no mutation, no throw.
 */
export interface RaftNode<C = unknown> {
  /** Seed a fresh node: term 0, no vote, empty log, follower. */
  init(): RaftState<C>;

  /**
   * The election timeout fired without a heartbeat / granted vote. Convert
   * follower OR candidate → candidate and start a NEW election: bump the term,
   * vote for self, reset the tally to `{self}`, and emit `RequestVote` to every
   * peer (carrying the real last-log index/term). A leader ignores its own
   * election timeout (it has a live mandate).
   *
   * `at` is the firing wall-clock (carried by the Msg) — used only so the
   * caller can re-arm the next election deadline at `at + <jittered timeout>`
   * via `subs`; the verb itself reads no clock.
   *
   * A single-node cluster (`peers` empty) wins the election immediately:
   * one vote (self) is already a majority, so the node converts straight to
   * leader and emits the first heartbeat round (empty here — no peers).
   */
  onElectionTimeout(state: RaftState<C>, at: number): RaftStep<C>;

  /**
   * Handle an inbound `RequestVote` request (Figure 2 receiver rule).
   *
   * - Rules for all servers: if `req.term > currentTerm`, adopt the term, clear
   *   `votedFor`, and step down to follower BEFORE evaluating the grant.
   * - Reply `false` if `req.term < currentTerm` (stale candidate).
   * - Otherwise grant iff (`votedFor` is null OR already this candidate) AND the
   *   candidate's log is at least as up-to-date ({@link logIsUpToDate} — the
   *   real last-log term/index comparison, #120). Granting sets
   *   `votedFor = candidateId`.
   *
   * Granting a vote (or stepping down) counts as "heard from a valid leader /
   * candidate", so the consumer re-arms the election timer off the resulting
   * state (`subs`).
   */
  onRequestVote(state: RaftState<C>, req: RequestVoteRequest): RaftStep<C>;

  /**
   * Handle an inbound `RequestVote` reply (the candidate tallying votes).
   *
   * - Rules for all servers: a higher-term reply steps the node down to follower
   *   (it lost the election implicitly).
   * - A stale-term reply (`reply.term < currentTerm`) is dropped.
   * - A grant from a peer not yet counted adds to the tally; on reaching a
   *   majority the candidate converts to leader (initializing `nextIndex` /
   *   `matchIndex`) and emits the first `AppendEntries` round to every peer.
   * - A reply that arrives when the node is no longer a candidate (already
   *   leader / stepped down) is a no-op.
   */
  onRequestVoteReply(state: RaftState<C>, reply: RequestVoteReply): RaftStep<C>;

  /**
   * Handle an inbound `AppendEntries` — heartbeat or replication (Figure 2
   * receiver rules). Always emits an `AppendEntries` reply Cmd unless the term
   * is stale-and-dropped without a state change.
   *
   * - Reply-side rule: `req.term < currentTerm` is rejected — a stale leader;
   *   the node holds its role and replies `success: false`.
   * - `req.term >= currentTerm`: a valid leader for this term. Adopt the term if
   *   higher and revert candidate → follower (a candidate that hears from a
   *   leader of term ≥ its own steps down). Then run the **consistency check**:
   *   if the follower's log has no entry at `prevLogIndex` with term
   *   `prevLogTerm`, reply `success: false` (the leader backs off `nextIndex`
   *   and retries). On a match, delete any conflicting suffix and append the new
   *   `entries`, then advance `commitIndex` to
   *   `min(leaderCommit, lastNewEntryIndex)`, and reply `success: true` with the
   *   follower's new last-agreed index as `matchIndex`.
   *
   * Hearing a valid `AppendEntries` resets the election timer (the consumer
   * re-arms off the resulting state).
   */
  onAppendEntries(
    state: RaftState<C>,
    req: AppendEntriesRequest<C>,
  ): RaftStep<C>;

  /**
   * Handle an inbound `AppendEntries` reply (the leader updating its per-peer
   * bookkeeping, Figure 2 leader rules).
   *
   * - Rules for all servers: a higher-term reply steps the leader down to
   *   follower.
   * - A reply received when no longer leader, or a stale-term reply, is a no-op.
   * - On `success`: set `matchIndex[from]` to the reply's `matchIndex` and
   *   `nextIndex[from]` to `matchIndex + 1`, then advance `commitIndex` under the
   *   **Figure-8 safety rule** — to the highest N such that N is on a majority of
   *   `matchIndex`es AND `log[N].term === currentTerm` (a leader NEVER commits a
   *   prior-term entry by counting replicas; it commits it only transitively once
   *   a current-term entry above it commits).
   * - On rejection: decrement `nextIndex[from]` (floored at 1) and re-emit an
   *   `AppendEntries` to that peer from the backed-off index (the retry).
   */
  onAppendEntriesReply(
    state: RaftState<C>,
    reply: AppendEntriesReply,
  ): RaftStep<C>;

  /**
   * A client submitted a command. On the leader: append a new entry
   * `{ term: currentTerm, index: lastLogIndex + 1, command }` to the log and
   * emit an `AppendEntries` round replicating it to every peer. On a non-leader:
   * a no-op (no append, no Cmds) — the consumer redirects the client to the
   * leader. This is the entry point that grows the replicated/event log.
   */
  onClientCommand(state: RaftState<C>, msg: ClientCommand<C>): RaftStep<C>;

  /**
   * The leader's heartbeat timer fired: emit an `AppendEntries` to every peer
   * (entries beyond that peer's `nextIndex`, empty when the peer is caught up).
   * A no-op (no Cmds) on a non-leader — a stale heartbeat fire racing a
   * step-down the reconcile pass has not yet retired.
   */
  onHeartbeat(state: RaftState<C>, at: number): RaftStep<C>;

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
  subs(state: RaftState<C>, now: number): readonly DeadlineSub[];
}

/**
 * The candidate "log at least as up-to-date" check (Figure 2 receiver rule,
 * §5.4.1 election restriction). Compares the candidate's last-log
 * (term, index) against ours: term dominates, index breaks a tie.
 *
 * Up-to-date iff the candidate's last-log term is GREATER than ours, OR the
 * terms are EQUAL and the candidate's last-log index is ≥ ours. (Our own
 * last-log term/index are read from the tail of `log`; an empty log is
 * (term 0, index 0), so any candidate is at least as up-to-date as an empty
 * log.) This is the property that keeps a leader's log a superset of every
 * committed entry — a node missing a committed entry can never gather a
 * majority, so it cannot win.
 */
export function logIsUpToDate(
  log: readonly LogEntry[],
  candidateLastLogIndex: number,
  candidateLastLogTerm: Term,
): boolean {
  const last = log.at(-1);
  const ourLastTerm = last?.term ?? 0;
  const ourLastIndex = last?.index ?? 0;
  if (candidateLastLogTerm !== ourLastTerm) {
    return candidateLastLogTerm > ourLastTerm;
  }
  return candidateLastLogIndex >= ourLastIndex;
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
export function createRaftNode<C = unknown>(
  config: RaftConfig,
  rng: () => number = Math.random,
): RaftNode<C> {
  const { self, peers, electionTimeout, heartbeatMs } = config;
  const quorum = majority(peers.length);

  /** This node's last-log index (1-based; 0 for an empty log). */
  function lastIndex(state: RaftState<C>): number {
    return state.log.at(-1)?.index ?? 0;
  }
  /** Term of this node's last log entry (0 for an empty log). */
  function lastTerm(state: RaftState<C>): number {
    return state.log.at(-1)?.term ?? 0;
  }

  /**
   * Adopt a strictly-higher term: bump `currentTerm`, clear `votedFor`, and
   * step down to follower (Figure 2 "rules for all servers"). Pure; the caller
   * folds the rest of its decision on top of the returned state. Returns the
   * input unchanged when `term` is not higher (so callers can apply it
   * unconditionally before evaluating their own rule).
   */
  function adoptHigherTerm(state: RaftState<C>, term: Term): RaftState<C> {
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
   * self, resets the tally to `{self}`, and emits `RequestVote` to every peer
   * carrying the real last-log index/term (the §5.4.1 election restriction the
   * receiver enforces via {@link logIsUpToDate}). Shared by `onElectionTimeout`
   * for both follower→candidate and candidate→candidate.
   */
  function startElection(state: RaftState<C>): RaftStep<C> {
    const newTerm = state.currentTerm + 1;
    const lastLogIndex = lastIndex(state);
    const lastLogTerm = lastTerm(state);

    const next: RaftState<C> = {
      ...state,
      currentTerm: newTerm,
      votedFor: self,
      role: { _tag: "candidate", votesGranted: [self] },
    };

    const requests: RaftCmd<C>[] = peers.map((peer) => ({
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
   * `AppendEntries` round to every peer. Figure 2 leader-on-election rules.
   * `nextIndex` / `matchIndex` live only on the leader variant — built here,
   * nowhere else.
   */
  function becomeLeader(state: RaftState<C>): RaftStep<C> {
    const nextIdx = lastIndex(state) + 1;
    const nextIndex: Record<NodeId, number> = {};
    const matchIndex: Record<NodeId, number> = {};
    for (const peer of peers) {
      nextIndex[peer] = nextIdx;
      matchIndex[peer] = 0;
    }

    const leader: RaftState<C> = {
      ...state,
      role: { _tag: "leader", nextIndex, matchIndex },
    };

    return [leader, replicateAll(leader)];
  }

  /**
   * Build the `AppendEntries` Cmd for one peer from the leader's `nextIndex`
   * for it: `prevLogIndex` is `nextIndex - 1`, `entries` is everything from
   * `nextIndex` onward (empty when the peer is caught up → a heartbeat). Pure
   * read of the leader's log + per-peer cursor. Caller guarantees `state` is a
   * leader.
   */
  function appendEntriesFor(
    state: RaftState<C>,
    peer: NodeId,
    next: number,
  ): SendAppendEntries<C> {
    const prevLogIndex = next - 1;
    // log is 1-based and contiguous, so index i lives at log[i - 1]; `.at`
    // keeps the access total (0 term at the head / off the end).
    const prevLogTerm =
      prevLogIndex > 0 ? (state.log.at(prevLogIndex - 1)?.term ?? 0) : 0;
    const entries = state.log.slice(prevLogIndex);
    return {
      type: "raft:send_append_entries",
      to: peer,
      term: state.currentTerm,
      leaderId: self,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: state.commitIndex,
    };
  }

  /** The full `AppendEntries` fanout a leader sends (one Cmd per peer). */
  function replicateAll(state: RaftState<C>): RaftCmd<C>[] {
    if (state.role._tag !== "leader") return [];
    const { nextIndex } = state.role;
    // Every peer is a key of nextIndex (built in becomeLeader); `?? 1` keeps
    // the read total for the type-checker and floors a missing cursor at the
    // log head.
    return peers.map((peer) =>
      appendEntriesFor(state, peer, nextIndex[peer] ?? 1),
    );
  }

  /**
   * Advance a leader's `commitIndex` under the Figure-8 safety rule. Returns the
   * highest N > commitIndex such that (a) a MAJORITY of the cluster — counting
   * the leader's own log plus the peers whose `matchIndex >= N` — has the entry,
   * AND (b) `log[N].term === currentTerm`. Clause (b) is the subtle correctness
   * point: a leader must NOT commit an entry from a PRIOR term merely because it
   * sits on a majority of logs (Figure 8 shows such an entry can still be
   * overwritten). A prior-term entry commits only transitively, once a
   * current-term entry above it reaches a majority. Returns the unchanged
   * `commitIndex` when no such N exists.
   */
  function advanceCommitIndex(state: RaftState<C>): number {
    if (state.role._tag !== "leader") return state.commitIndex;
    const { matchIndex } = state.role;
    const lastLogIndex = lastIndex(state);
    let commit = state.commitIndex;
    // Walk candidate indices above the current commit; the highest qualifying N
    // wins (each higher N implies the lower ones, so we keep the max).
    for (let n = state.commitIndex + 1; n <= lastLogIndex; n++) {
      // Figure-8: only an entry from the current term is committable by count.
      if (state.log.at(n - 1)?.term !== state.currentTerm) continue;
      // The leader itself holds entry n (n <= lastLogIndex), so start the count
      // at 1, then add every peer that has replicated up to at least n.
      let replicas = 1;
      for (const peer of peers) {
        if ((matchIndex[peer] ?? 0) >= n) replicas++;
      }
      if (replicas >= quorum) commit = n;
    }
    return commit;
  }

  function init(): RaftState<C> {
    return {
      currentTerm: 0,
      votedFor: null,
      log: [],
      commitIndex: 0,
      role: { _tag: "follower" },
    };
  }

  function onElectionTimeout(state: RaftState<C>, _at: number): RaftStep<C> {
    // A leader has a live mandate; its own election timer is never armed (see
    // `subs`), but a stale fire racing a step-up must be a no-op regardless.
    if (state.role._tag === "leader") return [state, []];
    return startElection(state);
  }

  function onRequestVote(
    state: RaftState<C>,
    req: RequestVoteRequest,
  ): RaftStep<C> {
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
    const granted: RaftState<C> = {
      ...base,
      votedFor: req.candidateId,
      role: { _tag: "follower" },
    };
    return [granted, [voteReply(req.candidateId, base.currentTerm, true)]];
  }

  function onRequestVoteReply(
    state: RaftState<C>,
    reply: RequestVoteReply,
  ): RaftStep<C> {
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
    const tallied: RaftState<C> = {
      ...state,
      role: { _tag: "candidate", votesGranted },
    };

    if (votesGranted.length >= quorum) return becomeLeader(tallied);
    return [tallied, []];
  }

  function onAppendEntries(
    state: RaftState<C>,
    req: AppendEntriesRequest<C>,
  ): RaftStep<C> {
    // Stale leader — reject. Reply with our (higher) term so the sender steps
    // down; no state change.
    if (req.term < state.currentTerm) {
      return [state, [appendReply(req.leaderId, state.currentTerm, false, 0)]];
    }

    // Valid leader for term ≥ ours. Adopt a higher term (clears votedFor, steps
    // down); then ensure we are a follower for this term — a candidate that
    // hears from a leader of term ≥ its own reverts (Figure 2). Hearing a valid
    // AppendEntries resets the election timer (consumer re-arms off this state).
    const adopted = adoptHigherTerm(state, req.term);
    const base: RaftState<C> =
      adopted.role._tag === "follower"
        ? adopted
        : { ...adopted, role: { _tag: "follower" } };

    // Consistency check (Figure 2): the follower must hold an entry at
    // `prevLogIndex` whose term is `prevLogTerm` (prevLogIndex 0 always matches
    // — it anchors at the head). Otherwise reject; the leader backs off.
    const prevOk =
      req.prevLogIndex === 0 ||
      base.log[req.prevLogIndex - 1]?.term === req.prevLogTerm;
    if (!prevOk) {
      return [base, [appendReply(req.leaderId, base.currentTerm, false, 0)]];
    }

    // Match: keep the log up to prevLogIndex, then delete any conflicting suffix
    // and append the new entries. Splicing at prevLogIndex and concatenating is
    // the truncate-and-append in one step (an entry already present and
    // identical is simply overwritten with itself — idempotent on a retry).
    const kept = base.log.slice(0, req.prevLogIndex);
    const nextLog = [...kept, ...req.entries];
    const lastNew = req.prevLogIndex + req.entries.length;

    // Advance commitIndex to min(leaderCommit, index of last new entry). Never
    // run ahead of what this follower actually holds.
    const commitIndex =
      req.leaderCommit > base.commitIndex
        ? Math.min(req.leaderCommit, lastNew)
        : base.commitIndex;

    const next: RaftState<C> = { ...base, log: nextLog, commitIndex };
    return [next, [appendReply(req.leaderId, base.currentTerm, true, lastNew)]];
  }

  function onAppendEntriesReply(
    state: RaftState<C>,
    reply: AppendEntriesReply,
  ): RaftStep<C> {
    // Rules for all servers: a higher-term reply steps us down.
    if (reply.term > state.currentTerm) {
      return [adoptHigherTerm(state, reply.term), []];
    }
    // Only a leader of the matching term acts on replies; anything else is a
    // stale/misrouted reply and a no-op.
    if (state.role._tag !== "leader") return [state, []];
    if (reply.term < state.currentTerm) return [state, []];

    const { nextIndex, matchIndex } = state.role;

    if (!reply.success) {
      // Consistency check failed at the follower: back off nextIndex (floored
      // at 1) and retry from the lower bound. matchIndex is untouched.
      const backed = Math.max(1, (nextIndex[reply.from] ?? 1) - 1);
      const retried: RaftState<C> = {
        ...state,
        role: {
          _tag: "leader",
          nextIndex: { ...nextIndex, [reply.from]: backed },
          matchIndex,
        },
      };
      return [retried, [appendEntriesFor(retried, reply.from, backed)]];
    }

    // Success: this peer now agrees up to reply.matchIndex. Advance its cursors
    // monotonically (a stale/duplicated success must never pull them backward),
    // then re-evaluate the commit index under the Figure-8 rule.
    const newMatch = Math.max(matchIndex[reply.from] ?? 0, reply.matchIndex);
    const advanced: RaftState<C> = {
      ...state,
      role: {
        _tag: "leader",
        nextIndex: { ...nextIndex, [reply.from]: newMatch + 1 },
        matchIndex: { ...matchIndex, [reply.from]: newMatch },
      },
    };
    const commitIndex = advanceCommitIndex(advanced);
    return [{ ...advanced, commitIndex }, []];
  }

  function onClientCommand(
    state: RaftState<C>,
    msg: ClientCommand<C>,
  ): RaftStep<C> {
    // Only the leader accepts client commands; a non-leader rejects (the
    // consumer redirects to the known leader). No append, no Cmds.
    if (state.role._tag !== "leader") return [state, []];

    const entry: LogEntry<C> = {
      term: state.currentTerm,
      index: lastIndex(state) + 1,
      command: msg.command,
    };
    const appended: RaftState<C> = { ...state, log: [...state.log, entry] };
    return [appended, replicateAll(appended)];
  }

  function onHeartbeat(state: RaftState<C>, _at: number): RaftStep<C> {
    // Only a leader heartbeats. A stale fire racing a step-down is a no-op.
    if (state.role._tag !== "leader") return [state, []];
    return [state, replicateAll(state)];
  }

  function subs(state: RaftState<C>, now: number): readonly DeadlineSub[] {
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

  /** Build an `AppendEntries` reply Cmd addressed to the asking leader. */
  function appendReply(
    to: NodeId,
    term: Term,
    success: boolean,
    matchIndex: number,
  ): SendAppendEntriesReply {
    return {
      type: "raft:send_append_entries_reply",
      to,
      term,
      success,
      matchIndex,
    };
  }

  return {
    init,
    onElectionTimeout,
    onRequestVote,
    onRequestVoteReply,
    onAppendEntries,
    onAppendEntriesReply,
    onClientCommand,
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
