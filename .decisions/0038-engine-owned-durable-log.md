---
id: 0038
title: Engine-owned durable log
status: accepted
date: 2026-11-16
tags: [tea, persistence, recovery]
---

# 0038 — Engine-owned durable log

**What this decides:** A run on a `LoggedStore` persists admission and atomic transition records through tea's shared engine. This slice ships that capability on a single-writer, caller-owned memory Map.

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

The neutral contract sits beside `Store`. The log format owns validation,
namespace and admission-ID encoding, sequences, deduplication, committed-State
projection, checkpoints and delivery high-water. Adapters translate storage
operations. The engine and handlers communicate through asynchronous store and
handler calls; initialization and reduction remain synchronous and pure. There
is one transition tail shared by the Promise and Effect engines.

The memory adapter serializes each protocol record into its own namespaced cell
in a caller-owned `Map<string, string>`. Cold recovery validates retained
records once and builds admission, receipt and checkpoint indexes. An active
writer validates and serializes only its new record, without scanning history.
Each mutation reads, decides and writes synchronously before yielding.
A transition uses one Map mutation containing its State, every
newly owed command, an applied/ignored/rejected source receipt and any automatic
checkpoint. The engine never calls the inherited snapshot `save` on a log store.

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
- State and Cmd payloads must survive JSON serialization and schema validation
  unchanged. Refuse lossy or normalized payloads before writing so a delivery
  has the same value live and after wake. Message normalization remains allowed.
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
  Ignored and rejected receipts do not advance the cadence. Checkpoints retain
  message and confirmation receipts and do not advance writer revision.
- Timers remain on their existing path; engine log commits carry `timers: []`.
  This slice adds no fenced log, file or Durable Object driver, deferred outcome,
  external delivery confirmation, agent integration or replacement host wrapper.
- [ADR 0025](./0025-stop-gives-up-on-handlers.md) continues to bound stop on both
  engines. A handler that is abandoned remains owed; its late results cannot
  start another store call after stop returns. This slice makes no new clean
  per-call teardown guarantee.

## Consequences

A fresh driver over a copy of the Map can recover admitted inputs and re-hand
unconfirmed work with the same delivery IDs. Delivery is at least once: a
receiver must atomically accept its business key with the external effect to
count that effect once. The receiver helper's marker alone does not close the
external effect's crash window.

The memory adapter requires one writer per namespace and retains full history
and receipts. It is a serialized process-memory durability contract, not a disk
or deployed-host guarantee. File storage, Durable Objects, fencing and logged
timer decisions need separate slices. The existing `/do` ledger import paths
remain re-exports of the neutral owner, so this slice removes no public API.
