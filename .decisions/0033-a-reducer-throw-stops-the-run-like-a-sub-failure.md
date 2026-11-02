---
id: 0033
title: A reducer throw under stop stops the run, the way a Sub failure does
status: accepted
date: 2026-11-01
tags: [tea, supervision, effect, scope, errors]
---

# 0033 — A reducer throw under `stop` stops the run, the way a Sub failure does

**What this decides:** Under the default `stop` strategy, a reducer throw starts the same stop a Sub failure starts. The Subs close, the final save runs, the run's own Scope closes, and for a run `spawn` started, `remove` and `notify` run. The host does not call `stop()`.

## Context

[#697](https://github.com/kamp-us/demlik/issues/697) made `done()` fail on a reducer throw. It left the teardown alone: the gate closed and `done()` failed, but the Subs kept running, nothing did the final save, and the run's Scope stayed open until the host called `stop()` or closed the Scope. A Sub failure, by contrast, stops the run by itself
([ADR 0030](./0030-a-sub-failure-closes-the-runs-own-scope.md)).

That left `docs/how-to/run-many-machines.md` wrong. It promises the parent a `child_stopped` Msg when a worker stops, but `spawn` runs `remove` and `notify` only when the worker's scope closes, and a reducer throw did not close it. A dead worker stayed in the host's table and its parent was never told.

The [owner ruled on #817](https://github.com/kamp-us/demlik/issues/817#issuecomment-6564370270): tear down. It matches a Sub failure, and it matches OTP, where a crashed process ends and its monitors hear. The `Supervision` comment already places these strategies beside Akka and OTP.

## Decision

**A halt stops the run.** `stop` halts the gate on a reducer throw, and the halt now asks the engine to stop the run through the one path a Sub failure takes: `stop()` on the Promise engine, closing the run's own Scope on the Effect engine. Closing that Scope runs `stop()` too, so both engines tear down through one teardown.

**The order is the teardown's.** The Msgs already in line fold first, so one that reaches a terminal State is still the answer. Then the Subs close, the disposals settle, and the final save runs once.

**On the Effect engine the run's own Scope closes with what was thrown, as a defect.** The caller's Scope stays open, as ADR 0030 rules for a Sub failure. When the run sits in a scope `spawn` forked, that scope closes, so `remove` and `notify` run.

**Binding constraints.**

- `done()` still fails with the throw, as #697 ruled. On the Effect engine it is a defect, outside `done()`'s typed channel.
- A later `stop()` by the host, or closing the caller's Scope, does nothing more: `stop()` runs its teardown once.
- Only an open run is stopped by a halt. A run a Sub failure or the host's `stop()` already started stopping is not stopped twice, and a Sub failure that already closed the run keeps its answer from `done()`.
- `escalate` and `restart` keep the run live, and a Msg with no cell is a refusal, not a reducer throw. Neither stops anything.

## Consequences

A host no longer has to call `stop()` after a failed `done()`. One that does stays correct.

A host that kept using a run's Subs or Scope between a reducer throw and its own `stop()` now finds them closed. This is published behaviour and owes a changeset, which the #697 changeset carries since neither has been released.

Between the throw and the Subs closing, a Sub can still send a Msg. The closed gate refuses it, and `onError` hears it under `"follow-up"`. The window is now the teardown's, not the host's.

With no `onError`, the default sink still rethrows the reducer throw on a later tick, which ends a Node process along with every run in it.
