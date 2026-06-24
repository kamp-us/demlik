/**
 * `@demlik/tea/raft/do` — the Raft node as a durable DO grain (#122).
 *
 * Three acceptance criteria, one suite (vitest globals are NOT enabled — import
 * describe/it/expect; fast-check seed + numRuns pinned by `src/test-setup.ts`):
 *
 *   1. **Persist-before-respond** — the persistent state (currentTerm, votedFor,
 *      log) is durably written BEFORE the node responds to a
 *      RequestVote/AppendEntries. Asserted by gating the transport: at the
 *      instant a reply Cmd is sent, the durable log already holds the inbound
 *      event (Figure-2 "persistent state on stable storage before responding").
 *   2. **Cold-wake byte-identity** — a grain rebuilt from its persisted log on
 *      cold wake equals the never-evicted grain after the same Msg sequence
 *      (the #91/#85 replay property, now over the Raft reducer + its volatile
 *      state rebuilt by the fold). Pinned as a property over random schedules.
 *   3. **Eviction-safe election timer** — the deadline is re-armed via the DO
 *      `setAlarm` (a host alarm), not an isolate-resident timer, and the
 *      re-woken grain re-arms on activation.
 *
 * Fakes mirror `do/event-sourced-store.test.ts`: an in-memory
 * `DurableObjectStorage` whose backing `Map` survives "eviction" (a fresh grain
 * over the SAME bytes), plus a recording alarm + transport. No live Workers
 * runtime.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type RaftAlarm,
  type RaftGrainCtx,
  type RaftTransport,
  raftGrain,
} from "./do";
import type { RaftCmd, RaftConfig, RaftMsg, RequestVoteRequest } from "./index";

// A three-node cluster (self + 2 peers): majority is 2. heartbeat < minMs so a
// live leader never lets a follower time out.
const CONFIG: RaftConfig = {
  self: "n1",
  peers: ["n2", "n3"],
  electionTimeout: { minMs: 150, maxMs: 300 },
  heartbeatMs: 50,
};

// Fixed rng → the jittered election timeout is exactly minMs, so an armed
// election alarm target is deterministic (`now + 150`).
const ZERO_RNG = () => 0;

// ── In-memory `DurableObjectStorage` fake (get/put/list). The backing Map is
// returned so a test can build a SECOND grain over the SAME bytes — the
// eviction/rehydrate simulation (the isolate dies, the storage survives). ────
function fakeStorage(backing: Map<string, string> = new Map()) {
  const storage = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return backing.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      backing.set(key, value as unknown as string);
    },
    async list<T = unknown>(options?: {
      prefix?: string;
    }): Promise<Map<string, T>> {
      const prefix = options?.prefix ?? "";
      const out = new Map<string, T>();
      // Real DO list() returns keys in lexicographic order.
      for (const key of [...backing.keys()].sort()) {
        if (key.startsWith(prefix)) out.set(key, backing.get(key) as T);
      }
      return out;
    },
  };
  return { backing, storage: storage as unknown as DurableObjectStorage };
}

/** A recording alarm: every `setAlarm` target is captured (host timer, no DO). */
function recordingAlarm(): RaftAlarm & { readonly armed: number[] } {
  const armed: number[] = [];
  return {
    armed,
    setAlarm(at) {
      armed.push(at);
    },
  };
}

/** A recording transport: collects every outbound `RaftCmd` the grain flushes. */
function recordingTransport<C>(
  onSend?: (cmd: RaftCmd<C>) => void,
): RaftTransport<C> & { readonly sent: RaftCmd<C>[] } {
  const sent: RaftCmd<C>[] = [];
  return {
    sent,
    send(cmd) {
      onSend?.(cmd);
      sent.push(cmd);
    },
  };
}

/** Assemble a grain ctx over a backing Map, with a fixed clock at `now`. */
function grainCtx<C>(
  backing: Map<string, string>,
  opts: {
    now?: number;
    alarm?: RaftAlarm & { armed: number[] };
    transport?: RaftTransport<C>;
  } = {},
): RaftGrainCtx<C> & { alarm: RaftAlarm & { armed: number[] } } {
  const { storage } = fakeStorage(backing);
  const alarm = opts.alarm ?? recordingAlarm();
  return {
    storage,
    alarm,
    transport: opts.transport ?? recordingTransport<C>(),
    now: () => opts.now ?? 1000,
  };
}

