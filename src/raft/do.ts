/// <reference types="@cloudflare/workers-types" />
/**
 * `@demlik/tea/raft/do` — a Raft node as a durable virtual actor on a Durable
 * Object (#122, child of the consensus epic #117).
 *
 * The pure reducer lives in `./index` (`createRaftNode` — #119 election + #120
 * replication). This file is the HOST/persistence wiring only: it reuses the
 * `../do` event-sourced store, threads persist-before-respond, rebuilds state
 * by replaying the persisted log on cold wake, and re-arms the election /
 * heartbeat deadline across eviction via the DO alarm API. The reducer stays
 * pure — the store, the transport, and the clock arrive as injected ports.
 *
 * Three Figure-2 rules map onto three host responsibilities:
 *
 *   1. **Persist-before-respond.** Figure 2: "persistent state (currentTerm,
 *      votedFor, log) is updated on stable storage BEFORE responding to RPCs."
 *      Here that becomes persist-before-DELIVER: the inbound Msg is appended to
 *      the durable event log (and its post-state snapshotted on a boundary)
 *      BEFORE any reply `Cmd` is handed to the transport. {@link RaftGrain}'s
 *      `deliver` awaits the store append, THEN flushes the outbound cmds. A
 *      crash between the two re-delivers nothing the node had not already
 *      durably recorded.
 *
 *   2. **Cold-wake replay.** A grain is a disposable process over durable
 *      storage (`.patterns/tea/durable-actors.md`): on activation the store's
 *      `load()` folds `init → update*` over the persisted log (the SAME pure
 *      reducer the live runtime ran), so a node rebuilt on cold wake is
 *      byte-identical to the never-evicted node after the same Msg sequence —
 *      the #91/#85 replay property, now over the Raft reducer. Volatile state
 *      (commitIndex, leader nextIndex/matchIndex) is reconstructed by the fold,
 *      not separately persisted: it is a deterministic function of the log.
 *
 *   3. **Eviction-safe timers.** The election / heartbeat deadline is a HOST
 *      concern, re-armed via `ctx.alarm.setAlarm` after every turn (the #92
 *      carrier-selection precedent — an alarm, not an isolate-resident
 *      `setTimeout`, and not a machine Sub). The node's own `subs(state, now)`
 *      computes the absolute target; the grain forwards it to the alarm. When
 *      the alarm fires, `onAlarm` maps it back to the election/heartbeat Msg
 *      (`toRaftMsg`) and routes it through `deliver` like any inbound Msg.
 *
 * Transport is a thin injected port ({@link RaftTransport}) — tests fake it; a
 * real DO grain may back it with a DO-to-DO fetch binding. Network hardening is
 * an epic non-goal (#117).
 */

import type { DeadlineSub } from "../deadline";
import { doEventSourcedStore, type EventSourcedStore } from "../do";
import {
  defineMachine,
  type Machine,
  type Runtime,
  run,
  type Store,
} from "../index";
import {
  createRaftNode,
  type NodeId,
  type RaftCmd,
  type RaftConfig,
  type RaftMsg,
  type RaftNode,
  type RaftState,
  toRaftMsg,
} from "./index";

// ===========================================================================
// Ports — the impure edges the grain injects (kept OUT of the pure reducer)
// ===========================================================================

/**
 * The DO alarm slice the grain re-arms across eviction. `setAlarm(atMs)`
 * schedules the next election/heartbeat deadline. Mirrors `../do`'s
 * `AlarmStorage` (the #92 step-host carrier) — only the alarm method, never the
 * whole `DurableObjectStorage`.
 */
export interface RaftAlarm {
  setAlarm(scheduledTime: number): void | Promise<void>;
}

/**
 * The outbound-RPC transport. The grain hands each emitted `RaftCmd` (a
 * `RequestVote`/`AppendEntries` request or reply) to `send`; the consumer
 * performs it over the wire (a DO-to-DO fetch binding in production, an
 * in-memory bus in tests). PURE-data in, effect out — the reducer never names
 * this; only the grain's `deliver` step does, and only AFTER the persist.
 */
export interface RaftTransport<C = unknown> {
  send(cmd: RaftCmd<C>): void | Promise<void>;
}

/**
 * Everything {@link raftGrain} needs from the Durable Object: its
 * `DurableObjectStorage` (the event log + snapshot live here), the alarm
 * (eviction-safe timers), the transport (outbound RPCs), and a `now` clock used
 * ONLY at the host edge to compute the next deadline target — never in a verb.
 */
export interface RaftGrainCtx<C = unknown> {
  readonly storage: DurableObjectStorage;
  readonly alarm: RaftAlarm;
  readonly transport: RaftTransport<C>;
  /** Wall-clock reader at the effect boundary (injected; fixed in tests). */
  readonly now: () => number;
}

