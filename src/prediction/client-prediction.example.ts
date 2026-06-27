/**
 * Worked, end-to-end client-prediction example (#215, epic #186).
 *
 * This is the reference for the **Gambetta/Valve authoritative-server netcode
 * loop** over a `@demlik/tea` machine — "one reducer, both sides." A client
 * predicts the player's moves locally for zero-latency feedback, the
 * authoritative server is the source of truth, and the client reconciles its
 * prediction against each authoritative snapshot. The narrative is in
 * [`.patterns/tea/client-prediction.md`](../../../../.patterns/tea/client-prediction.md);
 * this file is the code it cites, exercised by `./client-prediction.example.test.ts`.
 *
 * ## The runtime-free boundary (ADR 0006)
 *
 * Everything here imports ONLY from `../pure` — the `@demlik/tea/pure` umbrella
 * subpath that re-exports the fold seam (`foldMsgs`), the ack primitive
 * (`tagSeq` / `nextSeq` / `partitionByAck`), and the reconciliation helper
 * (`reconcile`). It imports NO `run`, NO host, NO `Store`: a client bundle built
 * from this example never drags the runtime in, and the
 * `pure/import-graph.test.ts` guard proves that boundary structurally.
 *
 * Note the shared `gameMachine` below is a **plain `Machine` data literal**, not
 * a `defineMachine(...)` call — `defineMachine` lives in the runtime root, so a
 * truly runtime-free client authors the machine as pure data and lets
 * `foldMsgs` / `reconcile` read its update form via `formOf`'s `detectUpdateForm`
 * fallback. The same literal is the authoritative reducer the server folds, so
 * client and server run one identical reducer.
 *
 * ## The shape, in four moves
 *
 *   - `clientPredict(client, input)` — mint the next `seq` (`nextSeq`), tag the
 *     input (`tagSeq`), append to the pending buffer, and re-predict locally by
 *     folding the whole pending buffer over the last authoritative base
 *     (`foldMsgs`). No server round-trip.
 *   - `serverReceive(server, inputs)` — the authoritative side folds the client's
 *     seq-tagged inputs into its state and advances `lastAppliedSeq` to the
 *     highest seq it applied.
 *   - `serverApplyWorld(server, moves)` — the authoritative state also advances
 *     from inputs the local client never predicted (other players, the world).
 *     These carry no client `seq`, so they do NOT move `lastAppliedSeq`.
 *   - `clientReconcile(client, snapshot)` — drop the acked prefix
 *     (`partitionByAck`), rebase on the authoritative snapshot, and replay only
 *     the un-acked tail over it (`reconcile`). The result folds in authoritative
 *     changes the client never predicted AND keeps its own in-flight inputs.
 */

import {
  type Ack,
  foldMsgs,
  type Machine,
  nextSeq,
  partitionByAck,
  type Reducer,
  reconcile,
  type Seq,
  type SeqTagged,
  tagSeq,
} from "../pure";

// === The authoritative game machine — pure data, shared by client + server ===

/** A 2D position. */
export interface Vec {
  readonly x: number;
  readonly y: number;
}

/** The whole game state — one player's position. */
export interface GameState {
  readonly pos: Vec;
}

/** The only input: a relative move. Stands in for any client-predicted command. */
export interface Move {
  readonly type: "move";
  readonly dx: number;
  readonly dy: number;
}

/** Construct a `move` input. */
export const move = (dx: number, dy: number): Move => ({
  type: "move",
  dx,
  dy,
});

/** The starting authoritative state. */
export const ORIGIN: GameState = { pos: { x: 0, y: 0 } };

// A flat `Reducer` record: one pure cell per Msg variant. Authored as data so it
// stays on the runtime-free boundary (no `defineMachine`, which is runtime-root).
const update: Reducer<GameState, Move, never> = {
  move: (s, m) => [{ pos: { x: s.pos.x + m.dx, y: s.pos.y + m.dy } }, []],
};

/**
 * The shared authoritative machine, as a plain `Machine` literal. `foldMsgs` /
 * `reconcile` read its update form via `formOf` (which falls back to
 * `detectUpdateForm` for a literal that never passed through `defineMachine`), so
 * the SAME reducer drives the client's prediction and the server's authority.
 */
export const gameMachine: Machine<GameState, Move, never, never, undefined> = {
  init: () => [ORIGIN, []],
  update,
};

// === The authoritative server — the source of truth ===

/** A snapshot the server publishes: its state + the highest client seq applied. */
export interface Snapshot {
  readonly state: GameState;
  readonly lastAppliedSeq: Seq;
}

