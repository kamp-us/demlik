---
id: 0027
title: code-graph reports one impure kind, and each concept has one word in code-graph and tea
status: accepted
date: 2026-10-16
tags: []
---

# 0027 — code-graph reports one impure kind, and each concept has one word in code-graph and tea

**What this decides:** `code-graph --boundaries` has one kind, `impure`, for a feature file that
touches the world where it may not. The old word for a world global and for a published import path
is retired in both packages: code-graph says impure, tea says subpath.

## Context

ADR 0023 named a world global by the target a use read and let Node's own `process` judge a
declaration. Around it the report grew five kinds for one fact, a file that is impure where its
place forbids it: `impure-application` (B7), the driven-adapter check (B9), the world half of
`impure-library` (B13), the owner check (B5) and `impure-rules` (B2). They differed only in the
place the file sat, and the place is already in the entry's `from` path. The same old word also
named a published import path in tea, so one word meant two things in one repo.

## Decision

**One kind, `impure`, answers "is this file impure where it must not be". The place comes from the
entry's `from` path, and the places that may be impure are one column in the zone table plus the
library `pure` flag.**

1. `impure` replaces `impure-application`, the driven-adapter check and the world half of
   `impure-library`. It fires in `application/`, `index.ts`, `ports.ts`, a driving adapter and a pure
   library, and not in a driven adapter or a test file. World-library import detection and the
   type-only count stay.
2. The owner check (B5) and its rules key are deleted. Nobody declares an owner for a world
   global any more, so `process-members.ts` goes with it.
3. `impure-rules` and the `global` ledger flag are deleted. The `layout` key and the `rules` layout
   go too: hexagonal is the only layout. The `contracts` key only fed `impure-rules`, so it goes.
4. The catalog is `IMPURE_GLOBALS` in `impure.ts`. The retired rule numbers B2, B5, B9 and B13 are
   not reused.
5. In tea, a published import path is a subpath, and the root is `@demlik/tea`. This applies to
   every accepted ADR that used the old word only in that sense; those take the word swap and nothing else.
6. This is a hard break with no alias, shim or deprecation path, per
   [0016](./0016-removal-lands-in-a-minor-at-0x.md). A ledger or rules file naming an old kind or key
   is refused.

**Banned.**

- A second kind for an impure file, split by place.
- A configurable vocabulary, or an alias for a retired kind or key.

## Consequences

- A repo's `boundary-ledger.json` and `boundary-rules.json` need one edit: old kinds become `impure`,
  and the deleted keys come out. Both packages ship the break in a minor with a changeset.
- A file that is both in a zone that bans impurity and in a pure library can show as one entry per
  rule; the ledger key keeps them as one row.
- `BoundaryRulesSchema` and `BoundaryRules` are exported from `@demlik/code-graph/boundaries`, and
  `BOUNDARY_KINDS` is derived from the crossing table, so a new kind cannot be left out of the list.
- 0023 is superseded. Its body stays as the record of what it decided.

## Records

no vocabulary impact
