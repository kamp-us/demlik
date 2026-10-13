---
id: 0025
title: "`stop()` gives up on a Cmd handler that has not returned at `disposeTimeoutMs`, never waits for it without limit"
status: accepted
date: 2026-10-13
tags: [tea, engine, stop, teardown]
---

# 0025 — `stop()` gives up on a Cmd handler that has not returned at `disposeTimeoutMs`, never waits for it without limit

**What this decides:** when a host stops a run while a Cmd handler is still running, `stop()` waits
for that handler only up to `disposeTimeoutMs`, then finishes the shutdown without it.

## Context

`stop()` waited for the run's queue with no time limit. The queue settles only once the handlers of
the running step have returned, so one handler that never returned meant `stop()` never returned.
The Sub cleanup, the final save and `runToTerminal`'s own timeout all sat behind that wait and never
happened.

The written promises pointed two ways. The TSDoc of `disposeTimeoutMs` and a comment in
`driveToDone` said `stop()` resolving is a contract. A test and a how-to page said `stop()` drains
the queue. Nothing said what happens when a handler never returns.
[#640](https://github.com/kamp-us/demlik/issues/640) put the question to a person, with a measured
run of each case.

The founder ruled on it in
[this comment](https://github.com/kamp-us/demlik/issues/640#issuecomment-6138418781). This record
writes that ruling down. The reason it gives: a host must always be able to shut down, and a rule
that every host bounds its own handlers is a rule on paper, not a guard.

That ruling's point 3 said nothing is saved after `stop()` has returned.
[#656](https://github.com/kamp-us/demlik/issues/656) showed the sentence reads wider than tea can
hold: a store call is a Promise too, so one already under way cannot be called back. It also showed
one case where tea itself started a save late, after a `store.load()` held past the limit.
[#660](https://github.com/kamp-us/demlik/issues/660) measured both, on both engines. The founder
narrowed the sentence in
[this comment](https://github.com/kamp-us/demlik/issues/656#issuecomment-6140793623). The Decision
and the Consequences below carry that narrowing.

## Decision

**`stop()` gives up on a Cmd handler that has not returned.**

- `stop()` waits for the queue for at most `disposeTimeoutMs`. No new option sets that limit.
- When the limit passes, `stop()` reports a `DrainTimeoutNotice` to `onError` under
  `phase: "discard"`. It names the Cmd of each handler still running. Then `stop()` stops the Subs,
  runs the final save and returns.
- Work that turns up after `stop()` gave up is dropped: what the stuck handler returns later, the
  next Cmd of its step, and the Msgs already queued behind it. Each dropped Msg is a
  `DispatchDiscardedError`. No further handler starts.
- tea starts no store call after `stop()` has returned. A run stopped while its `store.load()` was
  still pending saves nothing when that load returns: its `ready` resolves with the loaded State
  installed and unsaved, and it starts no Sub and no handler. A second `stop()` returns the first
  one's result and runs no second final save.
- `runToTerminal` rejects with `TerminalTimeoutError` at its `timeoutMs` window. It starts the
  teardown and does not wait for it.

What `stop()` promises on each engine when a Cmd handler never returns:

| Engine | What `stop()` does |
|---|---|
| Promise | It cannot interrupt the handler. It waits up to `disposeTimeoutMs`, reports, finishes the shutdown and returns. The handler keeps running; its late result is dropped. |
| Effect | It interrupts every handler fiber, so the queue settles and `stop()` returns without reaching the limit. The same limit applies to a handler that cannot be interrupted, because both engines run one loop. |

**Binding constraints.**

- A sentence that says `stop()` always returns stays true. A sentence that says `stop()` drains the
  queue says "up to the limit".
- A Msg dropped this way is reported, never silent, and never folded or saved.
- A second limit option for the queue wait is a new decision.

## Consequences

- A host that stops a run to get out of a stuck handler gets its Sub cleanup and its final save.
- **Cost:** a handler `stop()` gave up on is still running after `stop()` has returned. A Promise
  cannot be cancelled. Its side effects still happen; only its result is dropped.
- **Cost:** a store call already under way when `stop()` gave up is not cancelled and can finish
  after `stop()` has returned. A store's `load` and `save` are Promises on both engines. tea starts
  no store call after that.
- **Cost:** on a plain store a save that lands late can overwrite what a newer run saved, and
  nothing reports it. A fenced store refuses it with `StoreConflictError`
  ([ADR 0017](./0017-fencing-is-an-optional-store-widening.md)). So a host that starts a new run on
  the same store after a `stop()` that gave up needs a fenced store. No option is added to the
  store contract for this.
- `stop()` makes two waits, one after the other: the queue, then the teardown work that returned a
  Promise. Each is bounded by `disposeTimeoutMs`, so the worst case before the final save is twice
  that limit.
- The final save itself has no limit. The ruling does not cover a store whose `save` never returns.
- A dispatch a caller sent before `stop()` and that was still queued behind the stuck handler
  rejects with `DispatchDiscardedError` when its turn comes. If the handler never returns, that
  dispatch never settles.
