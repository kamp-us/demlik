/**
 * End-to-end client-prediction loop test (#215, epic #186).
 *
 * Drives the worked example in `./client-prediction.example` through the FULL
 * Gambetta/Valve authoritative-server loop and asserts convergence:
 *
 *   1. the client predicts locally by folding inputs (`foldMsgs`),
 *   2. each input is seq-tagged (`nextSeq` + `tagSeq`),
 *   3. the authoritative server advances and reports `lastAppliedSeq`, and
 *   4. the client reconciles (`reconcile`) against the authoritative snapshot —
 *
 * converging to the authoritative result. The example imports the seam ONLY
 * through the runtime-free boundary (`../pure`); this test never imports `run`
 * or any host either, so the loop is exercised entirely on the pure surface.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldMsgs } from "../pure";
import {
  type ClientState,
  clientPredict,
  clientReconcile,
  type GameState,
  gameMachine,
  initClient,
  initServer,
  type Move,
  move,
  ORIGIN,
  type Snapshot,
  serverApplyWorld,
  serverReceive,
  serverSnapshot,
} from "./client-prediction.example";

// Reference: the authoritative result of folding `moves` over `base` — the
// single source of truth the loop must converge to.
const authoritativeOf = (base: GameState, moves: readonly Move[]): GameState =>
  foldMsgs(gameMachine, base, moves);

describe("client-prediction worked example — the full Gambetta loop", () => {
  it("predicts locally ahead of the server by folding seq-tagged inputs", () => {
    // The player makes three moves with zero server round-trips. The client
    // predicts each immediately (foldMsgs over its pending buffer).
    let client = initClient();
    client = clientPredict(client, move(1, 0));
    client = clientPredict(client, move(0, 2));
    client = clientPredict(client, move(3, 0));

    // Local prediction === the authoritative result of those same moves.
    expect(client.predicted).toEqual(
      authoritativeOf(ORIGIN, [move(1, 0), move(0, 2), move(3, 0)]),
    );
    // All three are pending (un-acked), minted with monotonic seqs 0,1,2.
    expect(client.pending.map((p) => p.seq)).toEqual([0, 1, 2]);
  });

  it("reconciles to authoritative + un-acked tail, folding in changes the client never predicted", () => {
    // Client predicts A, B, C locally.
    let client = initClient();
    client = clientPredict(client, move(1, 0)); // seq 0
    client = clientPredict(client, move(1, 0)); // seq 1
    client = clientPredict(client, move(1, 0)); // seq 2
    expect(client.predicted).toEqual({ pos: { x: 3, y: 0 } });

    // The server receives only the first two (network delivered a prefix) AND a
    // world move from ANOTHER player the local client never predicted.
    let server = initServer();
    server = serverReceive(server, client.pending.slice(0, 2)); // acks seq 0,1
    server = serverApplyWorld(server, [move(0, 5)]); // someone else moved; no seq
    const snap: Snapshot = serverSnapshot(server);
    expect(snap.state).toEqual({ pos: { x: 2, y: 5 } });
    expect(snap.lastAppliedSeq).toBe(1);

    // Reconcile: drop the acked prefix (seq <= 1), rebase on the authoritative
    // snapshot (which carries the world move), replay only the un-acked tail (C).
    client = clientReconcile(client, snap);
    expect(client.pending.map((p) => p.seq)).toEqual([2]); // only C remains pending
    expect(client.predicted).toEqual({ pos: { x: 3, y: 5 } }); // 2+5 authoritative + C's +1
    expect(client.base).toEqual(snap.state);
  });

  it("converges to the authoritative state once every input is acked", () => {
    let client = initClient();
    let server = initServer();

    const inputs = [move(2, 1), move(-1, 3), move(4, 4), move(0, -2)];
    for (const i of inputs) client = clientPredict(client, i);

    // Deliver everything; server applies the whole buffer and acks the highest seq.
    server = serverReceive(server, client.pending);
    const snap = serverSnapshot(server);
    client = clientReconcile(client, snap);

    expect(client.pending).toEqual([]); // nothing un-acked
    expect(client.predicted).toEqual(snap.state); // converged to authoritative
    expect(client.predicted).toEqual(authoritativeOf(ORIGIN, inputs));
  });

  // ── Convergence properties (AC1) ──────────────────────────────────────────

  it("property: after full delivery + reconcile, the client equals the authoritative result", () => {
    const arbMove: fc.Arbitrary<Move> = fc.record({
      type: fc.constant("move" as const),
      dx: fc.integer({ min: -20, max: 20 }),
      dy: fc.integer({ min: -20, max: 20 }),
    });
    fc.assert(
      fc.property(
        fc.array(arbMove),
        fc.array(arbMove),
        (localInputs, worldMoves) => {
          let client = initClient();
          let server = initServer();
          for (const i of localInputs) client = clientPredict(client, i);
          // The world also advances (other players) — changes the client never predicted.
          server = serverApplyWorld(server, worldMoves);
          server = serverReceive(server, client.pending);
          const snap = serverSnapshot(server);
          client = clientReconcile(client, snap);

          // Converged: no pending, and predicted == the authoritative fold of
          // world moves THEN the local inputs.
          expect(client.pending).toEqual([]);
          expect(client.predicted).toEqual(snap.state);
          expect(client.predicted).toEqual(
            authoritativeOf(authoritativeOf(ORIGIN, worldMoves), localInputs),
          );
        },
      ),
    );
  });

  it("property: a partial ack leaves predicted == authoritative-base folded with the un-acked tail", () => {
    const arbMove: fc.Arbitrary<Move> = fc.record({
      type: fc.constant("move" as const),
      dx: fc.integer({ min: -20, max: 20 }),
      dy: fc.integer({ min: -20, max: 20 }),
    });
    fc.assert(
      fc.property(
        fc.array(arbMove, { minLength: 1 }),
        fc.nat(),
        (localInputs, deliverRaw) => {
          let client = initClient();
          let server = initServer();
          for (const i of localInputs) client = clientPredict(client, i);

          // Deliver a prefix of `deliver` inputs to the server.
          const deliver = deliverRaw % (localInputs.length + 1);
          const fullPending: readonly (typeof client.pending)[number][] =
            client.pending;
          server = serverReceive(server, client.pending.slice(0, deliver));
          const snap = serverSnapshot(server);
          client = clientReconcile(client, snap);

          // The un-acked tail is exactly the inputs the server has not applied.
          const tail = fullPending.slice(deliver).map((p) => p.value);
          expect(client.pending.map((p) => p.value)).toEqual(tail);
          // predicted == authoritative snapshot folded with the un-acked tail.
          expect(client.predicted).toEqual(authoritativeOf(snap.state, tail));
        },
      ),
    );
  });

  it("property: reconciling is idempotent — re-applying the same snapshot is a no-op", () => {
    const arbMove: fc.Arbitrary<Move> = fc.record({
      type: fc.constant("move" as const),
      dx: fc.integer({ min: -20, max: 20 }),
      dy: fc.integer({ min: -20, max: 20 }),
    });
    fc.assert(
      fc.property(fc.array(arbMove), fc.nat(), (localInputs, deliverRaw) => {
        let client = initClient();
        let server = initServer();
        for (const i of localInputs) client = clientPredict(client, i);
        const deliver =
          localInputs.length === 0 ? 0 : deliverRaw % (localInputs.length + 1);
        server = serverReceive(server, client.pending.slice(0, deliver));
        const snap = serverSnapshot(server);

        const once: ClientState = clientReconcile(client, snap);
        const twice: ClientState = clientReconcile(once, snap);
        expect(twice).toEqual(once);
      }),
    );
  });
});
