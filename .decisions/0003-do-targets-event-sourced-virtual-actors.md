# 0003 — The DO host targets event-sourced virtual actors

- **Status:** Accepted
- **Date:** 2026-06-23
- **Scope:** the `@demlik/tea/do` subpath and its roadmap — `doStore`,
  `DoSub` (alarm/ws), `do/host.ts` (`deferredGateway`, `sseHub`,
  `agentIsResumable`, `captureLastTurn`), and the substrate primitives the host
  still needs. Records the *target* ADR [0002](./0002-do-host-layer.md)'s host
  layer is building toward. The long-form canon is
  [`.patterns/tea/durable-actors.md`](../.patterns/tea/durable-actors.md).

## Context

ADR [0002](./0002-do-host-layer.md) committed to a *host layer, not a framework*
for running a `tea` machine inside a Durable Object. It left the larger question
open: **what is that host converging toward?** Without a named target, each
consumer (`sr-graph-tea` first) re-derives the wiring, and the backlog of host
seams reads as a pile of unrelated papercuts rather than one trajectory.

There are two distinct flavours of durable actor, and conflating them is the
governing error:

- **Resident process** (Erlang/OTP) — the actor stays alive in memory,
  supervised, self-driving. The process is durable.
- **Virtual actor / grain** (Orleans, Akka Cluster Sharding) — always
  *addressable* but only *activated* on a message, deactivated when idle; state
  is durable, the process is **disposable**.

A Cloudflare Durable Object is a **virtual actor**: addressable by id,
single-threaded, hibernates when idle, rehydrates from transactional storage.
Programming it as a resident process — keeping a loop alive, fighting
hibernation — is the cardinal mistake. The correct shape is *wake on a message →
fold into durable state → sleep*, which is exactly what `tea`'s `update` already
expresses.

## Decision

`@demlik/tea/do` targets **event-sourced virtual actors** — the same model
Akka Persistence Typed (`EventSourcedBehavior`) and Microsoft Orleans (grains)
hit on the JVM/.NET, expressed through TEA's pure reducer on Durable Objects.

Concretely, this names five substrate primitives as the roadmap to that target,
each with current status (full detail and grounding in the canon):

1. **Durable effects** — a pending-Cmd ledger re-emitted on activation,
   idempotent by key (Akka `AtLeastOnceDelivery` in TEA). *Net-new — the one
   real tax: durable state ≠ durable effects.*
2. **Event-sourcing persistence mode** in `tea/do` — append-only Msg log +
   snapshot, rebuild by fold. *Net-new but small: `replay`/`recorder`/`trace-replay`
   already are the fold; wire it to `Store`.*
3. **Projections / CQRS** — Model → named views (SSE, report, storage). *Already
   in the backlog as the semantic event stream + first-class run result.*
4. **Supervision policy** — declared restart-from-snapshot on a reducer throw
   (Akka supervisor strategies). *Blocked on closing the failure-swallowing seam
   first — you cannot supervise failures the substrate hides.*
5. **A compile-time reentrancy guard** — the non-reentrant reducer rule (today
   enforced only at runtime via the serial mailbox) encoded in types. *Net-new
   at the type level.*

This reopens two `vision.md` v1 non-goals — devtools time-travel and DO-side
WebSocket subs — **scoped to the host, not the core**: time-travel becomes a
free consequence of primitive 2, and `DoWsSub` is already load-bearing through
the gateway. The core stays a pure reducer; the *host* grows toward
Akka-Persistence-Typed parity.

## Consequences

- **The host backlog is now one epic, not scattered tickets.** The open `tea:`
  issues map onto either an existing invariant fix or one of the five primitives;
  the substrate wave (durable effects, event-sourcing mode, reentrancy guard) is
  net-new work this ADR authorizes filing.
- **Prior art is named, so we stop reinventing.** Akka Persistence Typed is the
  closest target to study; Orleans for grain/reentrancy semantics; OTP for
  supervision strategies (the behaviours, never the resident-process model).
- **"Fighting hibernation" becomes a review smell.** A PR that keeps a loop
  alive or drives the DO itself is presumptively wrong — the canon's review
  question ("is this programming the grain as a resident process?") is now an
  ADR-backed gate.
- **Cost:** durable effects is a real tax (a ledger slice in every host Model);
  event-sourcing mode adds a persistence path alongside snapshot-only. Both are
  opt-in, so existing snapshot-only machines are unaffected.
