# Client prediction over an authoritative machine

The pattern for **client-side prediction + server reconciliation** — the
Gambetta/Valve authoritative-server netcode loop — expressed over a `@demlik/tea`
machine. Where [`durable-actors.md`](./durable-actors.md) is the north star for the
*server* (a durable virtual actor folding events), this doc is the north star for
the *client*: predict locally for zero-latency feedback, treat the server as the
source of truth, and reconcile the two with **one reducer running on both sides**.

Read this when you are building a real-time client (a game, a collaborative
cursor, any optimistic-UI surface) over a tea machine and you want the prediction
math to be a guarantee, not a hand-roll.

The seam shipped in epic #186 (ADR
[0006](../../.decisions/0006-client-prediction-fold-seam-and-pure-boundary.md)).
The worked, tested code is
[`packages/tea/src/prediction/client-prediction.example.ts`](../../src/prediction/client-prediction.example.ts)
(+ `.test.ts`); the consumer-facing version that imports the public boundary is
[`packages/tea/examples/client-prediction.ts`](../../examples/client-prediction.ts).

---

## The problem, in one sentence

A networked client must show the player's own actions **immediately** (waiting a
round-trip for every input feels broken), while the **server stays authoritative**
(so two clients can't disagree and cheaters can't win) — and those two facts
contradict unless the client can re-run the authoritative logic locally and
correct itself when the server's truth arrives.

The classic answer (Gabriel Gambetta, *Fast-Paced Multiplayer*; Valve's Source
netcode) has three moving parts:

1. **Client-side prediction** — apply the player's input locally the instant it
   happens, before the server confirms it.
2. **Server reconciliation** — when an authoritative snapshot arrives, throw away
   the prediction, snap to the snapshot, and **replay the inputs the server has
   not yet acknowledged** on top of it.
3. **A sequence number per input** — so the client knows which of its predicted
   inputs the server has already folded in (and can stop replaying them).

The trap is writing the prediction reducer **twice** — once on the server, once on
the client — and watching them drift. tea's whole thesis is "one pure reducer,"
so the client must reuse the *same* `update` the server runs.

---

## The shape — one reducer, four moves

The authoritative game logic is an ordinary tea `update` (a `Reducer` or a
`Transitions` table). The same reducer drives both sides; the seam is three pure
functions from the runtime-free boundary (see below).

| Move | Helper | What it does |
|---|---|---|
| **Predict** | `nextSeq` + `tagSeq` + `foldMsgs` | Mint the next sequence number from the pending buffer, tag the input, append it, and fold the whole pending buffer over the last authoritative base. Zero round-trip. |
| **Send + apply** | (your transport) + `foldMsgs` | The client sends its seq-tagged inputs; the server folds them with the SAME reducer and reports the highest sequence it applied (`lastAppliedSeq`). |
| **Reconcile** | `reconcile` (= `partitionByAck` + `foldMsgs`) | On an authoritative snapshot: drop the acked prefix, rebase on the snapshot, and replay only the un-acked tail over it. |
| **Prune** | `partitionByAck` | Keep only the un-acked tail in the pending buffer (the inputs still in flight). |

