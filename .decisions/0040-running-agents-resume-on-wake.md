---
id: 0040
title: A cold wake resumes a running agent, including one lost during compaction
status: accepted
date: 2026-11-19
tags: [tea, agent, boot]
---

# 0040 — A cold wake resumes a running agent, including one lost during compaction

**What this decides:** `agentIsResumable`, and so `autoBoot` and `createAgentHost`, treat a restored agent whose status is `running` as resumable, the way they already treat a `suspended` one. No status value changes.

## Context

[ADR 0004](./0004-agent-context-compaction.md) says a `compacting` run reports `running` from `status()`, with "no new resumable case — resumability stays exactly 'awaiting tools'". That held while `agentIsResumable` was `status(s).kind === "suspended"`, and it left two cases restored and never re-entered. An activation lost while the model call was in flight, or while the compaction was in flight, persists a `running` run with that call still owed. `createAgentHost.runtime()` booted it, dispatched nothing, and the run stayed `running` with nothing in flight until a configured deadline failed it. The boot verb already reissues both calls, and `defineAgent`'s `agent.run` already boots a `running` run through its own copy of this rule.

This amends ADR 0004 only where it ties resumability to awaiting tools. Compaction still reports `running`, adds no status kind, keeps its own Cmd, retry slice and turn count, and still does not count toward `maxTurns`. [ADR 0028](./0028-restored-init-may-resume.md), [ADR 0038](./0038-engine-owned-durable-log.md) and [ADR 0039](./0039-a-request-is-run-with-an-opt-in-restored-boot.md) keep restored initialization and engine-owned recovery. The agent's `init` returns the loaded State and no Cmds, so `agent_boot` stays the one first move.

## Decision

**A restored agent whose status is `running` or `suspended` is mid-run, and a cold wake dispatches `agent_boot` once for it.**

One table, keyed by every `AgentStatus` kind and checked with `satisfies Record<AgentStatus<unknown>["kind"], boolean>`, names the mid-run kinds: `running` and `suspended` are true, and `idle`, `done`, `failed` and `cancelled` are false. `agentIsResumable` and `defineAgent`'s choice between `agent_start` and `agent_boot` both read it. The table reads `status(state)`, which already puts a failure annotation on a `running` phase ahead of it and reads a `stale` run as `running`, so a host never inspects `awaiting`.

`agent_boot` reissues the one outstanding operation: the model call, the compaction, or the tool calls still in flight, and it skips a tool call whose next attempt a retry timer already owes. `createAgentHost` runs it once per activation, never per request.

**The host's boot gate opens when `agent_boot` is queued.** [Invariant 6](../.patterns/tea/tea-invariants.md) says "Boot is a named, awaitable moment" and names `await runtime.ready` as that moment; `bootResume` dispatches after it. `createAgentHost.runtime()` resolves once the boot Msg is in the runtime's inbox, ahead of anything the caller dispatches next, and not when the work it re-fired has finished. That work can be parked on a tool that only the driver can answer, and the driver reaches the run through `runtime()`, so waiting for it deadlocks a `/step` engine. `reset()` stops the handle the host holds from the moment `run` returned it, so it never waits on a boot. `bootResume` and `autoBoot` keep their contract and resolve when the resumed work finishes.

**Binding constraints.**

- Do not add a status kind, a second boot Msg, or a host-side read of `awaiting`.
- Do not pair `agent_boot` with restored-init Cmds for the same work.
- A `/step` engine reaches the run with `host.runtime()` and stops it by dispatching `agentCancelMsg` into that runtime, then releasing the tool calls the run is parked on. `runtime()` does not wait on a tool nobody has answered, so no engine reads saved state to get around it. `reset()` stays a test and lifecycle seam for one caller at a time, and an overlapping call throws a `HostOverlapError`.
- An `idle`, `done`, `failed` or `cancelled` run is not booted.

## Consequences

- A run lost during its model call or its compaction finishes after the next wake, with its completed tool results still folded and its retry budgets as persisted.
- The call that was in flight is issued again, so a provider can bill it twice. Cloudflare eviction and billing are not measured by the tests that pin this.
- A host that dispatched `agent_boot` by hand beside `createAgentHost` to cover a `running` run now boots it twice. Delete that dispatch.
- A caller that read a finished run right after `await host.runtime()` now reads the run as it stands and waits with `subscribe` or `status()`.
- The two copies of the rule collapse into one table, so a new status kind is a compile error there.

## Records

no vocabulary impact
