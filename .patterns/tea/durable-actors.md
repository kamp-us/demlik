# Durable Actors — the event-sourced virtual actor target

The host-layer north star for `@demlik/tea/do`. Where [`elm-canon.md`](./elm-canon.md)
is the theory for the **core** (a pure reducer + Cmd + Sub), this doc is the
theory for the **Durable Object host** — what `@demlik/tea/do` is *trying to
become* and how far along it already is.

Read this when you're building or extending a DO-backed machine and you want to
know which abstractions are load-bearing, which are missing, and why.

---

## What we are building, in one sentence

`@demlik/tea/do` is **event-sourced virtual actors in TypeScript on Cloudflare
Durable Objects** — the same target Akka Persistence Typed and Microsoft Orleans
hit on the JVM and .NET, expressed through TEA's pure reducer.

This is not a new paradigm. It is a named, proven one (≈15 years of prior art),
and most of the substrate to reach it already exists.

---

## The distinction that governs everything: two flavors of durable actor

There are two ways to make an actor survive time, and they are **not
interchangeable**:

| | **Resident process** (Erlang/OTP) | **Virtual actor / grain** (Orleans, Akka Cluster Sharding) |
|---|---|---|
| Lifetime | Stays alive in memory, supervised, self-driving | Always *addressable*, but only *activated* on a message; deactivated when idle |
| The process | Durable | **Disposable** |
| State | Lives in the process | **Lives in storage**; the process is rebuilt from it |
| Failure model | Supervisor restarts the process from a known state | Next activation rehydrates from durable state |

**A Cloudflare Durable Object is a virtual actor.** It is addressable by id,
single-threaded, hibernates when idle, and rehydrates from transactional storage
on the next message. The platform owns activation and placement.

The cardinal error is to program a grain as if it were a resident process —
keeping a loop alive, driving itself, fighting hibernation. The correct shape is
the opposite and is exactly what TEA already encodes:

> **Wake on a message → fold it into durable state → go back to sleep.**

`update` *is* the fold. The DO *is* the grain. The whole design is making those
two facts line up without leaks.

---

## The concept map (actor model → tea construct)

Every classical actor-model concept has a concrete home in the substrate. This
is the Rosetta stone — when prior-art docs (Orleans, Akka) use a term, this is
where it lives in our code.

| Actor-model concept | In `@demlik/tea` | Where |
|---|---|---|
| The actor / grain | The Durable Object | the DO class |
| Mailbox | `runtime.dispatch(msg)` | feeds one serial turn |
| **Single-writer principle / serial mailbox** | dispatches are tail-enqueued and drained serially; re-entrant dispatches from `interpret` queue, never recurse | `index.ts` dispatch loop |
| One turn | `update: (State, Msg) → [State, Cmd[]]` | pure, deep-frozen in dev (inv. 2) |
| Effects (the impure edge) | `Cmd` as data → `interpret` | inv. 3 |
| Timers / external stimuli | `Sub` → `DoAlarmSub` / `DoWsSub` | declarative, reconciled from state (inv. 4) |
| **Location transparency** | address by identity (`runId` / DO id), not location | host wiring |
| Grain state persistence | `Store{load, save, migrate}` → `doStore` | saved every transition |
| Activation / rehydrate-on-wake | `init(loaded, ctx)` — `null` fresh, else rehydrate | inv. 8 (the parse boundary) |
| **Reentrancy** | non-reentrant by default: the serial mailbox forbids processing a new Msg mid-turn | runtime-enforced today |
| Inter-actor messaging | `RuntimeRef<M>` — just an inbox (`dispatch`) | inv. 5 (composition by reduction) |
| Event sourcing — `state = fold(events)` | `update` folded over a Msg stream; `replay()` reconstructs purely | core |
| Effects-as-data / algebraic effects | `Cmd` | inv. 3 |

---

## Where we are today (grounded, not aspirational)