/** The server's own state: the authoritative position + its ack cursor. */
export interface ServerState {
  readonly authoritative: GameState;
  readonly lastAppliedSeq: Seq;
}

/**
 * "Applied nothing yet" cursor. Client seqs are minted 0-based by `nextSeq`, so
 * the empty-ack sentinel must sit BELOW seq 0 — otherwise `partitionByAck`'s
 * inclusive `seq <= lastAppliedSeq` would falsely ack the seq-0 input before the
 * server ever applied it. `-1` is "before any seq."
 */
const NOTHING_APPLIED: Seq = -1;

/** A fresh server at the origin, having applied nothing. */
export const initServer = (): ServerState => ({
  authoritative: ORIGIN,
  lastAppliedSeq: NOTHING_APPLIED,
});

/**
 * Apply a batch of the client's seq-tagged inputs: fold them into the
 * authoritative state (the SAME reducer the client predicts with) and advance
 * `lastAppliedSeq` to the highest seq applied. A delivered prefix acks that
 * prefix; the rest stay in flight on the client until a later batch.
 */
export const serverReceive = (
  server: ServerState,
  inputs: readonly SeqTagged<Move>[],
): ServerState => {
  const authoritative = foldMsgs(
    gameMachine,
    server.authoritative,
    inputs.map((i) => i.value),
  );
  const lastAppliedSeq = inputs.reduce(
    (max, i) => (i.seq > max ? i.seq : max),
    server.lastAppliedSeq,
  );
  return { authoritative, lastAppliedSeq };
};

/**
 * Advance the authoritative state from inputs the local client never predicted —
 * other players, world events. These carry no client `seq`, so `lastAppliedSeq`
 * is unchanged: they are authoritative changes the client will first see (and
 * fold in) at its next `clientReconcile`.
 */
export const serverApplyWorld = (
  server: ServerState,
  moves: readonly Move[],
): ServerState => ({
  ...server,
  authoritative: foldMsgs(gameMachine, server.authoritative, moves),
});

/** Publish the server's current authoritative snapshot. */
export const serverSnapshot = (server: ServerState): Snapshot => ({
  state: server.authoritative,
  lastAppliedSeq: server.lastAppliedSeq,
});

// === The client — predicts locally, reconciles against authority ===

/**
 * The client's session:
 *   - `base`      — the last authoritative snapshot it reconciled to.
 *   - `pending`   — the seq-tagged inputs it has sent / will send and the server
 *                   has not yet acked (the replay tail).
 *   - `predicted` — `base` folded with `pending`: what the player sees NOW,
 *                   before the server confirms anything.
 */
export interface ClientState {
  readonly base: GameState;
  readonly pending: readonly SeqTagged<Move>[];
  readonly predicted: GameState;
}

/** A fresh client at the origin with nothing in flight. */
export const initClient = (): ClientState => ({
  base: ORIGIN,
  pending: [],
  predicted: ORIGIN,
});

/**
 * The player makes a move. Mint the next monotonic seq from the pending buffer
 * alone (`nextSeq` — no counter on the Model), tag the input (`tagSeq`), append
 * it, and re-predict locally by folding the whole pending buffer over `base`
 * (`foldMsgs`). Zero server round-trip — the player sees the move immediately.
 */
export const clientPredict = (
  client: ClientState,
  input: Move,
): ClientState => {
  const seq = nextSeq(client.pending);
  const pending = [...client.pending, tagSeq(seq, input)];
  return {
    ...client,
    pending,
    predicted: foldMsgs(
      gameMachine,
      client.base,
      pending.map((p) => p.value),
    ),
  };
};

/**
 * An authoritative snapshot arrived. Reconcile (the Gambetta correction step):
 *   - drop the acked prefix from the pending buffer (`partitionByAck`),
 *   - rebase on the authoritative `snapshot.state` (which may carry world changes
 *     the client never predicted), and
 *   - replay ONLY the un-acked tail over it (`reconcile`, which composes the
 *     same `partitionByAck` + `foldMsgs`).
 *
 * The corrected `predicted` folds the un-acked tail on top of the authoritative
 * snapshot, so the player keeps their in-flight inputs while snapping to the
 * server's truth.
 */
export const clientReconcile = (
  client: ClientState,
  snapshot: Snapshot,
): ClientState => {
  const ack: Ack = { lastAppliedSeq: snapshot.lastAppliedSeq };
  const { pending } = partitionByAck(client.pending, ack);
  return {
    base: snapshot.state,
    pending,
    predicted: reconcile(gameMachine, snapshot.state, ack, client.pending),
  };
};
