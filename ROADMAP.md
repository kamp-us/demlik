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

| Campaign | Milestone | State |
|---|---|---|
| Tuval on tea | #2 | active |

## Dependencies

No cross-row dependencies are declared yet. One row per real dependency when there is one.
