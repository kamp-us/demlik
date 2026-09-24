# @demlik/tea — Roadmap

> What we build next in this package, and why, in order. GitHub milestones are the
> operational projection of the rows below; the pipeline reads this file to join an
> open milestone to the work it stands for. Revised when a release lane opens or closes.

## How this roadmap works

An **arc** is a themed chapter of work on the library, projected onto one GitHub
milestone. A **campaign** is a bounded cross-cutting push that is not a release lane —
a docs sweep, a gate hardening — also pinned to a milestone. Exactly one arc is active
at a time; priority is relative to it. The join key is the `#<number>` cell, never the
title, so renaming an arc cannot silently repoint it.

## Arcs

| Arc | Milestone | State | What it covers |
|---|---|---|---|
| Kernel hardening | #1 | active | The reducer/runtime kernel and its host adapters — the surfaces `src/` already ships behind the kernel export tier. The v0.6 release lands the two-engine split (epic #273): the neutral core at `@demlik/tea`, the Promise engine at `./promise`, the Effect engine at `./effect`, with DI and the battery layer removed. |

## Campaigns

Exactly three cells per row — `build`'s scope fence reads this table and a fourth column makes
the whole thing unreadable, so what a campaign covers goes in prose above it, not in a column.

**Tuval on tea** (#2). Tuval, kamp-us/phoenix's process desk, is built on tea and runs its own
Effect host beside it (`packages/tuval/src/host/actor.ts` plus `demlik-bridges.ts`). This campaign
ships, in one release, everything Tuval needs to delete that host and run fully on
`@demlik/tea/effect`, then drop its own copies of persistence, process, test and React glue. It
ends with a phoenix PR that moves Tuval onto the release, which phoenix plans and builds. The
Effect engine leaves the experimental tier only once it powers Tuval fully. Declared and started 2026-09-24;
no build starts until the decisions in grilling session #325 are ruled.

**Binclusive agent migration** (#3). Binclusive's audit brain (`services/audit-agents` in
Binclusive/monorepo) is moving from LangGraph onto `@demlik/tea/agent`, and the move hit four gaps
in the agent layer. This campaign closes them, each as one feature sized to what that consumer
actually does: multimodal message parts so a vision agent can show the model a screenshot (#330),
agent tracing into Langfuse over OpenTelemetry via a `@demlik/tea/otel` subpath (#331), per-turn
token usage for context-size compaction and budgets (#332), and a durable sub-agent-as-tool (#333).
`./agent` is experimental, so none of it carries semver ceremony. It ends when the four ship; the
Binclusive-side cutover is planned and built in that repo. Declared and started 2026-09-24.

**Code coordinates** (#4). code-graph proposes and proves a codebase's structure, Jev judges what
each file means, and CI ratchets hold the result. This campaign brings the toolset into the
workspace: `@demlik/code-graph` syncs with the passes built after its snapshot (#344), then
`@demlik/structure-sweep` and `@demlik/backlog-sweep` land as packages over `@demlik/tea/jev` (#345).
It ends when both ship and Binclusive consumes the published packages. Declared and started 2026-09-24.

| Campaign | Milestone | State |
|---|---|---|
| Tuval on tea | #2 | active |
| Binclusive agent migration | #3 | active |
| Code coordinates | #4 | active |

## Dependencies

No cross-row dependencies are declared yet. One row per real dependency when there is one.
