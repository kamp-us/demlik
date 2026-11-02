---
id: 0032
title: Effect property tests draw answers from each Cmd's schema, and the laws are plain functions
status: accepted
date: 2026-11-01
tags: [tea, pbt, effect, testing]
---

# 0032 — Effect property tests draw answers from each Cmd's schema, and the laws are plain functions

**What this decides:** `@demlik/tea/testing/effect` draws a machine's answers from each Cmd's own Effect schema, on Effect's `Arbitrary`, with no fast-check. The laws are plain check functions that both `./pbt` and `./testing/effect` export. There is no bridge between the two generators and no second set of runners.

## Context

A Cmd made with `Cmd.define` from `@demlik/tea/effect` already holds its `ok` schema and its `err` tags. `./pbt` takes only fast-check arbitraries, so a test author on the Effect engine wrote every answer a second time, by hand ([#749](https://github.com/kamp-us/demlik/issues/749)). Effect 4's `Arbitrary` is its own generator, not fast-check, so reusing the schemas needed either a bridge to fast-check or an Effect flavor of the runners.

tea-fabrika's experiment 174 measured the routes: a bridge loses shrinking, and Effect's generator, folded through the machine, shrinks as well as fast-check does.

## Decision

By the owner's rulings on #749: [the first](https://github.com/kamp-us/demlik/issues/749#issuecomment-6552228314) and [the one that replaces its name and checks](https://github.com/kamp-us/demlik/issues/749#issuecomment-6564369809).

- **The home is the existing `./testing/effect`.** No new subpath. Each new function carries `@experimental` in its TSDoc, so it has no stability promise on a `stable` subpath, the way `fileJournal` sits on `./node`.
- **`arbSchemaGuidedSequence` draws the lists.** An `ok` answer comes from the Cmd's `schema.ok` and an `err` answer carries one of its `errTags`. The blind events fold through the same rule `arbGuidedSequence` uses (`src/pbt/arbitraries/guided-fold.ts`), so every answer answers a Cmd that was sent and not yet answered.
- **A machine it cannot draw for gets a failed `Result` naming why**: no `machine.cmds`, a Cmd whose `ok` schema is not an Effect schema, or nothing at all to draw.
- **The laws are plain functions in `src/pbt/laws.ts`**: `lawTerminates`, `lawInvariant` and `lawTrace` read one fold and answer `null` or what broke. `propertyTerminates`, `propertyInvariant` and `propertyTrace` call them, and Effect's `Arbitrary.checkEffect` runs them through `./testing/effect`.
- **Effect 4.1.1 only.** rc.117 and 4.0.6 are not supported.

**Binding constraints.**

- Nothing reachable from `./testing/effect` imports `fast-check`, and it exports no runner.
- Nothing reachable from `./pbt` imports `effect`.
- `src/entry-points.import-graph.test.ts` holds both. The rule that only `./effect` and `./testing/effect` import `effect` stays as it was.

## Consequences

- An Effect user property-tests a machine with `arbSchemaGuidedSequence`, `foldEvents`, a law and `Arbitrary.checkEffect`, and imports nothing from `./pbt`.
- **A shrunk list is never longer than the one first found, when `outside` is given and every state takes every Msg.** A dropped answer broke that: deleting an earlier answer let it back in, and a retry could grow the list. So an answer drawn with nothing waiting is dropped, and an `outside` Msg the event drew goes in its place. With no `outside`, or with a state that refuses a Msg, an event can still be dropped, and the bound does not hold.
- The fast-check `arbGuidedSequence` keeps its old drop rule. It shares the fold, not the stand-in.
- Experiment 121's 150 planted bugs are not a gate here. tea-fabrika runs them after the release.
