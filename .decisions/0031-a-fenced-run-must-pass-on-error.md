---
id: 0031
title: A fenced run must pass an onError, held by its type
status: accepted
date: 2026-10-31
tags: [tea, store, errors]
---

# 0031 — A fenced run must pass an `onError`, held by its type

**What this decides:** a run on a fenced store that passes no `onError` does not compile, and the default sink does not change.

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
- The default sink must not grow a case for `StoreConflictError`. One that reaches it is a store whose fenced type was thrown away, or a throwing sink, and both should be loud.

## Consequences

- A host that passes a fenced store with no `onError` gets a compile error. ADR [0016](./0016-removal-lands-in-a-minor-at-0x.md) lets that land in a minor at 0.x.
- `AgentHostConfig` is now a type alias, not an interface, so nothing can `extends` it. `AgentHostWiring` is the interface part.
- **The type reads the store's declared type.** A fenced store assigned to a variable typed plain `Store<S>` compiles with no `onError`, and runs on the default sink. A JavaScript caller has no type to hold it either. Closing that would take a runtime check the ruling did not ask for.
- A host running several unfenced machines in one process still loses them all to one failing Sub, unless it passes an `onError`. The docs for `onError` say so.
