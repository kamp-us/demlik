---
id: 0038
title: Engine-owned durable log
status: accepted
date: 2026-11-16
tags: [tea, persistence, recovery]
---

# 0038 — Engine-owned durable log

**What this decides:** A run on a `LoggedStore` persists admission and atomic transition records through tea's shared engine. A tea-owned factory builds that capability from a Journal and schemas, with optional fencing through a FencedJournal.

## Context

[ADR 0003](./0003-do-targets-event-sourced-virtual-actors.md) distinguishes durable
State from owed work. Recording messages from an observer happens after the
handler starts and cannot preserve an input when the activation crashes there.
Independent State, owed-work and applied-marker writes also leave partial steps.

[ADR 0028](./0028-restored-init-may-resume.md) permits restored initialization to
emit resume commands. A logged run already knows which commands it owes, so
running initialization again would create a second owner of recovery. A reducer
that was supervised into restart State cannot be recovered by replaying that
reducer's raw message either.

## Decision

**The existing engine owns durable admission, atomic transition commits and
owed-delivery recovery when the store exposes `logged: true`.** `Store<S>` and
the code path for a store without a log retain their existing behavior.

The neutral contract sits beside `Store`. The pure log rules own deduplication,
committed State, checkpoints and delivery high-water; the factory parses records,
maintains their read model and selects streams, while the Journal assigns storage
positions and preserves opaque text. Adapters translate storage operations.
The engine and handlers communicate through asynchronous store and handler calls; initialization and reduction remain synchronous and pure. There
is one transition tail shared by the Promise and Effect engines.

The tea-owned `eventSourcedStore` interprets pure write values through a Journal.
A transition's State, owed work, source receipt and automatic checkpoint are one
atomic append batch in the log stream. Manual checkpoints append to a sibling
stream. The first store call recovers the projection and read model from both
streams; loaded calls use acknowledgements without reading, and any append
failure invalidates the cache so the next call recovers both streams and their
fencing heads. The factory installs acknowledged decoded values, and discards
its cache after any failure at or after append begins. Ignored and rejected
messages save receipts without State, commands or timers. The engine never calls
the inherited snapshot `save` on a log store.

**Binding constraints.**

- Append a message before reduction. Caller, generated and answer IDs occupy
  separate namespaces. First accepted payload wins, and a repeated caller ID
  changes State once.
- Commit a birth before handing out its work. A committed birth calls `init`
  once; a wake never calls it. This scopes ADR 0028 to stores without a log.
  An uncommitted birth may recompute pure initialization after a crash.
- Recover State from committed State fields, using a valid checkpoint and its
  tail when available, including the State produced by supervised restart.
  Never run a committed reducer again. Consume pending sources before handing
  out surviving deliveries; recovery executes no historical command or Sub.
- With a log store, the program sees Msg, State and Cmd values as the store
  decoded them from the written bytes, both live and after wake. Refuse a
  payload before writing only if encoding fails or its decoded form fails its schema.
- The store assigns positive safe-integer delivery IDs, increasing monotonically
  with gaps permitted. Retain the high-water after confirmation. Every handout
  receives its persisted ID in a fresh invocation context.
- Admit a delivery's answers before confirming it. Await its registered detached
  work for confirmation without blocking the next command's handler. Missing,
  throwing, interrupted and contract-invalid handlers remain owed.
- Only a failed logged mutation poisons that activation's later writes and work.
  Existing snapshot save-failure recovery remains unchanged. Malformed or legacy
  log bytes are refused without overwriting history. A schema-rejected derived
  checkpoint falls back to retained committed records.
- Manual and automatic checkpoints share a baseline of applied source messages.
  Ignored and rejected receipts do not advance the cadence. Checkpoints copy
  State's stored form, retain message and confirmation receipts, and do not
  advance writer revision.
- Timers remain on their existing path; engine log commits carry `timers: []`.
  Journal-backed logs can use memory and file drivers, with explicit opt-in
  fencing; Durable Object integration, deferred outcome, external delivery
  confirmation, agent integration and replacement host wrappers remain separate
  slices.
- [ADR 0025](./0025-stop-gives-up-on-handlers.md) continues to bound stop on both
  engines. A handler that is abandoned remains owed; its late results cannot
  start another store call after stop returns. This slice makes no new clean
  per-call teardown guarantee.

## Consequences

A fresh factory over retained journal records recovers admitted inputs and
re-hands unconfirmed work with the same delivery IDs. Delivery is at least once: a
receiver must atomically accept its business key with the external effect to
count that effect once. The receiver helper's marker alone does not close the
external effect's crash window.

Plain journal-backed stores require one active writer per stream throughout the loaded activation; concurrent plain writers can corrupt history.
Fencing is explicitly opted into. Logs retain full history and receipts. Memory
and file drivers share the journal kit and durable assertions; file tests prove
controlled interruption, without a power-loss guarantee. Durable Object
integration and logged timer decisions remain separate slices. Existing `/do`
ledger import paths keep their current owner.
