---
id: 0030
title: A Sub failure closes the run's own Scope, and done() reports it
status: accepted
date: 2026-10-31
tags: [tea, effect, scope, errors]
---

# 0030 — A Sub failure closes the run's own Scope, and `done()` reports it

**What this decides:** On the Effect engine, a Sub's unhandled failure stops that run by closing a child Scope the run forked for itself. The caller's Scope stays open, and `done()` reports the failure on both engines.

## Context

[Ruling R3.1 of #325](https://github.com/kamp-us/demlik/issues/325#issuecomment-5808927812)
says an unhandled Sub failure "stops the whole run and closes its Scope". The
engine did that by closing the Scope the caller provided.

Moving to Effect 4.1.1 brings in
[Effect #8473](https://github.com/Effect-TS/effect/pull/8473), released in
`4.0.0-rc.118`: `Scope.close` takes a `Scope.Closeable`, and a `Scope.Scope` read
from the service is not one. The changelog says to use a scope created by
`Scope.make` or `Scope.fork`. Whoever opened a Scope owns closing it, so a cast
would hide a contract the run was breaking. The
[owner ruled on #793](https://github.com/kamp-us/demlik/issues/793#issuecomment-6552763562)
for no cast, the run's own child Scope, and a failure that does not go quiet.

Closing the caller's Scope was also the only signal a caller had. `done()` stayed
pending forever after a Sub failure, on both engines, and `result()` read
`undefined`.

## Decision

**The run forks its own child of the caller's Scope, and a Sub failure closes only that child.** Everything else R3.1 rules stays: a Sub maps the failures it expects to Msgs, an unhandled one stops the run, and tea adds no `subFailure` slot.

**What the run acquires belongs to the run.** A Cmd handler or Sub runner that reads `Scope.Scope` gets the run's child, so a resource it acquires, or a child it spawns under that Scope, is released with the run.

**`done()` reports the failure, and gives one answer for one run.** It fails with `SubFailed` on the Effect engine and rejects with `SubFailedError` on the Promise engine, for waiting and later callers, with what the Sub failed with as `cause`. It answers only after `stop()` has finished with the queue, because a Msg the Sub sent before it failed can still reach a terminal State. `stop()` gives up on a stuck handler at `disposeTimeoutMs`, so that wait has a limit.

**Binding constraints.**

- Closing the caller's Scope still stops the run, because the child closes with its parent.
- A run in the child scope `spawn` forked closes that child scope, not one of its own. That scope is `spawn`'s to close, and `remove` and `notify` depend on it closing. `spawn` records the scope it forked, so the type stays `Closeable` with no cast.
- A State that is terminal once the queue is finished keeps its answer from `done()` and `result()`.
- `result()` stays `S | undefined`, and reads `undefined` for a run a Sub failure stopped. It is a read of the saved terminal State, and `done()` is where the reason lives.

## Consequences

Other work in a caller's Scope survives one run's Sub failure. This is published behaviour: a host that relied on the Scope closing, or on a finalizer seeing the failure as its `Exit`, must now wait on `done()`. `done()`'s Effect error type widens by `SubFailed`, which owes a minor changeset while tea is at 0.x.

A handler that wants something to outlive its run has to hold a Scope other than the one it reads from the service.

A parent run in a host's tree is not special: its Sub failure leaves the scope its workers were spawned under open, so they keep running until the host closes that scope.

On the Promise engine a `done()` with no catch now raises an unhandled rejection when a Sub fails, which ends a Node process by default. It used to wait forever.

A `stop()` by the host still leaves `done()` pending; this decision covers only the Sub failure.
