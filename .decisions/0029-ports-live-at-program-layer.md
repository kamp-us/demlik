---
id: 0029
title: "Typed ports live on the program above tea, never on a tea machine"
status: accepted
date: 2026-10-18
tags: [tea, ports, tell, tuval, tea-program]
---

# 0029 — Typed ports live on the program above tea, never on a tea machine

**What this decides:** named, described inputs and outputs that are checked while a program runs,
their listing and the fit between two of them belong to the program layer that runs tea machines,
not to `defineMachine`; tea keeps only the typed Msgs a machine already has.

## Context

[ADR 0026](./0026-tea-owns-typed-ports-and-tell.md) put typed in and out ports on a tea machine,
and a `tell` that never waits in tea. Its reason for the ports half was that a port's declaration,
listing and check have one source only when they sit on the machine. The build was epic
[#657](https://github.com/kamp-us/demlik/issues/657).

The epic was put on hold
([comment](https://github.com/kamp-us/demlik/issues/657#issuecomment-6241624646)) while the same
work was tried one layer up, in tea-program
([usirin/tea-fabrika](https://github.com/usirin/tea-fabrika), `src/program/`). tea-program runs on
tea unchanged (its experiment 62). A program there declares typed inputs and outputs with a
description, checks values on the way in, lists them, and wires one program's output to another's
input with a fit check. It can hold several machines.

Tuval's real use of ports, read in kamp-us/phoenix, settled where they belong:

- Tuval declares about 25 ports: counter, cron, shell, notify, worktree, the AI agent and others.
- Every one connects two separate processes, wired by config read while running. Some are reloaded
  live, and the two ends can be on different package versions.
- None connects two machines inside one program. None needs a port on a machine that is not a
  program.
- A Tuval program is one machine: one `init`, one `update`. So "on the machine" and "on the
  program" were the same place there, which is how 0026 came to say "on the machine".
- Every catch Tuval's runtime parts made (a wrong shape, a route refused before boot, a window
  queuing a thousand prompts behind a stuck agent) was data crossing between processes. None was
  inside one.

Before the epic closed, each rule in it and in the
[#635 ruling](https://github.com/kamp-us/demlik/issues/635#issuecomment-6139737462) was compared
against tea-program. Four were worth taking and are built there (its experiments 79 and 80): a
resent value whose input got stricter goes to dead letters; each input's line has a limit; a program
`defineProgram` did not make is refused; a run's end counts what it never read. The epic, its
children #664 to #669 and the draft PR #675 are closed
([note](https://github.com/kamp-us/demlik/issues/657#issuecomment-6253983368)).

This record amends 0026 in part. Its `tell` half stands and is carried by
[#639](https://github.com/kamp-us/demlik/issues/639#issuecomment-6253991185).

## Decision

**A typed, described input or output that is checked at run time belongs to the program, the unit
that is started, wired and listed from outside; a tea machine keeps the compile-time typed Msgs it
already has.**

The line between the two is the boundary the compiler can see across:

- **Inside one program,** machines talk in their own Msg types, checked by the compiler. tea already
  gives this: the Msg union and its cells.
- **At the program's edge,** values come from a shell, a pipe, an agent, a config file or another
  program, maybe a different version of it. That is where a run-time shape check, a description, a
  listing and fit earn their cost, so that is where they live.

This matches Elm, where `port`s are declared for the program and wired to the outside there, never
on each component, and Unix, where a process has its standard input, output and arguments.

What changes against 0026:

| 0026 item | Now |
|---|---|
| 1. Ports on `defineMachine`, with listing | Withdrawn. Inputs, outputs and their listing are the program's. |
| 2. A shape only checks, never translates | Withdrawn for tea. The program layer decides its own rule. |
| 3. In port, checked before the line | Withdrawn for tea. |
| 4. Out port always reports back (`_ok` / `_err`) | Withdrawn. |
| 5. `tell` never waits | **Stands**, without the port words. `tell` puts the Msg on the receiver's line and returns at once. Being accepted and being done are two things: any result comes back later as its own Msg. Built under #639. Its answer words are #639's to settle. |
| 6. Ask-and-answer helper | Withdrawn for tea. |
| 7. Fit is shape only, and exact | Withdrawn for tea. Fit is the program layer's. |
| 8. The old port family goes | Withdrawn. `definePort` and its family stay until a reason of their own removes them. |

What stays in the host is unchanged from 0026, and the program layer is that host: the registry,
the table of running machines, the route graph, wiring from config, finding a machine by name,
`defineProgram`.

### The earlier rulings

| Ruling | Result |
|---|---|
| [#325](https://github.com/kamp-us/demlik/issues/325#issuecomment-5808832579) round R1.1 | **Back to the original.** 0026 narrowed it to "can a host do it correctly itself". tea-program did both things 0026 said a host could not: one source for an input's declaration, listing and check (on the program), and a hand-over that does not wait (on the program's own lines). So tea does not grow to fit a host. |
| "No registry" ([#312](https://github.com/kamp-us/demlik/issues/312), [#554](https://github.com/kamp-us/demlik/issues/554)) | **Stands.** |
| [ADR 0020](./0020-tea-owns-no-dependency-injection.md), [ADR 0022](./0022-no-battery-layer-plain-functions.md) | **Stand.** |
| [ADR 0025](./0025-stop-gives-up-on-handlers.md) | **Stands.** The Msgs a `stop()` drops behind a stuck handler are still unnamed: [#698](https://github.com/kamp-us/demlik/issues/698). |

**Binding constraints.**

- tea adds no `ports` field, no `port` helper and no fit function.
- A run-time shape check, a description, a listing and fit for a value from outside a program live
  in the program layer, never in tea.
- tea's `tell` never waits for the receiver to handle the Msg.
- tea keeps no table of runs, finds nothing by name and routes nothing.

## Consequences

- tea stays small and Elm-shaped. No breaking removal ships, and no handler's ctx type changes.
- A host that wants ports builds them on the program, as tea-program does. Tuval's move onto
  tea-program carries its ports there as program inputs and outputs, one program per Tuval program.
- The one place this could be wrong: a host that must wire one inner machine of a program from
  outside, without making that machine its own program. Nothing in Tuval or tea-program does that
  today. If one appears, it reopens this record.
- tea-program is still an experiment repo. Moving it into this repo is its own work.

## Records

- **port** keeps its present meaning in tea: the old `definePort` family. 0026's redefinition never
  shipped and is withdrawn, so the glossary does not change. The program layer calls its typed ends
  inputs and outputs.
