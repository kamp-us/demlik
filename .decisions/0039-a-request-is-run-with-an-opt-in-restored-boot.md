---
id: 0039
title: A request-scoped activation is `run` with an opt-in restored boot, never a second engine entry
status: accepted
date: 2026-11-19
tags: [tea, engine, boot, fencing, persistence]
---

# 0039 — A request-scoped activation is `run` with an opt-in restored boot, never a second engine entry

**What this decides:** `run` takes an opt-in `boot: "restored"`. With a State loaded from the store, `init` folds it, none of `init`'s Cmds run, and the run saves only when a transition commits. Without the option nothing changes.

## Context

A host that sleeps when idle and wakes on its next Msg boots on every wake, so `init`'s Cmds run on every wake ([#964](https://github.com/kamp-us/demlik/issues/964)). [ADR 0028](./0028-restored-init-may-resume.md) lets restored init resume work with no host latch, and that is the default. A request handler over one SQL row is the same shape with a second cost: `boot()` ends in `commit(initial, undefined, cmds)` and `teardown()` saves once more, so on a fenced store every request writes twice before it does any work, and a request that changed nothing can make a legal one lose ([#975](https://github.com/kamp-us/demlik/issues/975)). [ADR 0017](./0017-fencing-is-an-optional-store-widening.md) point 5 makes the boot save how a long-lived run takes the fence. [ADR 0038](./0038-engine-owned-durable-log.md) says a separate entry beside the engine would be a second owner of recovery, and that a wake on a log never calls `init`.

## Decision

**A request-scoped activation is the existing `run` with an opt-in restored boot.**

1. `boot?: "restored"` on the Promise and Effect engines' `run`. Absent, every promise of 0017 and 0028 holds.
2. With a loaded State, `init` still folds it and none of its Cmds run. Boot writes nothing while `init` returns the loaded State itself. A different State is a boot transition: it is saved and still runs no Cmds, so a terminal State from `init` crosses the persistence boundary first (0028).
3. A transition still saves before its Cmds run.
4. A run started with the option skips the save at `stop()` only while the current State is `Object.is` the one the store is known to hold: the loaded State, then the last State a save accepted. A refused save clears that knowledge, because the store may have written before it failed, and the run then flushes exactly as a default run does.
5. With nothing loaded, `init(null)` runs, its Cmds run and its State is saved. That save is the insert of a row store.
6. A store with a log and a run with no store are unchanged. A wake on a log already writes nothing at boot and never calls `init`.
7. There is no second engine entry. The Cmds stay with the engine.

## Consequences

- A machine whose `init` marks work in flight and relies on `init`'s Cmds to finish it must not be started with the option. The host that passes it says the Cmds already ran.
- A run on a fenced store that changed nothing moves no version, so it cannot make another writer's save lose. A lost fence reaches the host as the rejection of the dispatch whose save was refused, or of `ready` for a birth race. A run whose saves were all accepted, or that changed nothing, reports no `"stop-save"`; one whose last save was refused flushes at `stop()` and reports `"stop-save"` if that fails too, as a default run does.
- ADR 0017 point 5 still holds for long-lived runs: the newer starter takes the fence at its boot save.
- A fenced Store over one SQL row ([#975](https://github.com/kamp-us/demlik/issues/975)) builds on this.

## Records

no vocabulary impact
