---
id: 0043
title: An agent keeps its domain state in the Model through a pure fold hook
status: accepted
date: 2026-11-23
tags: [tea, agent, model, replay]
---

# 0043 — An agent keeps its domain state in the Model through a pure fold hook

**What this decides:** `createAgent` and `defineAgent` take an optional `domain: { init, step }`. `step` folds the four transcript events the kernel already settles (a turn, a tool outcome, a nudge, a compaction) into a slice the Model holds at `domain`, and `stopWhen` and `continueWhen` read it as `state.domain`. Without `domain`, the Model and the reducer are unchanged.

## Context

A host that builds on the agent decides on facts of its own: a stage, a running tally, what it has seen. Today it gets them by folding the whole conversation again on every model call, `stopWhen` and `continueWhen`. That costs O(n) per transition, and the result lives outside the Model, so no Store persists it and `replayTrace` does not replay it.

The kernel already folds each of the four events at exactly one site, with the data in hand:

- a settled turn in `turn`;
- a nudge in `turn`, after `continueWhen` returned text;
- a tool outcome in `settleTool`, which every path reaches: a router `<name>_ok` / `_err`, `agent_tool_ok` / `_err`, and a ladder timeout through `applyLadder`;
- a compaction in `compactOk`, through `foldSummary`.

A stale or late settle, `boot`, a brain retry, `compactErr`, and a ladder retry that settles nothing fold nothing.

[ADR 0015](./0015-hide-the-wiring-never-the-state.md) item 2 requires the lid's Model to be "the same JSON-serializable slice the raw kernel would produce, under the same keys". `compose-two-battery-slices.md` describes a battery as "pure state plus verbs over that state … never takes the host Model". [ADR 0037](./0037-tea-discriminants-are-keyed-tag.md) keys every discriminant tea owns `_tag`.

## Decision

**One optional hook, `AgentDomain<D, R> = { init(): D; step(slice: D, event: AgentDomainEvent<R>): D }`, stepped at the four fold sites.**

1. `AgentDomainEvent<R>` is a `_tag` union: `turn` (the `AgentTurn`), `tool` (the `ToolCall` and its `ToolOutcome<R>`), `nudge` (the `Nudge`), and `compaction` (the `folded` count and the `summary` turn). Each carries the transition's `at`, so `step` never reads a clock.
2. `step` runs where the kernel folds the event, before anything reads the state. The turn is stepped on the state that `continueWhen` reads and that the tool branch builds on. The nudge is stepped before `nextTurn`. A tool outcome is stepped on the state all three returns of `settleTool` share, so `stopWhen` after a drained batch sees every outcome. A compaction is stepped on the state handed to the next brain call, after the stale guard.
3. `init()` seeds the slice in the agent's `init`, and `start` resets it for a new `runId`. A repeated `start` for the same `runId` returns the Model untouched, with or without the slice.
4. A Model met without the slice is seeded from `init()` unless its run is mid-run (running or suspended, by `isMidRun`); mid-run it throws `MissingAgentDomainError`, which stops the run like any reducer throw. Seeding mid-run would silently restart the slice, and skipping the step would silently diverge. Upgrading an old save belongs to the host's Store `migrate`.
5. The types default `D = never`, and `AgentStateOf<…, D>` collapses to `AgentState` there. Every existing signature compiles unchanged, and `domain` sits at the same key in `createAgent`, `defineAgent` and `createAgentHost`.

**Binding constraints.**

- `step` is pure: no clock, no randomness, no Cmds, no mutation. In dev the Model is deep-frozen before each reducer call, so a mutating `step` throws.
- The slice is plain JSON data: no `Map`, `Set`, `Date`, class instance or function. `deepFreeze` skips non-plain prototypes, and every Store saves the slice as JSON.
- With no `domain`, `init` and `start` add no key, not even `domain: undefined`, and the step helper returns its input unchanged. A recording made before this change replays `matches: true`, and a committed fixture pins that.

**Rejected.**

- *An outer wrapper over `update`.* It cannot run between the turn fold and `continueWhen`, which fires inside the same transition, and it would have to rebuild the events by diffing conversations.
- *The slice in `payloadOf`.* `LlmCall.payload` is kept in `resilience.calls` for the call's life, so the slice would be stored twice per brain call. A host that wants the slice at model-call time reads `getState`.
- *Passing the conversation to `step`.* It invites the same O(n) re-derivation per event this removes.
- *`step` returning Cmds.* Nothing needs it, and effects stay in tool cells.
- *`step` seeing the whole Model.* The brick contract is slice in, slice out.

## Consequences

- A host's domain state is persisted by every Store, replayed by `replayTrace`, and frozen in dev with the rest of the Model, and `stopWhen` and `continueWhen` read it in O(1).
- A `step` that changes behaviour shows up in a recorded trace with steps as a divergence whose path starts at `state.domain`, at the msg where it first folds differently.
- A structure-sharing `step` costs O(changed) per transition under the `Object.isFrozen` early-out in `deepFreeze`.
- Recordings gain no Msg and no Cmd, because the slice is derived from Msgs the trace already holds. This is the same claim [ADR 0004](./0004-agent-context-compaction.md) makes: replay "needs no new seam".
- A host that adds `domain` to an agent with saved mid-run Models has to upgrade them in `migrate`, or the next transition throws `MissingAgentDomainError`.

## Records

no vocabulary impact