`reconcile(machine, authoritativeState, lastAppliedSeq, pending)` is the payoff:
it **composes** the ack partition (`partitionByAck`, #212) and the pure fold
(`foldMsgs`, #211) — there is no second copy of either. It is the whole reconcile
step in one call:

```ts
// the corrected prediction = authoritative snapshot, with the un-acked tail replayed on top
const corrected = reconcile(gameMachine, snapshot.state, snapshot.lastAppliedSeq, pending);
```

Because the server's authoritative snapshot may carry changes the client never
predicted (other players, world events), `reconcile` does the right thing
structurally: it rebases on `authoritativeState` first, *then* replays the local
tail — so the client folds in everyone else's moves AND keeps its own in-flight
inputs.

---

## The runtime-free boundary — why the client bundle stays small

A browser client must not drag the server runtime (`run`, the host, `Store`,
interpret, subscriptions) into its bundle. ADR 0006 makes that a **structural
guarantee, not a tree-shaking accident**:

- The seam ships on the dedicated subpath **`@demlik/tea/pure`** — the umbrella
  that re-exports the fold seam (`foldMsgs`), the ack primitive
  (`tagSeq`/`nextSeq`/`partitionByAck`/`ack`), and the reconciliation helper
  (`reconcile`). `@demlik/tea/prediction` is the focused leaf for just the ack +
  reconcile.
- The pure-core module imports **nothing** from the runtime; the runtime imports
  *from* it. That dependency direction is the actual decoupling.
- [`packages/tea/src/pure/import-graph.test.ts`](../../src/pure/import-graph.test.ts)
  BFS-walks the transitive import graph rooted at `@demlik/tea/pure` and **fails
  if it ever reaches `run`/the host**. That is the regression fence.

```ts
import { foldMsgs, nextSeq, partitionByAck, reconcile, tagSeq } from "@demlik/tea/pure";
```

One subtlety the worked example demonstrates: **author the shared machine as a
plain `Machine` data literal, not via `defineMachine`.** `defineMachine` lives in
the runtime root, so importing it would breach the boundary. `foldMsgs` and
`reconcile` read the update form via `formOf`, which falls back to
`detectUpdateForm` for a literal that never passed through `defineMachine` — so a
hand-authored `{ init, update }` literal folds correctly and stays runtime-free.

---

## Sequence numbers — the one invariant to hold

`nextSeq` mints **0-based** sequence numbers ("one past the highest seq in the
buffer, or 0 when empty"), and `partitionByAck` acks **inclusively**
(`seq <= lastAppliedSeq`). Two consequences a consumer must respect:

- **The "applied nothing yet" cursor is below seq 0.** Since seqs start at 0 and
  the ack is inclusive, a server that has applied nothing must report
  `lastAppliedSeq = -1`, not `0` — otherwise reconciliation falsely acks the seq-0
  input before the server ever saw it. The primitive ships this boundary value as
  the exported `NO_ACK` sentinel (with `initAck()` for the `Ack` form); consume it
  rather than re-declaring a local `-1`.
- **`nextSeq` is monotonic only while the pending buffer retains its high-water
  mark.** The client prunes only acked inputs (`seq <= lastAppliedSeq`) and always
  appends the newest, so the highest un-acked seq stays in the buffer — except if
  the buffer fully drains. A continuous predictor never hits this; a consumer that
  drains-then-predicts across a persistent connection should carry the high-water
  seq forward rather than re-minting from an empty buffer.

---

## Why this is the dogfooding payoff (epic #186)

This seam generalizes the `lastAckedSeq`-on-the-Model + `seq`-threaded-through-the-Msg
loop the (now archived) `vortex` consumer hand-rolled. The original dogfooding
consumer is **not on `main`** — it lives only in branch history — so the proof is
the in-package reference example + integration test above, exactly as the epic's
resolved questions decided. The lesson is the dogfooding lesson:
a real consumer hit a seam the substrate did not
cover (reusing the authoritative reducer on the client), and the finding became
the roadmap — `foldMsgs` (#211), the ack primitive (#212), the import boundary
(#213), `reconcile` (#214), and this worked example (#215).

---

## How to use this

| Task | Read / do |
|---|---|
| Building a predicting client over a tea machine | This doc → the worked example → import from `@demlik/tea/pure`. |
| Deciding the seam's name/signature/return shape | ADR [0006](../../.decisions/0006-client-prediction-fold-seam-and-pure-boundary.md) (it settled all three). |
| The exact API of each helper | the originating monorepo's `.glossary/TERMS.md` — `foldMsgs`, `reconcile`, `partitionByAck`, `tagSeq`, `nextSeq`, `Seq`/`SeqTagged`/`Ack`. |
| Verifying the boundary didn't regress | Run `packages/tea/src/pure/import-graph.test.ts`. |
