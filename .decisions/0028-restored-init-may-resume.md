---
id: 0028
title: Restored initialization may resume work
status: accepted
date: 2026-10-18
tags: [tea, init, replay]
---

# 0028 — Restored initialization may resume work

**What this decides:** A restored machine chooses its first move in `init`, while recorded replay folds messages from the captured state without initializing again.

## Context

The [owner ruling on #693](https://github.com/kamp-us/demlik/issues/693#issuecomment-6246398878)
permits resume commands from restored initialization. A host resume message sent
after boot can race the subscriptions already opened for the restored state.

This amends [ADR 0006](./0006-client-prediction-fold-seam-and-pure-boundary.md)
only where it requires passive restored initialization and retains `replay`'s
throw for restored init commands. Its client-prediction seam (`foldMsgs`) and
runtime-free module boundary remain in force.

## Decision

**`init(loaded, ctx)` may return a new state and resume commands on restoration.**

Initialization stays pure: it describes work as commands. The engine saves the
returned state, reconciles its subscriptions, and executes its commands through
the existing commit path. The returned state must describe the work already
started so a fast subscription response cannot request the same work again.

The pure `replay` helper initializes once and collects the commands from both
initialization and updates, including restored initialization. It executes none.
Recorded replay instead starts from the recorder's captured post-init state and
applies only the recorded messages. It never calls `init` or executes commands.
Test helpers stepping an existing state call the update cell directly.

**Binding constraints.**

- Resuming in `init` needs no host latch or post-boot resume dispatch.
- Recorded replay must not initialize the captured state again.
- A terminal state produced by restored init crosses the same persistence
  boundary as any other terminal transition before completion is published.
- `bootResume` and `driveToDone` remain host-message tools. Their messages run
  after boot, so they do not provide ordering ahead of subscriptions.

## Consequences

Machines can encode their restored first move in one place. Consumers using
`replay` with a loaded state now see init commands in the collected command
list; use a direct update step when testing an existing state. Recorded replay
needs a captured starting state, rather than reconstructing one with `init`.
These published behavior changes receive a minor changeset while tea is at 0.x.
