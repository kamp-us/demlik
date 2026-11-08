---
id: 0035
title: Effect machines infer from schemas and command constructors and expose model and message schemas
status: Accepted
date: 2026-11-07
tags: [tea, effect, types, schemas]
---

# 0035 — Effect machines infer from schemas and command constructors and expose model and message schemas

**What this decides:** Effect users declare a machine's model and plain messages with schemas and its commands with a required list.

## Context

Effect users already write schemas but repeat their model and message types for `defineMachine`. Inferring those types from `init` and update cells can widen the declared shapes and accept misspelled messages.

The [owner's ruling on issue 870](https://github.com/kamp-us/demlik/issues/870#issuecomment-6713609947) settles the declarations and signature. This adds a constructor on the Effect entry and leaves the core constructor in place. It keeps the inspectable machine required by [ADR 0015](./0015-hide-the-wiring-never-the-state.md).

## Decision

**`Machine.make` on `@demlik/tea/effect` derives a machine's types from required model and message Effect schemas and command constructors.**

`model` supplies the model type; `msg` supplies the plain message union. `cmds` supplies the command values and their settled messages, using the existing `CmdOf` and `Settled` contracts. An empty list declares no commands. The optional `types` object holds only `sub` and `ctx`.

One signature wraps the machine body in `NoInfer`, so initialization and cells must satisfy those declarations instead of widening them. The result is tea's existing `Machine`, built through `defineMachine` with the same initialization and update rules.

**Binding constraints.**

- Only the Effect entry exports the `Machine.make` value. Core `defineMachine` and the Promise constructor contract stay unchanged.
- The maker has one signature and no overloads. `types` has no model, message or command slot.
- Schemas supply types here. Construction, boot and dispatch perform no automatic decoding. Saved-model validation and any `schemaMigrate` change belong to [issue 872](https://github.com/kamp-us/demlik/issues/872).

## Consequences

Effect users declare each model and message shape once and keep the existing engines and pure helpers. They still parse external data at its boundary. Authors declare every command, including an explicit empty list for a pure machine. Existing core machines need no migration.

## Amendments

- **#897 — Keep the declared model and plain-message schemas reachable (2026-11-08).**
  The [owner's ruling](https://github.com/kamp-us/demlik/issues/897#issuecomment-6725677913)
  adds typed, readonly `model: Schema.Schema<S>` and `msg: Schema.Schema<M>`
  properties to the returned machine. Each is the same reference supplied to
  `Machine.make`. The message schema describes plain messages, without command
  settlements. The earlier "schemas supply types" constraint means the maker
  adds no automatic decoding; hosts may use those references to validate data
  explicitly. The core `Machine` type, `defineMachine`, engines, single
  constructor signature and inference rules stay unchanged. Work on
  `schemaMigrate` remains in [issue 872](https://github.com/kamp-us/demlik/issues/872).