/** Construction options for {@link raftGrain}. */
export interface RaftGrainOptions {
  /** Static Raft configuration (self id, peers, timeouts). */
  readonly config: RaftConfig;
  /**
   * Election-jitter RNG, injected ONCE and forwarded to `createRaftNode`
   * (default `Math.random`; a fixed value in tests so replay re-decides
   * identically).
   */
  readonly rng?: () => number;
  /**
   * Snapshot retention — take a snapshot every N appended events (forwarded to
   * `doEventSourcedStore`; default 100). Bounds replay length; never changes
   * the fold's result.
   */
  readonly snapshotEvery?: number;
}

// ===========================================================================
// Discriminant bridge
// ===========================================================================

/**
 * The substrate's reducer dispatch keys on `Msg.type`; `RaftMsg` discriminates
 * on `_tag` (engine AST convention). A `StoredMsg` mirrors each member's `_tag`
 * LITERAL onto `type` (distributed over the union, so `type` stays a literal —
 * not a widened `string`), so it satisfies the substrate's `{ type: string }`
 * bound AND its reducer mapped type narrows each cell's Msg correctly, both
 * live and on a cold-wake fold — WITHOUT mutating the Raft vocabulary (the
 * verbs still read `_tag`).
 */
type StoredMsg<C> =
  RaftMsg<C> extends infer M
    ? M extends { readonly _tag: infer T extends string }
      ? M & { readonly type: T }
      : never
    : never;

/** Stamp `type = _tag`. Idempotent — re-stamping is a no-op. */
function stampType<C>(msg: RaftMsg<C>): StoredMsg<C> {
  return { ...msg, type: msg._tag } as StoredMsg<C>;
}

// ===========================================================================
// The reducer-backed machine — pure, the SAME verbs the live runtime folds
// ===========================================================================

/** This grain emits no Subs: the deadline is a host alarm, not a machine Sub. */
type RaftGrainSub = never;

/** The grain's machine type alias (Cmd union stays the node's `RaftCmd`). */
type RaftMachine<C> = Machine<
  RaftState<C>,
  StoredMsg<C>,
  RaftCmd<C>,
  RaftGrainSub,
  RaftGrainCtx<C>
>;

/**
 * Build the pure `Machine` for one Raft node. The reducer routes each
 * `StoredMsg` (keyed by `type`, the stamped `_tag`) into the matching
 * `createRaftNode` verb and returns its `[state, cmds]` tuple unchanged.
 * `interpret` is EMPTY by design: the grain (not the machine) performs the
 * outbound RPCs, and only AFTER the persist — so the reducer never names the
 * transport and the persist-before-respond ordering lives entirely in the host.
 */
function raftMachine<C>(node: RaftNode<C>): RaftMachine<C> {
  return defineMachine<
    RaftState<C>,
    StoredMsg<C>,
    RaftCmd<C>,
    RaftGrainSub,
    RaftGrainCtx<C>
  >({
    // Fresh boot seeds a follower (term 0, no vote, empty log); rehydrate
    // returns the folded state verbatim (init's parse-boundary contract — no
    // boot Cmds).
    init: (loaded) => [loaded ?? node.init(), []],
    update: {
      request_vote_request: (s, m) => node.onRequestVote(s, m),
      request_vote_reply: (s, m) => node.onRequestVoteReply(s, m),
      append_entries_request: (s, m) => node.onAppendEntries(s, m),
      append_entries_reply: (s, m) => node.onAppendEntriesReply(s, m),
      client_command: (s, m) => node.onClientCommand(s, m),
      election_timeout_fired: (s, m) => node.onElectionTimeout(s, m.at),
      heartbeat_fired: (s, m) => node.onHeartbeat(s, m.at),
    },
    // No Cmds are interpreted in-runtime: the grain flushes them post-persist.
    interpret: {
      "raft:send_request_vote": async () => {},
      "raft:send_request_vote_reply": async () => {},
      "raft:send_append_entries": async () => {},
      "raft:send_append_entries_reply": async () => {},
    },
  });
}

// ===========================================================================
// The durable grain — persist-before-respond + cold-wake replay + alarm re-arm
// ===========================================================================

/**
 * The grain handle returned by {@link raftGrain}. `deliver(msg)` is the one
 * entry point: it folds the Msg through the pure reducer, persists the event
 * (persist-before-respond), THEN flushes the outbound RPCs and re-arms the
 * deadline alarm. `onAlarm()` is the DO `alarm()` lifecycle hook. `state()`
 * reads the current (post-recovery) `RaftState`.
 */