// Inbound Msg builders.
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

// ===========================================================================
// Acceptance criterion 1 — persist-before-respond
// ===========================================================================

describe("persist-before-respond (Figure-2 stable-storage rule)", () => {
  it("durably writes the inbound event BEFORE the reply Cmd is sent", async () => {
    const backing = new Map<string, string>();

    // The transport's send is the "respond" edge. At the instant the reply
    // leaves, the durable log MUST already hold a logged event (the inbound
    // RequestVote) — i.e. persist precedes respond.
    let logKeysAtSend: string[] | null = null;
    const transport = recordingTransport<number>((_cmd) => {
      logKeysAtSend = [...backing.keys()].filter((k) =>
        k.startsWith("@@es/evt/"),
      );
    });

    const ctx = grainCtx<number>(backing, { transport });
    const grain = await raftGrain<number>(ctx, {
      config: CONFIG,
      rng: ZERO_RNG,
    });

    const sent = await grain.deliver(voteReq({ term: 5 }));

    // A reply WAS produced (granting or rejecting the vote) ...
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]?.type).toBe("raft:send_request_vote_reply");
    // ... and at the moment it was sent, the event was already durably logged.
    expect(logKeysAtSend).not.toBeNull();
    expect((logKeysAtSend as unknown as string[]).length).toBeGreaterThan(0);

    // The persistent state reached storage: a fresh grain over the same bytes
    // recovers the adopted term (5) and the recorded vote.
    const recovered = await raftGrain<number>(grainCtx<number>(backing), {
      config: CONFIG,
      rng: ZERO_RNG,
    });
    expect(recovered.state().currentTerm).toBe(5);
    await grain.close();
    await recovered.close();
  });
});

// ===========================================================================
// Acceptance criterion 2 — cold-wake byte-identity (replay)
// ===========================================================================

describe("cold-wake replay byte-identity", () => {
  // A schedule of inbound Msgs over the n1 cluster. Terms span stale + higher
  // paths; senders drawn from the peer set; client commands grow the log.
  const peerArb = fc.constantFrom("n2", "n3");
  const termArb = fc.integer({ min: 0, max: 6 });
  const msgArb: fc.Arbitrary<RaftMsg<number>> = fc.oneof(
    fc.record({
      _tag: fc.constant("election_timeout_fired" as const),
      at: fc.integer({ min: 0, max: 1_000_000 }),
    }),
    fc.record({
      _tag: fc.constant("request_vote_request" as const),
      term: termArb,
      candidateId: peerArb,
      lastLogIndex: fc.integer({ min: 0, max: 4 }),
      lastLogTerm: termArb,
    }),
    fc.record({
      _tag: fc.constant("request_vote_reply" as const),
      term: termArb,
      from: peerArb,
      voteGranted: fc.boolean(),
    }),
    fc.record({
      _tag: fc.constant("client_command" as const),
      command: fc.integer(),
    }),
    fc.record({
      _tag: fc.constant("heartbeat_fired" as const),
      at: fc.integer({ min: 0, max: 1_000_000 }),
    }),
  );

  it("a grain rebuilt from its persisted log equals the never-evicted grain", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(msgArb, { maxLength: 20 }), async (msgs) => {
        const backing = new Map<string, string>();

        // Never-evicted: one long-lived grain folds the whole schedule.
        const live = await raftGrain<number>(grainCtx<number>(backing), {
          config: CONFIG,
          rng: ZERO_RNG,
        });
        for (const m of msgs) await live.deliver(m);
        const liveState = live.state();
        await live.close();

        // Cold wake: a brand-new grain over the SAME persisted bytes. Its
        // `load()` folds the log; no live Msg is replayed through `deliver`.
        const woken = await raftGrain<number>(grainCtx<number>(backing), {
          config: CONFIG,
          rng: ZERO_RNG,
        });
        const wokenState = woken.state();
        await woken.close();

        // Byte-identity: the rebuilt state (persistent AND volatile) equals the
        // never-evicted state — the volatile fields are a pure function of the
        // folded log, not separately persisted.
        expect(wokenState).toEqual(liveState);
      }),
    );
  });

  it("recovers persistent state (term/vote/log) across a single eviction", async () => {
    const backing = new Map<string, string>();
    const g1 = await raftGrain<number>(grainCtx<number>(backing), {
      config: CONFIG,
      rng: ZERO_RNG,
    });
    // A higher-term vote (adopts term + records vote) then an election timeout
    // (becomes candidate, bumps term again, appends nothing to the log but
    // mutates persistent term/vote).
    await g1.deliver(voteReq({ term: 3, candidateId: "n2" }));
    await g1.deliver({ _tag: "election_timeout_fired", at: 2000 });
    const before = g1.state();
    await g1.close();

    const g2 = await raftGrain<number>(grainCtx<number>(backing), {
      config: CONFIG,
      rng: ZERO_RNG,
    });
    expect(g2.state()).toEqual(before);
    expect(g2.state().currentTerm).toBe(before.currentTerm);
    await g2.close();
  });
});

