---
id: 0041
title: A store's save receives the applied message, as an optional argument
status: accepted
date: 2026-11-20
tags: [tea, persistence, engine, fencing]
---

# 0041 — A store's save receives the applied message, as an optional argument

**What this decides:** `Store<S>.save(state, msg?)` and `FencedStore<S>.saveFenced(state, expectedVersion, msg?)` receive the Msg whose transition produced `state`. The engine awaits the save before it starts that transition's Cmds, so a store that records the Msg has it durable first. Both arguments are optional for every implementor.

## Context

A host that fed its message log from `runtime.observe` wrote each Msg after the Cmds had run, because observers hear a transition after its effects ([ADR 0003](./0003-do-targets-event-sourced-virtual-actors.md), [ADR 0038](./0038-engine-owned-durable-log.md)). An activation lost inside a model call left no record that the call had started: the wake rebuilt the State from the log and found the run idle ([#989](https://github.com/kamp-us/demlik/issues/989)). The loop already holds the Msg when it saves: `commit(next, msg, cmds)` calls `store.save(next)` and then runs the Cmds. [ADR 0017](./0017-fencing-is-an-optional-store-widening.md) kept `Store<S>` untouched so no implementor broke. ADR 0038 gives the engine-owned admission, atomic step and recovery to a `LoggedStore`, and the snapshot `save` is never called on one.

## Decision

**Pass the applied Msg through the one save the engine already makes, and keep it optional.**

1. `save(state: S, msg?: unknown)`. The store is the persistence boundary, so the argument is `unknown` and no generic spreads across the machine and run types. A one-argument implementation still compiles and ignores it.
2. `saveFenced(state, expectedVersion, msg?)` takes the same context after the version. The fencing wrapper forwards it, and the version comparison and its error are unchanged. A two-argument `FencedStore` still compiles.
3. The Msg is the one that was folded. Boot and the final flush at `stop()` have none, and a Msg that folds to `null` (no cell, refused by identity) is not saved at all, so a store never sees an event for a transition that did not happen.
4. A save that rejects stops the transition before its Subs, listeners and Cmds, as before, and the Effect engine's failure wrapper carries the original cause.
5. Observers, `subscribe` listeners and Cmds keep their order: the listener hears the State after the save and before the first Cmd, and `observe` hears the transition after its Cmds.

**Binding constraints.**

- `Store.save` context is not a second `LoggedStore` protocol. A store with `logged: true` keeps its own admission and commit path (ADR 0038), and ADR 0028 and ADR 0039 keep their default and opt-in `init` contracts.
- tea invents no skip policy. A wrapper that skips a save for a State also skips the Msg the log would need, so a wrapper over a message-recording store must not skip.

## Consequences

- A store written before this change keeps compiling and behaving as it did. It gains nothing until its author reads the second argument.
- A store that records the Msg turns the engine's save-before-effects order into a write-ahead log. `doEventSourcedStore` does so: it writes the event, its meta cell and any due snapshot in one transaction inside `save`. Its public `append`, and the `runtime.observe` wiring that fed it, are removed in the same change, because keeping both would record a Msg twice.
- That store is still replay of an applied-message log. Its logs, meta cells and snapshots keep their bytes and read unchanged. A `LoggedStore` keeps admission before reduction and committed State, and is not combined with it.
- The `Store` contract in ADR 0017 point 1 ("`Store<S>` is untouched") is amended only by this optional argument. Everything else in 0017 stands.

## Records

no vocabulary impact
