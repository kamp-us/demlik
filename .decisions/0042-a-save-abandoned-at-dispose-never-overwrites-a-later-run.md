---
id: 0042
title: A save abandoned at dispose never overwrites a later run, checked once at the store's write point
status: accepted
date: 2026-11-20
tags: [tea, persistence, engine, stop, fencing]
---

# 0042 — A save abandoned at dispose never overwrites a later run, checked once at the store's write point

**What this decides:** `doEventSourcedStore` refuses a write that was called before a later run loaded the same log, at the moment the write would happen, with `StoreConflictError`. The engine does nothing new: it still cannot call a save back.

## Context

[ADR 0025](./0025-stop-gives-up-on-handlers.md) lets `stop()` give up on a stuck handler at `disposeTimeoutMs`, and records that a store call already under way is not cancelled and can land after `stop()` returned. With write-ahead saves ([ADR 0041](./0041-store-save-receives-the-applied-message.md)) a call under way is an event append. A host that resets a durable agent builds the next run on the same storage in the same isolate, and the stopped run's save, waiting behind an earlier write or at the transaction, then lands with a sequence number it computed before the later run loaded. It writes over an event the later run wrote, and the log forks without a word ([#989](https://github.com/kamp-us/demlik/issues/989)). A fenced store already refuses that save ([ADR 0017](./0017-fencing-is-an-optional-store-widening.md)), but the event store is not a `FencedStore`.

## Decision

**One generation per log, advanced by a load and compared at the write point.** The engine cannot recall a call, and a host-side wait would be a second `stop()` limit. So the store that owns the write asks the one question there.

1. A log is the storage object and the log's meta cell. A `load()` takes the log: it advances the log's generation in this isolate and the loading store holds the new one.
2. A `save` or `snapshotNow()` carries the generation its store held when it was called. First thing inside the storage transaction, the write compares it with the log's current generation. A later load has moved it, so the write throws `StoreConflictError(issuedUnder, current)` and touches no cell. The in-memory counters do not move, as for any failed write.
3. Whether the engine gave up on the save is not an input. A save with no later load behind it lands, abandoned or not, because it is the newest State.
4. The decision is the table in `src/do/save-fence.ts`: one state × event table (`issued`, `superseded`, `admitted`, `refused` by `takeOver`, `reach`) and one interpreter. A new case is a row.

| state \ event | `takeOver` (a later run loads) | `reach` (the write point) |
| --- | --- | --- |
| `issued` | `superseded` | `admitted`, write |
| `superseded` | `superseded` | `refused`, throw |
| `admitted` | `admitted` | `admitted` |
| `refused` | `refused` | `refused` |

**Binding constraints.**

- Nothing is written to storage for the fence. A log written before this change reads unchanged, and a log written after it reads the same in older code.
- The generation lives in the isolate. A Durable Object runs one isolate at a time, and the writes of a dead isolate die with it, so cross-isolate fencing stays with `FencedStore` ([ADR 0017](./0017-fencing-is-an-optional-store-widening.md)).
- Tests walk the table one cell at a time, then drive real runs with `disposeTimeoutMs: 0`.

## Consequences

- A stopped run's late save, and its late `snapshotNow()`, are refused at the write point, and the later run's State stays. The refused save rejects its dispatch with `StoreConflictError`, and a Msg with no caller reaches `onError` as `"follow-up"`.
- Every `load()` advances the generation, one on the same store included, and a call carries the generation it was called under. So a store a host hands to each run it rebuilds is covered, and a second `load()` refuses the same store's earlier call too.
- A later `load()` that never saves still refuses an earlier store's late save. The later run has taken the log.
- A custom plain store that waits between being called and writing is not covered: tea cannot reach into it. It checks at its own write point or is a `FencedStore`. `doStore` builds its `put` inside the call and has no wait to land from.
- The host's lifecycle table does not change: a replacement run still builds after the teardown it waited for, and the fence is what makes that safe when the teardown gave up.

## Records

no vocabulary impact