// ===========================================================================
// Acceptance criterion 3 — eviction-safe election timer via the DO alarm
// ===========================================================================

describe("eviction-safe timer (DO alarm, not an isolate timer)", () => {
  it("arms the election deadline via setAlarm on activation", async () => {
    const backing = new Map<string, string>();
    const alarm = recordingAlarm();
    const ctx = grainCtx<number>(backing, { now: 1000, alarm });
    const grain = await raftGrain<number>(ctx, {
      config: CONFIG,
      rng: ZERO_RNG,
    });

    // A fresh follower arms ONLY the election timeout at now + minMs (rng=0).
    expect(alarm.armed.length).toBeGreaterThan(0);
    expect(alarm.armed.at(-1)).toBe(1000 + CONFIG.electionTimeout.minMs);
    await grain.close();
  });

  it("re-arms the deadline across eviction (a re-woken grain arms its own alarm)", async () => {
    const backing = new Map<string, string>();

    // First activation arms an alarm, then the isolate "dies".
    const a1 = recordingAlarm();
    const g1 = await raftGrain<number>(
      grainCtx<number>(backing, { now: 1000, alarm: a1 }),
      { config: CONFIG, rng: ZERO_RNG },
    );
    await g1.deliver(voteReq({ term: 2 }));
    await g1.close();

    // Cold wake: a fresh alarm. The re-woken grain MUST re-arm the deadline
    // itself (the timer is reconstructed from durable state on activation, not
    // carried in the dead isolate).
    const a2 = recordingAlarm();
    const g2 = await raftGrain<number>(
      grainCtx<number>(backing, { now: 5000, alarm: a2 }),
      { config: CONFIG, rng: ZERO_RNG },
    );
    expect(a2.armed.length).toBeGreaterThan(0);
    expect(a2.armed.at(-1)).toBe(5000 + CONFIG.electionTimeout.minMs);
    await g2.close();
  });

  it("a leader arms the heartbeat deadline, not the election one", async () => {
    // Single-node cluster: an election timeout wins immediately → leader. A
    // leader arms ONLY the heartbeat (now + heartbeatMs).
    const soloConfig: RaftConfig = { ...CONFIG, peers: [] };
    const backing = new Map<string, string>();
    const alarm = recordingAlarm();
    const grain = await raftGrain<number>(
      grainCtx<number>(backing, { now: 1000, alarm }),
      { config: soloConfig, rng: ZERO_RNG },
    );
    await grain.deliver({ _tag: "election_timeout_fired", at: 1000 });
    expect(grain.state().role._tag).toBe("leader");
    expect(alarm.armed.at(-1)).toBe(1000 + soloConfig.heartbeatMs);
    await grain.close();
  });

  it("onAlarm fires the live timer Msg (election → candidate)", async () => {
    const backing = new Map<string, string>();
    const grain = await raftGrain<number>(grainCtx<number>(backing), {
      config: CONFIG,
      rng: ZERO_RNG,
    });
    expect(grain.state().role._tag).toBe("follower");
    // The DO alarm fires: a follower's live timer is the election timeout, so
    // onAlarm drives it → candidate, bumping the term.
    const term0 = grain.state().currentTerm;
    await grain.onAlarm();
    expect(grain.state().role._tag).toBe("candidate");
    expect(grain.state().currentTerm).toBe(term0 + 1);
    await grain.close();
  });
});
