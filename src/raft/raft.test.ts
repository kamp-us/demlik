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
  type AppendEntriesRequest,
  createRaftNode,
  electionSubId,
  heartbeatSubId,
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
    // First heartbeat round to every peer.
    expect(cmds).toEqual([
      { type: "raft:send_append_entries", to: "n2", term: 1, leaderId: "n1" },
      { type: "raft:send_append_entries", to: "n3", term: 1, leaderId: "n1" },
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
    expect(cmds).toEqual([]);
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

  it("rejects a stale-term heartbeat by holding role", () => {
    const r = node();
    const atTerm5: RaftState = { ...r.init(), currentTerm: 5 };
    const [next, cmds] = r.onAppendEntries(atTerm5, appendReq({ term: 2 }));
    expect(next).toBe(atTerm5);
    expect(cmds).toEqual([]);
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
      { type: "raft:send_append_entries", to: "n2", term: 1, leaderId: "n1" },
      { type: "raft:send_append_entries", to: "n3", term: 1, leaderId: "n1" },
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
  }
}

// Arbitrary inbound Msgs over the n1 cluster. Terms drawn 0..6 so both stale
// and higher-term paths are exercised; senders drawn from the peer set.
const peerArb = fc.constantFrom("n2", "n3");
const termArb = fc.integer({ min: 0, max: 6 });
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
  fc.record({
    _tag: fc.constant("append_entries_request" as const),
    term: termArb,
    leaderId: peerArb,
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
