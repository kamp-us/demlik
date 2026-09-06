# `@demlik/tea/workflow` — durable Saga workflows on the TEA substrate

A Temporal-style durable-workflow engine where the workflow is a **pure reducer**
(TEA: `state → msg → [state, cmds]`). A workflow is an ordered sequence of **steps**;
each step is an **activity** (a side effect) that may evict the actor mid-flight.
The engine composes two substrate primitives — the event-sourced store ("state
survives eviction") and the `do/` pending-effects ledger ("an owed effect survives
eviction", #67) — into a third: a reducer over a workflow's progress where each step
is a durable owed effect and the next step is decided only after the previous one's
result is folded back in. A replay of the event log re-decides every step identically.

A step may declare a **compensation** — the inverse activity that undoes it. On a
downstream failure the engine PIVOTS into compensation and runs the committed steps'
compensations in **strict reverse order** (the Saga pattern). The reducer reads no
clock and no RNG; all impurity lives in the consumer's *interpret cell* — the thing
that actually performs the activity `Cmd` and dispatches its result `Msg`.

**Boundary with [`@demlik/tea/saga`](../saga/index.ts) — the compensation test.**
Here `WorkflowStep.compensation` is *optional*: an irreversible step (a sent email)
is skipped during the unwind, and the run still reaches a terminal state. Saga's
`SagaStep<D, U>` *requires* both `do` and `undo` — a step without its inverse is
unrepresentable. Pick by the test: **every step must be reversible → saga; some
steps are irreversible but the run must finish → workflow.**

| File | What it is |
|------|------------|
| `index.ts` | The pure engine: `WorkflowStep` (+ optional `compensation`), the `WorkflowState` union, `createWorkflow`'s verbs (`init`, `onActivityOk/Err`, `onCompensationOk/Err`), `survivingActivities` (cold-wake re-emit), and `foldWorkflow` (the replay fold). No clock, no RNG, no IO. (#124 core + #125 compensation.) |
| `workflow.test.ts` | The forward core (#124): sequencing, idempotency-by-delivery-id, replay determinism. |
| `compensation.test.ts` | The Saga rollback (#125): reverse-order unwind, the `failed` / `failed_compensated` / `compensation_failed` terminals. |
| `do.ts` / `do.test.ts` | The durable DO grain (#126): persist-before-deliver + cold-wake replay + re-emit over the same reducer. |
| `demo.ts` | The runnable Saga demo (this doc). |
| `demo.test.ts` | The demo as an integration test + its run entry point. |

## The state machine (`index.ts`)

`WorkflowState` is a discriminated union on `status`, so invalid states are
unrepresentable — the in-flight effect lives ONLY on the active variants:

| Status | Meaning |
|--------|---------|
| `running` | A forward activity is in flight; `completed` holds the forward history. |
| `completed` | Every step ran; `output` is the final step's result. Terminal. |
| `failed` | The FIRST activity failed (nothing committed) — empty rollback. Terminal. |
| `compensating` | A forward failure pivoted the workflow into rollback; one compensation is in flight, walking `completed` in strict reverse. |
| `failed_compensated` | Forward failure, then fully unwound (every committed step compensated, in reverse). Terminal. |
| `compensation_failed` | A compensation itself bounced mid-unwind — visible, partially-unwound terminal state to reconcile by hand. |

The failure path, mirroring `@demlik/tea/saga`'s phases:

```
running ──activity_err with completed steps──▶ compensating ──all compensations ok──▶ failed_compensated
running ──activity_err with NO completed steps──▶ failed                 (empty rollback)
compensating ──a compensation itself fails──▶ compensation_failed
```

## The demo (`demo.ts`)

The canonical Saga — **`order → charge card → reserve inventory → ship`** — each
committed step declaring the compensation that undoes it (`cancel order`,
`refund charge`, `release inventory`, `cancel shipment`). A fixed, deterministic
**activity performer** maps each dispatched activity to a scripted success/failure;
the demo drives two scenarios:

1. **Happy path** — all four activities succeed → the workflow settles `completed`,
   carrying the final step's output (`ship#ok`).
2. **Forced failure** — `ship` fails after `order`/`charge`/`reserve` committed → the
   engine pivots into compensation and runs the committed steps' compensations in
   **strict reverse** (`release inventory`, then `refund charge`, then `cancel order`)
   → settles `failed_compensated`. `ship` never committed, so it owns no completed
   step and is never compensated.

`runDemo()` drives both scenarios against a fresh workflow each and returns a
structured `DemoResult` (it asserts nothing and prints nothing — the test and the
CLI both read it). `narrateDemo(result)` renders it as a readable, deterministic
narrative; `demoIsReproducible(result)` re-runs both scenarios and confirms the
result + trace are byte-identical.

The demo drives the published verbs directly: each verb returns the dispatch Cmd(s)
carrying their #67 delivery id; the demo performs each one and routes its result Msg
(echoing that exact id) back into the matching verb — exactly as a host's interpret
cell would, and exactly how `foldWorkflow` replays a log.

### Run it

```bash
# From the repo root, or from packages/tea:
pnpm --filter @demlik/tea demo:saga
```

This runs `src/workflow/demo.test.ts`, which drives both scenarios and prints the
narration. Sample output:

```
========================================================================
  @demlik/tea/workflow — Saga rollback demo (deterministic)
  saga: order → charge → reserve → ship
========================================================================

Happy path — every step succeeds
  committed (forward):    [order → charge → reserve → ship]
  compensated (reverse):  [—]
  final status:           completed
  output:                 ship#ok
  trace:
    ✓ did: place the order      → running
    ✓ did: charge the card      → running
    ✓ did: reserve inventory    → running
    ✓ did: ship the package     → completed

Forced failure — ship fails, the saga rolls back
  committed (forward):    [order → charge → reserve]
  compensated (reverse):  [reserve → charge → order]
  final status:           failed_compensated
  trace:
    ✓ did: place the order      → running
    ✓ did: charge the card      → running
    ✓ did: reserve inventory    → running
    ✗ FAILED: ship the package     → compensating
    ↩ undid: release the inventory → compensating
    ↩ undid: refund the charge    → compensating
    ↩ undid: cancel the order     → failed_compensated

------------------------------------------------------------------------
  Summary
  happy path:        completed (output ship#ok)
  forced failure:    failed_compensated
  committed before failure: [order → charge → reserve]
  rolled back (reverse):    [reserve → charge → order]
  reverse-order rollback: OK — compensations ran in strict reverse of the committed steps
------------------------------------------------------------------------
```

Or consume it programmatically:

```ts
import { runDemo, narrateDemo } from "@demlik/tea/workflow/demo"; // path within the package
const result = runDemo();
console.log(result.rollback.committed, "→ rolled back:", result.rollback.compensated);
console.log(narrateDemo(result));
```

The demo doubles as the `#127` integration test — each `it` in `demo.test.ts` maps to
one acceptance criterion (happy path → `completed`, forced failure → reverse-order
compensation → `failed_compensated`, byte-identical reproducibility).