export interface RaftGrain<C = unknown> {
  /**
   * Fold one inbound `RaftMsg` durably. Persist-before-respond: the event is
   * appended to the durable log (and its post-state snapshotted on a boundary)
   * BEFORE the reply/replication Cmds are sent over the transport. After the
   * send, re-arm the election/heartbeat alarm off the resulting state. Returns
   * the cmds that were sent (for tests / observability).
   */
  deliver(msg: RaftMsg<C>): Promise<readonly RaftCmd<C>[]>;
  /**
   * The DO `alarm()` hook. Maps the (re-armed-across-eviction) deadline back to
   * the election or heartbeat Msg via `toRaftMsg` and routes it through
   * `deliver`. A no-op if no timer is live.
   */
  onAlarm(): Promise<void>;
  /** The current `RaftState` (after cold-wake recovery has folded the log). */
  state(): RaftState<C>;
  /** Tear down the underlying runtime (releases the store). */
  close(): Promise<void>;
}

/**
 * Activate a Raft node as a durable grain over a Durable Object.
 *
 * Returns a Promise because activation REPLAYS: the event-sourced store's
 * `load()` folds the persisted log on top of the latest snapshot BEFORE the
 * grain serves any RPC (cold-wake replay, acceptance criterion 2). The same
 * call on a fresh DO boots a follower from an empty log.
 *
 * Wiring, in order (the persist-before-respond discipline):
 *   1. `run(machine, { store: es.store })` — `store.load()` folds the log →
 *      rebuilt `RaftState` (or fresh follower).
 *   2. `runtime.observe(append)` — every APPLIED Msg is appended to the durable
 *      log. The append Promise is tracked so `deliver` can AWAIT it before any
 *      outbound RPC leaves (persist-before-respond).
 *   3. After recovery, arm the initial deadline alarm off the recovered state.
 */
export async function raftGrain<C = unknown>(
  ctx: RaftGrainCtx<C>,
  opts: RaftGrainOptions,
): Promise<RaftGrain<C>> {
  const { config } = opts;
  const rng = opts.rng ?? Math.random;
  const node = createRaftNode<C>(config, rng);
  const machine = raftMachine<C>(node);

  // The event-sourced store: appends each applied Msg to the durable log and
  // rebuilds state by folding the SAME reducer on activation. The boundary
  // parses accept a recovered `RaftState` / a logged `StoredMsg`.
  // The fold only uses `init` + `update`, so `doEventSourcedStore` erases the
  // machine's Cmd/Sub to the substrate base unions (its own factory comment:
  // "pinning the machine's concrete C/U would force every caller to thread them
  // through"). The `interpret` map is contravariant in its Cmd param, so a
  // concrete `RaftCmd<C>` machine is not STRUCTURALLY assignable to the erased
  // `Machine<S, M, Cmd, Sub, Ctx>` parameter even though it is sound for the
  // fold; the cast crosses that erasure boundary deliberately (the live `run`
  // below keeps the machine's precise `RaftCmd<C>` / `never` types).
  const es: EventSourcedStore<RaftState<C>, StoredMsg<C>> = doEventSourcedStore<
    RaftState<C>,
    StoredMsg<C>,
    RaftGrainCtx<C>
  >(
    ctx.storage,
    machine as unknown as Parameters<
      typeof doEventSourcedStore<RaftState<C>, StoredMsg<C>, RaftGrainCtx<C>>
    >[1],
    ctx,
    {
      snapshotEvery: opts.snapshotEvery,
      parse: parseRaftState<C>,
      parseEvent: parseRaftEvent<C>,
    },
  );

  const store: Store<RaftState<C>> = es.store;

  // The live runtime. `load()` runs here (the cold-wake fold); `ready` resolves
  // once the persisted log has been replayed into `RaftState`.
  const runtime: Runtime<RaftState<C>, StoredMsg<C>> = await run(machine, {
    ctx,
    store,
  }).ready;

  // Track in-flight appends so `deliver` can persist-before-respond. `observe`
  // is synchronous (it cannot await us), so we capture the append Promise per
  // applied Msg; the `deliver` turn awaits it before flushing cmds.
  let pendingAppend: Promise<void> = Promise.resolve();
  runtime.observe((msg) => {
    if (msg !== null) pendingAppend = es.append(msg);
  });
  await runtime.ready;

  /** Compute + arm the next election/heartbeat deadline off the live state. */
  async function rearmAlarm(): Promise<void> {
    // The node arms exactly one DeadlineSub (election XOR heartbeat); take it.
    const next: DeadlineSub | undefined = node.subs(
      runtime.getState(),
      ctx.now(),
    )[0];
    if (next) await ctx.alarm.setAlarm(next.atMs);
  }

  // Arm the initial deadline off the recovered state (a freshly-woken follower
  // must already have an election timer pending, exactly as a never-evicted one
  // would).
  await rearmAlarm();

  const grain: RaftGrain<C> = {
    async deliver(msg) {
      // The cmds the reducer emits for THIS Msg, computed from the pre-state by
      // the SAME pure verb the reducer runs — deterministic, no clock/RNG, so
      // re-deriving them to know what to SEND cannot diverge from what the
      // runtime applied. We send them only AFTER the append settles.
      const cmds = stepCmds(node, runtime.getState(), msg);

      // Drive the Msg through the runtime so its state + the durable log advance
      // identically to the pure step. `dispatch` runs to quiescence and the
      // observer enqueues the append.
      await runtime.dispatch(stampType(msg));

      // PERSIST-BEFORE-RESPOND: block until the event is durably written before
      // any reply/replication Cmd leaves over the transport.
      await pendingAppend;

      // Now it is safe to respond: flush the outbound RPCs.
      for (const cmd of cmds) await ctx.transport.send(cmd);

      // Re-arm the deadline alarm off the post-Msg state (eviction-safe timer).
      await rearmAlarm();
      return cmds;
    },

    async onAlarm() {
      // The DO alarm carries no sub id; re-derive the live timer from the
      // current state (the node arms election XOR heartbeat), then synthesize
      // the timer Msg via the same `toRaftMsg` mapping the Sub path uses.
      const fired = node.subs(runtime.getState(), ctx.now())[0];
      if (!fired) return;
      const timerMsg = toRaftMsg(config.self, {
        id: fired.id,
        atMs: fired.atMs,
      });
      if (timerMsg === null) return;
      await grain.deliver(timerMsg);
    },

    state() {
      return runtime.getState();
    },

    async close() {
      await runtime.stop();
    },
  };

  return grain;
}