The grain skeleton is **correct and already shipped**. Verified in-tree:

- **Wake-fold-sleep, not residency.** No `keepAlive`, no `blockConcurrencyWhile`,
  no `while(true)` alarm loop anywhere in `packages/tea/src`. The pull path is the
  headline export: `deferredGateway` in `do/host.ts` — an inbound frame settles via
  `gateway.settle(callId, result)`, folds, and the DO sleeps. This is the
  grain-correct model in code.
- **Serial mailbox is real.** The dispatch loop tail-enqueues re-entrant calls
  ("enqueued onto the tail, NOT dispatched re-entrantly") and drains them in order.
  Single-writer consistency without locks — the reason a pure reducer is safe on an
  actor.
- **Snapshot persistence exists.** `snapshotEvery` / `snapshot_write` checkpoint
  state periodically (`monitored-run`, `agent`).
- **The fold already exists.** `replay()` reconstructs state from `init` + `update`
  with no Store and no interpret; `recorder` + `trace-replay` record and replay Msg
  streams. The event-sourcing *machinery* is built — it just isn't wired to durable
  persistence yet.

**Estimate: ~75% of the way to event-sourced virtual actors** (primitive 1,
durable effects, now shipped). What remains is a small set of named primitives,
below.

---

## The gap: five primitives that complete the target

Each turns an ad-hoc practice into a substrate guarantee. One is now **shipped**;
two more are already in the tea-hardening backlog wearing different hats; two are
net-new.

### 1. Durable effects — the one real tax ✅ SHIPPED

**The problem.** Durable *state* ≠ durable *effects*. State is saved every turn,
but a `Cmd` interpreted inside an activation that hibernates mid-flight is lost.

**The fix.** Make "I owe this Cmd" part of the Model — a pending-command ledger
that is re-emitted on activation and made idempotent by key. This is Akka's
`AtLeastOnceDelivery` / at-least-once + dedup, expressed in TEA.

