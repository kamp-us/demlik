/**
 * Raft leader election (#119) — the election half of Figure 2 as a pure
 * reducer. Unit tests pin the concrete transition rules; the property tests pin
 * the two invariants that must hold across ALL inputs: a higher-term message
 * steps any role down to follower, and a recorded (timer × message) schedule
 * re-decides byte-identically (the epic's replay-testing payoff).
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported
 * explicitly, matching the rest of the package. fast-check's seed + numRuns are
 * pinned globally by `src/test-setup.ts`.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AppendEntriesReply,
  type AppendEntriesRequest,
  createRaftNode,
  electionSubId,
  heartbeatSubId,
  type LogEntry,
  logIsUpToDate,
  type RaftConfig,
  type RaftMsg,
  type RaftNode,
  type RaftState,
  type RequestVoteReply,
  type RequestVoteRequest,
  toRaftMsg,
} from "./index";

// A three-node cluster (self + 2 peers): majority is 2. Election timeout window
// + heartbeat are arbitrary but heartbeat < minMs (a live leader never lets a
// follower time out).
const CONFIG: RaftConfig = {
  self: "n1",
  peers: ["n2", "n3"],
  electionTimeout: { minMs: 150, maxMs: 300 },
  heartbeatMs: 50,
};

// A fixed rng so the jittered election timeout is exactly predictable: 0 picks
// minMs, 1 would pick maxMs+1 clamped — we use 0 unless a test needs spread.
const ZERO_RNG = () => 0;

function node(over?: Partial<RaftConfig>, rng = ZERO_RNG): RaftNode {
  return createRaftNode({ ...CONFIG, ...over }, rng);
}

// Convenience builders for inbound Msgs.
const voteReq = (
  over: Partial<RequestVoteRequest> = {},
): RequestVoteRequest => ({
  _tag: "request_vote_request",
  term: 1,
  candidateId: "n2",
  lastLogIndex: 0,
  lastLogTerm: 0,
  ...over,
});
const voteReply = (over: Partial<RequestVoteReply> = {}): RequestVoteReply => ({
  _tag: "request_vote_reply",
  term: 1,
  from: "n2",
  voteGranted: true,
  ...over,
});
const appendReq = (
  over: Partial<AppendEntriesRequest> = {},
): AppendEntriesRequest => ({
  _tag: "append_entries_request",
  term: 1,
  leaderId: "n2",
  prevLogIndex: 0,
  prevLogTerm: 0,
  entries: [],
  leaderCommit: 0,
  ...over,
});
const appendReply = (
  over: Partial<AppendEntriesReply> = {},
): AppendEntriesReply => ({
  _tag: "append_entries_reply",
  term: 1,
  from: "n2",
  success: true,
  matchIndex: 1,
  ...over,
});

describe("createRaftNode — init", () => {
  it("seeds a fresh follower at term 0 with no vote and an empty log", () => {
    const s = node().init();
    expect(s.currentTerm).toBe(0);
    expect(s.votedFor).toBeNull();
    expect(s.log).toEqual([]);
    expect(s.commitIndex).toBe(0);
    expect(s.role).toEqual({ _tag: "follower" });
  });
});

describe("onElectionTimeout — follower/candidate → candidate", () => {
  it("promotes follower → candidate, bumps term, votes self, emits RequestVote to all peers", () => {
    const r = node();
    const [next, cmds] = r.onElectionTimeout(r.init(), 1_000);

    expect(next.currentTerm).toBe(1);
    expect(next.votedFor).toBe("n1");
    expect(next.role).toEqual({ _tag: "candidate", votesGranted: ["n1"] });

    // One RequestVote per peer, carrying the bumped term + self as candidate.
    expect(cmds).toEqual([
      {
        type: "raft:send_request_vote",
        to: "n2",
        term: 1,
        candidateId: "n1",
        lastLogIndex: 0,
        lastLogTerm: 0,
      },
      {
        type: "raft:send_request_vote",
        to: "n3",
        term: 1,
        candidateId: "n1",
        lastLogIndex: 0,
        lastLogTerm: 0,
      },
    ]);
  });

  it("a candidate whose timeout fires again starts a NEW election (term bumps again)", () => {
    const r = node();
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
    const [next] = r.onElectionTimeout(candidate, 2_000);
    expect(next.currentTerm).toBe(2);
    expect(next.role).toEqual({ _tag: "candidate", votesGranted: ["n1"] });
  });

  it("a leader ignores its own election timeout (stale fire is a no-op)", () => {
    const r = node();
    // Drive to leader first via a majority of votes.
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
    const leader = r.onRequestVoteReply(
      candidate,
      voteReply({ from: "n2" }),
    )[0];
    expect(leader.role._tag).toBe("leader");

    const [same, cmds] = r.onElectionTimeout(leader, 5_000);
    expect(same).toBe(leader);
    expect(cmds).toEqual([]);
  });

  it("a single-node cluster wins immediately on its own vote → leader", () => {
    const r = node({ peers: [] });
    const [next, cmds] = r.onElectionTimeout(r.init(), 1_000);
    expect(next.role._tag).toBe("leader");
    // No peers → empty heartbeat fanout.
    expect(cmds).toEqual([]);
  });
});

describe("onRequestVote — receiver rules (Figure 2)", () => {
  it("rejects a stale-term candidate (term < currentTerm)", () => {
    const r = node();
    const atTerm5: RaftState = { ...r.init(), currentTerm: 5 };
    const [next, cmds] = r.onRequestVote(atTerm5, voteReq({ term: 3 }));

    expect(next.currentTerm).toBe(5);
    expect(cmds).toEqual([
      {
        type: "raft:send_request_vote_reply",
        to: "n2",
        term: 5,
        voteGranted: false,
      },
    ]);
  });

  it("grants a vote at an equal/greater term when unvoted, recording votedFor", () => {
    const r = node();
    const [next, cmds] = r.onRequestVote(r.init(), voteReq({ term: 1 }));

    expect(next.currentTerm).toBe(1); // adopted the higher term
    expect(next.votedFor).toBe("n2");
    expect(next.role).toEqual({ _tag: "follower" });
    expect(cmds).toEqual([
      {
        type: "raft:send_request_vote_reply",
        to: "n2",
        term: 1,
        voteGranted: true,
      },
    ]);
  });

  it("grants only once per term (second distinct candidate is rejected)", () => {
    const r = node();
    const afterFirst = r.onRequestVote(
      r.init(),
      voteReq({ candidateId: "n2" }),
    )[0];
    expect(afterFirst.votedFor).toBe("n2");

    const [next, cmds] = r.onRequestVote(
      afterFirst,
      voteReq({ candidateId: "n3", term: 1 }),
    );
    expect(next.votedFor).toBe("n2"); // unchanged
    expect(cmds).toEqual([
      {
        type: "raft:send_request_vote_reply",
        to: "n3",
        term: 1,
        voteGranted: false,
      },
    ]);
  });

  it("re-grants idempotently to the same candidate it already voted for", () => {
    const r = node();
    const afterFirst = r.onRequestVote(
      r.init(),
      voteReq({ candidateId: "n2" }),
    )[0];
    const [, cmds] = r.onRequestVote(
      afterFirst,
      voteReq({ candidateId: "n2", term: 1 }),
    );
    expect(cmds[0]).toMatchObject({ voteGranted: true });
  });

  it("a higher-term request steps a voted node down and resets votedFor, then grants", () => {
    const r = node();
    // Vote for n2 at term 1, then a term-2 candidate arrives.
    const votedT1 = r.onRequestVote(
      r.init(),
      voteReq({ candidateId: "n2", term: 1 }),
    )[0];
    const [next, cmds] = r.onRequestVote(
      votedT1,
      voteReq({ candidateId: "n3", term: 2 }),
    );

    expect(next.currentTerm).toBe(2);
    expect(next.votedFor).toBe("n3"); // reset to null on step-down, then granted
    expect(next.role).toEqual({ _tag: "follower" });
    expect(cmds[0]).toMatchObject({ term: 2, voteGranted: true });
  });
});

describe("onRequestVoteReply — tally → leader", () => {
  it("a candidate reaching a majority of granted votes becomes leader and heartbeats", () => {
    const r = node();
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0]; // self vote = 1/2-needed

    const [leader, cmds] = r.onRequestVoteReply(
      candidate,
      voteReply({ from: "n2" }),
    );
    expect(leader.role._tag).toBe("leader");
    if (leader.role._tag === "leader") {
      // Leader-only volatile state initialized for each peer.
      expect(leader.role.nextIndex).toEqual({ n2: 1, n3: 1 });
      expect(leader.role.matchIndex).toEqual({ n2: 0, n3: 0 });
    }
    // First AppendEntries round to every peer — an empty-log leader sends an
    // empty heartbeat anchored at the head (prevLogIndex 0).
    expect(cmds).toEqual([
      {
        type: "raft:send_append_entries",
        to: "n2",
        term: 1,
        leaderId: "n1",
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      },
      {
        type: "raft:send_append_entries",
        to: "n3",
        term: 1,
        leaderId: "n1",
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      },
    ]);
  });

  it("does not double-count a duplicate grant from the same peer", () => {
    const r = node({ peers: ["n2", "n3", "n4"] }); // 4 peers, majority = 3
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
    const afterN2 = r.onRequestVoteReply(
      candidate,
      voteReply({ from: "n2" }),
    )[0];
    const afterN2Again = r.onRequestVoteReply(
      afterN2,
      voteReply({ from: "n2" }),
    )[0];

    // Still a candidate: only self + n2 = 2 distinct votes, majority is 3.
    expect(afterN2Again.role).toEqual({
      _tag: "candidate",
      votesGranted: ["n1", "n2"],
    });
  });

  it("ignores a reply once the node is no longer a candidate", () => {
    const r = node();
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
    const leader = r.onRequestVoteReply(
      candidate,
      voteReply({ from: "n2" }),
    )[0];

    const [same, cmds] = r.onRequestVoteReply(
      leader,
      voteReply({ from: "n3" }),
    );
    expect(same).toBe(leader);
    expect(cmds).toEqual([]);
  });

  it("a denied vote does not advance the tally", () => {
    const r = node();
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
    const [next] = r.onRequestVoteReply(
      candidate,
      voteReply({ from: "n2", voteGranted: false }),
    );
    expect(next.role).toEqual({ _tag: "candidate", votesGranted: ["n1"] });
  });

  it("a higher-term reply steps the candidate down to follower", () => {
    const r = node();
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0]; // term 1
    const [next] = r.onRequestVoteReply(candidate, voteReply({ term: 5 }));
    expect(next.currentTerm).toBe(5);
    expect(next.votedFor).toBeNull();
    expect(next.role).toEqual({ _tag: "follower" });
  });
});

describe("onAppendEntries — heartbeat handling", () => {
  it("a candidate reverts to follower on AppendEntries from a leader of term ≥ its own", () => {
    const r = node();
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0]; // term 1
    const [next, cmds] = r.onAppendEntries(candidate, appendReq({ term: 1 }));
    expect(next.role).toEqual({ _tag: "follower" });
    // #120: a valid AppendEntries now always replies (success on the empty,
    // head-anchored heartbeat).
    expect(cmds).toEqual([
      {
        type: "raft:send_append_entries_reply",
        to: "n2",
        term: 1,
        success: true,
        matchIndex: 0,
      },
    ]);
  });

  it("a higher-term heartbeat steps a leader down and adopts the term", () => {
    const r = node();
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
    const leader = r.onRequestVoteReply(
      candidate,
      voteReply({ from: "n2" }),
    )[0];

    const [next] = r.onAppendEntries(
      leader,
      appendReq({ term: 9, leaderId: "n2" }),
    );
    expect(next.currentTerm).toBe(9);
    expect(next.role).toEqual({ _tag: "follower" });
  });

  it("rejects a stale-term heartbeat by holding role and replying false", () => {
    const r = node();
    const atTerm5: RaftState = { ...r.init(), currentTerm: 5 };
    const [next, cmds] = r.onAppendEntries(atTerm5, appendReq({ term: 2 }));
    expect(next).toBe(atTerm5);
    // #120: a stale-term AppendEntries replies false carrying our higher term.
    expect(cmds).toEqual([
      {
        type: "raft:send_append_entries_reply",
        to: "n2",
        term: 5,
        success: false,
        matchIndex: 0,
      },
    ]);
  });
});

describe("onHeartbeat — leader fanout", () => {
  it("a leader emits empty AppendEntries to every peer on its heartbeat timer", () => {
    const r = node();
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
    const leader = r.onRequestVoteReply(
      candidate,
      voteReply({ from: "n2" }),
    )[0];

    const [same, cmds] = r.onHeartbeat(leader, 2_000);
    expect(same).toBe(leader);
    expect(cmds).toEqual([
      {
        type: "raft:send_append_entries",
        to: "n2",
        term: 1,
        leaderId: "n1",
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      },
      {
        type: "raft:send_append_entries",
        to: "n3",
        term: 1,
        leaderId: "n1",
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [],
        leaderCommit: 0,
      },
    ]);
  });

  it("a non-leader heartbeat fire is a no-op", () => {
    const r = node();
    const [same, cmds] = r.onHeartbeat(r.init(), 2_000);
    expect(same.role._tag).toBe("follower");
    expect(cmds).toEqual([]);
  });
});

describe("subs — election / heartbeat DeadlineSubs", () => {
  it("a follower arms only the election timeout, jittered from the injected rng", () => {
    const r = node({}, () => 0); // minMs
    const subs = r.subs(r.init(), 1_000);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.id).toBe(electionSubId("n1"));
    expect(subs[0]?.atMs).toBe(1_000 + 150); // now + minMs at rng 0
  });

  it("the rng spreads the election timeout across [minMs, maxMs]", () => {
    const r = node({}, () => 0.999_999); // ~maxMs
    const subs = r.subs(r.init(), 0);
    expect(subs[0]?.atMs).toBe(300); // ~maxMs
  });

  it("a candidate arms the election timeout (it can re-elect on a split vote)", () => {
    const r = node();
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
    const subs = r.subs(candidate, 2_000);
    expect(subs[0]?.id).toBe(electionSubId("n1"));
  });

  it("a leader arms only the heartbeat", () => {
    const r = node();
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
    const leader = r.onRequestVoteReply(
      candidate,
      voteReply({ from: "n2" }),
    )[0];
    const subs = r.subs(leader, 3_000);
    expect(subs).toHaveLength(1);
    expect(subs[0]?.id).toBe(heartbeatSubId("n1"));
    expect(subs[0]?.atMs).toBe(3_000 + 50); // now + heartbeatMs
  });
});

describe("toRaftMsg — fired-deadline → Raft Msg mapping", () => {
  it("maps the election sub id to election_timeout_fired carrying atMs as at", () => {
    const m = toRaftMsg("n1", { id: electionSubId("n1"), atMs: 1_234 });
    expect(m).toEqual({ _tag: "election_timeout_fired", at: 1_234 });
  });
  it("maps the heartbeat sub id to heartbeat_fired", () => {
    const m = toRaftMsg("n1", { id: heartbeatSubId("n1"), atMs: 5_678 });
    expect(m).toEqual({ _tag: "heartbeat_fired", at: 5_678 });
  });
  it("returns null for a foreign sub id", () => {
    expect(toRaftMsg("n1", { id: "some:other:sub", atMs: 1 })).toBeNull();
  });
});

// ===========================================================================
// Property-based invariants
// ===========================================================================

// A small driver folding one Msg into a node — the shape `update` would route.
function step(r: RaftNode, state: RaftState, msg: RaftMsg): RaftState {
  switch (msg._tag) {
    case "election_timeout_fired":
      return r.onElectionTimeout(state, msg.at)[0];
    case "heartbeat_fired":
      return r.onHeartbeat(state, msg.at)[0];
    case "request_vote_request":
      return r.onRequestVote(state, msg)[0];
    case "request_vote_reply":
      return r.onRequestVoteReply(state, msg)[0];
    case "append_entries_request":
      return r.onAppendEntries(state, msg)[0];
    case "append_entries_reply":
      return r.onAppendEntriesReply(state, msg)[0];
    case "client_command":
      return r.onClientCommand(state, msg)[0];
  }
}

// Arbitrary inbound Msgs over the n1 cluster. Terms drawn 0..6 so both stale
// and higher-term paths are exercised; senders drawn from the peer set.
const peerArb = fc.constantFrom("n2", "n3");
const termArb = fc.integer({ min: 0, max: 6 });
// A short run of log entries; index is stamped contiguously from prevLogIndex
// so the follower's consistency check sees a well-formed batch.
const entriesArb = (prevLogIndex: number) =>
  fc
    .array(fc.record({ term: termArb, command: fc.integer() }), {
      maxLength: 3,
    })
    .map((es) =>
      es.map((e, i) => ({
        term: e.term,
        index: prevLogIndex + i + 1,
        command: e.command,
      })),
    );
const msgArb: fc.Arbitrary<RaftMsg> = fc.oneof(
  fc.record({
    _tag: fc.constant("election_timeout_fired" as const),
    at: fc.integer({ min: 0, max: 1_000_000 }),
  }),
  fc.record({
    _tag: fc.constant("heartbeat_fired" as const),
    at: fc.integer({ min: 0, max: 1_000_000 }),
  }),
  fc.record({
    _tag: fc.constant("request_vote_request" as const),
    term: termArb,
    candidateId: peerArb,
    lastLogIndex: fc.integer({ min: 0, max: 5 }),
    lastLogTerm: termArb,
  }),
  fc.record({
    _tag: fc.constant("request_vote_reply" as const),
    term: termArb,
    from: peerArb,
    voteGranted: fc.boolean(),
  }),
  fc
    .record({
      term: termArb,
      leaderId: peerArb,
      prevLogIndex: fc.integer({ min: 0, max: 4 }),
      prevLogTerm: termArb,
      leaderCommit: fc.integer({ min: 0, max: 5 }),
    })
    .chain((base) =>
      entriesArb(base.prevLogIndex).map((entries) => ({
        _tag: "append_entries_request" as const,
        ...base,
        entries,
      })),
    ),
  fc.record({
    _tag: fc.constant("append_entries_reply" as const),
    term: termArb,
    from: peerArb,
    success: fc.boolean(),
    matchIndex: fc.integer({ min: 0, max: 5 }),
  }),
  fc.record({
    _tag: fc.constant("client_command" as const),
    command: fc.integer(),
  }),
);

describe("invariants (PBT)", () => {
  it("any single message whose term exceeds currentTerm steps the node to follower", () => {
    fc.assert(
      fc.property(
        fc.array(msgArb, { minLength: 0, maxLength: 30 }),
        msgArb,
        (prefix, last) => {
          const r = node();
          // Fold an arbitrary prefix to reach some role at some term.
          let s = r.init();
          for (const m of prefix) s = step(r, s, m);

          const before = s.currentTerm;
          const after = step(r, s, last);

          // A message carrying a strictly higher term must leave the node a
          // follower with the adopted term and a cleared/overwritten vote.
          const carried = "term" in last ? last.term : -1;
          if (carried > before) {
            expect(after.currentTerm).toBe(carried);
            // A higher-term RequestVote may grant (votedFor=candidate); every
            // other higher-term message clears it. Either way the role is
            // follower or (for a granted vote) follower.
            expect(after.role._tag).toBe("follower");
          }
        },
      ),
    );
  });

  it("currentTerm is monotonically non-decreasing across any message sequence", () => {
    fc.assert(
      fc.property(fc.array(msgArb, { maxLength: 40 }), (msgs) => {
        const r = node();
        let s = r.init();
        for (const m of msgs) {
          const before = s.currentTerm;
          s = step(r, s, m);
          expect(s.currentTerm).toBeGreaterThanOrEqual(before);
        }
      }),
    );
  });

  it("leader-only volatile state exists iff the role is leader", () => {
    fc.assert(
      fc.property(fc.array(msgArb, { maxLength: 40 }), (msgs) => {
        const r = node();
        let s = r.init();
        for (const m of msgs) {
          s = step(r, s, m);
          if (s.role._tag === "leader") {
            expect(Object.keys(s.role.nextIndex).sort()).toEqual(["n2", "n3"]);
            expect(Object.keys(s.role.matchIndex).sort()).toEqual(["n2", "n3"]);
          } else {
            // Structurally there is no nextIndex/matchIndex to read.
            expect("nextIndex" in s.role).toBe(false);
          }
        }
      }),
    );
  });

  it("determinism: the same (timer × message) schedule yields byte-identical state", () => {
    fc.assert(
      fc.property(fc.array(msgArb, { maxLength: 40 }), (msgs) => {
        // Two independently-built nodes with the SAME fixed rng + same schedule
        // must reach the identical final state — the replay guarantee.
        const a = node({}, () => 0.42);
        const b = node({}, () => 0.42);
        let sa = a.init();
        let sb = b.init();
        for (const m of msgs) {
          sa = step(a, sa, m);
          sb = step(b, sb, m);
        }
        expect(sa).toEqual(sb);

        // And the subs (which read the rng) re-derive the identical deadline.
        expect(a.subs(sa, 1_000)).toEqual(b.subs(sb, 1_000));
      }),
    );
  });
});

// ===========================================================================
// #120 — log replication (Figure 2 + the Figure-8 commit rule)
// ===========================================================================

// A typed log entry builder over numeric commands (the generic C = number here).
const entry = (
  term: number,
  index: number,
  command = index,
): LogEntry<number> => ({
  term,
  index,
  command,
});

// A node generic over number commands; ZERO_RNG keeps election timeouts pinned.
function numNode(over?: Partial<RaftConfig>): RaftNode<number> {
  return createRaftNode<number>({ ...CONFIG, ...over }, ZERO_RNG);
}

// Drive a fresh node to leader of term 1 (self + n2 vote = majority of 3),
// optionally seeding a pre-existing log + commitIndex on the way.
function leaderState(
  r: RaftNode<number>,
  seed?: { log?: LogEntry<number>[]; commitIndex?: number },
): RaftState<number> {
  const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
  const seeded: RaftState<number> = seed
    ? {
        ...candidate,
        log: seed.log ?? candidate.log,
        commitIndex: seed.commitIndex ?? candidate.commitIndex,
      }
    : candidate;
  const leader = r.onRequestVoteReply(seeded, voteReply({ from: "n2" }))[0];
  if (leader.role._tag !== "leader") throw new Error("expected leader");
  return leader;
}

describe("logIsUpToDate — §5.4.1 election restriction (all three branches)", () => {
  it("an empty log: any candidate (incl. another empty log) is up-to-date", () => {
    expect(logIsUpToDate([], 0, 0)).toBe(true);
    expect(logIsUpToDate([], 3, 2)).toBe(true);
  });

  it("higher candidate last-log term wins regardless of index", () => {
    const log = [entry(2, 1), entry(2, 2)]; // ours: term 2, index 2
    expect(logIsUpToDate(log, 0, 3)).toBe(true); // term 3 > 2, even at index 0
  });

  it("lower candidate last-log term loses regardless of index", () => {
    const log = [entry(2, 1)]; // ours: term 2, index 1
    expect(logIsUpToDate(log, 9, 1)).toBe(false); // term 1 < 2, even at index 9
  });

  it("equal last-log term: the candidate's index must be ≥ ours", () => {
    const log = [entry(2, 1), entry(2, 2), entry(2, 3)]; // term 2, index 3
    expect(logIsUpToDate(log, 3, 2)).toBe(true); // equal index
    expect(logIsUpToDate(log, 4, 2)).toBe(true); // longer
    expect(logIsUpToDate(log, 2, 2)).toBe(false); // shorter
  });

  it("is wired into onRequestVote: a stale-log candidate is denied", () => {
    const r = numNode();
    // We hold a term-2 entry; a candidate with an empty log (term 0) asks.
    const ours: RaftState<number> = {
      ...r.init(),
      currentTerm: 2,
      log: [entry(2, 1)],
    };
    const [, cmds] = r.onRequestVote(
      ours,
      voteReq({ term: 2, candidateId: "n2", lastLogIndex: 0, lastLogTerm: 0 }),
    );
    expect(cmds[0]).toMatchObject({ voteGranted: false });
  });

  it("is wired into onRequestVote: an up-to-date candidate is granted", () => {
    const r = numNode();
    const ours: RaftState<number> = {
      ...r.init(),
      currentTerm: 2,
      log: [entry(2, 1)],
    };
    const [, cmds] = r.onRequestVote(
      ours,
      voteReq({ term: 2, candidateId: "n2", lastLogIndex: 1, lastLogTerm: 2 }),
    );
    expect(cmds[0]).toMatchObject({ voteGranted: true });
  });
});

describe("onAppendEntries — Figure-2 consistency check + truncate/append", () => {
  it("accepts at the head (prevLogIndex 0) and appends, replying with the new matchIndex", () => {
    const r = numNode();
    const [next, cmds] = r.onAppendEntries(
      r.init(),
      appendReq({
        term: 1,
        leaderId: "n2",
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [entry(1, 1), entry(1, 2)],
        leaderCommit: 0,
      }),
    );
    expect(next.log).toEqual([entry(1, 1), entry(1, 2)]);
    expect(cmds).toEqual([
      {
        type: "raft:send_append_entries_reply",
        to: "n2",
        term: 1,
        success: true,
        matchIndex: 2,
      },
    ]);
  });

  it("rejects on a prevLogIndex the follower does not hold (gap)", () => {
    const r = numNode();
    const start: RaftState<number> = { ...r.init(), log: [entry(1, 1)] };
    const [next, cmds] = r.onAppendEntries(
      start,
      appendReq({
        term: 1,
        prevLogIndex: 5, // far beyond our single entry
        prevLogTerm: 1,
        entries: [entry(1, 6)],
      }),
    );
    expect(next.log).toEqual([entry(1, 1)]); // unchanged
    expect(cmds[0]).toMatchObject({ success: false, matchIndex: 0 });
  });

  it("rejects on a prevLogTerm mismatch at a held index", () => {
    const r = numNode();
    const start: RaftState<number> = {
      ...r.init(),
      currentTerm: 3,
      log: [entry(1, 1), entry(2, 2)], // index 2 has term 2
    };
    const [next, cmds] = r.onAppendEntries(
      start,
      appendReq({
        term: 3,
        prevLogIndex: 2,
        prevLogTerm: 9, // does not match our term-2 entry
        entries: [entry(3, 3)],
      }),
    );
    expect(next.log).toEqual([entry(1, 1), entry(2, 2)]); // unchanged
    expect(cmds[0]).toMatchObject({ success: false });
  });

  it("truncates a conflicting suffix and appends the leader's entries", () => {
    const r = numNode();
    // Follower has a stale term-1 suffix at indices 2,3; the leader overwrites
    // from index 2 with term-2 entries.
    const start: RaftState<number> = {
      ...r.init(),
      currentTerm: 2,
      log: [entry(1, 1), entry(1, 2), entry(1, 3)],
    };
    const [next, cmds] = r.onAppendEntries(
      start,
      appendReq({
        term: 2,
        prevLogIndex: 1,
        prevLogTerm: 1,
        entries: [entry(2, 2), entry(2, 3)],
      }),
    );
    expect(next.log).toEqual([entry(1, 1), entry(2, 2), entry(2, 3)]);
    expect(cmds[0]).toMatchObject({ success: true, matchIndex: 3 });
  });

  it("a duplicated AppendEntries is idempotent (no growth, same matchIndex)", () => {
    const r = numNode();
    const req = appendReq({
      term: 1,
      prevLogIndex: 0,
      prevLogTerm: 0,
      entries: [entry(1, 1), entry(1, 2)],
    });
    const once = r.onAppendEntries(r.init(), req)[0];
    const [twice, cmds] = r.onAppendEntries(once, req);
    expect(twice.log).toEqual([entry(1, 1), entry(1, 2)]);
    expect(cmds[0]).toMatchObject({ success: true, matchIndex: 2 });
  });
});

describe("onAppendEntries — follower commitIndex advance", () => {
  it("advances commitIndex to min(leaderCommit, lastNewEntryIndex)", () => {
    const r = numNode();
    // Leader has committed up to 5, but this batch only carries up to index 2.
    const [next] = r.onAppendEntries(
      r.init(),
      appendReq({
        term: 1,
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [entry(1, 1), entry(1, 2)],
        leaderCommit: 5,
      }),
    );
    expect(next.commitIndex).toBe(2); // min(5, 2)
  });

  it("clamps to leaderCommit when the follower's log runs ahead of it", () => {
    const r = numNode();
    const start: RaftState<number> = {
      ...r.init(),
      log: [entry(1, 1), entry(1, 2), entry(1, 3)],
    };
    const [next] = r.onAppendEntries(
      start,
      appendReq({
        term: 1,
        prevLogIndex: 3,
        prevLogTerm: 1,
        entries: [],
        leaderCommit: 2,
      }),
    );
    expect(next.commitIndex).toBe(2); // min(2, lastNew=3)
  });

  it("never lowers an already-higher commitIndex", () => {
    const r = numNode();
    const start: RaftState<number> = {
      ...r.init(),
      log: [entry(1, 1), entry(1, 2)],
      commitIndex: 2,
    };
    const [next] = r.onAppendEntries(
      start,
      appendReq({
        term: 1,
        prevLogIndex: 2,
        prevLogTerm: 1,
        entries: [],
        leaderCommit: 1, // lower than what we already committed
      }),
    );
    expect(next.commitIndex).toBe(2);
  });
});

describe("onClientCommand — leader appends + replicates", () => {
  it("a leader appends the command and replicates it to every peer", () => {
    const r = numNode();
    const leader = leaderState(r);
    const [next, cmds] = r.onClientCommand(leader, {
      _tag: "client_command",
      command: 42,
    });
    expect(next.log).toEqual([entry(1, 1, 42)]);
    // One AppendEntries per peer carrying the new entry from prevLogIndex 0.
    expect(cmds).toEqual([
      {
        type: "raft:send_append_entries",
        to: "n2",
        term: 1,
        leaderId: "n1",
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [entry(1, 1, 42)],
        leaderCommit: 0,
      },
      {
        type: "raft:send_append_entries",
        to: "n3",
        term: 1,
        leaderId: "n1",
        prevLogIndex: 0,
        prevLogTerm: 0,
        entries: [entry(1, 1, 42)],
        leaderCommit: 0,
      },
    ]);
  });

  it("a non-leader rejects the command (no append, no Cmds)", () => {
    const r = numNode();
    const [same, cmds] = r.onClientCommand(r.init(), {
      _tag: "client_command",
      command: 7,
    });
    expect(same.log).toEqual([]);
    expect(cmds).toEqual([]);
  });
});

describe("onAppendEntriesReply — nextIndex backoff + Figure-8 commit", () => {
  it("backs off nextIndex on rejection and re-sends from the lower index", () => {
    const r = numNode();
    // Leader with a 3-entry term-1 log; peers' nextIndex starts at 4.
    const log = [entry(1, 1), entry(1, 2), entry(1, 3)];
    const leader = leaderState(r, { log });
    if (leader.role._tag !== "leader") throw new Error("leader");
    expect(leader.role.nextIndex.n2).toBe(4);

    const [next, cmds] = r.onAppendEntriesReply(
      leader,
      appendReply({ from: "n2", success: false, matchIndex: 0 }),
    );
    if (next.role._tag !== "leader") throw new Error("leader");
    expect(next.role.nextIndex.n2).toBe(3); // 4 - 1
    // Retry from the backed-off index: prevLogIndex 2, entries [index 3].
    expect(cmds).toEqual([
      {
        type: "raft:send_append_entries",
        to: "n2",
        term: 1,
        leaderId: "n1",
        prevLogIndex: 2,
        prevLogTerm: 1,
        entries: [entry(1, 3)],
        leaderCommit: 0,
      },
    ]);
  });

  it("nextIndex backoff floors at 1 (never below the log head)", () => {
    const r = numNode();
    const leader = leaderState(r, { log: [entry(1, 1)] });
    if (leader.role._tag !== "leader") throw new Error("leader");
    // Force nextIndex to 1 then reject again — must not go to 0.
    const atOne: RaftState<number> = {
      ...leader,
      role: {
        _tag: "leader",
        nextIndex: { n2: 1, n3: 2 },
        matchIndex: { n2: 0, n3: 0 },
      },
    };
    const [next] = r.onAppendEntriesReply(
      atOne,
      appendReply({ from: "n2", success: false }),
    );
    if (next.role._tag !== "leader") throw new Error("leader");
    expect(next.role.nextIndex.n2).toBe(1);
  });

  it("on success advances matchIndex/nextIndex and commits a current-term entry on a majority", () => {
    const r = numNode();
    // Leader term 1, one entry of the current term at index 1.
    const leader = leaderState(r, { log: [entry(1, 1)] });
    // One peer (n2) confirms index 1 → self + n2 = 2 of 3 = majority.
    const [next] = r.onAppendEntriesReply(
      leader,
      appendReply({ from: "n2", success: true, matchIndex: 1 }),
    );
    if (next.role._tag !== "leader") throw new Error("leader");
    expect(next.role.matchIndex.n2).toBe(1);
    expect(next.role.nextIndex.n2).toBe(2);
    expect(next.commitIndex).toBe(1); // current-term entry on a majority → committed
  });

  it("a stale/duplicated success never pulls matchIndex backward", () => {
    const r = numNode();
    const leader = leaderState(r, { log: [entry(1, 1), entry(1, 2)] });
    const after2 = r.onAppendEntriesReply(
      leader,
      appendReply({ from: "n2", success: true, matchIndex: 2 }),
    )[0];
    if (after2.role._tag !== "leader") throw new Error("leader");
    expect(after2.role.matchIndex.n2).toBe(2);
    // A late, lower success must not regress matchIndex.
    const [after1] = r.onAppendEntriesReply(
      after2,
      appendReply({ from: "n2", success: true, matchIndex: 1 }),
    );
    if (after1.role._tag !== "leader") throw new Error("leader");
    expect(after1.role.matchIndex.n2).toBe(2);
  });
});

describe("Figure-8 safety rule — a prior-term entry is NOT committed by replica count alone", () => {
  it("withholds commit of a prior-term entry replicated on a majority, until a current-term entry covers it", () => {
    const r = numNode();
    // Leader is now in term 2, but index 1 is a PRIOR-term (term 1) entry.
    // Indices: 1 → term 1 (prior), 2 → term 2 (current).
    const log = [entry(1, 1), entry(2, 2)];
    const base = leaderState(r, { log });
    // Hand-set the leader to term 2 (it won a later election) with the same log.
    const leaderT2: RaftState<number> = { ...base, currentTerm: 2 };

    // n2 replicates ONLY up to index 1 (the prior-term entry) → self + n2 hold
    // index 1 = a majority. The Figure-8 rule must REFUSE to commit it.
    const [afterPrior] = r.onAppendEntriesReply(
      leaderT2,
      appendReply({ from: "n2", term: 2, success: true, matchIndex: 1 }),
    );
    expect(afterPrior.commitIndex).toBe(0); // NOT committed — prior term

    // Now n2 replicates up to index 2 (the current-term entry). Index 2 on a
    // majority commits — and index 1 commits transitively under it.
    const [afterCurrent] = r.onAppendEntriesReply(
      afterPrior,
      appendReply({ from: "n2", term: 2, success: true, matchIndex: 2 }),
    );
    expect(afterCurrent.commitIndex).toBe(2);
  });

  it("does not commit anything when only a minority has the current-term entry", () => {
    const r = numNode({ peers: ["n2", "n3", "n4"] }); // 4 peers + self = 5, majority 3
    // Drive to leader via a majority (self + n2 + n3), then seed a 1-entry log.
    const candidate = r.onElectionTimeout(r.init(), 1_000)[0];
    const afterN2 = r.onRequestVoteReply(
      candidate,
      voteReply({ from: "n2" }),
    )[0];
    const won = r.onRequestVoteReply(afterN2, voteReply({ from: "n3" }))[0];
    if (won.role._tag !== "leader") throw new Error("expected leader");
    const leader: RaftState<number> = { ...won, log: [entry(1, 1)] };
    // Only n2 confirms index 1 → self + n2 = 2 < majority 3.
    const [next] = r.onAppendEntriesReply(
      leader,
      appendReply({ from: "n2", success: true, matchIndex: 1 }),
    );
    expect(next.commitIndex).toBe(0);
  });
});

describe("replication — replay determinism (#120 verbs)", () => {
  it("the same replication schedule yields byte-identical state across two nodes", () => {
    const replArb = fc.array(msgArb, { maxLength: 40 });
    fc.assert(
      fc.property(replArb, (msgs) => {
        const a = createRaftNode<number>(CONFIG, () => 0.42);
        const b = createRaftNode<number>(CONFIG, () => 0.42);
        let sa = a.init();
        let sb = b.init();
        for (const m of msgs) {
          sa = step(a as RaftNode, sa, m);
          sb = step(b as RaftNode, sb, m);
        }
        expect(sa).toEqual(sb);
      }),
    );
  });

  it("commitIndex never exceeds the log length over any schedule (no phantom commit)", () => {
    fc.assert(
      fc.property(fc.array(msgArb, { maxLength: 40 }), (msgs) => {
        const r = numNode();
        let s = r.init() as RaftState;
        for (const m of msgs) {
          s = step(r as RaftNode, s, m);
          expect(s.commitIndex).toBeLessThanOrEqual(s.log.length);
          expect(s.commitIndex).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });
});
