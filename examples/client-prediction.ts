/**
 * Client-side prediction + server reconciliation over a `@demlik/tea` machine —
 * the Gambetta/Valve authoritative-server netcode loop, "one reducer, both
 * sides" (epic #186, ADR 0006).
 *
 * THE POINT OF THIS FILE: every import comes from `@demlik/tea/pure`, the
 * runtime-free umbrella subpath. It pulls in the fold seam (`foldMsgs`), the ack
 * primitive (`tagSeq` / `nextSeq` / `partitionByAck`), and the reconciliation
 * helper (`reconcile`) — and NOTHING that drags `run`, the host, or `Store` into
 * a client bundle. A browser game client built on this surface ships the reducer
 * and the prediction math, never the server runtime. (The `pure/import-graph`
 * guard test proves that boundary structurally.)
 *
 * The matching tested reference lives at
 * `packages/tea/src/prediction/client-prediction.example.ts` (+ `.test.ts`); the
 * narrative is in `.patterns/tea/client-prediction.md`.
 *
 * The loop, in four moves:
 *   1. the player moves → predict locally (`tagSeq` + `nextSeq` + `foldMsgs`),
 *   2. send the seq-tagged inputs to the authoritative server,
 *   3. the server folds them with the SAME reducer and reports `lastAppliedSeq`,
 *   4. the client reconciles its prediction against the snapshot (`reconcile`),
 *      keeping its still-in-flight inputs and folding in changes (other players,
 *      the world) it never predicted.
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
} from "@demlik/tea/pure";

// === The shared authoritative machine — pure data, no `defineMachine` ===
//
// `defineMachine` lives in the runtime root, so a runtime-free client authors the
// machine as a plain `Machine` literal and lets `foldMsgs` / `reconcile` read its
// update form via `formOf`'s `detectUpdateForm` fallback. This SAME literal is the
// reducer the server folds — client and server run one identical reducer.

interface GameState {
  readonly pos: { readonly x: number; readonly y: number };
}
interface Move {
  readonly type: "move";
  readonly dx: number;
  readonly dy: number;
}
const move = (dx: number, dy: number): Move => ({ type: "move", dx, dy });
const ORIGIN: GameState = { pos: { x: 0, y: 0 } };

const update: Reducer<GameState, Move, never> = {
  move: (s, m) => [{ pos: { x: s.pos.x + m.dx, y: s.pos.y + m.dy } }, []],
};
const gameMachine: Machine<GameState, Move, never, never, undefined> = {
  init: () => [ORIGIN, []],
  update,
};

// === The client session — predict locally, reconcile against authority ===

interface Client {
  readonly base: GameState; // last authoritative snapshot
  readonly pending: readonly SeqTagged<Move>[]; // un-acked, in-flight inputs
  readonly predicted: GameState; // base folded with pending — what the player sees
}

const initClient = (): Client => ({
  base: ORIGIN,
  pending: [],
  predicted: ORIGIN,
});

/** Player moves: tag with the next monotonic seq, predict locally, no round-trip. */
const predict = (client: Client, input: Move): Client => {
  const pending = [...client.pending, tagSeq(nextSeq(client.pending), input)];
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

/** Authoritative snapshot arrived: drop acked, rebase, replay the un-acked tail. */
const reconcileTo = (
  client: Client,
  snapshot: { readonly state: GameState; readonly lastAppliedSeq: Seq },
): Client => {
  const ack: Ack = { lastAppliedSeq: snapshot.lastAppliedSeq };
  return {
    base: snapshot.state,
    pending: partitionByAck(client.pending, ack).pending, // un-acked tail
    predicted: reconcile(gameMachine, snapshot.state, ack, client.pending),
  };
};

// === The authoritative server — the source of truth ===

interface Server {
  readonly authoritative: GameState;
  readonly lastAppliedSeq: Seq; // -1 = applied nothing yet (below 0-based seqs)
}

const initServer = (): Server => ({
  authoritative: ORIGIN,
  lastAppliedSeq: -1,
});

/** Fold the client's seq-tagged inputs; advance the ack to the highest applied. */
const receive = (
  server: Server,
  inputs: readonly SeqTagged<Move>[],
): Server => ({
  authoritative: foldMsgs(
    gameMachine,
    server.authoritative,
    inputs.map((i) => i.value),
  ),
  lastAppliedSeq: inputs.reduce(
    (mx, i) => (i.seq > mx ? i.seq : mx),
    server.lastAppliedSeq,
  ),
});

/** Other players / the world move too — no client seq, so the ack is unchanged. */
const applyWorld = (server: Server, moves: readonly Move[]): Server => ({
  ...server,
  authoritative: foldMsgs(gameMachine, server.authoritative, moves),
});

// === The loop ===

/**
 * Run one round of the prediction loop and return the converged client + server.
 * The player predicts three moves; the server applies the first two plus a world
 * move from another player; the client reconciles (keeping its third, un-acked
 * input and folding in the world move); then the last input is delivered and
 * acked, converging the client to the authoritative state.
 */
export function runClientPredictionDemo(): {
  readonly converged: boolean;
  readonly predicted: GameState;
  readonly authoritative: GameState;
} {
  let client = initClient();
  let server = initServer();

  // 1. Player makes three moves — all predicted locally, zero round-trips.
  client = predict(client, move(1, 0));
  client = predict(client, move(0, 2));
  client = predict(client, move(3, 0));

  // 2–3. Server gets the first two inputs and a world move from another player.
  server = receive(server, client.pending.slice(0, 2));
  server = applyWorld(server, [move(0, 5)]);

  // 4. Client reconciles: keeps its third (un-acked) input, folds in the world move.
  client = reconcileTo(client, {
    state: server.authoritative,
    lastAppliedSeq: server.lastAppliedSeq,
  });

  // Deliver the last input; server acks it; client converges to authoritative.
  server = receive(server, client.pending);
  client = reconcileTo(client, {
    state: server.authoritative,
    lastAppliedSeq: server.lastAppliedSeq,
  });

  return {
    converged:
      client.pending.length === 0 &&
      client.predicted.pos.x === server.authoritative.pos.x &&
      client.predicted.pos.y === server.authoritative.pos.y,
    predicted: client.predicted,
    authoritative: server.authoritative,
  };
}