/**
 * Run the matching pure verb for `msg` and return the cmds it emits. Mirrors
 * the reducer table; `deliver` uses it to know what to SEND only after the
 * persist settles (the runtime stays the single source of state truth).
 */
function stepCmds<C>(
  node: RaftNode<C>,
  state: RaftState<C>,
  msg: RaftMsg<C>,
): readonly RaftCmd<C>[] {
  switch (msg._tag) {
    case "request_vote_request":
      return node.onRequestVote(state, msg)[1];
    case "request_vote_reply":
      return node.onRequestVoteReply(state, msg)[1];
    case "append_entries_request":
      return node.onAppendEntries(state, msg)[1];
    case "append_entries_reply":
      return node.onAppendEntriesReply(state, msg)[1];
    case "client_command":
      return node.onClientCommand(state, msg)[1];
    case "election_timeout_fired":
      return node.onElectionTimeout(state, msg.at)[1];
    case "heartbeat_fired":
      return node.onHeartbeat(state, msg.at)[1];
  }
}

// ===========================================================================
// Boundary parses — the persisted snapshot + event cells (never throw)
// ===========================================================================

/**
 * Boundary parse for the persisted SNAPSHOT cell. Accepts a recovered
 * `RaftState` (a non-null object carrying the persistent + volatile fields);
 * returns `null` on an unrecognized shape so the grain boots a fresh follower
 * (the `doEventSourcedStore` parse contract — never throws).
 */
function parseRaftState<C>(raw: unknown): RaftState<C> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.currentTerm !== "number") return null;
  if (!("votedFor" in s)) return null;
  if (!Array.isArray(s.log)) return null;
  if (typeof s.commitIndex !== "number") return null;
  if (typeof s.role !== "object" || s.role === null) return null;
  return raw as RaftState<C>;
}

/**
 * Boundary parse for a persisted EVENT (one logged `StoredMsg`). Accepts a
 * non-null object whose `type` (the stamped `_tag`) is a known Raft Msg tag;
 * re-stamps both `_tag` and `type` so the recovered Msg routes correctly
 * through the reducer dispatch (`type`) AND the verbs (`_tag`). Returns `null`
 * to DROP a retired/unknown variant from replay (never throws).
 */
function parseRaftEvent<C>(raw: unknown): StoredMsg<C> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const m = raw as Record<string, unknown>;
  const tag = typeof m.type === "string" ? m.type : m._tag;
  if (typeof tag !== "string" || !RAFT_MSG_TAGS.has(tag)) return null;
  return { ...(raw as RaftMsg<C>), _tag: tag, type: tag } as StoredMsg<C>;
}

/** The known `RaftMsg` discriminant tags — the replay parse's accept set. */
const RAFT_MSG_TAGS: ReadonlySet<string> = new Set([
  "request_vote_request",
  "request_vote_reply",
  "append_entries_request",
  "append_entries_reply",
  "client_command",
  "election_timeout_fired",
  "heartbeat_fired",
]);

// Re-export the node-facing types a consumer wiring the grain needs, so they
// need not also import from `./index`.
export type { NodeId, RaftCmd, RaftConfig, RaftMsg, RaftState };
