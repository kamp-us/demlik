# `@demlik/tea/raft` — Raft consensus on the TEA substrate

A Raft implementation where each node is a **pure reducer** (TEA: `state → msg → [state, cmds]`).
Consensus is verified by **deterministic replay** of recorded `message × timer`
schedules — not by flaky wall-clock timing — and the same reducer runs durably as
a Durable Object grain.

| File | What it is |
|------|------------|
| `index.ts` | The pure node: role FSM, `RequestVote`, `AppendEntries` replication, commit-index advancement. No clock, no RNG, no IO. |
| `sim.ts` | The in-memory multi-node simulation driver: folds a `Schedule` of `SimEvent`s over a fresh cluster, records a `SimTrace`, replays byte-identically. |
| `safety.test.ts` | The four Raft safety invariants (§5) as fast-check property tests over generated schedules. |
| `do.ts` | The durable grain: persist-before-respond + cold-wake replay over the same reducer. |
| `demo.ts` | The runnable multi-node demo (this doc). |
| `demo.test.ts` | The demo as an integration test + its run entry point. |

## The simulation harness (`sim.ts`)

The driver owns **no wall clock, no real timers, no networking**. Time and message
ordering are entirely the *schedule* — a finite `readonly SimEvent[]` the caller hands
`runSchedule(configs, schedule)`. Five event kinds:

| Event | Move |
|-------|------|
| `{ kind: "timer", node, timer }` | Fire a node's `election` / `heartbeat` timer. |
| `{ kind: "deliver", index }` | Deliver one in-flight RPC from the pending pool (modulo pool size). |
| `{ kind: "client", node, command }` | A client submits a command to a node. |
| `{ kind: "settle", bound }` | Drain the pending pool FIFO until empty or `bound` deliveries — "let the network settle". |
| `{ kind: "partition", down }` | **Set the isolated-node set.** The transport drops every message **to or from** a down node (both directions, as a real partition severs); its timers still fire. `{ down: [] }` heals. |

Because the reducer is pure (`at` rides on the msg; `rng` injected once per node),
the same schedule re-run yields **byte-identical** cluster state — the property the
safety suite and the demo both lean on. `partition` is the only addition `#123` made
to the harness: a leader-kill / partition-heal primitive the failover demo needs.

## The demo (`demo.ts`)

`runDemo()` boots a fixed 3-node cluster and folds one scripted, deterministic
schedule through the five phases below, returning a structured `DemoResult`
(it asserts nothing and prints nothing — the test and the CLI both read it):

1. **Elect a leader** — `n0` times out, runs an election, wins a majority (term 1).
2. **Replicate + commit** — a client command (`42`) replicates to a majority, commits,
   and the next heartbeat carries the commit to the followers.
3. **Kill the leader** — `partition` isolates `n0`; all its traffic is dropped.
4. **A new leader is elected** — surviving follower `n1` times out and wins the
   surviving majority `{n1, n2}` in a **higher** term (2).
5. **Replicate → logs converged** — a client command (`77`) commits on the new leader,
   and a heartbeat converges the survivors' committed logs to `[42, 77]`.

The partitioned old leader keeps *believing* it leads (it cannot learn it was deposed
while its traffic is dropped) but sits at a strictly lower term — so the legitimate
current leader is always the **highest-term** one.

`narrateDemo(result)` renders a `DemoResult` as a readable, deterministic narrative;
`demoIsReproducible(result)` re-runs the schedule and confirms the trace is byte-identical.

### Run it

```bash
# From the repo root, or from packages/tea:
pnpm --filter @demlik/tea demo:raft
```

This runs `src/raft/demo.test.ts`, which drives the full scenario and prints the
narration. Sample output:

```
========================================================================
  @demlik/tea/raft — multi-node consensus demo (deterministic)
  cluster: n0, n1, n2  (majority = 2 of 3)
========================================================================

1. Elect a leader
  ...
  leader: n0
    n0  leader    term=1 commit=1 committed=[42]
    ...
4. A new leader is elected
  ...
    n1  leader    term=2 commit=0 committed=[]
5. Replicate on the new leader → logs converged
    n1  leader    term=2 commit=2 committed=[42,77]
    n2  follower  term=2 commit=2 committed=[42,77]
------------------------------------------------------------------------
  Summary
  first leader (pre-kill):  n0
  killed (partitioned):     n0
  new leader (post-kill):   n1
  converged committed log:  [42, 77]
  failover: OK — a NEW leader took over and the log converged
------------------------------------------------------------------------
```

Or consume it programmatically:

```ts
import { runDemo, narrateDemo } from "@demlik/tea/raft/demo"; // path within the package
const result = runDemo();
console.log(result.firstLeader, "→", result.secondLeader, result.convergedLog);
console.log(narrateDemo(result));
```

The demo doubles as the `#123` integration test — each `it` in `demo.test.ts` maps to
one acceptance criterion (elect, commit-on-majority, kill-leader + re-elect, converge,
byte-identical reproducibility).