**Shipped** (was the single highest-leverage gap; landed `221efa6`, PR #86 / issue
#67, 2026-06-23). The pending-command ledger is a first-class `@demlik/tea/do`
primitive: `packages/tea/src/do/durable-effects.ts` folds `effect_owed` /
`effect_confirmed` events (`foldLedger`), re-emits survivors on activation
(`survivingEffects`), keyed by a monotonic `DeliveryId` — exported from the `do`
barrel, test-backed. Receiver-side dedup across a resume re-fire is the
idempotent-effect brick (`idempotent-effect.ts`, #236); cold-wake resume dispatch
is `bootResume` (#235); a record→replay→assert-once parity gate guards it (#233).
The `idempotency` / `idempotent-intake` / `work-queue` bricks remain the lower-level
building blocks it assembles from.

### 2. Event-sourcing mode in `@demlik/tea/do`

**The fix.** An opt-in persistence mode: append Msgs as an immutable log +
periodic snapshot, rebuild state by `fold`. Buys audit trail + replay + time-travel
debugging almost free.

**Today.** Snapshot-only. But `replay()` + `recorder` + `trace-replay` already
*are* the fold — this is wiring existing machinery to `Store`, not new theory.
**Net-new but small.**

### 3. Projections as a first-class concept (CQRS)

**The fix.** Formalize "Model → views" (SSE, report, storage) as named
projections / read models, separate from the write model.

**Today.** `sseHub`, `subscribePort` / `Port`, `observe`, `captureLastTurn` are
the ad-hoc projection mechanisms. **Already in the backlog:** the semantic event
stream (#47) and first-class run result (#46) *are* the projection-formalization
work.

### 4. Supervision policy

**The fix.** A declared restart-from-snapshot strategy for when a reduce throws —
Akka supervisor strategies, so "let it crash" is config, not hope.

**Today.** The resilience kit (retry, circuit-breaker) covers *effect* failures;
a throw inside `update` has no declared strategy. **Blocked on #51** — you cannot
supervise failures the substrate currently swallows. Fix #51's `onError` sink
first; supervision policy plugs into that seam.

### 5. A reentrancy guard that fails to compile

**The fix.** Encode the non-reentrant rule in the type system: a reducer must
never inline-`await` a re-entrant result.

**Today.** Enforced at *runtime* (tail-enqueue) and a dev-mode thenable check
catches async `update` — but not at *compile* time. **Net-new at the type level**;
relates to the dispatch-settle-depth seam (#50). Per house rule (make the wrong
path fail to compile), this is the guard worth having.

---

## Reconciling with `vision.md` non-goals

`vision.md` lists, as **v1** non-goals: a devtools time-travel debugger, and
DO-side WebSocket Subs ("deferred indefinitely"). This doc deliberately reopens
both — **scoped to the DO host, not the core**:

- **Time-travel** stops being a UI feature and becomes a *free consequence* of
  event-sourcing mode (primitive 2). The non-goal stands for the core; the DO host
  gets it as a byproduct of durable persistence.
- **DO-side WebSocket** is now load-bearing — `DoWsSub` exists and the gateway
  bridges WS frames. The "fundamentally different hibernation lifecycle" the
  non-goal warned about is precisely what the virtual-actor model resolves.

These are evolutions, not reversals: the core stays a pure reducer; the *host*
grows toward Akka-Persistence-Typed parity.

---

## Prior art to study, ranked by closeness

1. **Akka Persistence Typed (JVM/Scala — Lightbend)** — the closest prior art.
   `EventSourcedBehavior` = command handler → events → state fold + snapshots +
   recovery. "TEA on a durable actor," named and battle-tested. Also: Cluster
   Sharding (route to an actor by entity-id ≈ how DOs shard), Streams (≈ Subs),
   `AtLeastOnceDelivery` (≈ primitive 1). **Read this one if you read nothing else.**
2. **Microsoft Orleans (.NET)** — virtual actors / grains. Grain lifecycle
   (activate/deactivate), grain persistence, explicit `[Reentrant]` semantics. The
   docs read like our own runtime; the reentrancy chapter is primitive 5 in someone
   else's words.
3. **Erlang/OTP** — `gen_statem` (a state-machine behavior, very TEA), `gen_server`,
   supervision trees. Mine the *behaviors and supervision strategies* (primitive 4) —
   but do **not** import the resident-process model.
4. **Cousins** — Temporal (durable execution, signals, deterministic replay), Dapr
   Actors + Workflow, Restate / DBOS / Inngest / CF Workflows, Service Fabric
   Reliable Actors.

**Search-term spine:** *event-sourced actor · virtual actor pattern · Akka
Persistence Typed EventSourcedBehavior · Orleans grain reentrancy · CQRS event
sourcing projections · durable execution deterministic replay · saga /
compensating actions.* Joe Armstrong's thesis — *Making reliable distributed
systems in the presence of software errors* — for the "let it crash" foundation.

---

## How to use this doc

- **Building a DO machine:** read the concept map; name your grain's mailbox,
  fold, and projections before writing code.
- **Extending the substrate:** the five primitives are the roadmap. Primitive 1
  (durable effects) is **shipped** — import it, don't rebuild it (`durable-effects.ts`).
  Check the backlog link before starting the rest — two more are already in flight.
- **In review:** "is this programming the grain as a resident process?" is a
  load-bearing question. Fighting hibernation is the tell.

---

## Status

Net: we are not inventing a paradigm — we are re-implementing event-sourced
virtual actors (Akka Persistence + Orleans grains) in TypeScript on Durable
Objects, and the grain skeleton already lines up. The remaining work is the
named primitives above — one (durable effects) shipped, four to go.

Tracked in the backlog as the tea-hardening epic's substrate wave. This doc is
the authority for *what the DO host is becoming*; [`elm-canon.md`](./elm-canon.md)
remains the authority for the core reducer.
