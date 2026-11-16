---
id: 0037
title: Every discriminant tea owns is keyed `_tag`, never `type`
status: Accepted
date: 2026-11-15
tags: [tea, types, effect, naming]
---

# 0037 — Every discriminant tea owns is keyed `_tag`, never `type`

**What this decides:** a Msg, a Cmd, a Sub, a State and a semantic event name their variant with `_tag`, the key Effect uses. A shape that copies another system's format keeps that system's key.

## Context

tea named a variant two ways. A Msg, a Cmd, a Sub and a State used `type`, and the core fixed it (`M extends { type: string }`). An error and an `Outcome` used `_tag` ([ADR 0011](./0011-errors-as-data.md), [ADR 0021](./0021-handler-outcome-becomes-the-msg.md)). `.patterns/tea/elm-canon.md` section 2.20 asks for one name used everywhere, and [ADR 0027](./0027-one-impure-kind-and-one-word-per-concept.md) asks for one word per concept.

Effect keys every tagged value by `_tag`: `Schema.TaggedStruct` and `Schema.TaggedUnion` write it, and `Match.tag` and `Data.TaggedEnum` read it. On the Effect engine a machine's Model and Msg are Effect schemas ([ADR 0035](./0035-effect-machines-infer-from-schemas.md)), so a host converted at every edge, and a `Machine.make` whose `msg` was a `Schema.TaggedUnion` did not compile ([issue 949](https://github.com/kamp-us/demlik/issues/949)).

## Decision

**The discriminant of a Msg, a Cmd, a Sub, a State and a semantic event is `_tag`.**

1. The core constraint is `{ _tag: string }`. A Cmd's name still mints its answer Msgs (`<name>_ok`, `<name>_err`), which is why a Cmd and a Msg share one key.
2. A shape that copies another system's format keeps that system's key. In tea these stay `type`: a content part and its source (`ContentPart`, `MediaSource`; Effect's own AI prompt parts are keyed `type` too), a Sentry-shaped `TraceBreadcrumb`, the DOM's event (`MinimalEvent`), Jev's HTTP contract, and typedoc's JSON.
3. Only the key is renamed. A name that merely contains the word (`MsgType`, `msgType`, `acceptedTypes`) keeps its spelling.
4. The break is hard, per [ADR 0016](./0016-removal-lands-in-a-minor-at-0x.md): no alias, no reader of both keys, no upcaster. Nothing converts saved data. The event-sourced store's default parser answers `null` for a row with no string `_tag`, so an event row an older release wrote is dropped. A saved Model is not rewritten: one with no discriminant inside loads as before, and one whose State or stored Msgs carry `type` no longer matches its machine. A host that must keep such a run converts it in its own `store.migrate`.
5. The rename was written by a script that asks the TypeScript checker who declared each key, and the pull request carries that script. A hand edit covers only what a checker cannot see: comments, pages, text in test expectations and untyped reads.

**Banned.**

- `type` as the discriminant of a new Msg, Cmd, Sub, State or semantic event.
- An alias, a fallback or an upcaster that reads `type` where `_tag` is meant.
- Renaming a key another system defines.

## Consequences

- Every machine written against an older release changes its Msg, Cmd, Sub and State literals and its reads. One minor changeset with a `**Breaking` callout records it.
- A run saved before this release does not continue after it unless its host converts it: its event rows are dropped, and a saved State keyed `type` matches no row of a state table. No deployment held saved runs when this was decided.
- `Schema.TaggedStruct`, `Schema.TaggedUnion`, `Match.tag` and `Data.TaggedEnum` fit a tea Msg and a tea State with no wiring.
- structure-sweep, backlog-sweep and code-graph do not change. Their `type` keys are `parseArgs` options, Jev shapes and a syntax tree, and none is a tea discriminant.
- tea's unions keyed `kind` are not ruled on here.

## Records

no vocabulary impact
