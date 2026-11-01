---
id: 0031
title: A fenced run must pass an onError, held by its type
status: accepted
date: 2026-10-31
tags: [tea, store, errors]
---

# 0031 — A fenced run must pass an `onError`, held by its type

**What this decides:** a run on a fenced store that passes no `onError` does not compile, and the default sink does not change. **Amended by [#810](#amendments):** where the fenced type was thrown away, the run is refused at start instead.

## Context

With no `onError`, the default sink rethrows on a fresh macrotask. That ends a Node process and every run in it.

A host that moves runs between processes by lease loses a fence as a matter of course. In a live experiment with three processes, a frozen owner woke up, called `stop()`, and its final save threw `StoreConflictError`. No `onError` was set, so the process died ([#728](https://github.com/kamp-us/demlik/issues/728)).

`stop()` is not the only way there. The `fencing` built-in refuses at the run's next save, and a Msg from a Sub or a Cmd has no caller to reject at, so it reports under `"follow-up"`. A failing Sub on an unfenced run reaches the same default under `"sub"` ([#697](https://github.com/kamp-us/demlik/issues/697)).

Three answers were on the table:

- **A: warn on a stop-save conflict only.** It leaves `"follow-up"` and `"sub"`. It would also need a new notice class, because the default branches on the error's class and never on the phase.
- **B: require an `onError` at the type for a fenced run.** The mistake stops compiling, and a real second writer stays loud. It does nothing for a failing Sub on an unfenced run.
- **C: the default logs and never rethrows.** One machine can no longer end the process. A failure nobody reads a log for goes unseen.

## Decision

**Route B**, by the [owner's ruling on #728](https://github.com/kamp-us/demlik/issues/728#issuecomment-6551510296): "With no `onError`, a fenced run must pass one, enforced by its type. A failing Sub on an unfenced run keeps today's behaviour."

- **`StoreAndOnError<S>` holds the rule.** It is a union of two shapes: no store or an `UnfencedStore<S>` with an optional `onError`, or any store with a required `onError`.
- **Every way of starting a run takes it.** That is `run` on both engines, `RunOptions`, `useMachine`, `createAgentHost`, a defined agent's `run`, and `agentTool`. The last four had no `onError` to pass, so they gained one. Without it they could not start a fenced run at all under this rule.
- **`defaultOnError` does not change.** It warns on a `RuntimeDiscardNotice` and rethrows everything else, a failing Sub on an unfenced run included.
- **The run's own behaviour does not change.** [ADR 0017](./0017-fencing-is-an-optional-store-widening.md) stands: a conflict is a throw, and the loser stops where it stands. This decides only what happens to the process.

**Binding constraints.**

- A fenced store must not gain a path to a run with no sink at the type.
- The default sink must not grow a case for `StoreConflictError`. One that reaches it came through a throwing sink, or from a store that does not say it is fenced, and both should be loud. (Before the #810 amendment, a store whose fenced type was thrown away also got here.)

## Consequences

- A host that passes a fenced store with no `onError` gets a compile error. ADR [0016](./0016-removal-lands-in-a-minor-at-0x.md) lets that land in a minor at 0.x.
- `AgentHostConfig` is now a type alias, not an interface, so nothing can `extends` it. `AgentHostWiring` is the interface part.
- **The type reads the store's declared type.** A fenced store assigned to a variable typed plain `Store<S>` compiles with no `onError`, and a JavaScript caller has no type to hold it either. This ADR first left that as a known limit; the amendment below closes it with a refusal at start.
- A host running several unfenced machines in one process still loses them all to one failing Sub, unless it passes an `onError`. The docs for `onError` say so.

## Amendments

- **#810 — a run on a store fenced at runtime, with no `onError`, is refused at start, on both engines (2026-11-01).** Option A, by the [owner's ruling on #810](https://github.com/kamp-us/demlik/issues/810#issuecomment-6564370065): "A run on a store fenced at runtime with no `onError` is refused at start, on both engines."
  - **What counts as fenced** is what the `fencing` built-in already reads: `isFencedStore`, the store's `fenced: true` field. The declared type plays no part, so a widened store and a JavaScript caller are held the same way.
  - **Where it is checked.** Each engine's `run` reads the caller's own `onError`, before the loop starts: the Promise engine's `run` throws, and the Effect engine's `run` dies. Nothing is loaded or saved. A check in `startLoop` alone would miss the Effect engine, because it always hands the loop a wrapped sink.
  - **What does not change.** A fenced store with an `onError`, an unfenced store with none and no store at all start as before. The type rule above stands, and `defaultOnError` still grows no case for `StoreConflictError`: one that reaches it came through a throwing sink, or from a store that does not say it is fenced.
  - **Cost.** A host that widened a fenced store on purpose and relied on the process ending now fails at boot. ADR [0016](./0016-removal-lands-in-a-minor-at-0x.md) lets that land in a minor at 0.x.
